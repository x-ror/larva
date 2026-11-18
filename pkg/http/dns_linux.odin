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
	host:       string,
	addrs:      [2]net.Address,
	addr_count: int,
	cancelled:  bool, // set by the pool when the loop closes; read by the worker only
	allocator:  runtime.Allocator,
}

// dns_lookup resolves `host` and calls `on_done` on the loop thread. nil when the pool
// would not take the job. The job lives on the heap, not in the caller's allocator: it can
// outlive the transfer that asked for it, until its worker comes back.
@(private)
dns_lookup :: proc(loop: ^eventloop.Loop, host: string, on_done: DNS_Done_Proc, user_data: rawptr) -> ^DNS_Job {
	allocator := runtime.heap_allocator()
	job := new(DNS_Job, allocator)
	job^ = {
		on_done   = on_done,
		user_data = user_data,
		host      = strings.clone(host, allocator),
		allocator = allocator,
	}

	if !eventloop.pool_submit(loop, dns_work, dns_done, job, dns_dispose, dns_cancel) {
		dns_free(job)
		return nil
	}

	return job
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
	dns_free(job)

	if requester != nil {
		on_done(requester, addrs, count)
	}
}

@(private = "file")
dns_cancel :: proc(user_data: rawptr) {
	sync.atomic_store(&(cast(^DNS_Job)user_data).cancelled, true)
}

@(private = "file")
dns_dispose :: proc(user_data: rawptr) {
	dns_free(cast(^DNS_Job)user_data)
}

@(private = "file")
dns_free :: proc(job: ^DNS_Job) {
	delete(job.host, job.allocator)
	free(job, job.allocator)
}
