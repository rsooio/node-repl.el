# node-repl.el

[English](README.md) | [中文](README.zh-CN.md)

Project-level Node.js REPL for Emacs: one REPL instance per project (identified
by package.json), modeled after eglot. Evaluate JS/TS code from your buffers
into a persistent Node vm context, with results shown as a REPL transcript.

## Features

- **One instance per project**: instances are self-contained and looked up by
  project root; buffer association is cached buffer-locally
- **TypeScript/TSX**: TS types stripped natively by Node (>= 23.6), module
  syntax (import/export/dynamic import/JSX) transpiled by sucrase
- **Top-level await** supported in evaluated code
- **State persists across requests**: variables, classes and imported bindings
  survive between evaluations
- **Hot class reload**: redefining a class in the REPL updates existing
  instances immediately (methods, statics, fields, constructor logic, extends)
- **Per-project dependencies**: code can `require()` the project's own
  node_modules via an injected `createRequire`
- **console output integrated**: `console.log`/`console.error` etc. from
  evaluated code and required modules appear in the transcript
- **C-M-x** bound to `node-repl-eval` in js/ts treesit major modes while a
  REPL is running

## Requirements

- Emacs 30 (js/ts treesit modes)
- Node.js >= 23.6 (native TS type stripping)
- [pnpm](https://pnpm.io/) (or npm) to install the REPL's own dependencies

## Installation

Install from git with `use-package` + `:vc`:

```elisp
(use-package node-repl
  :vc (:url "https://github.com/rsooio/node-repl.el"))
```

The package ships the complete repository (including `repl.ts` and its
`package.json`). After installation, install the REPL server's dependencies
inside the package directory once:

```sh
cd ~/.emacs.d/elpa/node-repl-*/ && pnpm install
```

`node-repl.el` locates `repl.ts` next to itself automatically; override with
`node-repl-script-path` if you keep a development checkout elsewhere:

```elisp
(use-package node-repl
  :vc (:url "https://github.com/rsooio/node-repl.el")
  :custom
  (node-repl-script-path "/path/to/node-repl/repl.ts"))
```

## Usage

| Command | Description |
|---|---|
| `M-x node-repl-ensure` | Start the REPL for the current project (asks to restart if already running) |
| `M-x node-repl-shutdown` | Shut down the REPL of the current project |
| `C-M-x` (`node-repl-eval`) | Evaluate the top-level JS/TS node at point, or the active region |

Evaluation output is shown as a transcript in the `*node-repl: <package>*`
buffer:

```
> 1 + 1
=> 2

> import { parse } from "acorn"; parse("1+1").body.length
=> 1
```

## Customization

- `node-repl-node-command`: node executable name or path (default `"node"`)
- `node-repl-script-path`: path to the REPL entry script `repl.ts`

## How it works

The Emacs side drives a Node subprocess over JSONL on stdin/stdout:

- Request: one JSON line `{"code": "...", "cwd": "<project root>", "fileDir": "<file directory>"}`
- Response: one JSON line `{"type": "result", "result": "..."}` or
  `{"type": "console", "method": "log", "args": [...]}`

The server (`repl.ts`) keeps a vm context across requests. Each request is
transpiled (TS types stripped, import/export rewritten to CJS), wrapped in an
async IIFE (allowing top-level await) and evaluated serially in the shared
context. Relative imports resolve against `fileDir`; project dependencies are
available through an injected `createRequire`. The REPL process is restarted
per project; restarting Emacs or shutting the REPL down discards all state.

## Development

Run the test suites:

```sh
pnpm test:repl   # node --test test/repl.test.ts (server protocol)
pnpm test:el     # emacs --batch -Q -l test/node-repl.test.el (Elisp integration)
pnpm test        # both
```

## License

GPLv3, see [LICENSE](LICENSE).
