package eventloop

import "base:runtime"
import "core:sync"
import "core:testing"
import "core:time"

// close_begin must leave a job a worker has taken to that worker: cancel it, report the
// pool busy, and dispose it only once the worker has exited (close_finish). Lava-only
// companion to eventloop_close_test.odin's close_begin_cancels_a_running_job_without_
// waiting_for_it (byte-identical to Larva's), for the one property that test cannot
// pin deterministically: when close_begin disposes the running job, that test goes on
// to release the worker, which then reads job.loop out of the freed Pool_Job to post
// its completion — a use-after-free. Locally it faults in post_async's mutex lock on
// a pointer made of reused bytes; on CI (ubuntu, 4 cores) the same mutant hung until
// the 120 s gate timeout instead, the garbage evidently landing on mapped memory. Its
// outcome is whatever the allocator reused the chunk for, so no gate can rely on it.
//
// This test checks right after close_begin and, when the job was disposed, fails
// WITHOUT releasing the worker: it stays blocked on a gate the test leaks on the heap,
// never reaches the freed job, and dies with the process. The loop is leaked with it
// on that path only — freeing either would hand the blocked worker freed memory.

@(private = "file")
Held_Job :: struct {
	gate:    sync.Sema,
	started: bool, // atomic
	cancel:  int, // atomic
	dispose: int, // atomic
}

@(private = "file")
held_work :: proc(user_data: rawptr) {
	job := cast(^Held_Job)user_data
	sync.atomic_store(&job.started, true)
	sync.sema_wait(&job.gate)
}

@(private = "file")
held_done :: proc(loop: ^Loop, user_data: rawptr) {}

@(private = "file")
held_cancel :: proc(user_data: rawptr) {
	sync.atomic_add(&(cast(^Held_Job)user_data).cancel, 1)
}

@(private = "file")
held_dispose :: proc(user_data: rawptr) {
	sync.atomic_add(&(cast(^Held_Job)user_data).dispose, 1)
}

@(test)
close_begin_never_disposes_a_job_its_worker_is_running :: proc(t: ^testing.T) {
	heap := runtime.heap_allocator()
	loop := new(Loop, heap)
	loop^ = init(heap)
	job := new(Held_Job, heap)
	testing.expect(t, pool_submit(loop, held_work, held_done, job, held_dispose, held_cancel))
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for !sync.atomic_load(&job.started) && time.tick_diff(time.tick_now(), deadline) > 0 {
		time.sleep(time.Millisecond)
	}

	if !sync.atomic_load(&job.started) {
		// Still queued: close_begin disposes it outright, and no worker holds it.
		destroy(loop)
		free(loop, heap)
		free(job, heap)
		testing.fail_now(t, "the worker never started the job")
	}

	busy := close_begin(loop)
	disposed := sync.atomic_load(&job.dispose)

	if disposed != 0 || !busy {
		// Leave the worker blocked: see the file comment.
		testing.expectf(
			t,
			false,
			"close_begin disposed a job its worker is still running (dispose %d, busy %v)",
			disposed,
			busy,
		)
		return
	}

	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)

	sync.sema_post(&job.gate)
	deadline = time.tick_add(time.tick_now(), 3 * time.Second)
	for !close_ready(loop) && time.tick_diff(time.tick_now(), deadline) > 0 {
		time.sleep(time.Millisecond)
	}
	close_finish(loop)
	free(loop, heap)
	testing.expect_value(t, sync.atomic_load(&job.dispose), 1)
	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)
	free(job, heap)
}
