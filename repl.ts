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
          args: args.map((a) => {
            if (["string", "number", "boolean"].includes(typeof a)) return a;
            return inspect(a, { depth: 4 });
          }),
        })}\n`,
      );
    },
  ]),
) as Console;

globalThis.console = jsonConsole;

/**
 * 顶层 class 重复定义时的热更新（配合 evaluator.utils.ts 的改写）：
 * 把新 class 的实例方法/静态成员（含 getter/setter 描述符）复制到旧 class，
 * 返回旧 class —— 绑定不变，旧实例的原型链与 instanceof 不破坏，方法变更
 * 对旧实例立即生效；extends 变化时同步切换旧原型链。
 *
 * 局限（JS 语义使然，非实现缺陷）：constructor 本身与实例字段的初始化逻辑
 * 无法更新——旧实例无法重建，新实例用的是旧 constructor；如需变更构造逻辑
 * 应重启 REPL 或手动重新创建实例。
 */
function patchClass(oldClass: unknown, newClass: unknown): unknown {
  if (typeof newClass !== "function") return newClass;
  if (typeof oldClass !== "function" || oldClass === newClass) return newClass;
  // 实例成员：复制到旧原型，旧实例立即可见
  for (const key of Reflect.ownKeys(newClass.prototype)) {
    if (key === "constructor") continue;
    Object.defineProperty(
      oldClass.prototype,
      key,
      Object.getOwnPropertyDescriptor(newClass.prototype, key)!,
    );
  }
  // 静态成员
  for (const key of Reflect.ownKeys(newClass)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    Object.defineProperty(
      oldClass,
      key,
      Object.getOwnPropertyDescriptor(newClass, key)!,
    );
  }
  // extends 变化：旧原型链切到新父类（子类旧实例经原型链看到新父类成员）
  const newParent = Object.getPrototypeOf(newClass.prototype);
  if (newParent !== Object.getPrototypeOf(oldClass.prototype)) {
    Object.setPrototypeOf(oldClass.prototype, newParent);
  }
  return oldClass;
}

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
  __replPatchClass: patchClass,
  // esbuild format: "cjs" 会把 export 转为 module.exports 赋值
  module: { exports: {} },
  exports: {},
});

// 当前注入的项目 require 基准（fileDir 变化时更新 context）
let requireBase: string | undefined;

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
  // 去掉 sucrase 注入的模块前缀："use strict" 是字符串语句、__esModule 标记
  // 是表达式语句，都会被 processCode 当作最后表达式返回；vm 非严格环境
  // 无需它们
  js = js.replace(/^"use strict";/, "");
  js = js.replace(
    /^Object\.defineProperty\(exports, "__esModule", \{value: true\}\);/, "",
  );
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
      // script + allowImportExportEverywhere：只解析语法，不做模块语义检查
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
 * 移除 export 语句：REPL 无模块消费者，export 不产生任何效果，
 * 且 sucrase 生成的 exports 赋值表达式会被 processCode 当作返回值。
 * - export const/class/function: 删除 "export " 前缀，保留声明
 * - export default/export {}/export *: 删除整条语句
 * 解析失败（如含 JSX）时原样返回（export 由 sucrase 转换兜底）。
 */
function stripExports(code: string): string {
  try {
    const ast = parse(code, {
      ecmaVersion: "latest",
      // script + allowImportExportEverywhere：跳过模块语义检查
      //（如 "Export 'a' is not defined"），只解析语法
      sourceType: "script",
      allowImportExportEverywhere: true,
    });
    const nodes = ast.body.filter((n) => n.type.startsWith("Export"));
    if (nodes.length === 0) return code;
    let result = code;
    // 从后往前处理，避免偏移错乱
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
      // require 基准用代码所在目录：相对 import/require 按文件解析，
      // 依赖解析沿目录向上找 node_modules；回退 cwd
      const base = req.fileDir ?? req.cwd;
      if (base && base !== requireBase) {
        // 用假文件名而非目录：避免 Node 把目录按 package.json main 解析
        context.require = createRequire(`${base}/__repl__.js`);
        requireBase = base;
      }
      const code = stripExports(req.code);
      const bindings = buildImportBindings(code);
      const js = transformCode(code);
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
        const req = JSON.parse(line) as {
          code?: unknown;
          cwd?: unknown;
          fileDir?: unknown;
        };
        if (typeof req.code !== "string") {
          respond("请求缺少 code 字段");
          return;
        }
        if (req.cwd !== undefined && typeof req.cwd !== "string") {
          respond("请求 cwd 字段必须是字符串");
          return;
        }
        if (req.fileDir !== undefined && typeof req.fileDir !== "string") {
          respond("请求 fileDir 字段必须是字符串");
          return;
        }
        return evalCode({ code: req.code, cwd: req.cwd, fileDir: req.fileDir });
      } catch (err) {
        respond(`请求解析失败: ${err}`);
      }
    });
  }
});
