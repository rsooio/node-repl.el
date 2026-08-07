#!/usr/bin/env node
/**
 * Evaluator stdio REPL
 *
 * 协议（JSONL，UTF-8）：
 *   请求：一行 JSON，形如 {"code": "<JS/TS 代码>", "cwd": "<项目根>"}
 *   响应：一行 JSON：
 *     {"type": "result",  "result": "<结果或错误文本>"}
 *     {"type": "console", "method": "log", "args": "<inspect 文本>"}
 *
 * 有 cwd 时向 context 注入 createRequire(cwd)，代码内可用 require() 加载
 * 该项目的 node_modules 依赖（仅 require，不提供 import）。
 * 代码先经 sucrase 擦除 TS 类型并把 import/export/import() 转为
 * require/module.exports（transforms: typescript, imports, jsx），
 * 顶层 await 保留原样（async IIFE 内合法）。
 * 每个请求串行执行，vm context 跨请求保留。
 * 运行：pnpm start（或 pnpm exec tsx repl.ts）
 */

import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import { transform } from "sucrase";
import { parse } from "acorn";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { processCode } from "./evaluator.utils.ts";

// console 输出作为 JSON 消息走 stdout，与响应统一协议
// 同时替换全局 console：require 的模块（含异步回调）的 console 输出也走协议，
// 否则原生 console 的纯文本输出会污染 JSONL 流
const jsonConsole = Object.fromEntries(
  Object.keys(console).map((type) => [
    type,
    (...args: unknown[]) => {
      process.stdout.write(
        `${JSON.stringify({
          type: "console",
          method: type,
          args: inspect(args, { depth: 4 }),
        })}\n`,
      );
    },
  ]),
) as Console;

globalThis.console = jsonConsole;

// 与 crawler 环境一致的基础上下文（不含 got/save/rateLimiter）
const context = createContext({
  URLSearchParams,
  URL,
  Buffer,
  FormData,
  CookieJar,
  cheerio,
  setTimeout,
  console: jsonConsole,
  // esbuild format: "cjs" 会把 export 转为 module.exports 赋值
  module: { exports: {} },
  exports: {},
});

// 当前注入的项目 require（cwd 变化时更新 context）
let projectCwd: string | undefined;

/**
 * 擦除 TS 类型并把模块语法转为 CJS：
 * - import 语句 → require（含 default/命名/命名空间/副作用，引用同步重写）
 * - export → exports/module.exports 赋值
 * - 动态 import() → Promise.resolve().then(() => require(...))
 * - 顶层 await 保留原样（processCode 包装的 async IIFE 内合法）
 */
function transformCode(code: string): string {
  let js = transform(code, {
    transforms: ["typescript", "imports", "jsx"],
  }).code;
  // sucrase 注入的 "use strict" 是字符串语句，会被 processCode 当作
  // 最后一个表达式返回（如 import 单独一行时结果变成 'use strict'）；
  // vm 非严格环境无需它，去掉。
  if (js.startsWith('"use strict";')) {
    js = js.slice('"use strict";'.length);
  }
  return js;
}

function respond(result: string): void {
  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
}

// vm 代码中的异步错误（未 await 的 promise 等）会逃出 evalCode 的 try/catch，
// 不能因此杀死 REPL：记录到 stderr（显示在 transcript buffer），进程保持存活。
// 注意：这些错误无法关联到具体请求，不能走 respond（会破坏请求-响应配对）。
process.on("unhandledRejection", (reason: unknown) => {
  process.stderr.write(`unhandledRejection: ${inspect(reason, { depth: 2 })}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`uncaughtException: ${err}\n`);
});

/**
 * 解析代码中的 import 声明，生成同名顶层绑定语句（跨请求可用）：
 * - default: var x = (m => m && m.__esModule ? m.default : m)(require("pkg"))
 * - named/别名: var x = require("pkg").prop
 * - namespace: var x = require("pkg")
 * sucrase 只重写同一份代码内的引用，绑定让后续请求也能使用导入名。
 * 解析失败（如含 JSX）时返回空串，仅首次请求内可用。
 */
function buildImportBindings(code: string): string {
  try {
    const ast = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
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

function evalCode(req: { code: string; cwd?: string }): Promise<void> {
  return (async () => {
    try {
      if (req.cwd && req.cwd !== projectCwd) {
        context.require = createRequire(`${req.cwd}/`);
        projectCwd = req.cwd;
      }
      const bindings = buildImportBindings(req.code);
      const js = transformCode(req.code);
      // 绑定单独执行：var 声明落到 context 属性，与用户代码同 Script 的
      // 词法声明（const/let 同名）不冲突；后续请求通过属性使用导入名
      if (bindings) {
        await runInContext(processCode(bindings), context);
      }
      const processedCode = processCode(js);
      const value = (await runInContext(processedCode, context))?.value;
      respond(inspect(value, { depth: null, maxArrayLength: 200 }));
    } catch (err) {
      respond(`${err}`);
    }
  })();
}

// 请求串行排队执行，共享 context
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
        const req = JSON.parse(line) as { code?: unknown; cwd?: unknown };
        if (typeof req.code !== "string") {
          respond("请求缺少 code 字段");
          return;
        }
        if (req.cwd !== undefined && typeof req.cwd !== "string") {
          respond("请求 cwd 字段必须是字符串");
          return;
        }
        return evalCode({ code: req.code, cwd: req.cwd });
      } catch (err) {
        respond(`请求解析失败: ${err}`);
      }
    });
  }
});
