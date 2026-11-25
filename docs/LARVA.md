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

1. **Layered core, two global profiles.** Base layer: JSC, event loop, network,
   Web APIs. On top, a **Node** profile (Lava as it is today) and a **Window**
   profile (a page). The Window profile is not "Node minus a few globals": no
   `process`, `require` or `Buffer` anywhere a page can reach, errors are plain
   `TypeError`/`DOMException` with browser messages and no Node `ERR_*` codes, and
   byte results are plain `Uint8Array`. Shared Web API code (`url.js`,
   `encoding.js`, …) takes its error constructors and byte helpers from the
   profile instead of from `buffer`/Node error helpers.
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
     be attributed and capped. Pools are fixed-size: every VM ever created keeps
     one `timerfd` open for the life of its thread (the timer is the thread's
     `WTF::RunLoop`'s; a dispatcher worker's close when it ends — 6 open while
     its workers live (3 workers × 2 slots), 0 after join, pinned by `dispatcher_closes_its_descriptors`),
     so retiring a VM is a rare, fd-budgeted event (heap runaway), not a routine
     step. A runner samples every Nth page's heap per VM into `Result.heap_bytes`
     (`Page_Runner.heap_sample_every`, off by default; never a killed or cancelled
     page). The sample is the heap's capacity — `JSGetMemoryUsageStatistics`'
     `heapCapacity`, since its `heapSize` is the last collection's mark count and
     reads 0 before the first one — and the call walks the heap: sampling every page
     took a trivial page from 133 to 109 pages/s and a page keeping 50k objects
     from 107 to 54 (`bench/pages`, N = 10, 1000 pages, medians of 7 interleaved
     launches per arm). Nothing acts on the sample yet. Measured: a warm VM
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
   - the pool bounds the per-VM `timerfd` leak (`runtime.odin`), and a warm VM
     runs a page in ~41% less time: 7.40 vs 12.61 ms/page, `bench/jsc-vm`
     scenario C (one warm pooled VM) vs A (a fresh VM per page), each page
     evaluating 8 embedded runtime modules plus a 200k-iteration loop, mean of
     100 pages per launch, medians of 5 interleaved launches per arm.
   - **one event loop per page**, interleaved by a per-thread page runner
     (`page_runner.odin`): closing a page closes its loop, which cancels
     everything the page registered, so nothing can fire into the next page
     that reuses the VM. No page loop blocks on its own; when no page can
     progress the runner blocks on every page loop's descriptor at once,
     bounded by the nearest timer;
   - closing a page never waits for blocking pool work (#34). A page whose
     loop still has a worker inside a job — an `fs` read on a FIFO, a `fetch`
     or `node:dns` lookup the resolver has not answered — has its JS side torn
     down at once (VM, `Runtime_State`, context; every callback of the job
     released while the context lives), and its loop, pool and wakeup pipe
     move to the runner's **reaping list**. The runner waits on the loop's
     wakeup pipe through its epoll set and finishes the loop when the worker
     exits. The list is bounded (8 by default, `Page_Runner.reap_limit`); at
     the bound `page_runner_open` refuses with `Kill_Reason.Reaping_Full`,
     since a page reading a FIFO nobody writes never releases its entry.
     `page_runner_destroy` detaches, it does not join: the last worker of a
     detached loop frees it. Page loops are on the heap, never on the runner
     allocator, so the embedder may free that allocator as soon as destroy
     returns; nothing is leaked once the workers exit, but each blocked
     worker keeps its thread and its loop's two pipe descriptors until then;
   - Pages on one thread still share its CPU; threads are sized to cores. A runner
     page must carry a CPU budget (`page_runner_open` refuses one without), and a
     page that spins is killed alone. Until then it delays its siblings by up to its
     **budget**, not its entry limit: one tick fires every timer already due, so a
     page that queues many timers holds the thread for all of them. Slicing a tick
     is open work (#35).
   - **threads:** a page dispatcher (`page_dispatcher.odin`) runs N worker
     threads, each driving its own page runner and VM pool. A page goes to the
     worker with the fewest pages queued or running, queues there while that
     worker's slots are full, and stays on it for its whole life; its Result comes
     back through `on_done` on that worker. Shutdown drains every accepted page
     or cancels them, between ticks — so a page inside one synchronous entry ends
     at its entry limit or budget, since stopping it sooner needs the VM lock its
     thread holds. Not built on `workers.odin`: that is a process per worker
     sharing a listen socket, which would put every VM pool behind IPC; a
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
     - The process fd table is shared. Under the Node profile a page can leak
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
| 4   | **Window** — DOM bindings, script execution (sync/defer/async/module), XHR, `location`/`history`, storage, `MutationObserver`, profile-driven `navigator`/`screen`/timezone, plausible fake geometry                                                                                                                                | Oracle JS pages match after `load`                                                        | Not started | [#12](https://github.com/x-ror/larva/issues/12), [#13](https://github.com/x-ror/larva/issues/13), [#14](https://github.com/x-ror/larva/issues/14)                                          |
| 5   | **HTTP server & adapter** — stateless HTTP crawling API: selector and DOM wait conditions, network-idle wait across XHR **and** `fetch`, custom script evaluation with async and scroll helpers, interaction actions DSL, cookie and network capture, response metadata headers, structured error codes, hard per-page kill timeout | Drop-in backend behind per-domain A/B routing                                             | Not started | [#15](https://github.com/x-ror/larva/issues/15)                                                                                                                                            |
| 6   | **Scale and CDP** — memory limits per page, recycling, then CDP for Puppeteer/Playwright                                                                                                                                                                                                                                            | —                                                                                         | Not started | [#16](https://github.com/x-ror/larva/issues/16), [#17](https://github.com/x-ror/larva/issues/17)                                                                                           |

Status as of 2026-11-14. The issues are the source of truth; this column is updated
in the PR that changes a stage's state.

Stage 1 so far, on the Node profile and the `.Web` global surface:

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
  tracking allocator, and the VM's protect count across pages.

Still open in stage 1: acting on a heap sample (killing or retiring a VM) and the
Window profile.

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
