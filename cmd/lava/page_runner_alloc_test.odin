// Linux-only: the page runner exists only there (page_runner_other.odin).
#+build linux
package main

import "core:fmt"
import "core:mem/virtual"
import "core:testing"
import "core:time"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Bytes handed to JSC as a Uint8Array's NoCopy backing are freed by
// jsc_buffer_deallocator, through the heap, whenever JSC collects them — at the
// latest when the runner destroys its VMs. So they must come from the heap, never
// from context.allocator: the runner installs ITS allocator for everything a tick
// does, and loop callbacks (net, fetch, TLS reads) allocate under it (CLAUDE.md §4).
//
// Run under an arena, a heap free of any arena byte is a glibc abort ("free():
// invalid pointer"), whatever the heap's layout happens to be — a tracking allocator
// over the heap would hand out heap pointers and let the mismatch through. That is
// how this surfaced: the readiness-backend runner test aborted in vm_pool_destroy,
// freeing a net read buffer. Pages: an http server and a fetch client (fetch's chunk
// copy), and a net server and client (net's read copy), on each backend.
@(test)
runner_bytes_handed_to_jsc_never_come_from_the_runner_allocator :: proc(t: ^testing.T) {
	run_alloc_pages(t, readiness = false)
	eventloop.force_readiness_backend = true
	defer eventloop.force_readiness_backend = false
	run_alloc_pages(t, readiness = true)
}

@(private = "file")
Alloc_Outcome :: struct {
	done:   bool,
	status: lava.Status,
	exit:   int,
}

@(private = "file")
alloc_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	o := cast(^Alloc_Outcome)user_data
	o^ = {
		done   = true,
		status = result.status,
		exit   = result.exit_code,
	}
	lava.result_destroy(&result)
}

@(private = "file")
run_alloc_pages :: proc(t: ^testing.T, readiness: bool) {
	arena: virtual.Arena
	if virtual.arena_init_growing(&arena) != nil {
		testing.fail_now(t, "arena_init_growing failed")
	}
	defer virtual.arena_destroy(&arena)
	alloc := virtual.arena_allocator(&arena)

	base := 20000 + int(time.tick_now()._nsec % 20000)
	// Heap, not tprintf: a page's require() resets the temp arena.
	sources := [4]string {
		fmt.aprintf(`const srv = require('http').createServer((req, res) => {{ res.end('hello'); srv.close(); process.exitCode = 5; }});
		srv.listen(%d, '127.0.0.1');`, base),
		fmt.aprintf(`setTimeout(() => {{
			fetch('http://127.0.0.1:%d/').then((r) => r.text()).then((s) => {{ process.exitCode = s === 'hello' ? 5 : 6; }}, () => {{ process.exitCode = 8; }});
		}}, 100);`, base),
		fmt.aprintf(`const srv = require('net').createServer((c) => {{ c.end('hi'); srv.close(); process.exitCode = 5; }});
		srv.listen(%d, '127.0.0.1');`, base + 1),
		fmt.aprintf(`setTimeout(() => {{
			const s = require('net').connect(%d, '127.0.0.1');
			s.on('data', (d) => {{ process.exitCode = String(d) === 'hi' ? 5 : 6; }});
			s.on('error', () => {{ process.exitCode = 8; }});
		}}, 100);`, base + 1),
	}
	defer for s in sources do delete(s)

	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 4, alloc_done, alloc) {
		testing.fail_now(t, "page_runner_init failed")
	}
	outcomes: [4]Alloc_Outcome
	for src, i in sources do lava.page_runner_open(&runner, src, "<alloc>", {cpu_budget = 30}, &outcomes[i])
	lava.page_runner_run(&runner)
	// The VMs die here, and with them every ArrayBuffer JSC still held.
	lava.page_runner_destroy(&runner)
	for o, i in outcomes {
		testing.expectf(t, o.done && o.status == .Ok && o.exit == 5, "readiness=%v page %d: %v", readiness, i, o)
	}
}
