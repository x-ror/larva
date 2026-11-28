package jsc

// never_optimize keeps JSC's optimizing tiers (DFG, and so FTL) off one function: its
// code still runs in the interpreter and the baseline JIT, and an optimized caller may
// still inline it.
//
// Params:
//   ctx  A live context of the VM that owns `fn`; the call takes that VM's lock.
//   fn   A JS function. Anything else (a host function, a non-function) is a no-op
//        inside JSC: it has no FunctionExecutable to mark.
// Returns:
//   false when this JSC does not export the entry point (and off Linux); the function
//   is then left as it was — only slower to build pages, never different.
//
// Why: the runtime's install code (the module loader, internal/native_shape's member
// wrappers) runs once per page, but each of its helpers is called hundreds of times in
// that one run — once per interface member — so JSC tiers every one of them up to the
// DFG on every page, on a JIT thread, for code that never runs again: a page's
// FunctionExecutables are its own, so the optimized code dies with the page.
// JSC_reportDFGCompileTimes=1 on bench/pages listed the same 12 functions compiled
// once per page (8ecd066).
//
// The entry point is JSC::setNeverOptimize(JSContextRef, JSValueRef), the C-API
// flavoured twin of the jsc shell's `noDFG`, from JSC's TestRunnerUtils (exported by
// libjavascriptcoregtk-6.0 for WebKit's test runners). It sets the function's
// FunctionExecutable::m_neverOptimize, which DFG::mightCompileFunctionForCall reads;
// inlining is governed by the separate neverInline flag, which is left alone. The
// mangled name encodes both parameter types, so a signature change is a dlsym miss,
// not a call through the wrong ABI. Nothing is read back, so there is no answer to
// probe: a miss is the only verdict, and it is a fact about the linked library.
//
// Effect on a FunctionExecutable that already tiered up: none for code already
// compiled. Callers mark a function right after creating it, before its first call.
when ODIN_OS == .Linux {
	foreign import libdl_optimize "system:dl"

	@(default_calling_convention = "c")
	foreign libdl_optimize {
		@(private = "file", link_name = "dlsym")
		optimize_dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
	}

	@(private = "file")
	Set_Never_Optimize_Proc :: #type proc "c" (ctx: JSContextRef, fn: JSValueRef) -> JSValueRef

	// Thread-local like every probe in this package: one dlsym per thread, no
	// synchronization. Only a miss is latched, and it is definitive.
	@(private = "file", thread_local)
	g_never_optimize_checked: bool
	@(private = "file", thread_local)
	g_never_optimize: Set_Never_Optimize_Proc

	never_optimize :: proc "contextless" (ctx: JSContextRef, fn: JSValueRef) -> bool {
		if ctx == nil || fn == nil {
			return false
		}

		if !g_never_optimize_checked {
			g_never_optimize_checked = true
			p := optimize_dlsym(nil, "_ZN3JSC16setNeverOptimizeEPK15OpaqueJSContextPK13OpaqueJSValue")
			g_never_optimize = transmute(Set_Never_Optimize_Proc)p
		}

		if g_never_optimize == nil {
			return false
		}

		g_never_optimize(ctx, fn)
		return true
	}
} else {
	// Honest stub: no private symbol is resolved off Linux, so nothing is marked.
	never_optimize :: proc "contextless" (_: JSContextRef, _: JSValueRef) -> bool {
		return false
	}
}
