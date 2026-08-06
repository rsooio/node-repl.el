#!/usr/bin/env node
/**
 * Evaluator stdio REPL
 *
 * 协议（JSONL，UTF-8）：
 *   请求：一行 JSON，形如 {"code": "<JS/TS 代码>"}
 *   响应：一行 JSON：
 *     {"type": "result",  "result": "<结果或错误文本>"}
 *     {"type": "console", "method": "log", "args": "<inspect 文本>"}
 *
 * 代码先经 esbuild 擦除 TS 类型（loader: tsx，含 JSX）再求值，不检查类型。
 * 每个请求串行执行，vm context 跨请求保留（变量、函数、类可持续使用）。
 * 运行：pnpm start（或 pnpm exec tsx repl.ts）
 */

import { createContext, runInContext } from "node:vm";
import { inspect } from "node:util";
import { transform } from "esbuild";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { processCode } from "./evaluator.utils.ts";

// 与 crawler 环境一致的基础上下文（不含 got/save/rateLimiter）
const context = createContext({
  URLSearchParams,
  URL,
  FormData,
  CookieJar,
  cheerio,
  setTimeout,
  // console 输出作为 JSON 消息走 stdout，与响应统一协议
  console: Object.fromEntries(
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
  ),
});

function respond(result: string): void {
  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
}

function evalCode(code: string): Promise<void> {
  return (async () => {
    try {
      // 擦除 TS 类型（含 JSX），类型错误不检查
      const { code: js } = await transform(code, {
        loader: "tsx",
        target: "esnext",
      });
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
        const code = JSON.parse(line).code;
        if (typeof code !== "string") {
          respond("请求缺少 code 字段");
          return;
        }
        return evalCode(code);
      } catch (err) {
        respond(`请求解析失败: ${err}`);
      }
    });
  }
});
