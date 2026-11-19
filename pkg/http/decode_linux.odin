#+build linux
package larva_http

import "core:sync"
import eventloop "lava:pkg/runtime/eventloop"

// A body is decoded on the loop's worker pool, as a DNS lookup is resolved there: undoing a
// chain costs CPU in proportion to the decoded size (11.7 ms for a 16 MiB gzip-encoded HTML
// body, best of 5 at -o:speed, measured in the review of #80), and on the loop thread
// every other transfer and timer would wait for it, the transfer's own timeout included.
// The worker touches only the job: the body it owns from submit until done, and the
// body's allocator, which fetch requires to be thread-safe.
//
// The move frees the loop; it does not make the decode faster. The round trip adds 8-10 us
// to every body (see INLINE_DECODE_MAX for the measurement, and the small bodies that skip
// it), and in the review of #80 a 2 MiB body took 1.15-2.3x longer in wall time on a worker
// than inline (one machine, not interleaved; cause not profiled).

@(private)
Decode_Done_Proc :: #type proc(user_data: rawptr, body: [dynamic]byte, err: Error)

@(private)
Decode_Job :: struct {
	on_done:   Decode_Done_Proc,
	user_data: rawptr, // nil once the requester is gone; the job then only frees itself
	slot:      ^^Decode_Job, // the requester's pointer to this job, cleared when the job goes
	body:      [dynamic]byte, // the job's from submit until done or dispose
	chain:     Chain,
	max_body:  int,
	err:       Error,
	cancelled: bool, // set when the requester stops waiting or the loop closes; read by the worker
}

// decode_start hands `body` to a worker that undoes `chain` over it, and calls `on_done`
// on the loop thread with the result. On success `body` is the job's, the caller's is left
// empty, and `slot` points at the job until it is done, the requester detaches it
// (decode_detach), or the loop drops it at teardown, which runs before the requester
// learns of the teardown; the job sets `slot` to nil in each case. false when the pool
// would not take the job, and `body` is untouched. The job is allocated from the body's
// allocator and freed through it, by done or dispose, even after the requester has
// stopped waiting.
@(private)
decode_start :: proc(
	loop: ^eventloop.Loop,
	body: ^[dynamic]byte,
	chain: Chain,
	max_body: int,
	on_done: Decode_Done_Proc,
	user_data: rawptr,
	slot: ^^Decode_Job,
) -> bool {
	allocator := body.allocator
	job := new(Decode_Job, allocator)
	job^ = {
		on_done   = on_done,
		user_data = user_data,
		slot      = slot,
		body      = body^,
		chain     = chain,
		max_body  = max_body,
	}

	if !eventloop.pool_submit(loop, decode_work, decode_done, job, decode_dispose, decode_cancel) {
		free(job, allocator)
		return false
	}

	body^ = make([dynamic]byte, allocator)
	slot^ = job
	return true
}

// decode_detach is the requester giving up on the decode: its on_done will not run, and
// the job frees the body when its worker comes back.
@(private)
decode_detach :: proc(job: ^Decode_Job) {
	job.user_data = nil
	job.slot = nil
	sync.atomic_store(&job.cancelled, true)
}

@(private = "file")
decode_work :: proc(user_data: rawptr) {
	job := cast(^Decode_Job)user_data

	if sync.atomic_load(&job.cancelled) {
		return
	}

	job.err = run_decoding(&job.body, job.chain, job.max_body)
}

@(private = "file")
decode_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	job := cast(^Decode_Job)user_data
	decode_release_slot(job)
	on_done, requester, body, err := job.on_done, job.user_data, job.body, job.err
	free(job, body.allocator)

	if requester == nil {
		delete(body)
		return
	}

	on_done(requester, body, err)
}

// decode_cancel and decode_dispose run on the loop thread in eventloop.close_begin, before
// the requester hears of the teardown (dispose of a taken job runs later, in close_finish,
// after this cancel has released the slot).
@(private = "file")
decode_cancel :: proc(user_data: rawptr) {
	job := cast(^Decode_Job)user_data
	decode_release_slot(job)
	job.user_data = nil
	sync.atomic_store(&job.cancelled, true)
}

@(private = "file")
decode_dispose :: proc(user_data: rawptr) {
	job := cast(^Decode_Job)user_data
	decode_release_slot(job)
	allocator := job.body.allocator
	delete(job.body)
	free(job, allocator)
}

@(private = "file")
decode_release_slot :: proc(job: ^Decode_Job) {
	if job.slot != nil {
		job.slot^ = nil
		job.slot = nil
	}
}
