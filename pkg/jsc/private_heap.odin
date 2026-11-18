package jsc

// heap_size_bytes reads how many bytes the JS heap of the VM that owns `ctx` occupies.
//
// Returns:
//   bytes  The heap's `heapCapacity` (JSC::Heap::capacity(): the bytes of every block
//          the heap holds, live cells and not-yet-collected garbage alike, plus extra
//          memory reported to it). > 0 whenever ok.
//   ok     false when this JSC does not export the path, when the probe found an
//          answer of the wrong shape, or for a nil context; the caller reports "not
//          sampled", never a made-up number.
//
// Why this symbol: JSGetMemoryUsageStatistics(JSContextRef) -> JSObjectRef is the
// only exported way to read a VM's heap size that takes a context. It is a plain C
// symbol (WebKit's JSBasePrivate.h, exported by libjavascriptcoregtk-6.0), so unlike
// host_function.odin there is no C++ ABI to probe — what is private is only that the
// header is not installed. JSC::Heap::size() and JSC::Heap::capacity() are exported
// too (C++ symbols) and would skip the walk below, but both take a Heap*, and reaching
// the Heap from a context means hard-coding VM's field layout; rejected for that, not
// measured. (size() would also carry the staleness explained below; capacity() is the
// unmeasured cheaper alternative to this call.)
//
// Cost: the call is not a counter read. It builds an object of per-type object
// counts, which walks the whole heap (JSC::Heap::objectTypeCounts), and allocates
// that object in the page's context. So it is opt-in and sampled (Page_Runner.
// heap_sample_every); the measured cost is stated at its one caller, page_close
// (pkg/runtime/page.odin).
//
// Why capacity and not the same object's `heapSize`: heapSize is the bytes MARKED live
// by the last collection, so it is stale by everything allocated since and reads 0
// until the VM's first collection. Measured with a standalone probe on JSC 2.52
// (libjavascriptcoregtk-6.0), one run, one VM, figures after each step: fresh VM
// heapSize 0 / capacity 344064; +200k small objects 8204346 / 8709098; +200k more
// 13286499 / 16832323. A 0 would also collide with Result.heap_bytes' "not sampled".
// Capacity is current, never 0, and is what the heap costs in memory, which is what a
// caller capping a page's memory needs.
//
// The answer is the VM's, not the context's: one page holds a VM at a time, so it is
// the page's heap plus whatever earlier pages on the VM left that no collection has
// reclaimed yet.
when ODIN_OS == .Linux {
	foreign import libdl_heap "system:dl"

	@(default_calling_convention = "c")
	foreign libdl_heap {
		@(private = "file", link_name = "dlsym")
		heap_dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
	}

	@(private = "file")
	Memory_Stats_Proc :: #type proc "c" (ctx: JSContextRef) -> JSObjectRef

	// Thread-local like every probe in this package (no synchronization, one dlsym per
	// thread). g_heap_checked latches only a definitive verdict: the symbol missing, or
	// a first answer without a positive numeric heapCapacity — facts about the linked
	// library.
	// A nil result (nothing in JSC returns one for a live context) is not a verdict
	// and is not latched.
	@(private = "file", thread_local)
	g_heap_checked: bool
	@(private = "file", thread_local)
	g_heap_ok: bool
	@(private = "file", thread_local)
	g_heap_stats: Memory_Stats_Proc

	heap_size_bytes :: proc "contextless" (ctx: JSContextRef) -> (bytes: i64, ok: bool) {
		if ctx == nil {
			return 0, false
		}

		if !g_heap_checked {
			if g_heap_stats == nil {
				p := heap_dlsym(nil, "JSGetMemoryUsageStatistics")

				if p == nil {
					g_heap_checked = true // definitive: this JSC does not export it
					return 0, false
				}

				g_heap_stats = transmute(Memory_Stats_Proc)p
			}
		} else if !g_heap_ok {
			return 0, false
		}

		stats := g_heap_stats(ctx)

		if stats == nil {
			return 0, false
		}

		name := JSStringCreateWithUTF8CString("heapCapacity")

		if name == nil {
			return 0, false
		}

		v := JSObjectGetProperty(ctx, stats, name, nil)
		JSStringRelease(name)

		// No answer at all says nothing about the library's shape: not latched, like a
		// nil `stats` (CLAUDE.md §4 probe rule). Only an answer of the wrong shape is.
		if v == nil {
			return 0, false
		}

		n: f64 = 0
		is_number := JSValueIsNumber(ctx, v)

		if is_number {
			n = JSValueToNumber(ctx, v, nil)
		}

		// `!(n > 0)` also catches NaN. A live VM's heap never holds no block: the global
		// object alone is in one.
		if !g_heap_checked {
			g_heap_checked = true
			g_heap_ok = is_number && n > 0 && n < 1e18
		}

		if !g_heap_ok || !(n > 0) {
			return 0, false
		}

		return i64(n), true
	}
} else {
	// Honest stub: no private symbol is resolved off Linux, so nothing is sampled.
	heap_size_bytes :: proc "contextless" (_: JSContextRef) -> (bytes: i64, ok: bool) {
		return 0, false
	}
}
