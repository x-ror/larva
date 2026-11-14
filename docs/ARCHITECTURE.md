# Lava Runtime Architecture

> Architectural overview of the underlying Lava runtime that Larva builds on.
> Companion to [`docs/LARVA.md`](LARVA.md) (headless browser architecture and
> roadmap) and [`README.md`](../README.md) (how to build and run).

---

## 1. What Lava is

Lava is a Node-compatible JavaScript runtime built on **JavaScriptCore (JSC)** as
the execution engine and **Odin** as the systems language for everything around
it: the engine FFI, the event loop, the I/O transports, and the native half of
the standard library. Compatibility targets modern Node (22+/24 behavior) rather
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
│   js/internal/*.js  embedded spec surface (Buffer, fetch, streams, …)  │
│   js/console.js     console implemented in JS over two write prims     │
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
  signal), and `crypto.randomFill` returns the view it filled, which `crypto.js`
  identity-checks as its second fail-closed layer.

- The host-call path itself is reached by `dlsym`ing a C++ mangled symbol
  (`pkg/jsc/host_function.odin`), so it can vanish under a JSC upgrade; callers
  then fall back to `JSObjectMakeFunctionWithCallback`. The two are **not**
  observably identical (`.length`, constructibility — see `inject_native_function`),
  so `LAVA_HOSTFN_DISABLE=1` forces the fallback and `make test-lava-nohostfn` runs
  every oracle suite through it, the same way `LAVA_NET_FORCE_READINESS` covers the
  second I/O backend.

### 3.3 Standard library: native + embedded JS

Built-ins are JS factories `#load`-embedded at compile time (the `EMBEDDED_*`
constants in `globals.odin`) and instantiated by `loader.js`. Each factory
receives `(require, module, exports,
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
instantiates them during bootstrap.

The JS layer is substantial and high quality: `url.js` (2071 LOC, WHATWG URL),
`streams.js` (2027, Web Streams), `buffer.js` (1646), `fetch.js` (1054),
`crypto.js` (917). Errors use Node-shaped coded errors (`ERR_INVALID_ARG_TYPE`,
`ERR_OUT_OF_RANGE`, …). Native byte ops are gated by a size threshold
so small inputs avoid FFI overhead — except that the threshold this sentence used to
name (`NATIVE_BYTEOP_MIN`) does not exist in the tree: `bytesToString` dispatches to a
native codec at every size. Removed rather than left as folklore steering review.

### 3.4 Module system (`require.odin`, `module_resolution.odin`)

- CommonJS is the substrate. `native_require_cb` consults, in order: the module
  cache → JS internal builtins (`require_builtin`) → filesystem resolution.
  `node:fs` used to sit between the last two as a natively-assembled object, the one
  built-in with no JS layer; it is now an ordinary internal builtin
  (`js/internal/fs.js` over `make_fs_bindings`). Nothing may rebuild it in
  `native_require_cb`: `require_builtin` runs first, so a second construction would be
  dead code silently disagreeing with the live one. Circular requires terminate via a pre-registered partial-exports
  entry (`__lava_precache`), and a module that throws while loading is _removed_
  from the cache so a later require re-runs it (Node parity).
- `.mjs`/static `import`/`export` are handled by a **source transform**
  (`esm.js`) that rewrites ESM onto the CommonJS `require`, not by JSC's native
  module records (the classic C API only runs script-goal source). This is
  pragmatic and works, with documented divergences (named imports from CJS).
  Its output is _executed source_, which is why it is the one internal module the
  runtime hands `primordials` as a factory argument: it is deliberately not
  registered as a requireable module (so user code cannot reach the transform),
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
swappable backend (OpenSSL, or a rejecting stub). DNS resolves off-loop on a
bounded 4-worker pool. Streaming request _and_ response bodies are real
incremental `ReadableStream`s with backpressure. This is the second-strongest
subsystem after the loop, and it validates the `post_async` design end to end.

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
`request_bytes` + the struct), `dns` (`Dns_Lookup_Request.hostname` + the struct), and
the fetch DNS pool (`DNS_Job.host` + the struct), timer bindings (`JS_Callback` + its
forwarded `args`, freed under eval's context on fire/teardown but under the heap when
`clearTimeout`/`clearImmediate` dispose synchronously), and the host-native registry's cached
names (`host_natives.odin`; note that registry's two tables are thread-lived, so their
_backing_ is bound to a process-lifetime allocator rather than to a state's). It is
deliberately _not_ context-based:
those structs free under _multiple_ contexts (e.g. `fetch_reclaim_pending` during normal
operation vs `fetch_destroy_pending` at teardown; a global DNS pool freeing jobs from
several runtimes), which a "rebind `context.allocator` at the callback entry" approach
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

The generic per-loop worker pool (`threadpool.odin`) backs async fs, crypto,
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
resolution) were migrated. The JS layer still sets `err.code` per module; growing
the `ERR_*` helper list lets native sites adopt the same codes as they need them.

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
pristine; modules consume it via `require('primordials')` and get the cached table
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

`make check-primordials` (part of `make check-js`) fails on any per-class
increase, and `--update` refuses to raise a floor without `--allow-raise`. The
detector self-tests against known-positive and known-negative fixtures on every
run and refuses to report — or to rebaseline — if one regresses. Differential
oracles `54-url-pollution.js` and `55-encoding-pollution.js` pin the behavior
against Node, and `cmd/lava/encoding_pollution_test.odin` pins the axes where Lava
is deliberately stronger than Node.

A baseline of 0 in a class means "no **counted** site of that class remains", not
"immune" — the ratchet is a floor, not a proof. Per-class counts are what make
that readable: `events.js` is at 0 `method` and 0 `accessor` while still carrying
`invoke` and `global` sites, which a single total hid. Do not restate the numbers
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

`primordials` is internal-only: the loader serves it to internal factories but
hides it from the public resolver native `require()` consults, so it neither
shadows a user package named `primordials` nor answers `require('node:primordials')`
(which Node rejects). The _specifier_ is what is hidden — the table itself also hangs
off that resolver object as `publicReq.primordials`, which is how `esm.js` receives it
(§3.4); the resolver is reachable only from Odin and never reaches user code. Gating
the other internal helper modules the same way is a future follow-up.
