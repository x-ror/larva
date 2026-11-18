package jsc

// termination_exception returns the VM's termination exception — the one JSC's
// watchdog throws — for a native to hand back through its `exception` out-param.
//
// Returns:
//   The exception as a JSValueRef; nil when this JSC does not export the path, and
//   the caller must fall back to an ordinary (catchable) end.
//
// Why a private symbol: JSC skips every catch and finally handler for this one
// exception object, and only for it. That is the only way to end a script from a
// native the way Node ends a worker on process.exit() (isolate TerminateExecution):
// code after the call, and any catch/finally around it, never runs. The public C API
// has nothing uncatchable — a thrown value is an ordinary exception.
//
// Both paths a native can raise through accept it: a C-API callback's `*exception`
// and host_throw both end in VM::throwException(JSGlobalObject*, JSValue), which uses
// a JSValue that already is an Exception cell as is instead of wrapping it. Verified
// with a standalone C probe on JSC 2.52 (javascriptcoregtk-6.0), one run per case:
// `try { exit() ; log(1) } catch { log(2) } finally { log(3) } log(4)` logs nothing,
// and an exit() inside a promise job skips that job's catch too.
//
// ensureTerminationException allocates the cell on first use per VM, and a C-API
// callback runs with every JSC lock dropped (JSCallbackFunction's DropAllLocks), so
// the call takes the VM lock itself — without it the allocation aborted in
// Heap::stopIfNecessarySlow in the same probe. JSLockHolder is recursive, so the
// host-call path, which already holds the lock, pays one uncontended re-entry.
when ODIN_OS == .Linux {
	foreign import libdl_term "system:dl"

	@(default_calling_convention = "c")
	foreign libdl_term {
		@(private = "file", link_name = "dlsym")
		term_dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
	}

	// JSC::Exception* JSC::VM::ensureTerminationException()
	@(private = "file")
	Ensure_Term_Proc :: #type proc "c" (vm: rawptr) -> rawptr
	// JSLockHolder is one RefPtr<VM>; see host_function.odin.
	@(private = "file")
	Term_Lock_Ctor_Proc :: #type proc "c" (holder: ^rawptr, global_object: rawptr)
	@(private = "file")
	Term_Lock_Dtor_Proc :: #type proc "c" (holder: ^rawptr)

	// Thread-local like the other probes in this package: a dlsym answer is the same
	// on every thread, but a per-thread latch needs no synchronization and costs one
	// dlsym per thread. Latched only on the definitive outcome, a missing symbol.
	@(private = "file", thread_local)
	g_term_checked: bool
	@(private = "file", thread_local)
	g_term_ensure: Ensure_Term_Proc
	@(private = "file", thread_local)
	g_term_lock_ctor: Term_Lock_Ctor_Proc
	@(private = "file", thread_local)
	g_term_lock_dtor: Term_Lock_Dtor_Proc

	termination_exception :: proc "contextless" (ctx: JSContextRef) -> JSValueRef {
		if !g_term_checked {
			g_term_checked = true
			pe := term_dlsym(nil, "_ZN3JSC2VM26ensureTerminationExceptionEv")
			pl := term_dlsym(nil, "_ZN3JSC12JSLockHolderC1EPNS_14JSGlobalObjectE")
			pd := term_dlsym(nil, "_ZN3JSC12JSLockHolderD1Ev")

			if pe != nil && pl != nil && pd != nil {
				g_term_ensure = transmute(Ensure_Term_Proc)pe
				g_term_lock_ctor = transmute(Term_Lock_Ctor_Proc)pl
				g_term_lock_dtor = transmute(Term_Lock_Dtor_Proc)pd
			}
		}

		if g_term_ensure == nil || ctx == nil {
			return nil
		}

		// A JSContextGroupRef is the VM (toJS(JSContextGroupRef)); host_function.odin
		// relies on the same identity for VM::throwException.
		vm := JSContextGetGroup(ctx)

		if vm == nil {
			return nil
		}

		holder: rawptr
		g_term_lock_ctor(&holder, rawptr(ctx))
		exc := g_term_ensure(vm)
		g_term_lock_dtor(&holder)
		return JSValueRef(exc)
	}
} else {
	// Honest stub: no private ABI off Linux, so callers take their catchable fallback.
	termination_exception :: proc "contextless" (_: JSContextRef) -> JSValueRef {
		return nil
	}
}
