// Linux-only: the clock is CLOCK_THREAD_CPUTIME_ID through core:sys/posix, and every
// test that reads it is itself `#+build linux`.
#+build linux
package main

import "base:runtime"
import "core:fmt"
import "core:math"
import "core:sys/posix"
import "core:testing"
import "core:thread"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Thread-CPU helpers shared by the CPU-budget and VM-pool tests. page_cpu_budget_test
// and page_runner_test each used to declare an identical file-private clock reader.
//
// Not lava.thread_cpu_ns (vm_cpu_posix.odin), for two reasons: the tests use this
// clock to check what that one charged, so reading the same proc would make the check
// circular; and it returns 0 on failure, which turns `while (cpu() - s < x)` into a
// loop that never ends.

// thread_cpu_seconds reads this thread's CPU clock in seconds. On a failed read it
// returns NaN rather than a constant: every `now - start < x` spin then ends at once
// instead of hanging, and every `spent < limit` expectation fails visibly instead of
// passing. CLOCK_THREAD_CPUTIME_ID does not fail on Linux; this is what a broken
// setup looks like if it ever does.
thread_cpu_seconds :: proc() -> f64 {
	ts: posix.timespec

	if posix.clock_gettime(.THREAD_CPUTIME_ID, &ts) != .OK {
		return math.nan_f64()
	}

	return f64(ts.tv_sec) + f64(ts.tv_nsec) / 1e9
}

// thread_cpu_cb is `cpu()` for a bare test context: this thread's CPU seconds. A
// `proc "c"` callback has no Odin context, so it sets the default one before calling
// thread_cpu_seconds; it allocates nothing.
thread_cpu_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: uint,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeNumber(ctx, thread_cpu_seconds())
}

// spin_thread_cpu installs `cpu()` on a bare context and runs one entry there that
// burns 100 ms of this thread's CPU. It returns false when the entry threw, which on
// a context whose script cannot throw means the JSC watchdog terminated it.
//
// The spin is on thread CPU, not wall time, because that is what the watchdog
// measures: its timer fires on wall time, then checks the thread's CPU. A watchdog
// left latched at its 1 ms floor (vm_arm_kill_floor) cuts any entry that has used
// 1 ms of CPU since the timer ran, but a wall-time spin on a loaded runner buys too
// little CPU to get there: 150 ms of wall time bought 3.3-3.6 ms with 64 busy loops
// pinned to the test's core (14 instrumented runs, x-ror/larva#56). 100 ms of CPU is
// 100x the floor whatever the load.
//
// A setup failure fails the test here, with its own message, rather than surfacing
// as a thrown entry the caller would blame on the watchdog: a `cpu` that did not
// install makes the script throw ReferenceError, and a clock that cannot be read
// makes the spin end at once (thread_cpu_seconds), so the script's completion value
// — the CPU it burned — is checked too.
spin_thread_cpu :: proc(t: ^testing.T, ctx: jsc.JSGlobalContextRef) -> (completed: bool) {
	cpu_name := jsc.JSStringCreateWithUTF8CString("cpu")
	cpu_fn := jsc.JSObjectMakeFunctionWithCallback(ctx, cpu_name, thread_cpu_cb)
	install_exc: jsc.JSValueRef
	jsc.JSObjectSetProperty(
		ctx,
		jsc.JSContextGetGlobalObject(ctx),
		cpu_name,
		cast(jsc.JSValueRef)cpu_fn,
		{},
		&install_exc,
	)
	jsc.JSStringRelease(cpu_name)

	if cpu_fn == nil || install_exc != nil {
		testing.fail_now(t, "setup: could not install cpu() on the test context")
	}

	src := jsc.JSStringCreateWithUTF8CString("var s = cpu(); while (cpu() - s < 0.1) {} cpu() - s")
	exc: jsc.JSValueRef
	spent_value := jsc.JSEvaluateScript(ctx, src, nil, nil, 1, &exc)
	jsc.JSStringRelease(src)

	if exc != nil {
		return false
	}

	spent := jsc.JSValueToNumber(ctx, spent_value, nil)

	if !(spent >= 0.1) {
		msg := fmt.tprintf("setup: the spin burned %v s of thread CPU, not 0.1 s; the clock is broken", spent)
		testing.fail_now(t, msg)
	}

	return true
}

@(private = "file")
Fresh_Thread :: struct {
	t:    ^testing.T,
	body: proc(t: ^testing.T),
}

// on_fresh_thread runs `body` on a new thread and joins it, then gives back what the
// thread holds as a dispatcher worker does (the implicit pool, the host tables, the
// drive). The test's context — its logger and tracking allocator — goes along; this
// thread only waits in the join, so nothing touches either concurrently.
//
// For a test of what JSC's RunLoop drive does (pkg/jsc/runloop_linux.odin): WTF binds a
// thread's RunLoop for good when the thread creates its first VM, and a test-runner thread
// is reused across tests, many of which create a bare JSGlobalContextCreate VM first.
on_fresh_thread :: proc(t: ^testing.T, body: proc(t: ^testing.T)) {
	f := Fresh_Thread{t, body}
	th := thread.create_and_start_with_poly_data(&f, proc(f: ^Fresh_Thread) {
		f.body(f.t)
		lava.thread_vm_pool_destroy()
		lava.host_native_thread_teardown()
		jsc.runloop_thread_teardown()
	}, context)
	thread.join(th)
	thread.destroy(th)
}
