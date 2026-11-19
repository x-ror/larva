#+build linux
package larva_http

import "base:runtime"
import "core:net"
import "core:strings"
import "core:sync"
import eventloop "lava:pkg/runtime/eventloop"

// A lookup runs on the loop's worker pool, because core:net's resolver blocks. The
// worker touches only the job; the loop thread reads the result in dns_done.

@(private)
DNS_Done_Proc :: #type proc(user_data: rawptr, addrs: [2]net.Address, count: int)

@(private)
DNS_Job :: struct {
	on_done:    DNS_Done_Proc,
	user_data:  rawptr, // nil once the requester is gone; the job then only frees itself
	slot:       ^^DNS_Job, // the requester's pointer to this job, cleared when the job goes
	host:       string,
	addrs:      [2]net.Address,
	addr_count: int,
	cancelled:  bool, // set by the pool when the loop closes; read by the worker only
	allocator:  runtime.Allocator,
}

// dns_lookup resolves `host` and calls `on_done` on the loop thread. false when the pool
// would not take the job. On success `slot` points at the job until it is done, the
// requester detaches it (dns_detach), or the loop drops it at teardown, which runs before
// the requester learns of the teardown; the job sets `slot` to nil in each case. The job
// lives on the heap, not in the caller's allocator: it can outlive the transfer that
// asked for it, until its worker comes back.
@(private)
dns_lookup :: proc(
	loop: ^eventloop.Loop,
	host: string,
	on_done: DNS_Done_Proc,
	user_data: rawptr,
	slot: ^^DNS_Job,
) -> bool {
	allocator := runtime.heap_allocator()
	job := new(DNS_Job, allocator)
	job^ = {
		on_done   = on_done,
		user_data = user_data,
		slot      = slot,
		host      = strings.clone(host, allocator),
		allocator = allocator,
	}

	if !eventloop.pool_submit(loop, dns_work, dns_done, job, dns_dispose, dns_cancel) {
		dns_free(job)
		return false
	}

	slot^ = job
	return true
}

// dns_detach is the requester giving up on the lookup: its on_done will not run, and the
// job frees itself when its worker comes back.
@(private)
dns_detach :: proc(job: ^DNS_Job) {
	job.user_data = nil
	job.slot = nil
	sync.atomic_store(&job.cancelled, true)
}

@(private = "file")
dns_work :: proc(user_data: rawptr) {
	job := cast(^DNS_Job)user_data

	if sync.atomic_load(&job.cancelled) {
		return
	}

	ep4, ep6, err := net.resolve(job.host)

	if err != nil {
		return
	}

	for ep in ([2]net.Endpoint{ep4, ep6}) {
		if ep.address != nil {
			job.addrs[job.addr_count] = ep.address
			job.addr_count += 1
		}
	}
}

@(private = "file")
dns_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	on_done, requester, addrs, count := job.on_done, job.user_data, job.addrs, job.addr_count
	dns_release_slot(job)
	dns_free(job)

	if requester != nil {
		on_done(requester, addrs, count)
	}
}

// dns_cancel and dns_dispose run on the loop thread in eventloop.close_begin, before the
// requester hears of the teardown (dispose of a taken job runs later, in close_finish,
// after this cancel has released the slot).
@(private = "file")
dns_cancel :: proc(user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	dns_release_slot(job)
	job.user_data = nil
	sync.atomic_store(&job.cancelled, true)
}

@(private = "file")
dns_dispose :: proc(user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	dns_release_slot(job)
	dns_free(job)
}

@(private = "file")
dns_release_slot :: proc(job: ^DNS_Job) {
	if job.slot != nil {
		job.slot^ = nil
		job.slot = nil
	}
}

@(private = "file")
dns_free :: proc(job: ^DNS_Job) {
	delete(job.host, job.allocator)
	free(job, job.allocator)
}
