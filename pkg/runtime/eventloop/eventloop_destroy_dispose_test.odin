package eventloop

import "core:testing"

// A timer's dispose runs inside destroy (close_begin), and since pkg/http's transfers ride
// their timeout timer's dispose to finish on teardown, it can run an embedder's callback
// that calls straight back into the loop: arm a timer, clear one, queue a task. None of
// that may disturb the teardown, nor clear a handle the teardown has already released.
// Every handle's dispose runs exactly once, whether it was armed before destroy or during
// it. What a skipped dispose would strand shows as a count, not as a leak, since
// make test-eventloop-odin does not fail on one.

@(private = "file")
Destroy_Rec :: struct {
	loop:     ^Loop,
	disposed: [16]int, // per handle: how often its dispose ran
	other:    Timer_ID, // a timer the first dispose clears
	pending:  Timer_ID, // an immediate set before destroy, which the first dispose clears
	immediate: int, // disposes of that immediate
	late:     int, // disposes of handles armed during destroy
}

@(private = "file")
Destroy_Slot :: struct {
	rec:   ^Destroy_Rec,
	index: int,
}

@(private = "file")
never_fires :: proc(loop: ^Loop, user_data: rawptr) {
	panic("a timer fired during destroy")
}

@(private = "file")
count_late :: proc(user_data: rawptr) {
	(cast(^Destroy_Rec)user_data).late += 1
}

@(private = "file")
count_immediate :: proc(user_data: rawptr) {
	(cast(^Destroy_Rec)user_data).immediate += 1
}

// reentrant_dispose counts itself and, the first time, does what an embedder's on_done
// may do inside destroy: arm a timer with a dispose, clear another timer, queue an
// immediate and an I/O callback.
@(private = "file")
reentrant_dispose :: proc(user_data: rawptr) {
	slot := cast(^Destroy_Slot)user_data
	rec := slot.rec
	rec.disposed[slot.index] += 1

	if slot.index != 0 {
		return
	}

	set_timeout(rec.loop, never_fires, 1, rec, count_late)
	clear_timeout(rec.loop, rec.other)
	clear_immediate(rec.loop, rec.pending)
	set_immediate(rec.loop, never_fires, rec, count_late)
	queue_io_callback(rec.loop, never_fires, rec, count_late)
}

@(test)
dispose_reentering_the_loop_during_destroy_runs_each_dispose_once :: proc(t: ^testing.T) {
	N :: 16
	rec: Destroy_Rec
	slots: [N]Destroy_Slot
	loop := init(context.allocator)
	rec.loop = &loop

	ids: [N]Timer_ID
	for i in 0 ..< N {
		slots[i] = {&rec, i}
		// Due times spread out and out of order, so the heap is not already sorted by index.
		ids[i] = set_timeout(&loop, never_fires, u64(1000 + (i * 7) % N * 100), &slots[i], reentrant_dispose)
	}

	rec.other = ids[N - 1]
	rec.pending = set_immediate(&loop, never_fires, &rec, count_immediate)
	destroy(&loop)

	for count, i in rec.disposed {
		testing.expectf(t, count == 1, "timer %d: dispose ran %d times, want once", i, count)
	}

	testing.expectf(t, rec.immediate == 1, "immediate: dispose ran %d times, want once", rec.immediate)
	testing.expectf(t, rec.late == 3, "handles armed during destroy: %d disposes, want 3 (each released at once)", rec.late)
}
