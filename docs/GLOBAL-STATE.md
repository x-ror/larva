# Process-global state audit

Larva runs many pages per process. Each page gets its own JSC VM, and each worker
thread drives many pages ([LARVA.md](LARVA.md) decision 2). Any state that outlives
one page is shared with the other pages on that thread (thread-local state) or with
every page in the process (process-global state). This file lists every
package-level variable in `pkg/` and gives each one a verdict, as #4 asks.

Verdicts:

- **shared-safe**: the value is a fact about the process, the build or the linked
  library. It is the same for every page, so sharing it leaks nothing between pages.
- **per-thread OK**: the value is thread-local and holds no page data. A page's VM
  is only entered by its owning thread, so these need no locks.
- **move**: the value carries page- or session-observable state, and it must move
  into the page or session before two pages share a thread.

## How the list was built

All of these were run against `pkg/` and `cmd/`, excluding `*_test.odin`:

- package-level declarations starting at column 0 (`name: T`, `name := v`);
- every `thread_local` attribute, which also finds the indented declarations inside
  `when ODIN_OS` blocks in `pkg/jsc`;
- every identifier with a `g_` prefix at any indentation.

Constants (`::`) are not state and are left out. A new package-level variable must
be added to this list in the same PR.

## Process-global

- `g_hex_val`, `g_b64_val`, `HEX_DIGITS`, `B64_ALPHABET`, `B64URL_ALPHABET` (`buffer_simd.odin:14-18`) — **shared-safe**. Codec lookup tables, filled once by an `@(init)` proc before `main` and read-only after that.
- `ERROR_INTRINSIC_NAMES` (`errors.odin:18`) — **shared-safe**. A read-only name list.
- `fs_mkdtemp_alphabet` (`fs.odin:1023`) — **shared-safe**. `@(rodata)`.
- `g_fetch_cancel_class`, `g_fetch_resume_class`, `g_fetch_push_class`, `g_fetch_end_class` (`fetch.odin:188-279`) — **shared-safe**. A `JSClassRef` does not belong to any context group, so one set serves every VM. `g_fetch_classes_once` makes the lazy creation race-free. The classes hold callbacks only; per-request data sits in each object's private pointer.
- `g_tls_ctx`, `g_tls_ctx_once` (`tls.odin:158-164`) — **shared-safe today, move later**. Today the `SSL_CTX` holds only the trust store, the TLS 1.2 floor and peer verification. It never enables client session caching (no `SSL_CTX_set_session_cache_mode` in the tree), so no ticket from one page can resume a handshake for another. That changes with LARVA.md decision 3: TLS session tickets and the ClientHello profile belong to a **session**, so the context (or at least its session cache) moves into the session object.
- `g_extra_anchors`, `g_extra_anchors_built` (`tls_darwin.odin:379-381`) — **shared-safe**. Platform trust anchors. Darwin is a stub target.
- `output_mutex` (`globals.odin:652`) — **shared-safe**. Serializes stdout/stderr writes so lines from different threads do not interleave. It guards no page data.
- `perf_once`, `perf_origin_tick`, `perf_time_origin_ms` (`globals.odin:892-896`) — **move**. These are `performance.timeOrigin` and the base of `performance.now()`, captured once per **process**. In a browser each document has its own time origin, so a second page reads a `timeOrigin` from before it existed and a `performance.now()` that already counts the earlier pages' run time. A page can also tell how long the process has been up. Both values move into the page's global when the Window profile installs `performance`.
- `net_tls_handshake_timeout_ms_cached` (`net.odin:43`) — **shared-safe**. Caches an environment variable. Racy across threads, but every thread writes the same value (see the comment at the declaration).
- `net_force_readiness_state` (`net.odin:689`) — **shared-safe**. Caches the test-only `LAVA_NET_FORCE_READINESS` switch. Same benign race as above.
- `g_zc_ok_reported`, `g_zc_engaged_reported` (`net.odin:1022-1024`) — **shared-safe**. One-shot stderr diagnostics for `LAVA_ZC_STATS`. They carry no page data.
- `g_multi_worker`, `g_shutdown`, `g_worker_crashed`, `g_worker_exits`, `g_listen_failed` (`workers.odin:57-72`) — **shared-safe**. Supervisor ↔ worker signalling for Lava's multi-worker server mode. They are process lifecycle flags, not page state. A page dispatcher (#4) would add its own signalling and leave these alone.

## Thread-local

- `g_thread_pool`, `g_thread_pool_ready` (`vm_pool.odin:63-66`) — **per-thread OK**. The thread's VM pool itself. A VM holds one live context at a time, so whatever is left in a released VM's heap cannot be reached from the next page's global object. It is collected at the next GC.
- `g_host_native_fns`, `g_host_native_cbs`, `g_host_tables_bound` (`host_natives.odin:121-123`) — **per-thread OK**. Cache of host-created native functions. Keys include the context (`Host_Native_Key.ctx`), and `destroy_runtime_state` sweeps a context's entries while the context is still alive. Because of that sweep, a pooled VM that hands a recycled context address to the next page cannot return the previous page's function objects. Pinned by `cmd/lava/repeated_eval_test.odin`.
- `g_bytes_ptr_mode` (`typed_array.odin:34`) — **per-thread OK**. Records which layout the linked JSC build uses for `JSObjectGetTypedArrayBytesPtr`. It is a fact about the library, and it is the same for every VM.
- `g_view_*`, `g_vec_off`, `g_len_off`, `g_len_u64`, `g_mode_*`, `g_probe_a..d` (`pkg/jsc/private_view.odin:53-73`) — **per-thread OK**. Private-ABI probe results: field offsets in JSC's ArrayBufferView. They describe the library's layout, not a VM, so they hold for every VM on the thread. The `g_probe_*` buffers are scratch space for the self-test.
- `g_i32_checked`, `g_i32_ok`, `g_i32_tag` (`pkg/jsc/private_value.odin:17-19`) — **per-thread OK**. Probe result for the JSValue int32 encoding. A library fact.
- `g_checked`, `g_ok`, `g_create8/16`, `g_try_create`, `g_read_ok`, `g_flag_*`, `g_val_*`, `g_string_type`, `g_fiber_off` (`pkg/jsc/private_string.odin:69-85, 240-243`) — **per-thread OK**. Resolved string-ABI entry points and layout offsets. Library facts.
- `g_host_checked`, `g_host_ok`, `g_host_create`, `g_host_lock_*`, `g_vm_throw`, `g_probe_seen`, `g_probe_callee` (`pkg/jsc/host_function.odin:96-103`) — **per-thread OK**. Resolved host-function ABI entry points. `g_probe_seen`/`g_probe_callee` are written only during the one-time self-test call. The private-ABI rule in CLAUDE.md §4 still applies: a probe latches failure only on a self-test mismatch, so one bad page cannot demote the thread for the pages after it.

## Not package-level, but shared by every page on a thread

Each of these is reached through `Runtime_State` or the loop, not through a global,
so the scan above does not find them. The thread's pages still share them, so they
are listed here for the page work:

- **The event loop.** There is one per thread, and every page on the thread
  registers timers, watchers and thread-pool jobs on it. Closing a page must cancel
  everything that page registered. A page's timers must never fire into the next
  page that reuses the VM. This needs a per-page owner tag on loop handles; it does
  not exist yet.
- **The VM's microtask queue.** It is drained on every exit from the C API. Because
  a VM hosts one page at a time, the queue holds only that page's jobs, as long as
  the page drains or drops them before it releases the VM.
- **The JSC `CodeCache`.** It is shared by design: this is what makes a warm VM
  faster. It holds compiled code keyed by source, not values, so it leaks nothing
  between pages that a page could observe.
