#+build linux
package jsc

import "core:sync"
import "core:sys/linux"
import "core:time"

// Driving JavaScriptCore's WTF::RunLoop (#91).
//
// JSC hands some of its work to a timer or a task on the thread's WTF::RunLoop rather
// than doing it inside an API call: a FinalizationRegistry's cleanup (DeferredWorkTimer),
// the settlement of its own asynchronous WebAssembly.compile/instantiate, the
// incremental sweeper. On WebKitGTK the RunLoop is a GLib GMainContext, and nothing in
// Lava ever iterated it — so those cleanups never ran and those promises never settled.
// Pages no longer reach the engine's asynchronous WebAssembly at all: its settlement
// runs page code from the RunLoop (pkg/runtime/wasm.odin says why, and replaces it).
// What the drive delivers to a page is cleanups only, through a shim that runs no page
// code (pkg/runtime/deferred.odin). Measured with standalone C probes against
// libjavascriptcoregtk-6.0 2.52.6 (session notes "runloop-verify", q1-q9; summarised
// where each fact is used below).
//
// The mechanism, per thread that runs JSC:
//   - Lava owns the context. WTF binds RunLoop::current() to whatever GMainContext is
//     thread-default when the thread creates its FIRST VM, and the binding is permanent
//     (q1: VM created first, then the push → 0/16 cleanups ever; push first → 16/16).
//     So runloop_before_vm pushes a context of ours as thread-default right before the
//     thread's first JSContextGroupCreate and runloop_after_vm pops it again at once,
//     so no other GLib user on the thread ever sees it. The context is per thread, not
//     per VM: every VM the thread creates later lands in it (q1, "twoctx").
//   - A functional self-test, not a structural one, decides whether the drive is on:
//     on the first VM, a FinalizationRegistry with 4 dead targets, one synchronous full
//     GC, one iteration — the cleanup ran or it did not. ~0.3 ms per thread (q8).
//     Checking that g_main_context_query lists a timerfd instead fails exactly when it
//     matters: with the GC timers off an idle VM has no timerfd (q2). A thread that fails
//     keeps today's behaviour, no drive.
//   - Lava never lets GLib poll. A per-thread epoll set (`gep`) holds GLib's pollfds,
//     re-synced from prepare/query before the thread blocks (runloop_sync); the thread's
//     driver watches `gep` as ONE more descriptor — the runner's epoll set, or eval's page
//     loop — and calls runloop_dispatch (one non-blocking g_main_context_iteration) when
//     it is readable or GLib's own deadline has passed (runloop_due). epoll_wait(gep, 0)
//     costs 390-397 ns whatever the VM count; prepare+query costs 0.19/1.1/6.5 us at
//     1/16/100 VMs and g_main_context_pending costs as much as an iteration (q5, q6),
//     hence the nested set rather than a per-round query.
//   - Dispatch happens at thread level only, never inside a VM entry: work JSC runs from
//     the RunLoop is then never nested in a page's JS, and what the page sees of it is
//     routed through its own loop by the bootstrap (js/internal/deferred.js).
//
// JSDisableGCTimer: with a drive, JSC's full-GC activity timer eventually fires
// FullGCActivityCallback::doCollection → MemoryPressureHandler::singleton() →
// RunLoop::mainSingleton(), which is null in an embedding that never called
// RunLoop::initializeMain, and SEGVs (12/12 runs crashed, 0/12 with the timer off, q3).
// initializeMain itself is out: it is a mangled C++ symbol, and called after a push it
// binds the main RunLoop, called before it prevents adoption (q1). JSDisableGCTimer is a
// plain C export of JSBasePrivate.h, like JSGetMemoryUsageStatistics (private_heap.odin).
// It is behaviour-neutral against Lava before this drive: those timers never fired,
// because nothing iterated. It must run before any VM that will live in a context of
// ours, so runloop_before_vm calls it ahead of the first push in the process; a JSC
// without the symbol gets no drive at all (the crash is the alternative).

// RUNLOOP_MAX_FDS bounds the pollfds one sync reads. GLib's set is one wakeup eventfd
// plus one timerfd per VM with a timer armed — measured 1-3 in practice (q4, q7); a set
// larger than this is truncated, so the extra sources are woken only through the
// deadline clamp or the next wake of another descriptor.
@(private = "file")
RUNLOOP_MAX_FDS :: 64

@(private = "file")
GPollFD :: struct {
	fd:      i32,
	events:  u16,
	revents: u16,
}

// gboolean is gint, four bytes: not a C _Bool, so i32 and not `bool` here (§4's
// `-> bool` rule is for JSC's _Bool returns).
@(private = "file")
gboolean :: i32

@(private = "file")
G_IO_IN :: 1
@(private = "file")
G_IO_PRI :: 2
@(private = "file")
G_IO_OUT :: 4

// GLib is already in the process (libjavascriptcoregtk-6.0 links it); linking it by name
// adds no library to the binary's closure.
foreign import glib "system:glib-2.0"

@(default_calling_convention = "c")
foreign glib {
	@(private = "file")
	g_main_context_new :: proc() -> rawptr ---
	@(private = "file")
	g_main_context_unref :: proc(ctx: rawptr) ---
	@(private = "file")
	g_main_context_push_thread_default :: proc(ctx: rawptr) ---
	@(private = "file")
	g_main_context_pop_thread_default :: proc(ctx: rawptr) ---
	@(private = "file")
	g_main_context_iteration :: proc(ctx: rawptr, may_block: gboolean) -> gboolean ---
	@(private = "file")
	g_main_context_acquire :: proc(ctx: rawptr) -> gboolean ---
	@(private = "file")
	g_main_context_release :: proc(ctx: rawptr) ---
	@(private = "file")
	g_main_context_prepare :: proc(ctx: rawptr, priority: ^i32) -> gboolean ---
	@(private = "file")
	g_main_context_query :: proc(ctx: rawptr, max_priority: i32, timeout: ^i32, fds: [^]GPollFD, n_fds: i32) -> i32 ---
	@(private = "file")
	g_main_context_check :: proc(ctx: rawptr, max_priority: i32, fds: [^]GPollFD, n_fds: i32) -> gboolean ---
}

foreign import libdl_runloop "system:dl"

@(default_calling_convention = "c")
foreign libdl_runloop {
	@(private = "file", link_name = "dlsym")
	runloop_dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
}

@(private = "file")
Disable_GC_Timer_Proc :: #type proc "c" ()
@(private = "file")
Collect_Now_Proc :: #type proc "c" (ctx: JSContextRef)

// Runloop_Drive is what this thread knows about its RunLoop.
Runloop_Drive :: enum u8 {
	// No VM created on this thread yet.
	Unset,
	// Our context is the thread's RunLoop and the self-test saw a cleanup run.
	Adopted,
	// The self-test failed, the process has no JSDisableGCTimer, or a JSC VM existed on
	// this thread before our first push: no drive here, today's behaviour.
	Not_Adopted,
	// runloop_thread_teardown ran. A thread that still creates a VM after it gets no
	// drive: the RunLoop stays bound to the context it adopted.
	Torn_Down,
}

@(private = "file")
Runloop_Thread :: struct {
	drive:        Runloop_Drive,
	// Our GMainContext; one reference, dropped by runloop_thread_teardown. WTF holds its
	// own for as long as the thread's RunLoop lives (until thread exit).
	gctx:         rawptr,
	// The nested epoll set of GLib's pollfds, and the descriptors registered in it.
	gep:          linux.Fd,
	fds:          [RUNLOOP_MAX_FDS]i32,
	events:       [RUNLOOP_MAX_FDS]u16,
	n_fds:        int,
	// GLib's next fd-less deadline from the last sync; zero means none.
	deadline:     time.Tick,
	has_deadline: bool,
}

// Thread-local by design: a GMainContext and the RunLoop bound to it are the thread's.
@(private = "file", thread_local)
g_runloop: Runloop_Thread

// Process-wide: whether JSDisableGCTimer ran (0 = not tried, 1 = done, 2 = missing).
// Resolved once under a sync.Once; a missing symbol is a fact about the linked library,
// the only verdict latched process-wide (CLAUDE.md §4's probe rule).
@(private = "file")
g_gc_timer_once: sync.Once
@(private = "file")
g_gc_timer_disabled: bool

// collect_garbage_now's resolved symbol, per thread like the other probes here.
@(private = "file", thread_local)
g_collect: Collect_Now_Proc
@(private = "file", thread_local)
g_collect_checked: bool

// runloop_before_vm prepares the calling thread's RunLoop before it creates a JSC VM:
// on the thread's first VM it disables JSC's GC activity timers for the process (once)
// and pushes a fresh GMainContext as thread-default, so WTF binds the thread's RunLoop
// to it. A no-op on every later call. Pair with runloop_after_vm on every path.
//
// Must run before the thread's first JSContextGroupCreate or JSGlobalContextCreate
// (JSClassCreate and JSStringCreate are harmless, q1). vm_pool.odin's vm_acquire is the
// one production VM-creation point.
runloop_before_vm :: proc() -> (pushed: bool) {
	if g_runloop.drive != .Unset {
		return false
	}

	sync.once_do(&g_gc_timer_once, proc "contextless" () {
		p := runloop_dlsym(nil, "JSDisableGCTimer")

		if p != nil {
			(transmute(Disable_GC_Timer_Proc)p)()
			g_gc_timer_disabled = true
		}
	})

	if !g_gc_timer_disabled {
		g_runloop.drive = .Not_Adopted
		return false
	}

	gctx := g_main_context_new()

	if gctx == nil {
		g_runloop.drive = .Not_Adopted
		return false
	}

	g_runloop.gctx = gctx
	g_main_context_push_thread_default(gctx)
	return true
}

// runloop_after_vm finishes what runloop_before_vm started on the thread's first VM:
// it runs the self-test in `group` (the VM just created), pops our context off the
// thread-default stack and records the verdict. `pushed` is runloop_before_vm's answer;
// false makes this a no-op. `group` nil (the create failed) leaves the drive off.
runloop_after_vm :: proc(pushed: bool, group: JSContextGroupRef) {
	if !pushed {
		return
	}

	adopted := group != nil && runloop_self_test(group)
	g_main_context_pop_thread_default(g_runloop.gctx)

	if adopted {
		gep, err := linux.epoll_create1({.FDCLOEXEC})

		if err == .NONE {
			g_runloop.gep = gep
			g_runloop.drive = .Adopted
			return
		}
	}

	// Keep the context: WTF holds it as the thread's RunLoop whatever the verdict, and
	// teardown drops our reference with the rest.
	g_runloop.drive = .Not_Adopted
}

// runloop_drive reports the calling thread's state.
runloop_drive :: proc() -> Runloop_Drive {
	return g_runloop.drive
}

// runloop_fd is the descriptor a thread's driver watches for RunLoop work: readable
// when GLib has a source ready. ok is false when the thread has no drive.
runloop_fd :: proc() -> (fd: i32, ok: bool) {
	if g_runloop.drive != .Adopted {
		return -1, false
	}

	return i32(g_runloop.gep), true
}

// runloop_sync re-reads GLib's pollfd set into the thread's epoll set and returns GLib's
// fd-less timeout: how long the driver may block before runloop_due turns true on its
// own. Call it before every block (the set is not stable: with the GC timers off a VM's
// timerfd appears lazily, 1-2 changes in 3 s at 16 VMs, q7).
//
// Returns:
//   timeout_ms  -1 when only a descriptor can make GLib ready; 0 when a source is ready
//               now; the milliseconds to GLib's nearest deadline otherwise.
//   ok          false when the thread has no drive (timeout_ms is then -1).
//
// Every descriptor GLib lists is (re-)added, an EEXIST ignored: a timerfd GLib closed
// leaves the epoll set on its own, and a new one may come back under the same number,
// which a set-difference would read as "already registered".
runloop_sync :: proc() -> (timeout_ms: int, ok: bool) {
	rl := &g_runloop

	if rl.drive != .Adopted {
		return -1, false
	}

	fds: [RUNLOOP_MAX_FDS]GPollFD
	priority: i32
	timeout: i32 = -1
	g_main_context_acquire(rl.gctx)
	ready := g_main_context_prepare(rl.gctx, &priority) != 0
	n := int(g_main_context_query(rl.gctx, priority, &timeout, raw_data(fds[:]), i32(len(fds))))
	n = clamp(n, 0, len(fds))
	// check closes the prepare; with no poll in between every revents is 0, so it only
	// re-reads the sources' own readiness (the deadline already in `timeout`).
	g_main_context_check(rl.gctx, priority, raw_data(fds[:]), i32(n))
	g_main_context_release(rl.gctx)

	for i in 0 ..< rl.n_fds {
		keep := false
		for j in 0 ..< n {
			if fds[j].fd == rl.fds[i] {
				keep = true
				break
			}
		}

		if !keep {
			linux.epoll_ctl(rl.gep, .DEL, linux.Fd(rl.fds[i]), nil)
		}
	}

	old_fds, old_events, old_n := rl.fds, rl.events, rl.n_fds
	rl.n_fds = 0
	for j in 0 ..< n {
		ev := linux.EPoll_Event{}

		if fds[j].events & G_IO_IN != 0 {
			ev.events += {.IN}
		}

		if fds[j].events & G_IO_PRI != 0 {
			ev.events += {.PRI}
		}

		if fds[j].events & G_IO_OUT != 0 {
			ev.events += {.OUT}
		}

		ev.data.fd = linux.Fd(fds[j].fd)

		// EEXIST is the steady state: the descriptor is still the one registered. Its
		// interest set is rewritten only when GLib changed it.
		if linux.epoll_ctl(rl.gep, .ADD, linux.Fd(fds[j].fd), &ev) == .EEXIST {
			changed := true
			for k in 0 ..< old_n {
				if old_fds[k] == fds[j].fd {
					changed = old_events[k] != fds[j].events
					break
				}
			}

			if changed {
				linux.epoll_ctl(rl.gep, .MOD, linux.Fd(fds[j].fd), &ev)
			}
		}

		rl.fds[rl.n_fds] = fds[j].fd
		rl.events[rl.n_fds] = fds[j].events
		rl.n_fds += 1
	}

	if ready {
		timeout = 0
	}

	rl.has_deadline = timeout >= 0

	if rl.has_deadline {
		rl.deadline = time.tick_add(time.tick_now(), time.Duration(timeout) * time.Millisecond)
	}

	return int(timeout), true
}

// runloop_due reports whether the RunLoop has work: a GLib descriptor is ready or the
// deadline from the last runloop_sync has passed. One epoll_wait(gep, 0) — cheap enough
// for every busy round of a driver, which must not starve GLib by never blocking.
runloop_due :: proc() -> bool {
	rl := &g_runloop

	if rl.drive != .Adopted {
		return false
	}

	if rl.has_deadline && time.tick_diff(rl.deadline, time.tick_now()) >= 0 {
		return true
	}

	events: [1]linux.EPoll_Event
	n, _ := linux.epoll_wait(rl.gep, raw_data(events[:]), 1, 0)
	return n > 0
}

// runloop_dispatch runs what is ready on the thread's RunLoop: one non-blocking
// g_main_context_iteration. Thread level only — never from inside a VM entry or a
// page's CPU window: what it runs (a FinalizationRegistry cleanup task) enters JS in
// whichever VM posted it. Nor between a limit kill and the
// VM's release: it would enter the VM with the kill still armed (page_close says what
// that cost).
//
// Returns:
//   true when GLib dispatched a source.
runloop_dispatch :: proc() -> bool {
	rl := &g_runloop

	if rl.drive != .Adopted {
		return false
	}

	rl.has_deadline = false
	return g_main_context_iteration(rl.gctx, 0) != 0
}

// runloop_thread_teardown gives back what the thread's drive holds: one last iteration
// (a released VM's timer source is finalized, and its timerfd closed, only when the
// context is next iterated — p4), the epoll set and our reference to the context. For a
// thread that is about to end, after its last VM is gone; WTF's own reference goes with
// the thread. A thread that creates a VM afterwards gets no drive.
runloop_thread_teardown :: proc() {
	rl := &g_runloop

	if rl.gctx != nil {
		if rl.drive == .Adopted {
			g_main_context_iteration(rl.gctx, 0)
		}

		g_main_context_unref(rl.gctx)
	}

	if rl.gep > 0 {
		linux.close(rl.gep)
	}

	rl^ = {}
	rl.drive = .Torn_Down
}

// collect_garbage_now runs a full, synchronous collection of `ctx`'s VM heap:
// JSSynchronousGarbageCollectForDebugging (a C export of JSBasePrivate.h), else the
// public JSGarbageCollect, which only reports an abandoned object graph and collects
// nothing by itself. With the GC activity timers off (runloop_before_vm), this is what
// stands in for the collection they used to schedule.
//
// Returns:
//   true when the synchronous path ran.
collect_garbage_now :: proc(ctx: JSContextRef) -> bool {
	if ctx == nil {
		return false
	}

	// A missing symbol is the library's shape, so one dlsym per thread decides it.
	if !g_collect_checked {
		g_collect_checked = true
		g_collect = transmute(Collect_Now_Proc)runloop_dlsym(nil, "JSSynchronousGarbageCollectForDebugging")
	}

	collect := g_collect

	if collect == nil {
		JSGarbageCollect(ctx)
		return false
	}

	collect(ctx)
	return true
}

// runloop_self_test answers whether the thread's RunLoop is the context we pushed, by
// making it do the thing the drive exists for: a FinalizationRegistry, rooted from a
// throwaway global (an unrooted registry gave a false negative, q8), four targets that
// are dead at once, one synchronous full GC, then up to two iterations of our context.
// The cleanup runs only if JSC's DeferredWorkTimer sits on that context.
@(private = "file")
runloop_self_test :: proc(group: JSContextGroupRef) -> bool {
	ctx := JSGlobalContextCreateInGroup(group, nil)

	if ctx == nil {
		return false
	}

	defer JSGlobalContextRelease(ctx)

	// FinalizationRegistry is routed through a host-function constructor
	// (pkg/runtime/deferred.odin); without the host-call path the engine's own
	// constructor stays, and a driven RunLoop would run page cleanups at thread level,
	// outside every page's window. So no host path, no drive.
	if !host_calls_active(cast(JSContextRef)ctx) {
		return false
	}

	// The same for wasm.odin's compile/instantiate, which must be non-constructors: a JSC
	// without the symbol could install them on no page, and a page keeping the engine's
	// is safe only where the RunLoop is not driven. So no symbol, no drive.
	if !host_non_constructor_available() {
		return false
	}

	SETUP :: "globalThis.ran = 0; globalThis.fr = new FinalizationRegistry(function () { ran = 1; });" +
		" (function () { for (var i = 0; i < 4; i++) fr.register({}, i); })(); 0"
	src := JSStringCreateWithUTF8CString(SETUP)

	if src == nil {
		return false
	}

	exc: JSValueRef
	JSEvaluateScript(ctx, src, nil, nil, 1, &exc)
	JSStringRelease(src)

	if exc != nil || !collect_garbage_now(ctx) {
		return false
	}

	read := JSStringCreateWithUTF8CString("ran")

	if read == nil {
		return false
	}

	defer JSStringRelease(read)
	for _ in 0 ..< 2 {
		g_main_context_iteration(g_runloop.gctx, 0)
		v := JSEvaluateScript(ctx, read, nil, nil, 1, nil)

		if v != nil && JSValueToNumber(ctx, v, nil) == 1 {
			return true
		}
	}

	return false
}
