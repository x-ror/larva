# Lava Runtime Architecture

> Architectural overview of the underlying Lava runtime that Larva builds on.
> Companion to [`docs/LARVA.md`](LARVA.md) (headless browser architecture and
> roadmap) and [`README.md`](../README.md) (how to build and run).

---

## 1. What Lava is

Lava is a Node-compatible JavaScript runtime built on **JavaScriptCore (JSC)** as
the execution engine and **Odin** as the systems language for everything around
it: the engine FFI, the event loop, the I/O transports, and the native half of
the standard library. Compatibility targets modern Node (26+ behavior, floor pinned in `.nvmrc`) rather
than legacy APIs.

Two design decisions shape the whole system:

1. **JSC is the VM; Odin owns the runtime.** Lava does not embed V8 or write its
   own interpreter. It drives JSC through its C API and builds the _runtime_ — the
   event loop, module system, timers, I/O, process model — natively in Odin.
2. **The standard library is layered: native primitives + embedded JS.** Hot or
   unsafe operations (byte codecs, hashing, sockets, the loop) live in Odin; the
   ergonomic, spec-shaped surface (`Buffer`, `fetch`, Web Streams, `URL`,
   `console`) is JavaScript embedded into the binary at compile time and wired up
   by a small loader. See §3.3.

---

## 2. System overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│  cmd/lava (CLI)                          main.odin                     │
│  parses argv → builds an eventloop.Loop → calls runtime.eval/run_file  │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │
┌───────────────────────────────▼──────────────────────────────────────┐
│  pkg/runtime  (orchestration)                                          │
│                                                                        │
│   runtime.odin      eval(): one page run to completion                 │
│   page.odin         page open/tick/close: context lifecycle, drains    │
│   page_runner.odin  many pages (VM + loop each) on one thread          │
│   page_dispatcher   pages over N threads, one page runner per thread   │
│   globals.odin      global surface, Runtime_State, JS↔loop callbacks   │
│   require.odin      CommonJS loader (cache, .js/.cjs/.mjs/.json)        │
│   module_resolution native resolver (file/dir/node_modules/main)       │
│   fs / buffer / crypto / dns / sqlite / fetch*  native primitives      │
│                                                                        │
│   js/node/**.js     public builtins; path == specifier (stream/web)    │
│   js/internal/*.js  helpers only builtins may require (primordials, …) │
│   js/bootstrap/*.js loader, microtasks, esm transform, console prelude │
└───────────────┬───────────────────────────────────┬──────────────────┘
                │                                     │
┌───────────────▼─────────────┐      ┌────────────────▼─────────────────┐
│  pkg/jsc  (engine FFI)       │      │  pkg/runtime/eventloop            │
│   bindings_{linux,darwin,    │      │   loop.odin   phases, timers,     │
│     windows}.odin            │      │     microtasks, async handoff     │
│   jsc_init* (Windows bring-  │      │   loop_{linux,darwin,windows}     │
│     up + locked typed-array) │      │     io_uring/epoll · kqueue · IOCP│
└──────────────────────────────┘      └───────────────────────────────────┘
```

---

## 3. Component architecture

### 3.1 The event loop (`pkg/runtime/eventloop`)

The strongest part of the system, and the right thing to have gotten right first.

- **Node-faithful phases.** `run_once` (`loop.odin`) runs the canonical order:
  next-tick → microtasks → timers → poll (I/O completions, then block) → check
  (`setImmediate`) → close. Each phase uses a _sequence limit_ so callbacks queued
  _during_ a phase defer to the next iteration — this is what makes ordering
  deterministic and matchable against Node.
- **Timers are a binary min-heap** keyed on `(due_ms, seq)` (`timer_heap_*`), so
  ties fire in FIFO order (Node parity) and push/pop are O(log n). Cancelled
  timers are dropped lazily at the root rather than compacted every tick.
- **Two clocks.** `real_time` mode tracks the monotonic wall clock; the default
  (used by tests) advances a _logical_ clock explicitly, enabling deterministic
  scheduling tests.
- **Cross-thread completion handoff** mirrors libuv's `uv_async`:
  `async_begin`/`post_async`/`drain_async` (`loop.odin`) let an off-loop
  worker enqueue a completion under a mutex and wake the loop, which drains it on
  its own thread. `active_async` keeps the loop alive and blocked in `poll` until
  the worker finishes. This primitive backs the generic worker pool
  (`threadpool.odin`) and DNS resolution.
- **Lifecycle accounting is meticulous.** `watched`/`active_io_count`,
  `reffed_timer_count`, and the `Dispose` hook contract (declared at the top of
  `loop.odin`) ensure a
  handle's GC-protected binding is released exactly once — on fire or on
  cancellation, never both, never neither.

### 3.2 Engine FFI (`pkg/jsc`)

Thin, per-platform `foreign` declarations of JSC's C API. Highlights:

- The global object is created from a custom `LavaGlobal` JSClass whose private
  slot stores `Runtime_State` (`make_global_class`, `globals.odin`), so the loop pointer and module
  cache are **unreachable from user JavaScript** — no writable `__loop_ptr__`.
- `jsc_init.odin` carries a Windows-only bring-up shim (`JSC::initialize` +
  disabling a broken baseline-JIT tier in the bun-webkit build) and a
  `make_uint8_nocopy_locked` helper that enters the VM lock when creating typed
  arrays from outside a JSC callback (e.g. the fetch streaming body driven from the
  loop). Both are no-ops on Linux/macOS — a clean conditional-compilation pattern.

- Natives are registered through a per-thread host-call registry
  (`pkg/runtime/host_natives.odin`) keyed by `{context pointer, callback, name}`
  and dispatched off the call frame's callee slot. JSC hands the _same_ address
  to a later `JSGlobalContextCreate`, so every entry for a context is dropped in
  `destroy_runtime_state` while that context is still alive; a surviving entry
  resolves a binding to an object in a dead VM. The tables are thread-lived, so
  their backing is bound to a process-lifetime allocator explicitly rather than
  adopting the caller's.

- That registry **fails closed**. A dispatch miss means our own tables are
  inconsistent, and several natives write through a caller-supplied buffer and
  signal nothing on return (`crypto.randomFill` into a zeroed `Buffer.alloc`), so
  answering `undefined` would forge a correct-looking result rather than merely
  fail. The miss raises through `jsc.host_throw` instead, and every native signals
  failure the same way — by setting `exception^`, never by its return value —
  with two audited exceptions recorded at the dispatcher comment in
  `host_natives.odin`: `net.write` returns a backpressure bool (not a failure
  signal), and `crypto.randomFill` returns the view it filled, which `internal/crypto/random.js`
  identity-checks as its second fail-closed layer.

- The host-call path itself is reached by `dlsym`ing a C++ mangled symbol
  (`pkg/jsc/host_function.odin`), so it can vanish under a JSC upgrade; callers
  then fall back to `JSObjectMakeFunctionWithCallback`. The two are **not**
  observably identical (`.length`, constructibility — see `inject_native_function`),
  so `LAVA_HOSTFN_DISABLE=1` forces the fallback and `make test-lava-nohostfn` runs
  every oracle suite through it, the same way `LAVA_NET_FORCE_READINESS` covers the
  second I/O backend.

### 3.3 Standard library: native + embedded JS

Built-ins are JS factories embedded at compile time and instantiated by
`js/bootstrap/loader.js`. A factory's source is evaluated on its module's first
require, through a native `compile(id)` (`builtin_compile_cb`) the loader keeps in its
closure, not at context init: only the eager closure (13 of 39 files) is compiled before
user code, which took `bench/micro/noop.js` from 16.85 to 14.63 ms (median of 50
interleaved spawn-to-exit runs per arm, darwin arm64, `-o:speed`). The directory
layout under `pkg/runtime/js` is the module table — there is no second list of files:

| Directory    | Holds                                    | Module id / visibility                                               |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| `node/`      | every module user code may `require`     | `node/<specifier>`; file path == specifier (`node/stream/web.js`)    |
| `internal/`  | helpers (`primordials`, `fetch`, `mime`) | `internal/<name>`; only the factories' own `require` reaches them    |
| `bootstrap/` | loader, microtasks, `esm.js`, console    | not modules — evaluated standalone by Odin through explicit `#load`s |

`globals.odin` embeds each module directory whole with `#load_directory`
(`EMBEDDED_JS_DIRS`, one row per directory because the directive is not recursive) and
derives the id and the JSC source name from directory + basename: stack frames read
`node:buffer`, `node:stream/web`, `node:internal/encoding`. The public resolver answers
`node/` ids only, so the directory a file lives in decides whether user code can reach
it; `scripts/check-js-graph.mjs` (`make check-js`) fails on an unembedded directory, an
unresolvable or non-literal `require`, an unreachable file, or a top-level require
cycle. Each factory receives `(require, module, exports,
native)`; the native fourth argument carries Odin-backed bindings (crypto, buffer,
fetch, sqlite, dns, fs, net, http(s), os, tty, stdio — twelve today, see
`install_internal_modules`) so **nothing transient lands on `globalThis`**
(`install_internal_modules`, `globals.odin`). This is an elegant boundary:
the spec surface is readable JS, the sharp edges are native, and the seam is one
well-defined argument.

A second, JS-side channel hangs off the loader's **internal** resolver. `loader.js`
snapshots the pristine `Buffer` operations right after it eager-instantiates `buffer` and
attaches them to the `req` it passes each factory, so an internal module reads them as
`require.pristineBuffer`. This is NOT public API: the property lives on `req`, never on the
`publicReq` that `native_require_cb` consults, so user code's `require.pristineBuffer` is
`undefined` (verified) and cannot read or overwrite the table.
It exists because a LAZY module's own `require('buffer').Buffer` runs on the user's first
require of that module — after user code, and therefore steerable (#333). `fs`, `http`,
`https`, `net` and `os` take it; `stream` and `stdio` do not need it because `installStdio`
instantiates them during bootstrap — and with them every `internal/streams/*` file `stream`
requires at its top level. `internal/webstreams/adapters` is the exception: `Readable`/
`Writable.fromWeb`/`toWeb` require it on first call (it requires `readable`/`writable` back
at its own top level, so the late edge is what keeps the graph acyclic), as node does.
`internal/blob` is eager yet takes it too, at call time: `buffer` requires it from its own
factory, before the table exists, and a top-level `require('buffer')` back would be a cycle.

The JS layer is substantial and high quality: URL (~2400 across `node/url.js`,
`internal/url.js` and `internal/{idna,punycode}.js`, WHATWG URL),
Web Streams (~2100 across `internal/webstreams/`), buffer (~1530 across `node/buffer.js` and
`internal/buffer.js`; `Blob`, `File` and the `blob:` URL registry live in `internal/blob.js`
and `internal/file.js`, as in node's `lib/internal`), fetch
(~1160 across `internal/fetch.js` and `internal/fetch/`), crypto (~1070 across `node/crypto.js`
and `internal/crypto/`). `node/stream.js` only assembles the public module; the classic
streams live in `internal/streams/` (`legacy`, `readable`, `writable`, `duplex`,
`transform`, `passthrough`, `destroy`, `add-abort-signal`, `end-of-stream`, `pipeline`,
`utils`) and the Web Streams bridges in `internal/webstreams/adapters.js`, the files node
keeps them in, so their frames read `node:internal/streams/readable`. `node/http.js` is
likewise only the public entry (and `createServer`): the server lives in `internal/http/`
(`common`, `incoming`, `outgoing`, `server`), split the way node splits `_http_common`,
`_http_incoming`, `_http_outgoing` and `_http_server`. Unlike streams the names differ from
node's — node publishes `require('_http_server')` and friends with a parser/agent surface
Lava does not have, so a public file under that name would answer with the wrong keys —
and frames read `node:internal/http/server` where node's read `node:_http_server`. Odin
keys the http bindings by `node/http` only, so `loader.js` aliases that one object to
`internal/http/outgoing` and `internal/http/server`. `node/stream/web.js` similarly
only assembles exports and installs the globals; the implementation is in
`internal/webstreams/` (`util`, `queuingstrategies`, `readablestream` — with tee, async
iteration and pipeTo, as in node — `writablestream`, `transformstream`), all eager through
`stream/web` and acyclic: `readablestream` requires `writablestream`, `transformstream`
requires both, nothing requires back. Fetch follows undici's `lib/web/fetch` seams:
`internal/fetch/headers`, `body` (the Body mixin plus the byte and transport-stream
helpers), `request` and `response` (each requiring `headers` and `body`), while
`internal/fetch` keeps the driver — body collection, redirects, the hand-off to
`native.request` — because the loader keys natives by module id, and installs the globals.
All five are eager through `internal/fetch`. Crypto follows node's `lib/internal/crypto`
seams, so its frames read `node:internal/crypto/pbkdf2` exactly as node's do:
`internal/crypto/util` (validators, byte coercion, the digest table and `getHashes`),
`hash` (`Hash`, `Hmac`, one-shot `hash`), `random`, `pbkdf2`, `hkdf` and `scrypt`, each
requiring only `util`. `node/crypto` keeps `createHash`/`createHmac` and `timingSafeEqual`
where node's `lib/crypto.js` has them, assembles the exports in their old order and
installs `globalThis.crypto`; the five files that call into Odin get the `node/crypto`
bindings through the same `loader.js` aliasing as http. All seven are eager through the one
`req('crypto')` root. Util follows node's `lib/internal/util` seams the same way:
`internal/util/inspect` (`inspect`, `format`/`formatWithOptions`,
`stripVTControlCharacters`, the `inspect.colors` table), `internal/util/comparisons`
(`isDeepStrictEqual`), `internal/util/debuglog` (requiring `inspect` for its formatting)
and `internal/util` (`promisify`, `deprecate`). `node/util` keeps `callbackify`,
`inherits`, `styleText` and `toUSVString` where node's `lib/util.js` has them, plus
`aborted`, and assembles the exports in their old order. Util calls no native, so there
is no alias, and every file stays lazy behind `require('util')`. Buffer takes node's one
seam: `internal/buffer` holds the encoding codecs (`normalizeEncoding`, `strToBytes`,
`bytesToString`) and `addBufferPrototypeMethods`, which installs the fixed-width
`read*`/`write*` accessors and the per-encoding `*Slice`/`*Write` aliases, so a bounds
error frames `node:internal/buffer` as node's does. `node/buffer` keeps the constructor,
the statics, the pool, the `lib/buffer.js` prototype methods and `atob`/`btoa`, calls the
installer where those methods were always assigned (the prototype's key order is
unchanged), and captures the codecs once at module-eval, so a `toString` pays the same
closure call as before. `internal/buffer` decodes through `node/buffer`'s bindings via the
same `loader.js` aliasing, and is eager through `req('buffer')`. `os` moves only its
data: `internal/os/constants` holds the signal, errno, priority and dlopen tables, which
node reads from its C++ constants binding rather than `lib/os.js`. The tables throw
nothing, so no frame moves; they call no native, so there is no alias, and the file stays
lazy behind `require('os')`. URL takes node's `lib/internal/url` seam: `internal/url` holds
the URL Standard parser, `URL`, `URLSearchParams`, `fileURLToPath`, `urlToHttpOptions` and
`domainToASCII`/`domainToUnicode`, so an invalid URL or a bad `fileURLToPath` argument frames
`node:internal/url` as node's does. `node/url` keeps `pathToFileURL` and `format`, which
node's `lib/url.js` defines and frames in `node:url`, installs the `URL`/`URLSearchParams`
globals (after `buffer`, keeping its object-URL statics) and assembles the exports in their
old order, borrowing the record slot, the path serializer and the Punycode decoder for
`format`. Url calls no native, so there is no alias; `internal/url` is eager through
`req('url')`, which keeps its module-eval captures pristine. The IDNA step takes node's
`lib/internal/idna` seam: `internal/idna` (separator fold, UTS-46 approximation) and the
`internal/punycode` codec under it return failure values instead of throwing, so the host
parser and every throw it feeds stay in `internal/url` and no frame moves; both are eager
through `internal/url`'s top-level require, and `internal/url` captures their functions at
module-eval, so the parse path gains no call layer. `internal/punycode` is not node's public
`punycode` (`node/punycode.js`, the userland punycode.js surface). Errors use Node-shaped
coded errors (`ERR_INVALID_ARG_TYPE`,
`ERR_OUT_OF_RANGE`, …), built in one place: `js/internal/errors.js` (eager, hardened)
holds node's `determineSpecificType`, `ERR_INVALID_ARG_TYPE`/`_VALUE`, `ERR_OUT_OF_RANGE`,
`ERR_MISSING_ARGS`, `ERR_UNKNOWN_ENCODING`, and two constructors for node's two shapes —
`nodeError` (node's JS layer: `String(e)` is `TypeError [ERR_X]: msg`) and `nativeError`
(node's C++ layer: `TypeError: msg`). A builtin requires it rather than keeping a local
copy; per-module message templates call `nodeError`/`nativeError` with their own text.
Native byte ops are gated by a size threshold
so small inputs avoid FFI overhead — except that the threshold this sentence used to
name (`NATIVE_BYTEOP_MIN`) does not exist in the tree: `bytesToString` dispatches to a
native codec at every size. Removed rather than left as folklore steering review.

### 3.4 Module system (`require.odin`, `module_resolution.odin`)

- CommonJS is the substrate. `native_require_cb` consults, in order: the module
  cache → JS internal builtins (`require_builtin`) → filesystem resolution.
  `node:fs` used to sit between the last two as a natively-assembled object, the one
  built-in with no JS layer; it is now an ordinary internal builtin
  (`js/node/fs.js` over `make_fs_bindings`). Nothing may rebuild it in
  `native_require_cb`: `require_builtin` runs first, so a second construction would be
  dead code silently disagreeing with the live one. Circular requires terminate via a pre-registered partial-exports
  entry (`__lava_precache`), and a module that throws while loading is _removed_
  from the cache so a later require re-runs it (Node parity).
- `.mjs`/static `import`/`export` are handled by a **source transform**
  (`js/bootstrap/esm.js`) that rewrites ESM onto the CommonJS `require`, not by JSC's native
  module records (the classic C API only runs script-goal source). This is
  pragmatic and works, with documented divergences (named imports from CJS).
  Its output is _executed source_, which is why it is the one internal file the
  runtime hands `primordials` as a factory argument: it lives in `bootstrap/`, which
  no `#load_directory` reads, so it is never a requireable module (user code cannot
  reach the transform),
  and that also denies it a `require`, so `loader.js` exposes the already-built
  table on the resolver object and `globals.odin` passes it in — failing closed if
  it is absent, since a forged match group here is code injection into the module
  body rather than a wrong answer.
- Resolution (`module_resolution.odin`) covers file probes, directory `main`/
  `index`, and `node_modules` walking. **`package.json` `"exports"` conditional
  resolution is not yet implemented** — a real gap for modern packages.

### 3.4.1 Global surfaces (`Global_Surface`, `runtime.odin`)

`eval` takes a trailing `surface` (default `.Node`), threaded through
`setup_module_environment` into `install_globals`. `.Node` is everything `lava run`
exposes; `run_file` and the CLI never select anything else. `.Web` is for an embedder
that runs untrusted web-platform code: the context keeps fetch, URL, the Web Streams
family, TextEncoder/TextDecoder, Blob/File, AbortController, structuredClone,
atob/btoa, crypto, performance, console, queueMicrotask and the four timer functions,
while `process`, `require`, `module`, `exports`, `__filename`, `__dirname`, `Buffer`,
`global`, `setImmediate`/`clearImmediate` and every `__lava*` hook are unreachable by
name. The bootstrap still needs some of those names while it runs, so `.Web` works in
three groups:

1. **Never injected** — the CommonJS entry bindings (`__filename`, `__dirname`,
   `require`, `__lava_precache`, `module`, `exports`) and the top-level drain's
   `__lavaDrainNextTicks`/`__lava_tl_drain`. Builtins get `require` as a factory
   argument, and native dispatch drains nextTicks through `Runtime_State`, so nothing
   internal reads them. `eval` appends no top-level drain and registers no entry module;
   an `.mjs` source is `Invalid_Input`, since the ESM transform emits `require`.
2. **Not installed** — `install_stdio`. `internal/stdio` and the node-streams stack it
   pulls in are never compiled; `console` writes through its own native writer.
3. **Installed, then removed** as the last step before user code — `process`,
   `Buffer`, `setImmediate`, `clearImmediate`, `global`. The loader hands `process` to
   `node:process`, `microtasks.js` installs `nextTick` on it, and the eager modules
   capture at module-eval.

`.Web` promises only that the names are gone: web APIs still hand out Node-shaped
values (Buffer-backed bytes, `ERR_*` codes), so `Buffer` stays reachable through a
value's `.constructor`. Pinned by `cmd/lava/global_surface_test.odin`.

### 3.5 I/O transports (`fetch_*`, `dns.odin`, `tls.odin`)

`fetch_transport.odin` is a platform-agnostic connect→[TLS]→write→read state
machine; each platform supplies only narrow socket primitives, and TLS is a
swappable backend (OpenSSL, or a rejecting stub). DNS — `fetch`'s and `node:dns`'s
— resolves off-loop on the loop's own 4-worker pool (`threadpool.odin`). Streaming request _and_ response bodies are real
incremental `ReadableStream`s with backpressure. This is the second-strongest
subsystem after the loop, and it validates the `post_async` design end to end.

### 3.6 HTML parser (`pkg/html`)

An incremental parser over [lexbor](https://github.com/lexbor/lexbor) (Apache-2.0,
pinned commit, built from source into `.deps/` by `scripts/build-lexbor.sh`). lexbor
stays behind the package: its bindings (`lexbor.odin`) are private, and callers see
`Parser` and `Node` only (docs/LARVA.md, decision 4). Linux only for now; elsewhere
`init` fails with a message (`lexbor_other.odin`).

The contract a page loader builds on is the pause. `pump` parses until the next
parser-blocking script and returns it with the tree holding exactly what precedes it,
as a browser's parser would. lexbor has no pause and no `document.write`, and needs
neither:

- the caller holds the input, and `cut.odin` cuts it so that a slice never runs past a
  `</script` end tag's `>` (quoted attribute values skipped, as the tokenizer does);
- the C shim (`shim/larva_html.c`) wraps lexbor's token callback and records which
  script element an end tag closed, so a `</script>` inside a comment or a JS string
  does not pause. More than one script closing in a slice is a failure, never a
  dropped script;
- `write` puts `document.write` text at the insertion point, after earlier writes and
  before the rest of the input; scripts in it pause in turn.

The cut scan resumes where it stopped and the consumed input is compacted only once
it is half the buffer, so feeding a page in many small reads stays linear. One
unterminated `</script` holds back at most 4 KiB (`END_TAG_MAX`).

CSS selectors (`select.odin`) use lexbor's selector engine with querySelectorAll
semantics: descendants of the root only, tree order, each node once however many
selectors of a list it matches. A compiled `Selector` owns its memory and belongs to
no document, so one compile serves any number of pages; the `Selectors` engine keeps
per-search state and is one per thread.

`lava html [--scripts] [--chunk N] [--select CSS] <file|->` drives it from the CLI.

### 3.7 HTTP client (`pkg/http`) and TLS (`pkg/tls`)

`pkg/http` fetches a URL with no JS engine involved: DNS on the loop's worker pool,
a non-blocking connect over the resolved addresses in turn, TLS through `pkg/tls`,
one HTTP/1.1 exchange per connection (`Connection: close`), responses framed by
Content-Length, chunked encoding or connection close, and up to 20 redirects on fresh
connections (303, and a POST answered with 301 or 302, become a GET; credentials are
dropped when a redirect leaves the origin). It runs on the same event loop as pages;
`lava fetch <url>` drives it from the CLI.

What a server can make it hold is bounded: 64 KiB of response head, 64 MiB of body by
default (`Request.max_body_bytes`), the whole transfer by a timeout. A URL with control
characters is refused and other unsafe target bytes are percent-encoded, so a crawled
link cannot add a header. Over TLS, only a peer closing TCP without close_notify reads
as the end of a body framed by the connection; a reset or an unauthenticated record is
a TLS error.

A body is decoded per its Content-Encoding once it has arrived whole: a single gzip or
deflate under 2 KiB on the loop thread, where the pool's round trip would cost more than
the decode, anything else on the loop's worker pool with the transfer's timeout still
running. gzip and deflate go through the system zlib, br and zstd through libbrotlidec
and libzstd, a chain of up to 10 codings (Chrome's limit) undone last to first. What is
offered and how each format ends — a cut-short stream keeps what it decoded, an unknown
coding leaves the body as sent, br and zstd only to https:// and localhost — follow
Chrome, recorded byte for byte in `pkg/http/testdata/content-coding`
(`make test-http-odin`). The decoded size counts against the same body limit. Since a
worker allocates the decoded body, the allocator a fetch runs with must be thread-safe
and outlive `eventloop.destroy`. Destroying the loop with a fetch in flight finishes it
with `.Cancelled`, from inside `destroy`.

The runtime's `fetch()` still has its own transport and chunked decoder, bound to JS
callbacks; moving it onto `pkg/http` is stage-2 work.

`pkg/tls` holds the OpenSSL bindings that used to live in `pkg/runtime/tls.odin`, so
the client and the runtime's `fetch()` and `node:https` share one set without the
client importing the runtime.

What it does not do yet, all stage 2 (docs/LARVA.md decision 3): connection reuse,
HTTP/2, cookies, proxies and client profiles. Linux only; elsewhere `fetch` returns
`.No_Transport`.

---

## 4. Cross-cutting concerns

### 4.1 Memory model

Disciplined and consistent. A per-tick `free_all(context.temp_allocator)` at the
single choke point in `run_once` (`loop.odin`), mirrored per-require
(`native_require_cb`, `require.odin`) and per-eval (`eval`, `runtime.odin`), bounds
scratch growth. JSC
values held across loop turns are explicitly `JSValueProtect`/`Unprotect`'d with
the lifecycle documented at every site. Queue buffers are bound to the loop
allocator up front (`init`, `loop.odin`) so a worker thread's `post_async` cannot
accidentally adopt the wrong allocator.

One allocator hazard is the `proc "c"` boundary: a JSC callback resets `context` to
`runtime.default_context()` (the heap allocator), so a long-lived string cloned
_inside_ a callback but freed from a teardown proc running under the caller's context
mismatches if the caller uses a custom allocator (an embedder, or the test runner's
tracking allocator). The fix is _localized_ — each request/job captures the owning
`Runtime_State.allocator` at creation and clones **and** frees through it, so the
alloc/free pair stays matched no matter which context is active at either end. This is
applied to `module_cache` keys, `fetch` (`Fetch_Request` method/url/host/path +
`request_bytes` + the struct), timer bindings (`JS_Callback` + its
forwarded `args`, freed under eval's context on fire/teardown but under the heap when
`clearTimeout`/`clearImmediate` dispose synchronously), and the host-native registry's cached
names (`host_natives.odin`; note that registry's two tables are thread-lived, so their
_backing_ is bound to a process-lifetime allocator rather than to a state's). The
payloads a pool worker writes into — `Dns_Lookup_Request` (+ `hostname`) and fetch's
`DNS_Job` (+ `host`) — capture the **heap** instead of the state's allocator: a worker
blocked in a lookup can outlive the loop's owner (a detached loop's last worker frees
them — the page runner's reaping, `page_runner.odin`) and the allocator an embedder handed in, so they must not live there
(pinned by `eval_dns_workers_own_their_requests_on_the_heap`). It is
deliberately _not_ context-based:
those structs free under _multiple_ contexts (e.g. `fetch_reclaim_pending` during normal
operation vs `fetch_destroy_pending` at teardown; a pool job disposed by a worker thread rather than
the loop thread), which a "rebind `context.allocator` at the callback entry" approach
cannot cover. Dynamic-array fields (`response`/`carry`/`body_out`, `results`) carry their
own bound allocator, so `delete()` already frees them correctly. Guarded by
`module_cache_alloc_test`, `dns_alloc_test` and `timer_binding_frees_through_its_own_allocator`
(eval under a tracking allocator asserts no bad frees; the timer test also asserts the
bindings were routed through it and none leaked).

### 4.2 Concurrency model

**One JS thread per loop, one live context per VM.** Each `eval` takes a VM from
its thread's pool (`vm_pool.odin`), creates one global context in it and returns the
VM when it finishes, so the next `eval` on that thread runs in a warm VM. A VM is
only ever entered by the thread that created it and never holds two live contexts.
Windows is the exception: it still calls `JSGlobalContextCreate`, a fresh VM per
context (`create_eval_context`, `runtime.odin`).

The Node profile runs one context at a time per thread. Several pages on one
thread, each in its own pooled VM and sharing that thread's loop, is the Larva
design ([LARVA.md](LARVA.md) decision 2) and is not built yet: no page object
exists, and loop handles carry no per-page owner. Package-level state is audited
for page isolation in [GLOBAL-STATE.md](GLOBAL-STATE.md).

The generic per-loop worker pool (`threadpool.odin`) backs async `fs.readFile`/`writeFile`,
`node:dns` (`dns.odin`) and fetch's resolver (`fetch_dns.odin`); the old
process-global `g_fetch_dns_pool` was folded into it. A worker touches only its own
request; all JS-value work stays on the loop thread.

### 4.3 The FFI trust boundary — resolved (#159)

The code once carried a _distrust of the FFI boundary_: several sites avoided the
`JSValueIs*` / `JSValueToBoolean` predicates in favor of `JSValueGetType`, with
comments calling them "unreliable across the FFI" (the sqlite readBigInts / bind
"heisenbugs" — _a JS `false` came back `true`_).

**Root cause, now pinned down:** the predicates were historically declared
`-> b32` (a 4-byte boolean). JSC's C API returns C `_Bool` (1 byte); on SysV-AMD64
and AArch64 the value sits in the low byte of the return register and the upper
bytes are _undefined_. Reading 4 bytes picked up that garbage, so a `false` (low
byte 0, upper bytes nonzero) read back truthy. The bindings already declare these
`-> bool` (Odin `bool` is 1 byte, reads only the low byte) — the ABI-correct fix —
and the codebase already trusts `JSValueToBoolean` in dns/fetch/fs/buffer; only one
stale workaround (sqlite `readBigInts`) and a few misleading comments remained.

`cmd/lava/jsc_predicates_test.odin` now pins the full predicate matrix down,
including from inside a `proc "c"` callback (the context the comments blamed), so a
regression to a wide return type fails loudly. The stale workaround and comments
are gone. This closes the consistency issue.

### 4.4 Error handling

`pkg/runtime/errors.odin` is the single source of truth for native error
construction. `make_native_error(ctx, ctor_name, message, code)` builds a **real**
instance of the named JS error constructor (so `err instanceof TypeError` holds, as
in Node — not just `err.name`), attaches Node's `err.code`, and falls back to a
base Error with an overridden name only when the constructor is unreachable.
`make_js_error` / `make_js_named_error` and the typed `ERR_*` helpers
(`err_out_of_range`, `err_invalid_arg_type`, …) all route through it; the ad-hoc
"base Error + manual `name`/`code` patch" sites (process.exit, sqlite, module
resolution) were migrated. The JS layer builds its coded errors through
`js/internal/errors.js` (§3.3); growing the `ERR_*` helper list lets native sites adopt
the same codes as they need them.

### 4.5 Primordials in the JS layer

`pkg/runtime/js/internal/primordials.js` is the shared hardened baseline: a frozen
table of pristine intrinsics — captured statics plus **fixed-arity `.call`
wrappers** over the captured prototype methods — so `ArrayPrototypePush(arr, x)`
is a pollution-proof `arr.push(x)`. Deliberately **not** Node's `bind.bind(call)`
uncurryThis: JSC does not inline through a `JSBoundFunction`, measured ~28x for a
hot-loop `charCodeAt`, so the classic idiom is a per-call tax here (the cost model
is documented at the head of `primordials.js`). Arity matters at the call site
too: the variadic `callerN` fallback carries an `arguments`-length switch, and
routing a per-code-unit codec loop through it cost 1.43x — hence
`ArrayPrototypePush1`/`Push2` for the fixed-arity cases, and plain indexed writes
into a null-prototype array where the loop is the inner loop.
The loader **eager-loads it first**, before any
other internal module and before user code, so the captured references are
pristine; modules consume it via `require('internal/primordials')` and get the cached table
(one exception — `esm.js`, which has no `require`; see §3.4).
This is the JS-layer analog of the native error-intrinsic capture (§4.4).

`events.js` (EventEmitter) is the first fully migrated consumer — its internal
`Array`/`Object`/`Reflect`/`Promise` use routes through primordials, and listener
arrays are copied/spliced via species-free helpers (`arrayClone`/`spliceOne`, array
literal + index only) so a poisoned `Array[Symbol.species]` cannot reach `emit()`
either. `cmd/lava/primordials_test.odin` (a Lava-only Odin test — Node's own
EventEmitter is _not_ immune here, so this can't be a Node oracle) proves it stays
correct while `Array.prototype.{push,unshift,slice,splice,map}`, `Object.create`,
and `Array[Symbol.species]` are all overwritten. Remaining modules adopt primordials
incrementally — the same grow-as-you-go model as the `ERR_*` taxonomy.

Adoption is **ratcheted, not aspirational**: `scripts/check-primordials.mjs` parses
every file under `pkg/runtime/js` with acorn (the detector is
`scripts/lib/primordials-detect.mjs`; its fixtures and the baseline comparison are
siblings, each with a `node:test` file) and counts **four classes** of
pollutable site, each baselined separately in
`tests/node-compat/pollution-baseline.json`:

| class      | example         | resolved through                |
| ---------- | --------------- | ------------------------------- |
| `method`   | `arr.push(x)`   | a pollutable prototype method   |
| `invoke`   | `fn.call(t, a)` | `Function.prototype`            |
| `accessor` | `view.buffer`   | a configurable prototype getter |
| `global`   | `String(x)`     | a replaceable global, read live |

`Function.prototype.call/apply/bind` themselves are **locked** before user code:
the loader calls `lockIntrinsics()` right after the primordials table is captured,
turning each into a non-configurable accessor in the shape of node's
`--frozen-intrinsics` (assignment on `Function.prototype` throws in both modes;
`f.call = x` on an ordinary function still defines an own property). That is a
deliberate node deviation (#450), pinned by `cmd/lava/function_call_lock_test.odin`.
It does **not** make `.call` safe on a captured INTRINSIC: user code holds the same
object, so `Function.prototype.apply.call = evil` defines an own `call` that
`apply.call(listener, …)` in `events.js` then runs, and `Array.prototype.push.call = evil`
reaches the `callerN` wrappers' `fn.call` (both probed on `bin/lava`; node runs
neither). So the `invoke` class counts every `.call`/`.apply` (and `method` every
`.bind`) except on one receiver: a strict function declaration the file never lets
go of — one binding of the name in the file, never written, referenced only as
`g(…)` or `g.call/apply/bind(…)` inside its declaring scope, and no direct `eval`
(`capturedCallees` in `primordials-detect.mjs`). A suppression marker may carry its
reason after an em dash: `// primordials-ok: invoke — why`.

A `global` read at module-eval is exempt only in a module instantiated before user
code — the loader's `req()` roots closed over top-level requires, computed by
`scripts/lib/js-graph.mjs` (the parser the graph rules in `lib/js-graph-check.mjs`
also use). In a lazy module the factory runs on the user's first `require()`, so its
capture counts (#333).
`cmd/lava/lazy_builtins_test.odin` checks that set against what context init compiles.

`make check-primordials` (part of `make check-js`) fails on any per-class
increase, and `--update` refuses to raise a floor without `--allow-raise`. The
detector self-tests against known-positive and known-negative fixtures on every
run and refuses to report — or to rebaseline — if one regresses. Differential
oracles `54-url-pollution.js` and `55-encoding-pollution.js` pin the behavior
against Node, and `cmd/lava/encoding_pollution_test.odin` pins the axes where Lava
is deliberately stronger than Node.

A baseline of 0 in a class means "no **counted** site of that class remains", not
"immune" — the ratchet is a floor, not a proof. Per-class counts are what make
that readable: `events.js` is at 0 `method`, `accessor` and `global` while still
carrying `invoke` sites, which a single total hid. Do not restate the numbers
here — `pollution-baseline.json` is the source and `make check-primordials` prints
the live split; the counts copied into prose went stale twice. `.call`/`.apply`
and live globals used to be the author's problem and are now gated classes;
**one vector outside those four is still uncounted**, because deciding that an
object literal is a lookup table read with a caller-supplied key takes dataflow a
per-file counter does not have — give those `__proto__: null` by hand.
A fourth vector is COUNTED and still not resolved by routing through the
primordial, which no other entry in the table above is:
`StringPrototypeReplace/Match/Search/Split` read 0 in `method`, but the spec's
RegExpExec re-reads `R.exec` off the receiver, so a poisoned `exec` steers them
anyway — and a GLOBAL one never terminates rather than answering wrongly, since
`lastIndex` only advances on an empty match. That shipped as a remote-triggerable
hang on the URL and header paths. `RegExpPrototypeTest` was removed from the
frozen table for the same reason: capturing `test` cannot fix what RegExpExec
re-reads. Use `RegExpMatches`, or drop the RegExp entirely where the pattern is
just a character class — and when you do, scan with the **captured**
`StringPrototypeCharCodeAt`, not a live `.charCodeAt` (that is its own writable
data property; a CR/LF-lying gadget splits HTTP responses). Capture free globals
used for conversion beside the validator (`parseInt`/`Number` on `primordials` at
bootstrap) the same way: a sound digit check next to a live `parseInt` still
desyncs Content-Length framing.
Two more vectors are uncounted, for two DIFFERENT reasons that are worth keeping
apart. The iterator and coercion protocols (`for…of`, spread, `Symbol.toPrimitive`)
read a well-known SYMBOL, so there is no named property to count at all. A poisoned
`Object.prototype.then` is the opposite case: `then` is an ordinary named property
and the detector does count it — `p.then(cb)` and `p['then'](cb)` each score 1
`method` — but `await x` and `Promise.resolve(x)` read it IMPLICITLY, with no
member expression in the source to see. So the explicit half is gated and only the
assimilation half is blind, which is why the guidance is a code convention rather
than a counter: never `await` a caller-supplied value directly.

`primordials` is internal-only by living in `js/internal/`: the public resolver native
`require()` consults answers `node/` ids only, so it neither shadows a user package
named `primordials` nor answers `require('node:primordials')` (which Node rejects). The
same holds for every file under `internal/`. The _specifier_ is what is hidden — the
table itself also hangs off that resolver object as `publicReq.primordials`, which is
how `esm.js` receives it (§3.4); the resolver is reachable only from Odin and never
reaches user code.
