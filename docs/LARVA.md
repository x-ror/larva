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

Anything that needs real layout or pixels stays on Chrome: screenshots, PDF,
video, coordinate-based clicks, slider/Turnstile captchas, canvas/WebGL
fingerprint surfaces, and sites gated by JS sensor scripts (Akamai
`sensor_data`, PerimeterX). A per-domain router (fed by the oracle below)
decides which traffic goes to Larva and which stays on Chrome.

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
   unmeasurable. Each worker thread owns an event loop and drives many pages,
   each in its own VM. VMs come from a per-thread pool and are reused
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
     one `timerfd` open for the life of the process, so retiring a VM is a rare,
     fd-budgeted event (heap runaway), not a routine step. Measured: a warm VM
     stays flat over 500 pages, and a live VM with a page costs ~15 MB
     (`bench/jsc-vm`);
   - reuse keeps JSC's `CodeCache` warm, so the embedded runtime JS is not
     recompiled for every page. Context start-up cost is measured (stage 1) and
     the Web API surface is installed lazily where it is not. `make bench-pages`
     (bench/README.md): ~19 ms per page on a cold VM, ~7 ms warm, ~160 pages/s on
     one thread at N = 1..100 concurrent pages, and ~18 MB kept per idle pooled VM
     (medians of 5 launches per N, 2026-11-13). The Node-profile install is the
     whole cost today; the Window profile's is measured once it exists (#5);
   - the pool bounds the per-VM `timerfd` leak (`runtime.odin`), and a warm VM
     runs a page in ~41% less time: 7.40 vs 12.61 ms/page, `bench/jsc-vm`
     scenario C (one warm pooled VM) vs A (a fresh VM per page), each page
     evaluating 8 embedded runtime modules plus a 200k-iteration loop, mean of
     100 pages per launch, medians of 5 interleaved launches per arm.
   - **one event loop per page**, interleaved by a per-thread page runner
     (`page_runner.odin`): closing a page destroys its loop, which cancels
     everything the page registered, so nothing can fire into the next page
     that reuses the VM. No page loop blocks on its own; when no page can
     progress the runner blocks on every page loop's descriptor at once,
     bounded by the nearest timer;
   - **threads:** a page dispatcher (`page_dispatcher.odin`) runs N worker
     threads, each with its own page runner, and sends a new page to the
     least-loaded one. Only plain data crosses threads (source text in, Result
     out). Lava's process-based workers (`workers.odin`) are not reused as the
     supervisor: they exist to share a listening socket between processes, and a
     process per worker would put the VM pools behind an IPC hop. A supervisor
     process can still run one dispatcher per process to contain a crash;
   - **heap accounting:** one page holds a VM at a time, so the VM's JS heap
     sampled as the page closes is that page's (`vm_sample_heap`,
     `Result.heap_bytes`). The only exported reader walks the heap — 19 ms on
     a VM holding ~300k objects (three calls on one VM, JSC 2.52) — so the
     runner samples every Nth page per VM, off by default.
     `JSReportExtraMemoryCost` for DOM arena bytes waits for the DOM (stage 3);
   - Pages on one thread still share its CPU. A long synchronous script delays the
     thread's other pages up to the execution limit; threads are sized to cores.
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
5. **Wire protocols stay in adapters.** The HTTP crawling server contract,
   domain routing lists and compatibility shims live in an adapter package
   (`pkg/adapters`), keeping the browser engine independent of any single
   caller's wire format.

## Roadmap

| # | Stage | Done when |
| --- | --- | --- |
| 0 | **Oracle** — record what Chrome returns (HTML, status, cookies) for 100–200 URLs from real JS traffic | Every later stage is measured against it |
| 1 | **Multi-VM core** — per-page `Runtime_State`, VM pool per thread, execution limits, Window profile skeleton, start-up cost measured | N pages run concurrently in one process with isolated VMs; a runaway page is killed alone |
| 2 | **Network** — BoringSSL, HTTP/2 (nghttp2), per-session connection pool and TLS sessions, CONNECT proxies, cookie jar, redirects, gzip/brotli/zstd, Chrome client profiles | ClientHello and H2 fingerprints match the claimed Chrome version |
| 3 | **HTML + DOM** — streaming parser (pause/resume at `<script>`), tree, mutation, events, serialization, CSS selectors, XPath, shadow DOM, same-origin iframes; `larva fetch URL` | Static pages serialize like the oracle |
| 4 | **Window** — DOM bindings, script execution (sync/defer/async/module), XHR, `location`/`history`, storage, `MutationObserver`, profile-driven `navigator`/`screen`/timezone, plausible fake geometry | Oracle JS pages match after `load` |
| 5 | **HTTP server & adapter** — stateless HTTP crawling API: selector and DOM wait conditions, network-idle wait across XHR **and** `fetch`, custom script evaluation with async and scroll helpers, interaction actions DSL, cookie and network capture, response metadata headers, structured error codes, hard per-page kill timeout | Drop-in backend behind per-domain A/B routing |
| 6 | **Scale and CDP** — memory limits per page, recycling, then CDP for Puppeteer/Playwright | — |

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
