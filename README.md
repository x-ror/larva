# Larva

Larva is a lightweight headless browser engine (HTML + DOM + JavaScriptCore,
no rendering) built on the Lava runtime. See [`docs/LARVA.md`](docs/LARVA.md)
for the goals, architecture decisions and roadmap.

## Runtime Base (Lava)

The underlying runtime is written in Odin on top of JavaScriptCore (JSC),
providing the event loop, native I/O transports, and core Web APIs (`fetch`,
`URL`, Web Streams, timers). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for how the runtime pieces fit together.

## Requirements

- Odin
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

Node 24+ and Bun are needed for the JavaScript gates — run `bun install` once.
They are dev-only (`vite-plus`, `markdownlint-cli2`, `acorn`/`acorn-walk` for the
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
- `pkg/std/sqlite` - SQLite bindings
- `scripts` - project helper scripts
