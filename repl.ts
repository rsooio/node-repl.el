/**
 * Evaluator stdio REPL
 *
 * Protocol (JSONL, UTF-8):
 *   Request: one JSON line, e.g. {"code": "<JS/TS code>", "cwd": "<project root>"}
 *   Response: one JSON line:
 *     {"type": "result",  "result": "<result or error text>"}
 *     {"type": "console", "method": "log", "args": ["<string args as-is>", <number/boolean args as-is>]}
 *
 * With cwd, createRequire(cwd) is injected into the context, so code can load
 * that project's node_modules with require() (require only, no import).
 * Code is transpiled by sucrase (transforms: typescript, imports, jsx) which
 * strips TS types and rewrites import/export/import() to
 * require/module.exports; top-level await is kept as-is (legal inside the
 * async IIFE wrapper). Requests run serially, the vm context persists across
 * requests.
 * Run: pnpm start (i.e. node repl.ts, Node >= 23.6 native type stripping)
 */

import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { transform } from "sucrase";
import { parse } from "acorn";
import * as walk from "acorn-walk";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { processCode } from "./evaluator.utils.ts";

// console output goes to stdout as JSON messages, unified with the response
// protocol. The global console is also replaced: console output from required
// modules (including async callbacks) goes through the protocol too,
// otherwise native plain-text console output would corrupt the JSONL stream
const jsonConsole = Object.fromEntries(
  Object.keys(console).map((type) => [
    type,
    (...args: unknown[]) => {
      process.stdout.write(
        `${JSON.stringify({
          type: "console",
          method: type,
          args: args.map((a) => {
            if (["string", "number", "boolean"].includes(typeof a)) return a;
            return inspect(a, { depth: 4 });
          }),
        })}\n`,
      );
    },
  ]),
) as unknown as Console;

globalThis.console = jsonConsole;

/**
 * Hot-update on top-level class redefinition (paired with the rewrite in
 * evaluator.utils.ts): sync the old class to the new class's member set
 * (full-replacement semantics). Instance/static members removed from the new
 * class are deleted from the old one (calling them reports "is not a
 * function", exposing the removal instead of silently keeping the old
 * implementation); new members are copied to the old class by descriptor
 * (getters/setters included). Returns the old class -- the binding stays put,
 * old instances keep their prototype chain and instanceof, and old instances
 * pick up the changes immediately; on extends changes the old prototype chain
 * switches to the new parent.
 *
 * Constructor logic is extracted into the prototype method __replInit (see
 * evaluator.utils.ts), regenerated on every redefinition; the constructor
 * only delegates to it, so constructor/field-init changes hot-update too:
 * new instances dispatch dynamically to the newest __replInit, old instances
 * can re-run initialization via f.__replInit(...). Degraded cases (the
 * __replInit name is taken by the user, constructor contains return/
 * new.target) are not extracted, constructor changes don't hot-update.
 */
function patchClass(oldClass: unknown, newClass: unknown): unknown {
  if (typeof newClass !== "function") return newClass;
  if (typeof oldClass !== "function" || oldClass === newClass) return newClass;
  const hasOwn = (o: object, k: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(o, k);
  // Full sync: delete old members the new class removed
  for (const key of Reflect.ownKeys(oldClass.prototype)) {
    if (key === "constructor") continue;
    if (!hasOwn(newClass.prototype, key)) {
      delete (oldClass.prototype as Record<PropertyKey, unknown>)[key];
    }
  }
  for (const key of Reflect.ownKeys(oldClass)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    if (!hasOwn(newClass, key)) {
      delete (oldClass as unknown as Record<PropertyKey, unknown>)[key];
    }
  }
  // Instance members: copy to the old prototype, visible to old instances now
  for (const key of Reflect.ownKeys(newClass.prototype)) {
    if (key === "constructor") continue;
    Object.defineProperty(
      oldClass.prototype,
      key,
      Object.getOwnPropertyDescriptor(newClass.prototype, key)!,
    );
  }
  // Static members
  for (const key of Reflect.ownKeys(newClass)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    Object.defineProperty(
      oldClass,
      key,
      Object.getOwnPropertyDescriptor(newClass, key)!,
    );
  }
  // extends changes: switch the old prototype chain to the new parent (old
  // subclass instances see new parent members through the chain)
  const newParent = Object.getPrototypeOf(newClass.prototype);
  if (newParent !== Object.getPrototypeOf(oldClass.prototype)) {
    Object.setPrototypeOf(oldClass.prototype, newParent);
  }
  return oldClass;
}

// Base context consistent with the crawler environment (no got/save/rateLimiter)
const context = createContext({
  URLSearchParams,
  URL,
  Buffer,
  FormData,
  CookieJar,
  cheerio,
  setTimeout,
  console: jsonConsole,
  __replPatchClass: patchClass,
  WebSocket,
  // esbuild format: "cjs" turns export into module.exports assignments
  module: { exports: {} },
  exports: {},
});

// Current injected project require base (recreated when fileDir changes)
let requireBase: string | undefined;

/**
 * Strip TS types and rewrite module syntax to CJS:
 * - import statements -> require (default/named/namespace/side-effect, references rewritten)
 * - export -> exports/module.exports assignments
 * - dynamic import() -> Promise.resolve().then(() => require(...))
 * - top-level await kept as-is (legal inside the async IIFE from processCode)
 */
function transformCode(code: string): string {
  let js = transform(code, {
    transforms: ["typescript", "imports", "jsx"],
  }).code;
  // Drop sucrase's injected module prefix: "use strict" is a string
  // statement and the __esModule marker an expression statement, both would
  // be returned as the last expression by processCode; the vm is not strict
  js = js.replace(/^"use strict";/, "");
  js = js.replace(
    /^Object\.defineProperty\(exports, "__esModule", \{value: true\}\);/, "",
  );
  return js;
}

function respond(result: string): void {
  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
}

/**
 * Append .ts/.tsx extensions to relative require paths: node's createRequire
 * does not resolve extensionless .ts relative paths the way tsx does, so a
 * transpiled require("./x") must become require("./x.ts"). Only when the
 * corresponding TS file exists; non-relative paths and paths with an
 * extension (.js/.json etc.) are left alone. Returns the input unchanged on
 * parse failure.
 */
function fixRequireExtensions(js: string, base: string): string {
  try {
    const ast = parse(js, {
      ecmaVersion: "latest",
      // module rather than script: sucrase output keeps top-level await
      // (legal inside the async IIFE from processCode), which script mode
      // would reject and leave extensions unpatched
      sourceType: "module",
      allowImportExportEverywhere: true,
    });
    const edits: { start: number; end: number; text: string }[] = [];
    walk.simple(ast, {
      CallExpression(node: any) {
        if (node.callee?.type !== "Identifier" || node.callee.name !== "require") return;
        const arg = node.arguments?.[0];
        if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") return;
        const spec = arg.value;
        if (!/^\.{1,2}\//.test(spec) || /\.[a-zA-Z0-9]+$/.test(spec)) return;
        for (const ext of [".ts", ".tsx"]) {
          if (existsSync(join(base, spec + ext))) {
            edits.push({
              start: arg.start,
              end: arg.end,
              text: JSON.stringify(spec + ext),
            });
            return;
          }
        }
      },
    });
    if (edits.length === 0) return js;
    let result = "";
    let cursor = 0;
    for (const e of edits) {
      result += js.slice(cursor, e.start) + e.text;
      cursor = e.end;
    }
    return result + js.slice(cursor);
  } catch {
    return js;
  }
}

// Async errors in vm code (unawaited promises etc.) escape evalCode's
// try/catch and must not kill the REPL: log to stderr (shown in the
// transcript buffer) and keep the process alive. Note: these errors cannot
// be tied to a specific request, so respond() must not be used (it would
// break the request/response pairing).
process.on("unhandledRejection", (reason: unknown) => {
  process.stderr.write(`unhandledRejection: ${inspect(reason, { depth: 2 })}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`uncaughtException: ${err}\n`);
});

/**
 * Parse import declarations in CODE and generate top-level bindings with the
 * same names (usable across requests):
 * - default: var x = (m => m && m.__esModule ? m.default : m)(require("pkg"))
 * - named/aliased: var x = require("pkg").prop
 * - namespace: var x = require("pkg")
 * sucrase only rewrites references within the same chunk of code; the
 * bindings let later requests use the imported names. Returns "" on parse
 * failure (e.g. JSX), in which case the names work only within the first
 * request.
 */
function buildImportBindings(code: string): string {
  try {
    const ast = parse(code, {
      ecmaVersion: "latest",
      // script + allowImportExportEverywhere: syntax only, no module semantics
      sourceType: "script",
      allowImportExportEverywhere: true,
    });
    const lines: string[] = [];
    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration") continue;
      const spec = JSON.stringify(node.source.value);
      for (const s of node.specifiers) {
        if (s.type === "ImportDefaultSpecifier") {
          lines.push(
            `var ${s.local.name} = (function (m) { return m && m.__esModule ? m.default : m; })(require(${spec}));`,
          );
        } else if (s.type === "ImportSpecifier") {
          const prop =
            s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
          lines.push(`var ${s.local.name} = require(${spec}).${prop};`);
        } else {
          lines.push(`var ${s.local.name} = require(${spec});`);
        }
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Remove export statements: the REPL has no module consumer, exports have no
 * effect, and sucrase's exports assignments would be returned as the
 * expression value by processCode.
 * - export const/class/function: drop the "export " prefix, keep the declaration
 * - export default/export {}/export *: drop the whole statement
 * On parse failure (e.g. JSX) returns the input unchanged (sucrase's
 * transform handles exports as a fallback).
 */
function stripExports(code: string): string {
  try {
    const ast = parse(code, {
      ecmaVersion: "latest",
      // script + allowImportExportEverywhere: skip module semantics checks
      // (e.g. "Export 'a' is not defined"), syntax only
      sourceType: "script",
      allowImportExportEverywhere: true,
    });
    const nodes = ast.body.filter((n) => n.type.startsWith("Export"));
    if (nodes.length === 0) return code;
    let result = code;
    // Process back to front to keep offsets valid
    for (const n of [...nodes].reverse()) {
      if (n.type === "ExportNamedDeclaration" && n.declaration) {
        result = result.slice(0, n.start) + result.slice(n.declaration.start);
      } else {
        result = result.slice(0, n.start) + result.slice(n.end);
      }
    }
    return result;
  } catch {
    return code;
  }
}

function evalCode(req: {
  code: string;
  cwd?: string;
  fileDir?: string;
}): Promise<void> {
  return (async () => {
    try {
      // require base is the code's own directory: relative import/require
      // resolves against the file, dependency lookup walks up to
      // node_modules; falls back to cwd
      const base = req.fileDir ?? req.cwd;
      if (base && base !== requireBase) {
        // Use a fake filename rather than the directory: avoids Node
        // resolving the directory by its package.json main
        context.require = createRequire(`${base}/__repl__.js`);
        requireBase = base;
      }
      const code = stripExports(req.code);
      const bindings = buildImportBindings(code);
      let js = transformCode(code);
      // node's createRequire does not resolve extensionless .ts relative
      // paths; patch extensions
      if (base) {
        js = fixRequireExtensions(js, base);
      }
      // Bindings run separately: var declarations land on context properties
      // and don't clash with lexical declarations (const/let) of the same
      // name in the user code's Script; later requests use the names via
      // properties
      if (bindings) {
        await runInContext(
          processCode(base ? fixRequireExtensions(bindings, base) : bindings),
          context,
        );
      }
      const processedCode = processCode(js);
      const value = (await runInContext(processedCode, context))?.value;
      respond(inspect(value, { depth: null, maxArrayLength: 200 }));
    } catch (err) {
      respond(`${err}`);
    }
  })();
}

// Requests run serially through a queue, sharing the context
let queue: Promise<void> = Promise.resolve();

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    queue = queue.then(() => {
      try {
        const req = JSON.parse(line) as {
          code?: unknown;
          cwd?: unknown;
          fileDir?: unknown;
        };
        if (typeof req.code !== "string") {
          respond("missing code field");
          return;
        }
        if (req.cwd !== undefined && typeof req.cwd !== "string") {
          respond("cwd field must be a string");
          return;
        }
        if (req.fileDir !== undefined && typeof req.fileDir !== "string") {
          respond("fileDir field must be a string");
          return;
        }
        return evalCode({ code: req.code, cwd: req.cwd, fileDir: req.fileDir });
      } catch (err) {
        respond(`failed to parse request: ${err}`);
      }
    });
  }
});
