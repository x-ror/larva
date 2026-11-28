# Larva

> _larva_ (lat.) — a ghost; a mask. A browser with no body and no face — and one
> letter away from Lava, the runtime it grows out of.

Larva is a lightweight headless browser: an HTML parser, a DOM and a JavaScript
engine with no rendering, driven over an HTTP API and, later, the Chrome
DevTools Protocol. It is built on Lava — the JavaScriptCore bindings, the event
loop and the Web APIs (`fetch`, `URL`, Streams, timers) are reused, and the
browser layer is added on top.

Larva targets high-throughput JavaScript crawling workloads where pipelines
otherwise spawn a fresh Chromium process per request (typically 2–26 concurrent
per host). It handles the bulk of that traffic inside a single multi-context
process: navigate → load → wait for selector or network idle → run a script or
actions → return the serialized DOM, status, headers and cookies.

## Non-goals

The engine does not lay out or paint. Anything that needs real layout or pixels
is outside the core: screenshots, PDF, video, coordinate-based clicks,
slider/Turnstile captchas, canvas/WebGL fingerprint surfaces, and sites gated by
JS sensor scripts (Akamai `sensor_data`, PerimeterX). A per-domain router (fed by
the oracle below) decides which traffic goes to Larva and which goes to Chrome.

"Outside the core" is not "never available". Those capabilities are served by
extension modules (decision 6) — first by handing the request to a Chrome
fallback behind the same API, later by a real layout engine plugged in where the
core has fake geometry. Sensor-script and captcha sites stay on Chrome either way.

## Architecture decisions

1. **Layered core, one global profile.** Base layer: JSC, event loop, network,
   Web APIs. On top, the **Window** profile (a page). It is not "Node minus a few
   globals": no `process`, `require` or `Buffer` anywhere a page can reach, errors
   are plain `TypeError`/`DOMException` with browser messages and no Node `ERR_*`
   codes, and byte results are plain `Uint8Array`. The **Node** profile Lava started
   with (CommonJS, `node:*` modules, `process`, `Buffer`, the ESM transform) was
   removed in stages S3–S5b; `lava run` and `lava eval` run with the Window globals
   only, and the oracle is recorded Chrome output (tests/web).
2. **One VM per top-level page, many VMs per thread, VMs pooled.** A `JSContextGroup` is
   one `JSC::VM`: one GC heap, one lock, one microtask queue that JSC drains at
   every exit from the C API. Pages therefore never share a VM — sharing one
   would let page A run page B's promise jobs and would make per-page heap size
   unmeasurable. Each worker thread drives many pages,
   each in its own VM with its own event loop (below). VMs come from a per-thread pool and are reused
   sequentially, one page at a time:
   - a VM is only ever entered by its owning thread;
   - **same-origin iframes** live in their page's VM, as extra globals created
     with `JSGlobalContextCreateInGroup`: the parent reaches
     `iframe.contentWindow` synchronously, and JSC objects only pass between
     contexts of one group. They share the page's arena, session and lifecycle.
     Cross-origin iframes get an opaque `WindowProxy`;
   - **CPU kill:** `JSContextGroupSetExecutionTimeLimit` per VM. The watchdog
     measures time since VM entry, so a runaway script is stopped without
     touching other pages. It only covers one synchronous entry, so the page
     also sums `CLOCK_THREAD_CPUTIME_ID` over its runtime install, top-level
     script and every event-loop tick (`vm_cpu_enter`/`vm_cpu_exit`), and is
     killed when the total passes its CPU budget. The watchdog is clamped to
     the budget left (re-armed when that shrinks by more than a tenth), so one
     long entry overruns it by at most about 10%, and a kill latches: whatever
     the page still reaches after it is cut at once. Both limits act at JS traps
     and callback boundaries only; a long native call is not interrupted. Wall-clock
     page deadlines are event-loop timers;
   - **memory:** the VM's heap belongs to one page at a time, so heap growth can
     be attributed and capped. Pools are fixed-size. A VM's `timerfd` (its timer
     on the thread's `WTF::RunLoop`) used to stay open for the life of the thread;
     the timer's source closes it only when the RunLoop's GLib context is iterated,
     and Lava now drives that context (#91: `pkg/jsc/runloop_linux.odin`), so
     destroying a pool's VMs closes their fds (`vm_pool_releases_its_timerfds`) and
     retiring a VM costs no descriptor. A runner samples every Nth page's heap per
     VM into `Result.heap_bytes`
     (`Page_Runner.heap_sample_every`, off by default; never a killed or cancelled
     page). The sample is the heap's capacity — `JSGetMemoryUsageStatistics`'
     `heapCapacity`, since its `heapSize` is the last collection's mark count and
     reads 0 before the first one — and the call walks the heap: sampling every page
     took a trivial page from 133 to 109 pages/s and a page keeping 50k objects
     from 107 to 54 (`bench/pages`, N = 10, 1000 pages, medians of 7 interleaved
     launches per arm). A sample at or above 16 MB has the VM collected before its
     next page (`HEAP_COLLECT_BYTES`, `page.odin`): JSC's GC activity timers are
     off with the RunLoop drive (a driven full-GC timer crashes this embedding), and
     this stands in for them where the heap is known to be large — on the heavy shape
     with every page sampled, 131 pages/s and 27396 KB RSS growth per VM against
     master's 96 and 66263. A VM is **retired** — destroyed at `vm_release` and
     replaced by a fresh one on the next acquire — once it has hosted 200 pages or a
     heap sample taken on it reached 64 MB, whichever comes first
     (`VM_RETIRE_AFTER_PAGES`, `VM_RETIRE_HEAP_BYTES`, `vm_pool.odin`; thresholds
     approved 2026-11-26; per runner on `Page_Runner.pool`, 0 turns a trigger off;
     eval's thread pool applies the same defaults). The heap trigger reads only the
     samples `heap_sample_every` takes, since the read walks the heap; an unsampled
     VM is bounded by the page cap. A retirement iterates the RunLoop once, so the
     VM's `timerfd` goes with it, and costs one cold page (~5.2 ms, `bench/jsc-vm`
     A vs C). On `bench/pages` (N = 10, 4000 pages, medians of 7 interleaved launches
     per arm, -o:speed, Ryzen 7 7700X, load average ~2) retiring at 200 against
     never: trivial pages 448 vs 346 pages/s and 295620 vs 344484 KB end RSS growth,
     pages keeping 50k objects 330 vs 280 pages/s and 525708 vs 541096 KB — 20
     retirements in each run. Faster, not slower; why was not profiled. A page can
     also carry its own **heap limit** (`Page_Limits.heap_bytes`, 0 = off): over it
     after a full collection, the page is killed alone (`Kill_Reason.Heap_Limit`,
     through the CPU-budget kill's Result path, the reading in `Result.heap_bytes`)
     and its VM retired whatever the pool's thresholds. The same reading is taken
     between the page's steps — after its install, its top-level script, each
     `page_eval` and element script and each tick, on the loop thread, never inside an
     entry — on a schedule amortised against its cost: ~0.85 ms per MB of heap walked
     (0.16-0.25 ms at 441 KB, 80 ms at 92 MB; a throwaway probe, medians of 9 reads,
     two launches, 4-core Xeon @ 2.10GHz), so a page with a steady heap is read again
     after 16 times the last read's CPU (≤ ~6% of its CPU), one heading for its limit
     sooner, and a page growing steadily is killed by about 1.5x its limit (1.02-1.41x
     of 8 MB in `runner_kills_a_page_over_its_heap_limit_alone`, thirty runs). One entry that
     allocates without returning is not checked until it returns: the entry limit and
     the CPU budget bound it (`page_heap_check`, `page.odin`). Measured: a
     warm VM
     stays flat over 500 pages (`bench/jsc-vm` scenario G), and 50 bare JSC VMs
     each holding one page add 4999 KB of RSS apiece (`bench/jsc-vm` scenario D,
     medians of 5 launches, same machine as below) — raw JSC contexts after a
     process warm-up, so lower than the page-runner figures below, which add the
     Lava runtime and loop per page and count JSC's process init;
   - reuse keeps JSC's `CodeCache` warm, so the embedded runtime JS is not
     recompiled for every page. Context start-up cost is measured (stage 1) and
     the Web API surface is installed lazily where it is not. `make bench-pages`
     (bench/README.md, commit `aee73e1`, 4-core Xeon @ 2.10GHz, medians of 5
     launches per N, 1000 pages per launch, 30 s CPU budget per page), at N = 10..100
     concurrent pages on one thread: ~24 ms per page on a cold VM, ~10-11 ms warm,
     ~110 pages/s, 4463-6233 KB whole-process RSS growth per live page, and
     18688-26254 KB per VM created after churn. That last column is an
     upper bound — JSC process init, heaps `vm_release` leaves uncollected (it runs
     no GC) and malloc's high-water mark, with per-VM and per-run cost inseparable
     — not what an idle pooled VM keeps; N = 1 is dominated by process init. The
     Node-profile install is the whole cost today; the Window profile's is measured once it exists (#5);
   - a warm VM runs a page in ~41% less time: 7.40 vs 12.61 ms/page, `bench/jsc-vm`
     scenario C (one warm pooled VM) vs A (a fresh VM per page), each page
     evaluating 8 embedded runtime modules plus a 200k-iteration loop, mean of
     100 pages per launch, medians of 5 interleaved launches per arm.
   - **one event loop per page**, interleaved by a per-thread page runner
     (`page_runner.odin`): closing a page closes its loop, which cancels
     everything the page registered, so nothing can fire into the next page
     that reuses the VM. No page loop blocks on its own; when no page can
     progress the runner blocks on every page loop's descriptor at once,
     bounded by the nearest timer;
   - **JSC's own deferred work** (a `FinalizationRegistry` cleanup) is queued on
     the thread's `WTF::RunLoop`, one per thread whatever its VM count. Lava drives
     it at thread level, never inside a page's tick: the runner between rounds, and
     a page that drives its own thread (eval, `lava run`, workers) before each tick.
     What runs there for a page is a shim that posts to the page's own loop
     (`js/internal/deferred.js`; the registry holds the shim through a native
     `FinalizationRegistry` constructor), so the callback runs in the page's tick,
     charged to its budget, and a closed page's runs nowhere. `WebAssembly.compile`
     and `instantiate` stay off the RunLoop: the engine's settlement there runs page
     code (a start function, a `then` getter) outside every window, so Lava compiles
     in the caller's entry and settles a task later on the page's loop
     (`pkg/runtime/wasm.odin`);
   - one worker pool per runner thread (#36), not one per page: every page
     loop is a client of the runner's `eventloop.Worker_Pool`, four core
     threads shared by all its pages instead of four per page that touched
     the pool. Clients are served round-robin, at most four jobs running each;
     a page left waiting while the oldest running job is older than 10 ms and
     no worker is idle gets an overflow worker (at most 32 workers serving
     live pages; extra workers exit after 1 s idle), so a page whose lookups hang does not starve its
     siblings;
   - closing a page never waits for blocking pool work (#34). A page whose
     job is still running — an `fs` read on a FIFO, a `fetch` or `node:dns`
     lookup the resolver has not answered — has its JS side torn down at once
     (VM, `Runtime_State`, context; every callback of the job released while
     the context lives) and its loop closed: the job becomes an **orphan**
     that its worker finishes and disposes alone, and no completion can reach
     the closed loop (a worker posts only to an open client, under the pool's
     lock). Orphans count neither toward the four core workers nor toward the
     32-worker cap, so they never take the threads live pages run on. They are
     bounded (32 by default, `Page_Runner.orphan_limit`); at the bound
     `page_runner_open` refuses with `Kill_Reason.Reaping_Full`, since a page
     reading a FIFO nobody writes never releases its thread.
     `page_runner_destroy` does not join: the pool's last worker frees it. The
     pool, its jobs and the page loops are on the heap, never on the runner
     allocator, so the embedder may free that allocator as soon as destroy
     returns; each blocked worker keeps its thread until its job returns;
   - Pages on one thread still share its CPU; threads are sized to cores. A runner
     page must carry a CPU budget (`page_runner_open` refuses one without), and a
     page that spins is killed alone. A tick also has a CPU **quantum**
     (`Page_Runner.slice_us`, 1 ms by default, #35): once a tick has spent it, the
     page's timers phase suspends before its next timer task — the whole turn pauses,
     no later phase runs — and the runner ticks the siblings before resuming it with
     the same sequence limit, so the order within the turn holds (eventloop case 14
     and the Chrome-recorded timer orders, run sliced by
     `runner_slicing_keeps_event_loop_order`). The
     check reuses the per-callback CPU clock read of the budget, so it adds one
     compare per callback. A sibling then waits at most about the quantum plus one
     callback behind a page with a pile of due timers, instead of up to that page's
     budget. `bench/pages sibling 100000 10` (one thread, 10 pages on a 1 ms
     interval beside one page with 100k timers due in one tick, medians of 7
     interleaved launches per arm, 16 cores, taken while a game held one core):
     the worst sibling gap is 322.83 ms with no quantum, 4.22 ms at 1 ms and
     4.23 ms at 250 µs, where 4 ms is one callback the probe spins on purpose;
     alone, that page's 100k timers take 348.38, 345.26 and 347.71 ms — no cost
     above the noise. Runner pages only: `eval`, `page_eval` and
     `page_run_until` never slice, since `page_run_until`'s `cond` may evaluate script
     between two ticks. Still unbounded by the quantum, each up to the entry limit and
     budget: one long callback; a microtask or promise flood inside one drain (JSC
     drains on C-API exit); the top-level script (registering 100k timers took 124 ms
     inside `page_runner_open`); `page_close` of a page holding many handles; and the
     Node-profile check, I/O-callback and close phases, which do not suspend.
   - **threads:** a page dispatcher (`page_dispatcher.odin`) runs N worker
     threads, each driving its own page runner and VM pool. A page goes to the
     worker with the fewest pages queued or running, queues there while that
     worker's slots are full, and stays on it for its whole life; its Result comes
     back through `on_done` on that worker. Shutdown drains every accepted page
     or cancels them, between ticks — so a page inside one synchronous entry ends
     at its entry limit or budget, since stopping it sooner needs the VM lock its
     thread holds. Not built on Lava's `workers.odin` (deleted with the Node
     profile): that was a process per worker sharing a listen socket, which would put every VM pool behind IPC; a
     supervisor wanting process isolation runs one dispatcher per process.
     Throughput with 10 slots per worker, 2000 trivial pages submitted at once:
     122, 230 and 354 pages/s at 1, 2 and 4 workers (`bench/pages dispatch`,
     medians of 7 interleaved launches, the same 4-core box). Threads are not
     "a few per process": JSC starts a collector thread per VM, so a dispatcher
     runs about workers × slots threads plus a constant. Counted from `/proc`
     4 s into `bench-pages dispatch T 10 1500`, one launch each: 17 threads,
     34 fds and 241 MB VmRSS at 1 worker; 53 threads (40 of them "Collector
     Thread"), 148 fds and 659 MB at 4. The dispatcher's own share is one
     thread, a wake pipe and an epoll set per worker; the rest is the per-VM
     cost multiplied (#36);
   - Known limits of the runner, open as issues:
     - The process fd table is shared. Under the old Node profile a page could leak
       descriptors to `EMFILE` or `closeSync` a sibling's; the runner is not a
       security boundary there. The Window profile has no `fs`, which is what
       isolates descriptors between untrusted pages (#37).
     - Each page loop starts its own 4-thread worker pool on first use (#36).
   - every process-global and thread-local is audited for page isolation in
     [GLOBAL-STATE.md](GLOBAL-STATE.md); a new one is added there in the same PR.
3. **Network stack with client profiles; network state belongs to the session.**
   BoringSSL instead of OpenSSL, HTTP/2 through nghttp2 (I/O-agnostic, driven
   from our transport; a hand-written H2 stack is not worth its edge cases as
   long as nghttp2 lets profiles set every wire knob), and named profiles
   (e.g. `chrome_142_mac`) that set the TLS ClientHello, H2 SETTINGS and
   pseudo-header order, header order and Client Hints together so they always
   match the User-Agent. Used by both `fetch` and the page loader. The H2/H1
   connection pool, TLS session tickets, proxy tunnels and the cookie jar belong
   to a **session**, not to the process or thread. Within a session, requests to
   one origin multiplex over one H2 connection, as Chrome does; between sessions
   nothing is shared. A session is one page by default. A caller can keep a
   session alive across pages on purpose (sticky sessions).
4. **The DOM lives in Odin; JSC holds wrappers.** The tree sits in a per-page
   arena and is freed with the page.
   - **Wrapper rule.** A node's wrapper is created lazily, recorded in the page's
     `node → JSObjectRef` map and `JSValueProtect`ed until the page closes. This
     keeps wrapper identity (`a.firstChild === a.firstChild`) and expando
     properties (framework fields, listeners) stable for the page's short life.
   - **Teardown order.** For every wrapper: `JSObjectSetPrivate(nil)`, then
     unprotect. Only then `free_all` the arena. Finalizers and late callbacks must
     treat a nil private pointer as "page gone". With pooled VMs, wrappers outlive
     the arena until the next GC, so this ordering is mandatory.
   - **Streaming parser.** HTML is parsed with lexbor at first, behind our own
     interface so it can be replaced. That interface is incremental: it accepts
     network chunks, pauses at a parser-blocking `<script>` (fetch it, run it
     against the partial tree), accepts `document.write` input into the
     tokenizer stream, then resumes. Fragment parsing (`innerHTML`) builds into
     the live tree. A batch `parse(string) → Document` API is not the design.
   - **Parser decision (#10, settled 2026-11-18).** lexbor, unmodified, as the
     tokenizer and tree builder (`pkg/html`, #68). lexbor has neither the pause
     nor `document.write` — its tree builder leaves both as `TODO` at
     `</script>` — and needs neither, because the caller holds the input:
     slices handed to lexbor never run past a script end tag, a C shim on its
     token callback reports which script that tag closed, and written text is
     parsed at the insertion point before the rest of the input. So no fork of
     lexbor and no own tokenizer. The comparison of "lexbor as the DOM" against
     "lexbor tokenizer + our own tree builder" on real pages waits for the
     oracle corpus (#2); until then lexbor's tree is the DOM, and the wrapper
     rule above applies to its nodes.
5. **Wire protocols stay in adapters.** The HTTP crawling server contract,
   domain routing lists and compatibility shims live in an adapter package
   (`pkg/adapters`), keeping the browser engine independent of any single
   caller's wire format.
6. **Open core; extensions attach at named seams.** The core in this repository
   is AGPL-3.0 and is complete by itself: parser, DOM, script execution, network
   stack, the HTTP API and CDP. Extension modules live in a separate repository
   under a commercial licence and are compiled in as an extra Odin collection,
   producing a second binary — Odin has no stable plugin ABI, so there is no
   runtime loading. JavaScriptCore is LGPL, so both binaries link it dynamically.
   - **The rule for what goes where.** The core holds whatever one developer needs
     for the engine to be correct and fast. An extension holds what an
     organisation needs around it: rendering, fleet management, managed
     identities, recording, tenancy. The core never ships a stub that exists only
     to be unlocked, and no core gate depends on an extension being present.
   - **Seams.** An extension may only attach where the core defines an interface,
     and each interface has a working core implementation:
     - _geometry provider_ — the core's implementation returns the plausible fake
       geometry of stage 4; a layout engine replaces it. DOM bindings read
       geometry only through this interface, never from the tree directly;
     - _DOM mutation hooks_ — a subscriber is told about every tree change, which
       is what a layout engine or a DOM recorder needs. `MutationObserver` is the
       core's own subscriber;
     - _client profiles as data_ — a profile (decision 3) is a file, not code, so
       adding or updating one never needs a rebuild of the core;
     - _session hooks_ — proxy selection, cookie and storage persistence, and
       connection events are callbacks on the session;
     - _request router_ — the per-domain decision to serve a request in Larva or
       hand it elsewhere is an interface in the adapter layer (decision 5).
   - **Cost rule.** A seam with no subscriber costs one predictable branch on the
     path it sits on. A seam that would cost more on a hot path needs a
     `make bench` number before it lands, as any other perf-relevant change does.
   - None of these seams exists yet. Each is introduced by the stage that builds
     its core implementation, not ahead of it.

## Roadmap

| #   | Stage                                                                                                                                                                                                                                                                                                                               | Done when                                                                                 | Status      | Issues                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | **Oracle** — record what Chrome returns (HTML, status, cookies) for 100–200 URLs from real JS traffic                                                                                                                                                                                                                               | Every later stage is measured against it                                                  | Not started | [#2](https://github.com/x-ror/larva/issues/2)                                                                                                                                              |
| 1   | **Multi-VM core** — per-page `Runtime_State`, VM pool per thread, execution limits, Window profile skeleton, start-up cost measured                                                                                                                                                                                                 | N pages run concurrently in one process with isolated VMs; a runaway page is killed alone | In progress | [#3](https://github.com/x-ror/larva/issues/3), [#4](https://github.com/x-ror/larva/issues/4), [#5](https://github.com/x-ror/larva/issues/5)                                                |
| 2   | **Network** — BoringSSL, HTTP/2 (nghttp2), per-session connection pool and TLS sessions, CONNECT proxies, cookie jar, redirects, gzip/brotli/zstd, Chrome client profiles                                                                                                                                                           | ClientHello and H2 fingerprints match the claimed Chrome version                          | In progress | [#6](https://github.com/x-ror/larva/issues/6), [#7](https://github.com/x-ror/larva/issues/7), [#8](https://github.com/x-ror/larva/issues/8), [#9](https://github.com/x-ror/larva/issues/9) |
| 3   | **HTML + DOM** — streaming parser (pause/resume at `<script>`), tree, mutation, events, serialization, CSS selectors, XPath, shadow DOM, same-origin iframes; `larva fetch URL`                                                                                                                                                     | Static pages serialize like the oracle                                                    | Not started | [#10](https://github.com/x-ror/larva/issues/10), [#11](https://github.com/x-ror/larva/issues/11)                                                                                           |
| 4   | **Window** — DOM bindings, script execution (sync/defer/async/module), XHR, `location`/`history`, storage, `MutationObserver`, profile-driven `navigator`/`screen`/timezone, plausible fake geometry                                                                                                                                | Oracle JS pages match after `load`                                                        | In progress | [#12](https://github.com/x-ror/larva/issues/12), [#13](https://github.com/x-ror/larva/issues/13), [#14](https://github.com/x-ror/larva/issues/14)                                          |
| 5   | **HTTP server & adapter** — stateless HTTP crawling API: selector and DOM wait conditions, network-idle wait across XHR **and** `fetch`, custom script evaluation with async and scroll helpers, interaction actions DSL, cookie and network capture, response metadata headers, structured error codes, hard per-page kill timeout | Drop-in backend behind per-domain A/B routing                                             | Not started | [#15](https://github.com/x-ror/larva/issues/15)                                                                                                                                            |
| 6   | **Scale and CDP** — memory limits per page, recycling, then CDP for Puppeteer/Playwright                                                                                                                                                                                                                                            | —                                                                                         | Not started | [#16](https://github.com/x-ror/larva/issues/16), [#17](https://github.com/x-ror/larva/issues/17)                                                                                           |

Status as of 2026-11-14. The issues are the source of truth; this column is updated
in the PR that changes a stage's state.

Stage 1 so far, on the Window global surface (the only one since S5b):

- the page (`pkg/runtime/page.odin`: `Page`, `page_open`/`page_tick`/`page_close`),
  one global context and one event loop per page, which `eval` and the page runner
  (`page_runner.odin`) both drive; the cumulative CPU budget (`Page_Limits`);
- the persistent page: `page_open` split into `page_create` + `page_run_script`, and
  on a live page `page_eval` (one more script; a throw fails the call, not the page)
  and `page_run_until` (tick until a condition, idle, a deadline, or the page ends),
  pinned by `cmd/lava/page_api_test.odin`;
- the per-thread VM pool (`pkg/runtime/vm_pool.odin`); `eval` runs in a pooled VM
  on Linux and macOS, while Windows still creates a VM per context;
- the per-entry execution limit (`vm_set_entry_limit`), exercised only by
  `cmd/lava/vm_pool_test.odin` — nothing sets it for real work yet;
- VM cost measurements (`bench/jsc-vm`) and the global-state audit
  ([GLOBAL-STATE.md](GLOBAL-STATE.md));
- the page dispatcher over N worker threads and per-page heap sampling
  (`page_dispatcher.odin`, `Result.heap_bytes`; decision 2);
- the Lava-only lifecycle tests in `cmd/lava/page_lifecycle_test.odin`: what a page
  sees of a predecessor that finished in the same VM, a mixed-fate churn under a
  tracking allocator, and the VM's protect count across pages;
- the per-page heap limit (`Page_Limits.heap_bytes`): a page over it after a full
  collection is killed alone with `Kill_Reason.Heap_Limit` and its VM retired, the
  check scheduled between ticks against its own measured cost (decision 2), pinned by
  `cmd/lava/page_heap_limit_test.odin`. No CLI flag: the CLI has none for the CPU
  limits either.

Stage 4a, the first slice of stage 4 (#12): `lava page <file.html>` runs an HTML page
end to end (`pkg/runtime/page_html.odin`) — the document parsed with its inline classic
scripts run as the parser reaches each one, `document` and `window` in scope,
DOMContentLoaded, the loop to idle, then the document printed. The bindings are
hand-written (`pkg/runtime/dom.odin`, `pkg/runtime/js/internal/dom.js`): Node, Element,
HTMLElement and its per-tag subclasses, Document, CharacterData, Text, Comment,
DocumentType, DocumentFragment, NodeList and HTMLCollection, with events propagating
along the tree. Wrappers follow decision 4's rule — one JSClass per interface, made
lazily, recorded and protected until the page closes, private slot cleared before the
document is freed — pinned by `cmd/lava/dom_page_test.odin`; the behaviour is compared
with Chrome by tests/dom's `*.page` cases. Left for 4b: a WebIDL generator, live
collections, `window` as an EventTarget and `load`, and reflected attributes.

Script execution beyond inline classic scripts (#13, `pkg/runtime/page_script.odin`):
parser-blocking external scripts (`<script src>`, read beside the page and run with the
parser paused, then the element's `load` or `error`), `defer` scripts between the
`interactive` readystatechange and DOMContentLoaded, `async` and script-inserted
external scripts as tasks on the page's loop before `load`, inline scripts a script
inserts run during the insertion, `document.currentScript`, and `document.write` while a
parser-inserted script runs (parsed before write returns). Each is a recorded
`dom-script-*.page` case. Not there: module scripts (the JavaScriptCore C API has no
module loader; a known gap), fetching a `src` over the network (a `lava page` document
is a file, so a `src` is a file beside it; an http(s) `src` fails its fetch), and
document.write after the parse (Chrome's implicit document.open).

## Risks

- **JS sensor anti-bot** reads canvas/WebGL/audio; without rendering it will
  fail. Those domains stay on Chrome.
- **Infinite scroll** depends on geometry (`scrollHeight`,
  `IntersectionObserver`); fake layout will not satisfy every site.
- **Web compatibility** only shows on real sites — hence the oracle first.
- **Engine fingerprint.** JSC, not V8, produces error messages (`undefined is
not an object` vs `Cannot read properties of undefined`), `Error.stack` format
  and some `Function.prototype.toString` output. Wrappers cannot fully hide
  this. Scripts that probe engine behaviour can tell Larva from Chrome, and the
  oracle has to show how many sites do.
