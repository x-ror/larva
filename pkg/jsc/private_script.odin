package jsc

// A JSScriptRef is a parsed-for-syntax source held by one VM (JSC's OpaqueJSScript, a
// SourceProvider), evaluable in any context of that VM as often as needed.
JSScriptRef :: distinct rawptr

// script_create makes a script of `source` for the VM `group`, named `url` (what a
// stack frame shows) and starting at line 1.
//
// Returns:
//   The script, owned by the caller (one script_release); nil when this JSC does not
//   export the API (and off Linux), or when `source` does not parse — the caller then
//   evaluates the source the ordinary way, which reports the error.
//
// Why: JSEvaluateScript makes a new SourceProvider of a new string every call, and
// OpaqueJSString::string() copies the text once more (isolatedCopy), so a page that
// evaluates the ~0.8 MB of embedded runtime JS pays, per page and in proportion to its
// length, a UTF-8 decode, two copies and a full hash of every source (JSC's CodeCache
// keys on the text) — about 12% of a page's CPU in a perf profile of bench/pages
// (8ecd066, N=1, 600 pages: JSStringCreateWithUTF8CString 4.0%, isolatedCopy 3.3%,
// StringImpl::hashSlowCase 5.3% of all samples). A script made once per VM keeps one
// string: its hash is computed once and cached on it, and CodeCache's key compare finds
// the same characters. Measured on bench/pages (-o:speed, N=1, 400 pages a launch,
// medians of 5 interleaved launches per arm, a 4-core Xeon shared with other work), on
// top of jsc.never_optimize: process CPU 10.4 -> 8.4 ms a page, pages/s 100 -> 130.
//
// The API is JSScriptRefPrivate.h's: plain C symbols libjavascriptcoregtk-6.0 exports,
// private only in that the header is not installed — no C++ ABI to probe, as for
// heap_size_bytes. JSScriptCreateFromString runs a syntax check (once per VM per
// source, the price of reuse) and JSScriptEvaluate RELEASE_ASSERTs that the context
// belongs to the script's VM, so a script never outlives or leaves its VM: callers keep
// them on the VM record and release them before the group (vm_pool.odin).
when ODIN_OS == .Linux {
	foreign import libdl_script "system:dl"

	@(default_calling_convention = "c")
	foreign libdl_script {
		@(private = "file", link_name = "dlsym")
		script_dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
	}

	@(private = "file")
	Script_Create_Proc :: #type proc "c" (
		group: JSContextGroupRef,
		url: JSStringRef,
		starting_line: i32,
		source: JSStringRef,
		error_message: ^JSStringRef,
		error_line: ^i32,
	) -> JSScriptRef
	@(private = "file")
	Script_Evaluate_Proc :: #type proc "c" (
		ctx: JSContextRef,
		script: JSScriptRef,
		this_value: JSValueRef,
		exception: ^JSValueRef,
	) -> JSValueRef
	@(private = "file")
	Script_Release_Proc :: #type proc "c" (script: JSScriptRef)

	// Thread-local like every probe in this package. A miss of any of the three is a
	// fact about the linked library, so it is latched; nothing else is.
	@(private = "file", thread_local)
	g_script_checked: bool
	@(private = "file", thread_local)
	g_script_create: Script_Create_Proc
	@(private = "file", thread_local)
	g_script_evaluate: Script_Evaluate_Proc
	@(private = "file", thread_local)
	g_script_release: Script_Release_Proc
	// Scripts made and not yet released on this thread: what a test reads to see that a
	// VM's scripts go with it (script_live_count).
	@(private = "file", thread_local)
	g_script_live: int

	@(private = "file")
	script_resolve :: proc "contextless" () -> bool {
		if !g_script_checked {
			g_script_checked = true
			c := script_dlsym(nil, "JSScriptCreateFromString")
			e := script_dlsym(nil, "JSScriptEvaluate")
			r := script_dlsym(nil, "JSScriptRelease")

			if c != nil && e != nil && r != nil {
				g_script_create = transmute(Script_Create_Proc)c
				g_script_evaluate = transmute(Script_Evaluate_Proc)e
				g_script_release = transmute(Script_Release_Proc)r
			}
		}

		return g_script_create != nil
	}

	script_create :: proc "contextless" (group: JSContextGroupRef, url: JSStringRef, source: JSStringRef) -> JSScriptRef {
		if group == nil || source == nil || !script_resolve() {
			return nil
		}

		error_message: JSStringRef
		error_line: i32
		script := g_script_create(group, url, 1, source, &error_message, &error_line)

		if error_message != nil {
			JSStringRelease(error_message)
		}

		if script != nil {
			g_script_live += 1
		}

		return script
	}

	script_evaluate :: proc "contextless" (ctx: JSContextRef, script: JSScriptRef, exception: ^JSValueRef) -> JSValueRef {
		return g_script_evaluate(ctx, script, nil, exception)
	}

	script_release :: proc "contextless" (script: JSScriptRef) {
		if script == nil || g_script_release == nil {
			return
		}

		g_script_release(script)
		g_script_live -= 1
	}

	script_live_count :: proc "contextless" () -> int {
		return g_script_live
	}
} else {
	// Honest stubs: nothing is resolved off Linux, so no script is made and callers
	// evaluate every source the ordinary way.
	script_create :: proc "contextless" (_: JSContextGroupRef, _: JSStringRef, _: JSStringRef) -> JSScriptRef {
		return nil
	}

	script_evaluate :: proc "contextless" (_: JSContextRef, _: JSScriptRef, _: ^JSValueRef) -> JSValueRef {
		return nil
	}

	script_release :: proc "contextless" (_: JSScriptRef) {}

	script_live_count :: proc "contextless" () -> int {
		return 0
	}
}
