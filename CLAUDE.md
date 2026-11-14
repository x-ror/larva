# Larva — working agreement

Lightweight headless browser engine built on the Lava runtime: **JavaScriptCore**
is the VM, **Odin** owns the runtime, DOM, and I/O transports. Read
[docs/LARVA.md](docs/LARVA.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
before any structural change.

Layering (never blur it):

| Layer                    | Path                    | Holds                                      |
| ------------------------ | ----------------------- | ------------------------------------------ |
| CLI                      | `cmd/lava`              | argv → loop → `runtime.eval/run_file`      |
| Runtime orchestration    | `pkg/runtime`           | globals, require, native primitives        |
| Embedded spec surface    | `pkg/runtime/js/**.js`  | `Buffer`, `fetch`, streams, `URL`, `http`… |
| Engine FFI / private ABI | `pkg/jsc`               | JSC C API, string/view/host ABI, probes    |
| Event loop               | `pkg/runtime/eventloop` | phases, timers, io_uring/epoll, threadpool |

---

## 1. How code is judged (ranked, in this order)

1. **Oracle conformance.** For the browser (`Window`/DOM/network) layer, recorded
   Chrome output is the oracle ([docs/LARVA.md](docs/LARVA.md)); for the base
   runtime (`Node` profile), Node 22+/24 is the oracle. The observable surface —
   names, argument coercion order, defaults, thrown error `code`/`name`/`message`,
   event order, return types — matches the oracle, not our reading of the docs.
   Deviation is allowed **only** when it buys measured speed or memory control
   (or is an explicit non-goal in `docs/LARVA.md`), and then it must be: written
   down in the code comment, listed in the PR, and covered by a test pinning the
   intended behavior.
2. **Speed and memory.** Fewer allocations, fewer copies, fewer FFI crossings,
   less memory per connection/request. A perf claim without a `make bench` number
   or a profile is not a perf claim.

   A number written into a comment carries **how it was measured**, in the same
   breath: what was compared against what, and at what size or count — "0.74x on a
   9-byte decode, medians of 7 interleaved launches per arm", not "faster". Without
   that the number cannot be rechecked and quietly becomes folklore: this file's own
   justification for keeping `.call` over `Reflect.apply` read "2.22x" for months,
   and remeasuring gave 25x on the bare wrapper and 1.00x–1.76x end to end depending
   on wrapper density. The decision survived; the stated reason for it did not.
   A comment that cites a ratio with no method is worse than one that cites none,
   because it stops the next reader from measuring.

Everything else (quality, docs, security, coverage) is a gate, not a ranking:
a PR that fails one of them does not merge regardless of how fast it is.

---

## 2. Reuse-first law (applies to every new native line)

Before writing new low-level code, prove nothing already implements it. Search in
this order and stop at the first real fit:

1. **In-repo** — `pkg/runtime/*.odin`, `pkg/jsc`, `pkg/runtime/eventloop`,
   `pkg/runtime/picohttpparser`. Duplicating our own helper is the most common
   defect in this codebase.
2. **Odin `core:`** — the SDK is large and already covers most of what a runtime
   needs (`core:net`, `core:crypto/*`, `core:encoding/*`, `core:sys/linux/uring`,
   `core:sys/posix`, `core:mem`, `core:sync`, `core:thread`, `core:simd`,
   `core:text/regex`, `core:container/*`, `core:time`, `core:strconv`). Index:
   [agents/prompts/odin-feature-reference/odin-sdk-map.md](agents/prompts/odin-feature-reference/odin-sdk-map.md).
3. **Odin `vendor:`** — vendored third-party bindings shipped with the SDK.
4. **C libraries already linked** — JavaScriptCore, OpenSSL, SQLite, libc/POSIX,
   `picohttpparser`. Extending an existing link costs nothing.
5. **A new C dependency** — allowed, but must justify: license, Linux packaging
   story, CI provisioning, binary-size impact, and why 1–4 do not work. The
   licence must permit linking from both the AGPL core and the commercially
   licensed extension modules ([docs/LARVA.md](docs/LARVA.md) decision 6):
   permissive or LGPL (linked dynamically) qualifies, GPL-only and AGPL-only
   third-party code does not. Add the dependency to `NOTICE` in the same PR.
6. **Hand-rolled** — last resort. Requires a written reason in the file: measured
   perf, ABI mismatch, allocator control, or a Node semantic the SDK cannot express.

A rejection of an SDK candidate must cite evidence (`core:x/y.odin:NN` plus the
concrete problem: per-call allocation, wrong error taxonomy, blocking, missing
case) — never "probably doesn't fit". Precedents in-tree: DNS uses `core:net`'s
resolver instead of `getaddrinfo`; KDFs use `core:crypto/{pbkdf2,hmac,hkdf}`;
io_uring uses `core:sys/linux/uring`; HTTP parsing vendors `picohttpparser`
because no Odin equivalent matches its throughput.

Use the `odin-sdk-scout` agent for this search — it reads the real SDK source.

---

## 3. Commands

```sh
make check            # Odin type-check (incl. windows/darwin cross-target front-end)
make check-js         # vp fmt + lint + orphan-JS + node:test over scripts/ + primordials ratchet
make check-md         # markdownlint over the repo's docs (make fix-md auto-fixes)
make check-actions    # actionlint over .github/workflows
make build            # ./scripts/build.sh → bin/lava
make test             # Odin unit tests + oracle suites
make test-lava        # every oracle suite compared node-vs-Lava
make test-lava-nohostfn  # same suites with the private host-call ABI forced off
make test-odin-serial # cmd/lava tests on ONE runner thread (shared-thread defects)
make bench            # node-vs-Lava ratio table (report-only)
```

Full per-subsystem routing (which smoke/bench a given path requires) lives in
[agents/prompts/pr-gate-reference/gates.md](agents/prompts/pr-gate-reference/gates.md).
Never claim a change works without running the gates its paths map to.

**Linux-first.** darwin/windows native code is stubs; CI runs Linux only. But
`make check` still cross-checks both targets — a change that breaks the stub
front-end fails CI.

**CI runs on `ubuntu-latest`: 4 cores.** Worth knowing before trying to reproduce
a concurrency failure — a dev box with 16 cores does not oversubscribe the way CI
does, and the `run_until_idle` race that CI caught survived 40 runs of the test
alone, 25 whole-suite runs and 20 under `taskset -c 0,1` locally. When a race only
appears in CI, read the code or shrink the CPU set; do not just re-run.

---

## 4. Odin conventions

- **Allocator discipline.** A struct that outlives the call captures the owning
  `Runtime_State.allocator` at creation and clones _and_ frees through it. Do not
  rely on the ambient `context.allocator`: a `proc "c"` callback resets `context`
  to `runtime.default_context()`, so alloc-inside-callback / free-at-teardown
  mismatches. Guarded by `module_cache_alloc_test`, `dns_alloc_test`.
- **Temp arena** is freed at one choke point per tick / per require / per eval.
  Anything crossing a loop turn must not live in `context.temp_allocator`.
- **JSC lifetimes.** Every `JSValueProtect` has exactly one `Unprotect`, on fire
  **or** on cancel, never both. Every `JSStringCreate*` has a `JSStringRelease`.
  Never hold an unrooted `JSValueRef` across an allocation that can GC. A cache
  keyed by a JSC handle (context, object, string) must be swept when that handle
  dies — JSC recycles addresses, so a surviving entry silently resolves to an
  object in the _next_ VM. Sweep from `destroy_runtime_state`, while the context
  is still alive. Pinned by `cmd/lava/repeated_eval_test.odin`.
- **Bind map/array backing explicitly.** A container that outlives the call must
  be `make`d with the owning allocator, never left to bind implicitly: Odin binds
  a zero-valued map's allocator on its first grow, capturing whatever ambient
  allocator happened to be live. A thread-lived table that adopts a per-eval
  arena writes through reclaimed memory once that arena is reset. Pinned by
  `cmd/lava/host_native_alloc_test.odin`.
- **FFI ABI.** JSC C API `_Bool` returns must be declared `-> bool` (1 byte), not
  `b32` — the historic "predicates are unreliable" bug. Pinned by
  `cmd/lava/jsc_predicates_test.odin`.
- **Private-ABI probes** latch failure only on a probe/self-test mismatch, never
  on a transient runtime allocation failure, and never permanently demote a whole
  process because of one bad call.
- **Threads** touch only their own request payload — never the loop, never JSC.
  Completions come back through `post_async`; JS values are materialized only on
  the loop thread.
- **Conditional compilation** (`when ODIN_OS`) must keep every target _compiling
  and honest_: a stub returns a real "unsupported" error, it does not silently
  succeed.
- **Comments explain why**, not what. Match the density of the surrounding file —
  this codebase documents non-obvious decisions inline and expects the same.
- File-size policy: `pkg/runtime/buffer.odin` stays under ~1000 lines (split into
  `buffer_utf8.odin` / `buffer_simd.odin` / `buffer_host.odin`). Dedicated `*_host`
  wrappers exist only for **measured** hot natives; cold natives use the generic
  `host_native_create` path. The UTF-16→UTF-8 bridge belongs in `pkg/jsc`, not
  `environment.odin`.
- `make fmt` (`odin strip-semicolon`) before committing Odin.

### Contract comments

Anything on a **user-visible surface** — a native behind a Node API, error
construction, event/callback ordering — carries a structured header above the
declaration. `odin doc` (and `odin doc -doc-format`, for external tooling) takes
the comment block verbatim, so this is the doc source, not decoration.

```odin
// host_native_create returns a host-registered function for `cb`, creating and
// caching it on first use.
//
// Params:
//   ctx    Thread-confined JSC context that will own the binding.
//   name   Binding name; cloned through the Runtime_State allocator.
//   arity  Becomes the function's `.length`.
// Returns:
//   The cached-or-new function object; nil when the host path is unavailable
//   and the caller must fall back to JSObjectMakeFunctionWithCallback.
// Node:
//   setTimeout/setInterval report `.length` 2, every other global 1 — verified
//   against node 24, not read off the docs.
// Deviates:
//   The C-API fallback reports 0 and is not repairable through the public API.
//   Pinned by tests/node-compat/cases/56-native-function-arity.js.
//
// <freeform "why" prose continues here: allocator discipline, ordering, the
// measured reasons — unchanged, and still the bulk of the comment.>
```

Rules that keep this from becoming ceremony:

- **Structured header first, prose after.** The header states the observable
  contract; §4's "comments explain why" still governs everything below it. A
  header that restates the code instead of the contract is noise — delete it.
- `Params:`/`Returns:` only where the answer is not obvious from the signature.
- `Node:` records the oracle **and how it was verified**. `Deviates:` names the
  deviation and the test pinning it, per §1 — omit the line when there is none.
- Internal helpers with no Node counterpart keep the plain why-comment. Do not
  retrofit existing code; this applies to new and changed surfaces.

## 5. Embedded JS conventions (`pkg/runtime/js`, incl. the top-level preludes)

- Route through `require('primordials')` — internal modules run alongside user
  code that can poison prototypes. `make check-primordials` is a **ratchet**: a
  hardened file (baseline 0) rejects any new pollutable call. `UPDATE=1` only to
  _lower_ a baseline.
  One exception, and do not add a second: `js/internal/esm.js` is evaluated
  standalone and deliberately kept off the module table, so user code cannot reach
  the transform — which also denies it a `require`. It takes the table as a factory
  argument instead (`loader.js` publishes it on the resolver, `globals.odin` passes
  it in and fails closed without it). The exception is affordable there because the
  file emits executed source and had to be hardened regardless.
- The ratchet parses with acorn and counts **four** classes, each baselined
  separately: `method` (`arr.push(x)`, and `RegExp`/`Promise`/`Function`
  prototype methods too), `invoke` (`fn.call/apply` — use `ReflectApply`),
  `accessor` (a read through a configurable prototype getter: `view.buffer`,
  `.byteOffset`, `.byteLength`, `.constructor`, `__proto__` — use a captured
  getter such as `TypedArrayPrototypeGetBuffer`), and `global` (a replaceable
  global read live instead of captured at module-eval, which the loader runs
  before user code).
  **Module-eval capture is pristine only in a module the loader instantiates BEFORE user
  code** — the eager list in `loader.js`, plus `stream`/`stdio` via `installStdio`. A LAZY
  module's factory runs on the user's first `require()`, so a capture there is a live read
  in disguise: `var StringG = String` at the top of `net.js` scores 0 and is still
  steerable. Take the handle from the loader instead (`require('primordials')`,
  `require.pristineBuffer`). The ratchet cannot see this — it exempts every module-eval
  capture, which is why #333 shipped. Computed and destructured forms count the same as the dot
  form, so `view['buffer']` is not a way to lower a number.
- A false positive takes `// primordials-ok` on the line. On a line carrying
  candidates from **more than one class** the bare marker suppresses nothing —
  name it, `// primordials-ok: method` (comma-separated list allowed). An
  unrecognized class name suppresses nothing, so a typo fails loud.
- `UPDATE=1` only _lowers_ a baseline. Raising one needs
  `make check-primordials UPDATE=1 RAISE=--allow-raise` and a stated reason (a
  newly scanned file, or a new class). A corrupt baseline fails hard rather than
  inviting a rebaseline.
- **One vector is still on you**, outside the four counted classes: an object
  literal indexed by a caller-supplied key (label/scheme/header/encoding tables)
  needs `__proto__: null`. Deciding that a literal is a lookup table read with a
  dynamic key takes dataflow the counter does not have, and a blanket rule would
  fire on every options object.
  A fourth is COUNTED and still wrong, which is the nastiest of the set because the
  fix _looks_ applied: `StringPrototypeReplace/Match/Search/Split` score 0 in
  `method`, yet they route through the spec's RegExpExec, which re-reads `R.exec`
  off the receiver — so a poisoned `exec` steers them straight through the
  primordial. A GLOBAL one does not answer wrongly, it never returns, because
  `lastIndex` only advances on an empty match; that shipped as a remote-triggerable
  hang in `url.js` and `fetch.js`. Validate with `RegExpMatches(re, s)`; there is
  deliberately no `RegExpPrototypeTest`, and for a plain character class prefer a
  code-unit loop over the **captured** `StringPrototypeCharCodeAt` — a live
  `value.charCodeAt(i)` is itself a writable data property (response splitting
  under `HTTP_POISON_REGEXP=charcodeat`). Capture `parseInt`/`Number` used for
  framing conversion the same way (bootstrap on `primordials`); a sound digit
  check beside a live `parseInt` still desyncs Content-Length.
  Two more are uncounted, for reasons worth keeping apart. `for…of`, spread and
  `Symbol.toPrimitive` read a well-known SYMBOL, so there is no named property to
  count. `Object.prototype.then` is the opposite: an ordinary named property that
  IS counted when written (`p.then(cb)` scores 1 `method`), but `await x` and
  `Promise.resolve(x)` read it implicitly, with no member expression in the
  source. It is also a plain data property an ordinary merge gadget can set, so
  treat `await` on a caller-supplied value as a live call.
- "Baseline 0" in a class means no _counted_ site of that class is left — the
  ratchet is a floor, not a proof, and per-class counts are what make it
  readable rather than reassuring. It earned that caveat: `encoding.js` stood at
  0 while `units.buffer` went through the live `%TypedArray%.prototype.buffer`
  getter, which is why the accessor class exists. And a high number is not
  automatically work: `primordials.js` reads 9 in `invoke` **by construction**,
  because every `callerN` wrapper is a `fn.call` — its `global` column is 1,
  since the module-eval rule already exempts the capture table.
- Pick the primordial by **arity**. `callerN` (`ArrayPrototypePush`) carries an
  `arguments` switch and belongs at cold call sites; per-element loops use the
  fixed-arity wrappers (`ArrayPrototypePush1`/`Push2`) or plain indexed writes
  into a preallocated null-prototype array. Getting this wrong cost 1.43x on the
  TextDecoder JS path.
- Nothing transient lands on `globalThis`; natives arrive as the factory's fourth
  argument.
- Errors follow the **profile** ([docs/LARVA.md](docs/LARVA.md) decision 1). Node
  profile: Node-shaped coded errors (`ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`)
  with Node's exact message template. Window profile (anything a page can reach):
  plain `TypeError`/`RangeError`/`DOMException` with Chrome's message and no
  `code`, byte results as plain `Uint8Array`, and no `process`/`require`/`Buffer`
  reachable. Shared Web API code (`url.js`, `encoding.js`, …) takes its error
  constructors and byte helpers from the profile and never imports Node error
  helpers or `buffer` directly.
- Native byte ops should stay behind a size threshold so small inputs skip FFI
  overhead. NOTE: the constant this rule used to name (`NATIVE_BYTEOP_MIN`) does not
  exist — `bytesToString` crosses to a native codec at every size. Treat the rule as
  the intent, not as something the tree already enforces.
- **Contract comments** use JSDoc, already the convention in `buffer.js`, so the
  same block serves editors and any future generator. Same scope rule as §4 —
  exported spec surface, not every closure:

  ```js
  /**
   * Decodes `input` per the WHATWG encoding standard.
   * @param {Uint8Array|ArrayBuffer} [input]
   * @param {{stream?: boolean}} [options]
   * @returns {string}
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — options is a non-null scalar.
   * @node Options are validated BEFORE the input is converted; `decode(5, 5)`
   *       reports the options (node 24, verified).
   * @deviates none
   */
  ```

  `@node` and `@deviates` are repo tags carrying what §1 requires; JSDoc ignores
  unknown tags, so tooling still parses the block.

## 6. Tests

Oracle-first: a behavior is correct when the same script produces byte-identical
output under its oracle and under `bin/lava`. Node profile: the oracle is `node`;
add cases to `tests/node-compat/cases`, `tests/runtime/*`, `tests/std/*`. Window
profile: the oracle is output **recorded from Chrome** (roadmap stage 0), kept with
its source; Node's output is never the expectation for a page-facing surface, and
until a recording exists the behavior is unverified, not passing. Shared Web API
code needs a case per profile. Lava-only Odin tests (`cmd/lava/*_test.odin`,
`pkg/runtime/*_test.odin`) are for what no oracle can see: allocator pairing, probe
latching, pollution resistance, FFI ABI, and isolation between pages and VMs — a
second page in a reused VM must see nothing of the first, which a single-page
test cannot show.

Widening `known-lava-gaps.txt` is a regression and needs an explicit reason.

Two more kinds, both added because hand-picked inputs kept missing edge cases:

- **Differential property tests** — `tests/property/*.property.test.mjs`.
  fast-check generates a seeded corpus on the Node side and drives `bin/lava` as a
  subprocess, one process pair per property, comparing byte-for-byte. For input
  spaces too large to pick by hand (decoders, URL, buffer). `make test-property`,
  in CI, `PROPERTY_RUNS=N` to sweep deeper. It earned its place by finding a
  utf-16le divergence at 5000 inputs that 200 hand-picked ones missed.
- **Build-tooling tests** — `scripts/**/*.test.mjs` under `node:test`,
  `make test-scripts`, run inside `make check-js`.

**Order: contract → red test → implementation.** Write the contract comment
(§4/§5) from a real `node` probe, then the tests, and watch them fail _before_
there is anything to pass them. A test authored after the code routinely asserts
less than its comment claims, and nothing catches that — two tests landed that
way in #320, both with confident comments, and mutation is what exposed them.

**A test is not done until a mutation has failed it.** Delete or invert the line
it claims to pin, re-run, and confirm it goes red for the stated reason; then
restore. The red phase of test-first gives this for free — for a test added
afterwards it is a separate, mandatory step.

For anything on a user-visible surface, a security property, or a gate script,
**record the mutation** in `tests/mutation-manifest.json` instead of only doing it
once by hand: `make test-mutation` re-applies it in CI and fails if the test
survives. Doing it by hand depends on remembering to, and that is exactly how the
three examples below got in — each passed, and each passed just as well with the
code it claimed to pin deleted. The runner refuses to report unless the tree is
clean, each `find` is unique, and every gate is green _before_ mutating; a stale
entry is a failure, not a skip. Two examples of what this catches,
both real: an assertion that holds equally with and without the code under test
(a failed `map_insert` stores nothing either way, so `!hit` proved nothing), and
an assertion aimed at memory the test cannot observe (net connections are freed
under `runtime.default_context()`, so no tracking allocator ever sees them —
the census had to move to `/proc/self/fd`), and an assertion whose _setup_ threw
before reaching the code under test — `obj + name` as a map key coerces
`%TypedArray%.prototype` and calls `join` on an incompatible receiver, so the case
printed `THREW:TypeError` on both runtimes: byte-identical, which is exactly what
the oracle model reads as success. A third shape worth naming because it is
invisible on inspection: a test whose _scaffolding_ suppresses the condition under
test — an event-loop case used a timer to avoid needing a thread, and a pending
timer gives `platform_poll` a positive timeout, which counts as progress by itself,
so the no-progress tick being tested never occurred.

## 7. PR contract

Title: `type(scope): imperative summary` (`feat(net):`, `perf(url):`,
`fix(http):`, `harden(url):`, `build(js):`, `refactor(runtime):`).

Every PR body states: what changed, the reuse verdict (§2), which gates were run
with results, Node-parity evidence (or the justified deviation), and bench numbers
if perf is claimed. Run `/pr-gate` before asking for review.

## 8. Agents in this repo

Playbooks a human invokes as slash commands. Nothing here self-starts — every
command runs only because someone typed it — but a command, once typed, is
**conducted**: the session's own model (run it on the strongest available)
decides, briefs and rules; workers pinned to cheaper models do the reading,
the gates and the code, and answer in ≤40 lines.
[agents/prompts/conductor.md](agents/prompts/conductor.md) is that protocol.

| Command         | Role                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `/odin-feature` | Implement with TDD (reuse scout → design → red test → code); `--fix` closes pr-gate findings or red gates |
| `/pr-gate`      | Hard merge gate: tests + specialists → SHIP / SHIP-AFTER / BLOCK                                          |
| `/planner`      | Build task DAG from GitHub issues                                                                         |

| Worker                    | Model  | Owns                                                       |
| ------------------------- | ------ | ---------------------------------------------------------- |
| `odin-implementer`        | opus   | All edits to the tree — features and fix rounds            |
| `regression-hunter`       | opus   | Correctness gate                                           |
| `safety-security-auditor` | opus   | Native-safety and Security gates                           |
| `oracle-test-auditor`     | opus   | Criterion 1 (oracle parity) and the Test-coverage gate     |
| `perf-memory-auditor`     | opus   | Criterion 2 (speed and memory)                             |
| `quality-docs-auditor`    | sonnet | Code-quality and Documentation gates                       |
| `odin-sdk-scout`          | sonnet | Reuse verdicts (§2)                                        |
| `gate-runner`             | sonnet | Running the mechanical gates; the conductor never runs one |

- **Playbooks:** [agents/prompts/](agents/prompts/) — the canonical text each command follows.
- **Specialists:** [agents/specialists/](agents/specialists/) (mirrored under `.claude/agents/` for harness discovery).
  A specialist pins `model: opus` or `sonnet` — never `inherit`, which would bill
  volume work at the conductor's rate — and carries the reply contract from
  [report-contract.md](agents/prompts/conductor-reference/report-contract.md).
  `scripts/agents-mirror.test.mjs` enforces both.
- **Gate integrity:** `runtime/gates/integrity.mjs` is Lava's own machinery, not the
  agent system's — a PreToolUse hook blocks env/flag bypasses that turn a gate green
  without a fix, and `runtime/gates/assert-case-counts.mjs` backs four oracle runners.
- **PR only after successful `pr-gate`.** Merge to master is always human.
