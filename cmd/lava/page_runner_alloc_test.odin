// Linux-only: the page runner exists only there (page_runner_other.odin).
#+build linux
package main

import "core:fmt"
import "core:mem"
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
// The runner runs on a Poisoned_Arena: the heap's free reads the word just before
// the block as the pointer to release (heap_allocator.odin, aligned_free), and this
// allocator puts a poison address there, so a heap free of any of its bytes is a
// glibc abort ("free(): invalid pointer") every time. A plain arena is not enough —
// its memory is zeroed, the word reads as nil, and free(nil) passes silently (the
// first version of this test survived its own mutations that way); a tracking
// allocator over the heap hands out real heap blocks and lets the mismatch through.
// This surfaced as the readiness-backend runner test aborting in vm_pool_destroy,
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
	poisoned: Poisoned_Arena

	if virtual.arena_init_growing(&poisoned.arena) != nil {
		testing.fail_now(t, "arena_init_growing failed")
	}

	defer virtual.arena_destroy(&poisoned.arena)
	alloc := mem.Allocator{poisoned_arena_proc, &poisoned}

	base := 20000 + int(time.tick_now()._nsec % 20000)
	// Heap, not tprintf: a page's require() resets the temp arena.
	sources := [4]string {
		fmt.aprintf(
			`const srv = require('http').createServer((req, res) => {{ res.end('hello'); srv.close(); process.exitCode = 5; }});
		srv.listen(%d, '127.0.0.1');`,
			base,
		),
		fmt.aprintf(
			`setTimeout(() => {{
			fetch('http://127.0.0.1:%d/').then((r) => r.text()).then((s) => {{ process.exitCode = s === 'hello' ? 5 : 6; }}, () => {{ process.exitCode = 8; }});
		}}, 100);`,
			base,
		),
		fmt.aprintf(
			`const srv = require('net').createServer((c) => {{ c.end('hi'); srv.close(); process.exitCode = 5; }});
		srv.listen(%d, '127.0.0.1');`,
			base + 1,
		),
		fmt.aprintf(
			`setTimeout(() => {{
			const s = require('net').connect(%d, '127.0.0.1');
			s.on('data', (d) => {{ process.exitCode = String(d) === 'hi' ? 5 : 6; }});
			s.on('error', () => {{ process.exitCode = 8; }});
		}}, 100);`,
			base + 1,
		),
	}
	defer for s in sources {delete(s)}

	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 4, alloc_done, alloc) {
		testing.fail_now(t, "page_runner_init failed")
	}

	outcomes: [4]Alloc_Outcome
	for src, i in sources {
		lava.page_runner_open(&runner, src, "<alloc>", {cpu_budget = 30}, &outcomes[i])
	}
	lava.page_runner_run(&runner)
	// The VMs die here, and with them every ArrayBuffer JSC still held.
	lava.page_runner_destroy(&runner)
	for o, i in outcomes {
		testing.expectf(t, o.done && o.status == .Ok && o.exit == 5, "readiness=%v page %d: %v", readiness, i, o)
	}
}

// Poisoned_Arena hands out arena memory with POISON_FREE_PTR in the word before every
// block. Frees are no-ops (it is an arena); a resize copies into a fresh block.
@(private = "file")
Poisoned_Arena :: struct {
	arena: virtual.Arena,
}

// An address glibc's free() rejects outright: not 16-byte aligned.
@(private = "file")
POISON_FREE_PTR :: uintptr(0x11)

@(private = "file")
poisoned_arena_proc :: proc(
	data: rawptr,
	mode: mem.Allocator_Mode,
	size, alignment: int,
	old_memory: rawptr,
	old_size: int,
	loc := #caller_location,
) -> (
	[]byte,
	mem.Allocator_Error,
) {
	p := cast(^Poisoned_Arena)data
	backing := virtual.arena_allocator(&p.arena)
	switch mode {
	case .Alloc, .Alloc_Non_Zeroed, .Resize, .Resize_Non_Zeroed:
		align := max(alignment, 16)
		raw, err := mem.alloc_bytes(size + align, align, backing, loc)

		if err != nil {
			return nil, err
		}

		block := raw[align:][:size]
		(cast(^uintptr)(uintptr(raw_data(block)) - size_of(uintptr)))^ = POISON_FREE_PTR

		if (mode == .Resize || mode == .Resize_Non_Zeroed) && old_memory != nil {
			mem.copy(raw_data(block), old_memory, min(old_size, size))
		}

		return block, nil
	case .Free, .Free_All:
		return nil, nil
	case .Query_Features, .Query_Info:
		return nil, .Mode_Not_Implemented
	}
	return nil, .Mode_Not_Implemented
}
