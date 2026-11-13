// Linux-only: the timerfd census reads /proc/self/fd, and the leak it pins is the
// WebKitGTK RunLoop timer.
#+build linux
package main

import "core:os"
import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

@(private = "file")
VM_POOL_TEST_THREADS :: #config(ODIN_TEST_THREADS, 0)

@(private = "file")
count_timerfds :: proc() -> int {
	dir, err := os.open("/proc/self/fd")
	if err != nil do return -1
	defer os.close(dir)
	infos, _ := os.read_dir(dir, -1, context.temp_allocator)
	n := 0
	for fi in infos {
		target, lerr := os.read_link(fi.fullpath, context.temp_allocator)
		if lerr == nil && strings.contains(target, "timerfd") do n += 1
	}
	return n
}

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
	_, _, created_before := lava.vm_pool_stats(lava.thread_vm_pool())
	fds_before := count_timerfds()
	for _ in 0 ..< 40 do run_one(t)
	_, busy, created_after := lava.vm_pool_stats(lava.thread_vm_pool())
	testing.expect_value(t, created_after, created_before)
	testing.expect_value(t, busy, 0)
	// /proc/self/fd is process-wide: parallel tests' sockets and VMs land in it, so
	// the census only means something under `make test-odin-serial` (as in
	// net_teardown_stress_test). The pool counters above hold either way.
	when VM_POOL_TEST_THREADS == 1 {
		testing.expect_value(t, count_timerfds(), fds_before)
	} else {
		_ = fds_before
	}
}

// The execution limit stops a runaway entry, records that the watchdog did it, and
// leaves the VM usable for the next context.
@(test)
vm_entry_limit_terminates_runaway_script :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1)
	defer delete(pool.vms)

	vm, err := lava.vm_acquire(&pool)
	testing.expect_value(t, err, lava.VM_Pool_Error.None)
	if vm == nil do return
	defer free(vm)
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
	jsc.JSContextGroupRelease(vm.group)
}

@(test)
vm_pool_respects_capacity :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 2)
	defer delete(pool.vms)
	a, _ := lava.vm_acquire(&pool)
	b, _ := lava.vm_acquire(&pool)
	c, err := lava.vm_acquire(&pool)
	testing.expect(t, c == nil, "acquired beyond capacity")
	testing.expect_value(t, err, lava.VM_Pool_Error.Exhausted)
	lava.vm_release(a)
	d, err2 := lava.vm_acquire(&pool)
	testing.expect_value(t, err2, lava.VM_Pool_Error.None)
	testing.expect(t, d == a, "released VM was not reused")
	_, busy, created := lava.vm_pool_stats(&pool)
	testing.expect_value(t, busy, 2)
	testing.expect_value(t, created, 2)
	for vm in pool.vms {
		jsc.JSContextGroupRelease(vm.group)
		free(vm)
	}
	_ = b
}
