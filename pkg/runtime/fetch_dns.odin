#+build linux, darwin, windows
package lava_runtime

import "base:runtime"
import "core:net"
import "core:strings"
import "core:sync"
import eventloop "lava:pkg/runtime/eventloop"

// Hostname resolution for fetch (#77) runs OFF the loop (getaddrinfo blocks) on the loop's generic
// worker pool (eventloop.pool_submit) — the same pool fs/crypto/node:dns use. It previously had its
// own dedicated 4-thread process-global pool; Slice 3a folds it onto the per-loop generic pool so
// multi-core doesn't multiply thread pools (one 4-thread pool per worker, not two), and the per-loop
// pool's loop-thread-only ownership is preserved verbatim under N workers — the data race a shared
// pool would have had on its lock-free queues across N loop threads simply cannot arise.
//
// Lifetime / safety (mirrors node:dns in dns.odin):
//   - dns_resolve_work runs on a pool worker and touches ONLY its DNS_Job (an owned host copy +
//     result fields) — never the loop, the request, or the JS engine. The job carries the result
//     back; dns_resolve_done reads it on the loop thread and drives the connect.
//   - pool_submit does the async_begin that keeps the loop alive until the completion posts (and
//     undoes it itself on a start failure); the caller (fetch_transport_start) pins the REQUEST via
//     drive_pending so a cancel mid-lookup cannot free it before the completion runs.
//   - At teardown the loop's close_begin stops the pool without waiting for a lookup in flight, and
//     dns_resolve_dispose frees each job whose completion will not fire — once its worker has exited,
//     which may be after the page and its Fetch_Request are gone (#34). dns_resolve_done never runs
//     after close_begin, so a late lookup never reaches the freed request; the job holds no JS, so it
//     needs no Pool_Cancel.

// DNS_Job is one resolution request: an owned host copy + the ordered result (up to one IPv4 then one
// IPv6 address, #145, tried in turn by the connect path). Allocated by fetch_dns_submit, freed by
// dns_resolve_done (success) or dns_resolve_dispose (dropped at teardown) through its captured
// allocator, so the alloc/free pair stays matched whichever path releases it. That allocator is the
// heap, not req.allocator: the worker writes into the job and may still be resolving after a detached
// loop's owner (Larva's page runner) has freed the request's allocator.
DNS_Job :: struct {
	host:       string,
	allocator:  runtime.Allocator,
	req:        ^Fetch_Request,
	addrs:      [2]Fetch_Addr,
	addr_count: int,
	// Set on the loop thread when the owning request aborts while this job is queued; the worker
	// loads it atomically and skips the now-pointless blocking resolve. Atomic because it crosses the
	// loop/worker threads and the generic pool exposes no shared lock — best-effort for a resolve
	// already in flight, guaranteed for one still queued.
	cancelled:  bool,
}

// fetch_dns_submit offloads a hostname resolution to the loop's generic pool. Loop-thread only.
// Returns false only if the pool could not start a worker (the caller then undoes its drive_pending
// pin); the request settles later via dns_resolve_done.
fetch_dns_submit :: proc(req: ^Fetch_Request, host: string) -> bool {
	job := new(DNS_Job, runtime.heap_allocator())
	job.allocator = runtime.heap_allocator()
	job.host = strings.clone(host, job.allocator)
	job.req = req
	req.dns_job = job // back-pointer so an abort before the completion can cancel it
	if !eventloop.pool_submit(req.loop, dns_resolve_work, dns_resolve_done, job, dns_resolve_dispose) {
		req.dns_job = nil
		delete(job.host, job.allocator)
		free(job, job.allocator)
		return false
	}
	return true
}

// dns_resolve_work is the blocking resolve, off the loop, writing only into the job. net.resolve
// returns up to one IPv4 and one IPv6 endpoint and errors only when BOTH families fail, so an
// AAAA-only host still resolves (#145); the list is ordered A then AAAA. (The pool worker frees this
// lookup's temp-allocator scratch after work returns.)
@(private = "file")
dns_resolve_work :: proc(user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	if sync.atomic_load(&job.cancelled) do return
	if ep4, ep6, dns_err := net.resolve(job.host); dns_err == nil {
		if ip4, ip_ok := ep4.address.(net.IP4_Address); ip_ok {
			job.addrs[job.addr_count] = Fetch_Addr {
				is_v6 = false,
				v4    = ip4,
			}
			job.addr_count += 1
		}
		if ip6, ip_ok := ep6.address.(net.IP6_Address); ip_ok {
			job.addrs[job.addr_count] = Fetch_Addr {
				is_v6 = true,
				v6    = ip6,
			}
			job.addr_count += 1
		}
	}
}

// dns_resolve_done runs on the loop thread once the lookup finishes: free the job, then drive the
// connect to the resolved address (or reject). A request cancelled mid-lookup is already settled, so
// the result is dropped — the drive_pending decrement lets it be reclaimed.
@(private = "file")
dns_resolve_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	req := job.req
	addrs := job.addrs
	addr_count := job.addr_count
	if req != nil do req.dns_job = nil // drop the back-pointer before the job is freed
	delete(job.host, job.allocator)
	free(job, job.allocator)
	if req == nil do return
	req.drive_pending -= 1
	if req.settled do return
	if addr_count == 0 {
		fetch_settle_error(req, "fetch: could not resolve host")
		return
	}
	// Hand the resolved list to the request and connect to the first address;
	// fetch_advance_connect falls through to the next on a connect failure (#145).
	req.addrs = addrs
	req.addr_count = addr_count
	req.addr_index = 0
	fetch_advance_connect(req)
}

// dns_resolve_dispose frees a job whose completion will not run (dropped at loop teardown). The owning
// request is freed separately by fetch_destroy_pending, so only the job's own heap allocations are
// released here, and job.req — possibly freed by now — is never read. Runs in close_begin for a queued
// job, or once its worker has exited for one in flight (close_finish, or that worker's own thread for
// a detached loop).
@(private = "file")
dns_resolve_dispose :: proc(user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	delete(job.host, job.allocator)
	free(job, job.allocator)
}

// fetch_dns_cancel_job marks a still-queued lookup cancelled so its worker skips the blocking resolve
// (the owning request has already settled). Loop-thread only; the atomic store pairs with the worker's
// atomic load in dns_resolve_work. Best-effort for an in-flight resolve, guaranteed for a queued one.
fetch_dns_cancel_job :: proc(job: ^DNS_Job) {
	sync.atomic_store(&job.cancelled, true)
}
