# Lava

[![CI](https://github.com/x-ror/lava/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/x-ror/lava/actions/workflows/ci.yml)

Lava is an experimental Bun-inspired JavaScript runtime and toolkit written in
Odin. The runtime target is JavaScriptCore (JSC).

## Status

This repository is initialized with a small Odin CLI and the first package
boundaries for the runtime, package manager, bundler, and JSC integration.
Compatibility targets modern Node.js 22+ behavior rather than legacy Node APIs.

## Requirements

- Odin (CI pins `dev-2026-11a` with LLVM 18)
- JavaScriptCore development headers and libraries
- SQLite development headers and libraries (for `node:sqlite`)
- OpenSSL development headers and libraries (for `fetch` HTTPS/TLS)

On Linux, the JSC package is exposed through `pkg-config` as `javascriptcoregtk-6.0`,
SQLite as `sqlite3`, and OpenSSL as `openssl`
(e.g. `apt-get install libjavascriptcoregtk-6.0-dev libsqlite3-dev libssl-dev`).

On macOS, JSC is provided by the `JavaScriptCore` framework and SQLite by the
system `libsqlite3`; OpenSSL comes from Homebrew (`brew install openssl@3`) and
`scripts/build.sh` adds its keg-only lib path to the link line.

On Windows, Lava keeps third-party native payloads out of git. Run
`make bootstrap-windows-deps` (or `bash scripts/bootstrap-windows-deps.sh`) to
fetch JavaScriptCore/WebKit and the SQLite amalgamation into the ignored `.deps/`
cache. `scripts/build-sqlite-windows.sh` then compiles SQLite into
`build/sqlite3.lib`; WebKit is linked from `.deps/webkit/bun-webkit/lib`.

Node 24 (`24.22.2` pinned in [`.nvmrc`](.nvmrc); oracle suites require Node 24) and Bun are needed for the JavaScript gates — run `bun install` once.
They are dev-only (`markdownlint-cli2`, `acorn`/`acorn-walk` for the
prototype-pollution ratchet, `fast-check` for `make test-property`); `bin/lava`
links none of them. `make check-js` is an always-gate and now fails without them.

## Build

```sh
make build
```

Run it:

```sh
make eval SOURCE="console.log('hello from Lava')"
make run FILE=app.js
```

Useful project commands:

```sh
make help
make bootstrap-windows-deps
make check
make check-jsc
make check-native
make test
make test-lava
make test-sqlite-node
make test-sqlite-lava
```

## Layout

- `cmd/lava` - command line entry point
- `pkg/runtime` - JavaScript runtime orchestration
- `pkg/runtime/eventloop` - native event-loop abstraction using io_uring/epoll on Linux
- `pkg/jsc` - JavaScriptCore foreign declarations
- `pkg/std/sqlite` - first modern standard-library target
- `pkg/bundler` - future bundling/transpilation work
- `pkg/install` - future package install and lockfile work
- `scripts` - project helper scripts

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit
together (engine FFI, event loop, module system, the native + embedded-JS
standard library), a review of risks and inconsistencies, and the forward-looking
roadmap toward a best-in-class runtime.

## Roadmap

1. Link JSC and evaluate source through `JSEvaluateScript`.
2. Add module loading and a small CommonJS/ESM compatibility layer.
3. Implement `lava run <file>`.
4. Add package install, lockfile, and cache primitives.
5. Add bundling and TypeScript/JSX transform support.
