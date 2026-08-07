// 服务端协议测试：spawn repl.ts，按 JSONL 协议请求/断言响应。
// 运行：pnpm test:repl（tsx --test test/repl.test.ts）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const replScript = path.join(root, "repl.ts");
const projRoot = root; // node-repl 自身作为测试项目（有 acorn 等依赖）
const otherProj = path.resolve(root, "..", "auto-bidding-v2");

let child: ChildProcessWithoutNullStreams;
let outBuf = "";
let stderrText = "";
const messages: { type: string; result?: string; args?: string }[] = [];

function start(): void {
  child = spawn(tsx, [replScript]);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    outBuf += d;
    let nl: number;
    while ((nl = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (d: string) => (stderrText += d));
}

/** 发送一行原始输入，等待下一个 result 消息（跳过 console 消息）。 */
function expectResult(deadlineMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const startIdx = messages.length;
    const deadline = Date.now() + deadlineMs;
    const timer = setInterval(() => {
      const result = messages
        .slice(startIdx)
        .find((m) => m.type === "result");
      if (result !== undefined) {
        clearInterval(timer);
        resolve(result.result ?? "");
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("timeout waiting for result"));
      }
    }, 10);
  });
}

function sendRaw(line: string): Promise<string> {
  const p = expectResult();
  child.stdin.write(line + "\n");
  return p;
}

function request(code: string, cwd?: string, fileDir?: string): Promise<string> {
  return sendRaw(JSON.stringify({ code, cwd, fileDir }));
}

before(start);
after(() => child.kill());

test("require is undefined without cwd", async () => {
  // 必须最先执行：任何 cwd 注入之前
  assert.equal(await request("typeof require"), "'undefined'");
});

test("basic eval", async () => {
  assert.equal(await request("1 + 1", projRoot), "2");
});

test("ts annotation stripped", async () => {
  assert.equal(await request("const x: number = 5; x * 2", projRoot), "10");
});

test("ts enum", async () => {
  assert.equal(await request("enum Color { R, G } Color.G", projRoot), "1");
});

test("ts generic class with parameter properties", async () => {
  assert.equal(
    await request(
      "class Box<T> { constructor(public v: T) {} get(): T { return this.v } } new Box<string>('hi').get()",
      projRoot,
    ),
    "'hi'",
  );
});

test("ts type errors are not checked", async () => {
  assert.equal(await request('const n: number = "str"; n', projRoot), "'str'");
});

test("state persists across requests", async () => {
  await request("var a = 5", projRoot);
  assert.equal(await request("a + 1", projRoot), "6");
});

test("import only evaluates to undefined", async () => {
  // sucrase 的 "use strict" 前缀不应被当作结果返回
  assert.equal(await request(`import { spawn } from "node:child_process"`, projRoot), "undefined");
});

test("import bindings persist across requests", async () => {
  await request(`import { spawn } from "node:child_process"`, projRoot);
  assert.equal(await request(`typeof spawn`, projRoot), "'function'");
  assert.equal(await request(`spawn !== undefined`, projRoot), "true");
});

test("default import binding persists", async () => {
  await request(`import acorn from "acorn"`, projRoot);
  assert.equal(await request(`acorn.version`, projRoot), "'8.18.0'");
});

test("namespace import binding persists", async () => {
  await request(`import * as tc from "tough-cookie"`, projRoot);
  assert.equal(await request(`tc.CookieJar !== undefined`, projRoot), "true");
});

test("import shadowing does not conflict", async () => {
  await request(`import { parse } from "acorn"`, projRoot);
  // 用户显式声明同名 const：词法声明遮蔽全局绑定，不报重复声明
  assert.equal(
    await request(`const parse = 42; parse`, projRoot),
    "42",
  );
  // 词法声明跨请求保留（vm 全局词法环境），绑定被遮蔽
  assert.equal(await request(`typeof parse`, projRoot), "'number'");
  // 其他导入绑定不受影响
  assert.equal(await request(`typeof spawn`, projRoot), "'function'");
});

test("named import", async () => {
  assert.equal(
    await request(`import { parse } from "acorn"; parse("1+1").body.length`, projRoot),
    "1",
  );
});

test("default import of cjs module", async () => {
  assert.equal(await request(`import acorn from "acorn"; acorn.version`, projRoot), "'8.18.0'");
});

test("renamed import", async () => {
  assert.equal(
    await request(
      `import { CookieJar as CJ } from "tough-cookie"; new CJ().constructor.name`,
      projRoot,
    ),
    "'_CookieJar'",
  );
});

test("namespace import", async () => {
  assert.equal(
    await request(`import * as tc from "tough-cookie"; tc.CookieJar !== undefined`, projRoot),
    "true",
  );
});

test("side-effect import", async () => {
  assert.equal(await request(`import "acorn"; "side-effect ok"`, projRoot), "'side-effect ok'");
});

test("import combined with top-level await", async () => {
  assert.equal(
    await request(
      `import { version } from "typescript"; await new Promise(r => setTimeout(r, 5)); version`,
      otherProj,
    ),
    "'6.0.3'",
  );
});

test("dynamic import", async () => {
  assert.equal(await request(`const m = await import("acorn"); m.version`, projRoot), "'8.18.0'");
});

test("export keyword is stripped, declaration kept", async () => {
  // export const 移去关键字后只剩 const 声明，不求值
  assert.equal(await request("export const c = 3;", projRoot), "undefined");
  // 声明仍可用；后续表达式正常求值
  assert.equal(await request("c", projRoot), "3");
  assert.equal(await request("export const x = 42; x", projRoot), "42");
});

test("export class stripped", async () => {
  assert.equal(await request(`export class C {}`, projRoot), "undefined");
  assert.equal(await request(`typeof C`, projRoot), "'function'");
});

test("export function stripped", async () => {
  assert.equal(await request(`export function f() { return 7 }`, projRoot), "undefined");
  assert.equal(await request(`f()`, projRoot), "7");
});

test("export default and bare export stripped", async () => {
  assert.equal(await request(`const a = 1
export default a`, projRoot), "undefined");
  assert.equal(await request(`export { a }`, projRoot), "undefined");
});

test("export class combined with other statements", async () => {
  assert.equal(
    await request(`export class C {}
const c = 3;`, projRoot),
    "undefined", // 最后语句是声明，不求值
  );
  assert.equal(await request(`typeof C`, projRoot), "'function'");
});

test("export function combined", async () => {
  assert.equal(
    await request(`export function f() { return 7 }
f()`, projRoot),
    "7",
  );
});

test("top-level await only", async () => {
  assert.equal(
    await request("await new Promise(r => setTimeout(r, 5)); 'tla only'", projRoot),
    "'tla only'",
  );
});

test("require loads project dependency", async () => {
  assert.equal(
    await request(`require("tough-cookie").CookieJar !== undefined`, projRoot),
    "true",
  );
});

test("require missing dependency reports error", async () => {
  const result = await request(`require("no-such-pkg-xyz")`, projRoot);
  assert.match(result, /^Error: Cannot find module/);
});

test("relative import resolves against fileDir", async () => {
  // fileDir 基准：相对路径按代码所在目录解析（含 .ts 扩展）
  assert.equal(
    await request(
      `import { VK } from "./constants"; VK`,
      projRoot,
      path.join(root, "test", "fixtures"),
    ),
    "'vk-value'",
  );
});

test("runtime error", async () => {
  assert.equal(await request("foo()", projRoot), "ReferenceError: foo is not defined");
});

test("syntax error", async () => {
  assert.match(await request("1 +", projRoot), /^SyntaxError/);
});

test("malformed json request", async () => {
  assert.match(await sendRaw("not-json"), /^请求解析失败/);
});

test("missing code field", async () => {
  assert.equal(await sendRaw('{"nope":1}'), "请求缺少 code 字段");
});

test("module console output goes through json protocol", async () => {
  assert.equal(
    await request(
      `const f = require("./test/fixtures/console-module.cjs"); f(); "ok"`,
      projRoot,
    ),
    "'ok'",
  );
  // 等异步回调输出到达（发送一个后续请求保证排队）
  await request("await new Promise(r => setTimeout(r, 50)); 'x'", projRoot);
  const consoleArgs = messages
    .filter((m) => m.type === "console")
    .map((m) => m.args ?? "");
  assert(consoleArgs.some((a) => a.includes("load time")), "load-time console missing");
  assert(consoleArgs.some((a) => a.includes("call time")), "call-time console missing");
  assert(consoleArgs.some((a) => a.includes("async time")), "async-time console missing");
});

test("unhandled rejection does not kill process", async () => {
  assert.equal(
    await request("Promise.reject(new Error('boom')); 'first'", projRoot),
    "'first'",
  );
  assert.match(stderrText, /unhandledRejection/);
  // 进程仍可用
  assert.equal(await request("1 + 1", projRoot), "2");
});
