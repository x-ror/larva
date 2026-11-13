// Linux-only: the timerfd census reads /proc/self/fd, and the leak it pins is the
// WebKitGTK RunLoop timer.
#+build linux
package main

import "core:log"
import "core:mem"
import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

@(private = "file")
eval_source :: proc(ctx: jsc.JSContextRef, src: cstring) -> (ok: bool) {
	s := jsc.JSStringCreateWithUTF8CString(src)
	defer jsc.JSStringRelease(s)
	exc: jsc.JSValueRef
	jsc.JSEvaluateScript(ctx, s, nil, nil, 1, &exc)
	return exc == nil
}

// Every JSC VM ever created keeps one timerfd for the life of the process
// (bench/jsc-vm). eval used to create a VM per call, so a process running many evals
// grew one fd per eval. With pooled VMs the count must stay flat after the first.
@(test)
repeated_eval_reuses_pooled_vm :: proc(t: ^testing.T) {
	run_one :: proc(t: ^testing.T) {
		loop := eventloop.init()
		result := lava.eval("globalThis.x = [1, 2, 3].map(n => n * 2).join(',');", "<vm-pool-test>", &loop, false)
		defer lava.result_destroy(&result)
		testing.expect_value(t, result.status, lava.Status.Ok)
	}
	run_one(t)
	_, created_before := lava.vm_pool_stats(lava.thread_vm_pool())
	fds_before := fd_census(timerfds_only = true)
	for _ in 0 ..< 40 do run_one(t)
	busy, created_after := lava.vm_pool_stats(lava.thread_vm_pool())
	testing.expect_value(t, created_after, created_before)
	testing.expect_value(t, busy, 0)
	// The pool counters above hold under any runner; the fd census needs one thread
	// (see fd_census).
	when RUNNER_THREADS == 1 {
		testing.expect_value(t, fd_census(timerfds_only = true), fds_before)
	} else {
		_ = fds_before
		log.info("timerfd census skipped: needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)")
	}
}

// The execution limit stops a runaway entry, records that the watchdog did it, and
// leaves the VM usable for the next context.
@(test)
vm_entry_limit_terminates_runaway_script :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)

	vm, err := lava.vm_acquire(&pool)
	testing.expect_value(t, err, lava.VM_Pool_Error.None)
	if vm == nil do return
	lava.vm_set_entry_limit(vm, 0.1)

	ctx := lava.vm_create_context(vm, nil)
	testing.expect(t, !eval_source(ctx, "while (true) {}"), "runaway script was not terminated")
	testing.expect(t, vm.limit_hit, "termination not attributed to the watchdog")
	jsc.JSGlobalContextRelease(ctx)
	lava.vm_release(vm)

	vm2, err2 := lava.vm_acquire(&pool)
	testing.expect_value(t, err2, lava.VM_Pool_Error.None)
	testing.expect(t, vm2 == vm, "pool did not reuse its only VM")
	testing.expect(t, !vm2.limit_hit, "limit_hit not cleared on acquire")
	ctx2 := lava.vm_create_context(vm2, nil)
	// Released VMs drop their limit, so a long-but-finite script now completes.
	testing.expect(t, eval_source(ctx2, "var s = Date.now(); while (Date.now() - s < 150) {}"), "limit leaked past vm_release")
	jsc.JSGlobalContextRelease(ctx2)
	lava.vm_release(vm2)
}

@(test)
vm_pool_respects_capacity :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 2, context.allocator)
	defer lava.vm_pool_destroy(&pool)
	a, _ := lava.vm_acquire(&pool)
	b, _ := lava.vm_acquire(&pool)
	c, err := lava.vm_acquire(&pool)
	testing.expect(t, c == nil, "acquired beyond capacity")
	testing.expect_value(t, err, lava.VM_Pool_Error.Exhausted)
	lava.vm_release(a)
	d, err2 := lava.vm_acquire(&pool)
	testing.expect_value(t, err2, lava.VM_Pool_Error.None)
	testing.expect(t, d == a, "released VM was not reused")
	busy, created := lava.vm_pool_stats(&pool)
	testing.expect_value(t, busy, 2)
	testing.expect_value(t, created, 2)
	lava.vm_release(b)
	lava.vm_release(d)
}

// Reuse order follows RELEASE order, not acquire order: the VM that went idle last
// has the warmest CodeCache. Acquire a then b, release b then a — a was released
// last, so it is the one handed out next.
@(test)
vm_pool_reuses_most_recently_released :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 2, context.allocator)
	defer lava.vm_pool_destroy(&pool)
	a, _ := lava.vm_acquire(&pool)
	b, _ := lava.vm_acquire(&pool)
	if a == nil || b == nil {
		testing.fail_now(t, "could not create two VMs")
	}
	lava.vm_release(b)
	lava.vm_release(a)
	next, err := lava.vm_acquire(&pool)
	testing.expect_value(t, err, lava.VM_Pool_Error.None)
	testing.expect(t, next == a, "acquire returned the VM released first, not the one released last")
	lava.vm_release(next)
}

// vm_pool_destroy returns everything the pool allocated — the VM records and the
// array backing — through the pool's own allocator. A tracking allocator bound as
// the pool's allocator sees every one of them, so anything left is a leak.
@(test)
vm_pool_destroy_frees_through_pool_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)

	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 2, mem.tracking_allocator(&track))
	a, _ := lava.vm_acquire(&pool)
	b, _ := lava.vm_acquire(&pool)
	lava.vm_release(a)
	lava.vm_release(b)
	testing.expect(t, len(track.allocation_map) > 0, "the pool allocated nothing through its allocator")
	lava.vm_pool_destroy(&pool)
	testing.expectf(t, len(track.allocation_map) == 0, "vm_pool_destroy leaked %d allocation(s)", len(track.allocation_map))
	testing.expect_value(t, len(track.bad_free_array), 0)
}

// A thread whose pool is full must not be told to install JavaScriptCoreGTK: the
// runtime is present, the VMs are just all busy. eval reports the pool error.
@(test)
eval_reports_exhausted_vm_pool :: proc(t: ^testing.T) {
	pool := lava.thread_vm_pool()
	held: [dynamic]^lava.VM
	defer delete(held)
	for {
		vm, err := lava.vm_acquire(pool)
		if err != .None do break
		append(&held, vm)
	}
	// Release, then drop the whole thread pool, so the 16 VMs this test forced into
	// existence do not idle under every later test on this runner thread. Also the
	// worker-exit path (thread_vm_pool_destroy) run on a pool that has been used.
	defer {
		for vm in held do lava.vm_release(vm)
		lava.thread_vm_pool_destroy()
		busy, _ := lava.vm_pool_stats(lava.thread_vm_pool())
		testing.expect_value(t, busy, 0)
	}

	loop := eventloop.init()
	result := lava.eval("1", "<vm-pool-exhausted-test>", &loop, false)
	defer lava.result_destroy(&result)
	testing.expect(t, result.status != .Ok, "eval ran with every pooled VM busy")
	testing.expectf(t, strings.contains(result.message, "VM pool exhausted"), "unexpected message: %q", result.message)
	testing.expect(t, !strings.contains(result.message, "JavaScriptCoreGTK"), "pool exhaustion reported as a missing runtime")
}
