# node-repl.el

[English](README.md) | [中文](README.zh-CN.md)

面向项目的 Node.js REPL（Emacs）：每个项目（以 package.json 标识）一个独立 REPL 实例，
模型与 eglot 一致。在 buffer 中求值 JS/TS 代码到持久的 Node vm context，结果以
REPL transcript 形式展示。

## 特性

- **每项目一实例**：实例自包含，按项目根查找；buffer 关联采用 buffer-local 缓存
- **TypeScript/TSX**：TS 类型由 Node（>= 23.6）原生擦除，模块语法
  （import/export/动态 import/JSX）经 sucrase 转译
- **支持顶层 await** 的代码求值
- **跨请求状态持久**：变量、类、导入绑定在多次求值之间保留
- **类热更新**：在 REPL 中重定义类时，已有实例立即生效
  （方法、静态成员、字段、构造逻辑、extends 均同步）
- **项目依赖可用**：代码可通过注入的 `createRequire` 加载项目自身的 node_modules
- **console 输出集成**：求值代码及 require 模块的 `console.log`/`console.error`
  等输出显示在 transcript 中
- **C-M-x** 在 js/ts treesit major mode 中绑定到 `node-repl-eval`（REPL 运行期间）

## 环境要求

- Emacs 30（js/ts treesit major mode）
- Node.js >= 23.6（原生 TS 类型擦除）
- [pnpm](https://pnpm.io/)（或 npm）用于安装 REPL 自身的依赖

## 安装

通过 `use-package` + `:vc` 从 git 安装：

```elisp
(use-package node-repl
  :vc (:url "https://github.com/rsooio/node-repl.el"))
```

包内包含完整仓库（含 `repl.ts` 与 `package.json`）。安装后需在包目录内
安装一次 REPL 服务端依赖：

```sh
cd ~/.emacs.d/elpa/node-repl-*/ && pnpm install
```

`node-repl.el` 自动定位同目录下的 `repl.ts`；若在其他位置保留开发副本，
可用 `node-repl-script-path` 覆盖：

```elisp
(use-package node-repl
  :vc (:url "https://github.com/rsooio/node-repl.el")
  :custom
  (node-repl-script-path "/path/to/node-repl/repl.ts"))
```

## 使用

| 命令 | 说明 |
|---|---|
| `M-x node-repl-ensure` | 启动当前项目的 REPL（已运行时询问是否重启） |
| `M-x node-repl-shutdown` | 停止当前项目的 REPL |
| `C-M-x`（`node-repl-eval`） | 求值光标所在 JS/TS 文件顶层节点，或活动选区 |

求值输出以 transcript 形式显示在 `*node-repl: <包名>*` buffer 中：

```
> 1 + 1
=> 2

> import { parse } from "acorn"; parse("1+1").body.length
=> 1
```

## 配置项

- `node-repl-node-command`：node 可执行文件名或路径（默认 `"node"`）
- `node-repl-script-path`：REPL 入口脚本 `repl.ts` 的路径

## 工作原理

Emacs 侧通过 stdin/stdout 上的 JSONL 协议驱动 Node 子进程：

- 请求：一行 JSON `{"code": "...", "cwd": "<项目根>", "fileDir": "<文件所在目录>"}`
- 响应：一行 JSON `{"type": "result", "result": "..."}` 或
  `{"type": "console", "method": "log", "args": [...]}`

服务端（`repl.ts`）在多个请求之间保留 vm context。每个请求先转译
（擦除 TS 类型、import/export 改写为 CJS），包装进 async IIFE（支持顶层
await），再串行求值于共享 context 中。相对导入按 `fileDir` 解析；项目依赖
通过注入的 `createRequire` 加载。每个项目独立 REPL 进程；重启 Emacs 或
停止 REPL 会丢弃全部状态。

## 开发

运行测试套件：

```sh
pnpm test:repl   # node --test test/repl.test.ts（服务端协议）
pnpm test:el     # emacs --batch -Q -l test/node-repl.test.el（Elisp 集成）
pnpm test        # 两者
```

## License

GPLv3，见 [LICENSE](LICENSE)。
