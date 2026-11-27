# Larva

[![CI](https://github.com/x-ror/larva/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/x-ror/larva/actions/workflows/ci.yml)

Larva is a lightweight headless browser engine (HTML + DOM + JavaScriptCore,
no rendering) built on the Lava runtime. See [`docs/LARVA.md`](docs/LARVA.md)
for the goals, architecture decisions and roadmap.

The browser layer is at an early stage: the per-thread JSC VM pool is in the tree,
while the page lifecycle, the network stack with client profiles, the HTML parser
and the DOM are not. The roadmap table in `docs/LARVA.md` carries the status of each
stage. What builds and runs today is the Lava runtime below.

## Runtime Base (Lava)

The underlying runtime is written in Odin on top of JavaScriptCore (JSC),
providing the event loop, native I/O transports, and core Web APIs (`fetch`,
`URL`, Web Streams, timers). `lava run` and `lava eval` run a classic script with
the Window globals only — the Node profile (`require`, `process`, `Buffer`,
`node:*` modules) is gone. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for how the runtime pieces fit together.

## Requirements

- Odin at the commit pinned in [`.odin-version`](.odin-version) (LLVM 18); `make env`
  shows whether your compiler and SDK checkout match it
- JavaScriptCore development headers and libraries
- SQLite development headers and libraries (for `pkg/std/sqlite`'s own tests; nothing
  else links SQLite)
- OpenSSL development headers and libraries (for `fetch` HTTPS/TLS). The roadmap
  replaces it with BoringSSL (stage 2); until that lands, OpenSSL is what links.
- zlib, brotli (`libbrotlidec`) and zstd development headers and libraries (Linux):
  `pkg/http` decodes gzip, deflate, br and zstd response bodies through them.
- `cmake`, `git` and network access on the first build (Linux): `pkg/html` links
  [lexbor](https://github.com/lexbor/lexbor), which `scripts/build-lexbor.sh` fetches
  at a pinned commit, checks by its commit id and builds into `.deps/`.

On Linux, the JSC package is exposed through `pkg-config` as `javascriptcoregtk-6.0`,
SQLite as `sqlite3`, OpenSSL as `openssl`, and the decoders as `zlib`, `libbrotlidec`
and `libzstd`
(e.g. `apt-get install libjavascriptcoregtk-6.0-dev libsqlite3-dev libssl-dev libbrotli-dev
libzstd-dev zlib1g-dev`).

On macOS, JSC is provided by the `JavaScriptCore` framework and SQLite by the
system `libsqlite3`; OpenSSL comes from Homebrew (`brew install openssl@3`) and
`scripts/build.sh` adds its keg-only lib path to the link line.

On Windows, Lava keeps third-party native payloads out of git. Run
`make bootstrap-windows-deps` (or `bash scripts/bootstrap-windows-deps.sh`) to
fetch JavaScriptCore/WebKit and the SQLite amalgamation into the ignored `.deps/`
cache. `scripts/build-sqlite-windows.sh` then compiles SQLite into
`build/sqlite3.lib`; WebKit is linked from `.deps/webkit/bun-webkit/lib`.

Node 26+ (`26.13.0` pinned in [`.nvmrc`](.nvmrc)) and Bun are needed for the JavaScript gates and the oracle runners — run `bun install` once.
They are dev-only (`markdownlint-cli2`, `acorn`/`acorn-walk` for the
prototype-pollution ratchet); `bin/lava`
links none of them. `make check-js` is an always-gate and now fails without them.

## Build

```sh
make build
```

Run it:

```sh
make eval SOURCE="console.log('hello from Lava')"
make run FILE=page.js
```

Useful project commands:

```sh
make help
make bootstrap-windows-deps
make check
make check-jsc
make check-native
make test
make test-web
make test-dom
make test-sqlite-odin
make check-js
make check-md
make test-mutation
make bench
```

## Layout

- `cmd/lava` - command line entry point, and the Lava-only Odin tests
- `pkg/runtime` - JavaScript runtime orchestration and native primitives
- `pkg/runtime/js` - embedded JavaScript: `Buffer`, `fetch`, streams, `URL`
- `pkg/runtime/eventloop` - native event-loop abstraction using io_uring/epoll on Linux
- `pkg/jsc` - JavaScriptCore foreign declarations and the private-ABI probes
- `pkg/std/sqlite` - SQLite bindings (kept for storage; nothing links them yet)
- `tests` - Chrome-recorded oracle suites (`web`, `dom`), the stdio write test and
  the mutation manifest
- `bench` - node-vs-Lava benchmarks, and `bench/jsc-vm` for JSC VM costs
- `runtime/gates` - gate integrity checks and the oracle case-count assertions
- `scripts` - build, check and test-runner scripts
- `agents` - review playbooks and specialist definitions
- `docs` - `LARVA.md` (goals and roadmap), `ARCHITECTURE.md` (the runtime),
  `GLOBAL-STATE.md` (page-isolation audit), `lava/` (I/O design notes)

## License

Larva is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`). If you modify Larva and let others use it over a network, the
AGPL requires you to offer them the source of your modified version.

A commercial licence is available for teams that cannot meet those terms, and it
is also how the separately distributed extension modules are licensed. Contact the
maintainer through the GitHub profile that owns this repository.

Third-party code and the licences of linked libraries are listed in
[NOTICE](NOTICE). Contributions are accepted under the terms in
[CONTRIBUTING.md](CONTRIBUTING.md).
