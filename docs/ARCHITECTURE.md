# Lava Architecture

> An architectural overview and forward-looking review of the Lava runtime.
> Companion to `README.md` (how to build/run) and `ROADMAP.md` (feature status).
> This document explains _how the pieces fit together_, _why the boundaries are
> where they are_, and _where the architecture should go next_ to become the most
> elegant, fast, and predictable JavaScript runtime we can build.

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
│   runtime.odin      eval(): JSC context lifecycle, ownership, drains   │
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

Supporting packages `pkg/bundler` and `pkg/install` are placeholders today
(README only) — reserved for the transpile/bundle and package-manager stories.

---

## 3. Component architecture

### 3.1 The event loop (`pkg/runtime/eventloop`)

The strongest part of the system, and the right thing to have gotten right first.

- **Node-faithful phases.** `run_once` (`loop.odin:619`) runs the canonical order:
  next-tick → microtasks → timers → poll (I/O completions, then block) → check
  (`setImmediate`) → close. Each phase uses a _sequence limit_ so callbacks queued
  _during_ a phase defer to the next iteration — this is what makes ordering
  deterministic and matchable against Node.
- **Timers are a binary min-heap** keyed on `(due_ms, seq)` (`timer_heap_*`), so
  ties fire in FIFO order (Node parity) and push/pop are O(log n). Cancelled
  timers are dropped lazily at the root rather than compacted every tick.
- **Two clocks.** `real_time` mode tracks the monotonic wall clock; the default
  (used by tests) advances a _logical_ clock explicitly. This dual-clock design is
  quietly powerful — it is the seed of a future deterministic record/replay mode
  (§6).
- **Cross-thread completion handoff** mirrors libuv's `uv_async`:
  `async_begin`/`post_async`/`drain_async` (`loop.odin:248-302`) let an off-loop
  worker enqueue a completion under a mutex and wake the loop, which drains it on
  its own thread. `active_async` keeps the loop alive and blocked in `poll` until
  the worker finishes. **This primitive already exists but is under-used** — it is
  the foundation the thread pool in §5.2 should build on.
- **Lifecycle accounting is meticulous.** `watched`/`active_io_count`,
  `reffed_timer_count`, and the `dispose` hook contract (`loop.odin:8-14`) ensure a
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

### 3.5 I/O transports (`fetch_*`, `dns.odin`, `tls.odin`)

`fetch_transport.odin` is a platform-agnostic connect→[TLS]→write→read state
machine; each platform supplies only narrow socket primitives, and TLS is a
swappable backend (OpenSSL, or a rejecting stub). DNS — `fetch`'s and `node:dns`'s
— resolves off-loop on the loop's own 4-worker pool (`threadpool.odin`). Streaming request _and_ response bodies are real
incremental `ReadableStream`s with backpressure. This is the second-strongest
subsystem after the loop, and it validates the `post_async` design end to end.

---

## 4. Cross-cutting concerns

### 4.1 Memory model

Disciplined and consistent. A per-tick `free_all(context.temp_allocator)` at the
single choke point in `run_once` (`loop.odin:620`), mirrored per-require
(`require.odin:58`) and per-eval (`runtime.odin:106`), bounds scratch growth. JSC
values held across loop turns are explicitly `JSValueProtect`/`Unprotect`'d with
the lifecycle documented at every site. Queue buffers are bound to the loop
allocator up front (`loop.odin:157`) so a worker thread's `post_async` cannot
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
them, §5.2) and the allocator an embedder handed in, so they must not live there
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

**Single VM, single JS thread, single context.** The generic per-loop worker pool
(`threadpool.odin`) backs async `fs.readFile`/`writeFile`, `node:dns` lookups
(`dns.odin`) and `fetch`'s DNS resolution (`fetch_dns.odin`) (§5.2). There are no
`worker_threads` and no isolates, and the `*Sync` APIs and `crypto` KDFs still run on
the loop thread — but blocking file I/O and DNS no longer do. A worker touches only its
own request; all JS-value work stays on the loop thread. Lifting the remaining blocking
ops (async `fs.stat`/`readdir`, `crypto`) onto the pool is the rest of §5.2.

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

---

## 5. Findings & prioritized recommendations

Severity: **P0** trust/correctness foundations · **P1** scalability/perf · **P2**
documentation/process.

### 5.1 [P0] Close the FFI trust boundary ✓ + unify the error layer ✓

**FFI boundary — done (#159).** The "`JSValueIs*` is unreliable" workaround was
root-caused to the retired `-> b32` (4-byte) return reading undefined upper bytes
of a 1-byte C `_Bool` (§4.3). The bindings already return the ABI-correct `-> bool`;
`cmd/lava/jsc_predicates_test.odin` now proves the predicate matrix from both a
normal context and a `proc "c"` callback, the last stale workaround (sqlite
`readBigInts`) uses `JSValueToBoolean` again, and the misleading comments are
corrected. The remaining `JSValueGetType` uses are idiomatic multi-way type
switches, not hazard workarounds.

**Error layer — done.** `pkg/runtime/errors.odin` is now the single source of
truth (§4.4): `make_native_error` builds real error instances (so `instanceof`
matches Node) carrying `err.code`, with typed `ERR_*` helpers mirroring Node's
message templates. `make_js_error` / `make_js_named_error` route through it and the
ad-hoc code-setting sites were migrated; `cmd/lava/errors_test.odin` pins the shape
(instanceof + name + message + code). The `ERR_*` helper set grows as native call
sites adopt coded errors — the mechanism and parity contract are in place.

### 5.2 [P1] A real thread pool → non-blocking `fs` and `crypto`

**Problem.** Synchronous file reads and CPU-bound KDFs run on the loop thread, so a
single large `fs.readFile` or `pbkdf2` stalls all timers and I/O. The ROADMAP
itself notes `fs.readFile`'s "read is synchronous for now."

**The good news: the hard part is already built.** `async_begin` / `post_async` /
`drain_async` is exactly libuv's completion-handoff contract, already proven by the
DNS pool and the fetch transport. What's missing is a _generic_ worker pool that
sits on top of it.

**Step 1 — the generic pool — done (`pkg/runtime/eventloop/threadpool.odin`).**
A fixed pool (`THREADPOOL_SIZE`, libuv's default of 4) of OS threads blocking on a
shared FIFO queue, lazily started on first submit and stopped at loop teardown.
`pool_submit(loop, work, done, user_data)` does `async_begin(loop)` (keeping the
loop alive and parked in poll), runs `work` off-loop on a worker, then hands the
completion back through `post_async`, where `done` runs on the loop thread. The
invariant that **workers touch only their user_data — never the loop or JSC** keeps
the single-VM model intact; only the loop-thread `done` materializes JS values. It
generalizes the DNS pool and shares its teardown discipline (workers joined before
the async queue is torn down). Teardown is split: `close_begin` stops the pool
without waiting and settles every job on the loop thread while the JS context is alive —
`dispose` for a job no worker took, `Pool_Cancel` (releasing its protected callback) for
one a worker is still running — and `close_finish` joins the workers, then frees the
remaining jobs, the async queue and the wakeup pipe; `destroy` is the two back to back,
which is what `eval` runs. `close_detach` instead leaves a heap-allocated loop to its last
worker to finish — Larva's page runner uses it so a page blocked on a FIFO read or an
unanswered DNS lookup cannot hold its thread (#34); in Lava only tests call it. Because a
worker can outlive the loop's owner that way, what it writes into is heap-owned (§4.1).
Covered by deterministic tests in
`eventloop_test.odin` (off-loop work → on-loop completion; submit-then-destroy joins
in-flight work without leak/hang).

**Remaining.**

- **Step 2 — `fs.readFile`/`writeFile` — done (`fs.odin`).** The blocking read/write
  syscall runs off-loop on the pool (`fs_read_work`/`fs_write_work`, touching only the
  request). `writeFile` first snapshots its bytes into an owned copy _on the loop thread_
  (a worker must not read — and JS must not mutate/detach — the live buffer, exactly as
  Node copies into a Buffer), so for a write only the syscall is off-loop, not the
  payload copy; that copy is bounded and still strictly better than master, which ran the
  whole blocking write on-loop. The completion bridges the phase gap the doc
  flagged: `post_async` drains at the _top_ of the tick, but the loop-thread `done`
  (`fs_*_pool_done`) re-queues via `queue_io_callback` so the callback still fires in the
  **poll phase** — preserving Node's I/O-before-`setImmediate` ordering (guarded by
  `tests/runtime/eventloop/cases/08-io-before-immediate.js`). Teardown needs no separate
  request tracking: the pool's `dispose` hook frees a request whose job is dropped before
  `done`, and a `dispose` on the re-queued `queue_io_callback` covers the window after
  `done` but before poll. With no loop (bare eval) or if the pool can't start, it falls
  back to a synchronous read/write, so behavior is unchanged there.
- **Step 3 — `crypto.pbkdf2`/`scrypt`** async forms (CPU-bound; ordering is simpler).

Synchronous `*Sync` APIs stay on the loop thread (Node does the same). The same pool
path now generalizes to async `fs.stat`/`readdir`/`mkdir`, `fs.promises`, and any future
blocking op — making "predictable latency under load" a real property rather than an
aspiration.

### 5.3 [P1] Make "fast" provable: a benchmark harness with CI gating

The README promises speed; nothing measures it. Add `bench/` with micro
(startup, `require`, JSON, Buffer codecs) and macro (fetch throughput, fs
throughput) benchmarks, recorded against Node as the same oracle the tests use.
Gate CI on regressions beyond a threshold. Without this, every perf claim and
every "is this change faster?" question is unfalsifiable.

### 5.4 [P1] Server-side networking (`node:net`, `node:http`)

Lava can make HTTP requests but cannot accept them. `node:net` (TCP server/socket)
and a `node:http` server unlock a whole class of applications and reuse the
existing transport/loop machinery. This is the highest-leverage _capability_ gap.

### 5.5 [P2] Consolidate primordials in the JS layer — foundation laid

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
This is the JS-layer analog of the native error-intrinsic capture (§4.3/§5.1).

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
deliberate node deviation (#450), pinned by `cmd/lava/function_call_lock_test.odin`,
and it is what lets the `callerN` wrappers keep a live `.call` on a captured method.
It does not cover `.call` on a caller-supplied function, which can carry its own
`call`, so the `invoke` class still counts every site.

A `global` read at module-eval is exempt only in a module instantiated before user
code — the loader's `req()` roots closed over top-level requires, computed by
`scripts/lib/js-graph.mjs` (the parser `check-js-graph.mjs` also uses). In a lazy
module the factory runs on the user's first `require()`, so its capture counts (#333).
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

### 5.6 [P2] Documentation & process gaps

- **No `package.json` `"exports"`** resolution — note it explicitly and plan it.
- **Event-loop backend tradeoffs undocumented** — add a short
  `pkg/runtime/eventloop/PLATFORMS.md` (io_uring vs epoll vs kqueue vs IOCP, and the
  fallback logic).
- **Odin unit tests are orphaned** in `pkg/` rather than discoverable from a test
  index — document their locations.
- **Windows provisioning is duplicated** between `ci.yml` and
  `bootstrap-windows-deps.sh`; the pinned `WEBKIT_TAG` should have a single source
  of truth.
- **`known-lava-gaps.txt`** has no structured format or CI enforcement — define
  `file:reason` tuples and check them so a regression cannot silently widen a gap.
- **`process.env` is a one-shot snapshot** (`build_env_object`, called from `install_process`, `globals.odin`), not live — revisit
  with a Proxy-backed object when child processes land.
- **Stack-trace line numbers** are off by one (known) — fix once the loader wrapper
  no longer shifts line 1.

---

## 6. The longer view: what would make Lava _best in class_

Three differentiators, each a natural extension of architecture that already
exists rather than a bolt-on:

1. **TypeScript/JSX-first.** Native transpile-on-load (the empty `pkg/bundler`
   becomes a real transform stage) removes the build step that Node still imposes.
   This is the largest single "why Lava over Node" lever.
2. **Deterministic by construction.** The loop's existing dual clock (real vs
   logical) is half of a record/replay engine. Capture every nondeterministic input
   — timer firings, I/O completions, `Math.random`, `Date.now` — and replay them
   byte-for-byte. A runtime where any run can be deterministically reproduced for
   debugging would be genuinely novel, and the oracle test methodology already
   thinks this way.
3. **Capability-based security in the loader.** A permissions model finer than
   Deno's, enforced at the module/native-binding boundary that Lava already funnels
   everything through.

Then the table-stakes parallelism story: `worker_threads` (multiple JSC contexts,
one per thread, message-passed), built on the same thread-pool and `post_async`
foundations as §5.2.

---

## 7. Recommended sequence

| #   | Work                                                      | Class  | Rationale                                                                                      |
| --- | --------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 1   | ~~FFI root-cause (#159) + unified `ERR_*` error layer~~ ✓ | P0     | FFI boundary proven (§4.3); `errors.odin` factory in place (§4.4) — foundation of parity tests |
| 2   | Generic thread pool → async `fs`/`crypto`                 | P1     | Removes the loop-blocking ceiling; reuses the proven `post_async` primitive                    |
| 3   | Benchmark harness + CI perf gate                          | P1     | Makes "fast" provable instead of asserted                                                      |
| 4   | `node:net` + `node:http` server                           | P1     | Unlocks server-side applications                                                               |
| 5   | `package.json` `"exports"`; consolidate primordials       | P2     | Modern-package compat; uniform pollution safety                                                |
| 6   | TypeScript/JSX transpile-on-load                          | Vision | Biggest differentiator vs Node                                                                 |
| 7   | `worker_threads`; deterministic record/replay             | Vision | Parallelism + a genuinely unique capability                                                    |

---

## 8. Verdict

Lava is, today, a **carefully engineered early-stage runtime** whose core — the
event loop, the FFI lifetime discipline, the native/JS layering, and the
oracle-based test methodology — already meets a high bar. The work ahead is not
rescue work; it is _extension and hardening_: pin down the one boundary the code
distrusts, lift blocking work off the loop thread, prove the performance, and then
reach for the differentiators (TS-first, determinism, capabilities) that the
existing architecture is unusually well-positioned to deliver.
