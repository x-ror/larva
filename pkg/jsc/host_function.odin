package jsc

import "core:c"
import "core:os"

// Native functions registered through JSC's internal host-call convention
// instead of the C API's callback objects. A C-API callback
// (JSObjectMakeFunctionWithCallback) pays, on every call: the
// JSCallbackFunction trampoline, marshaling arguments into a JSValueRef
// vector, and — dominating the cost — a full JSLock::DropAllLocks/re-lock
// mutex round trip around the client callback. A host function created via the
// exported JSC::JSFunction::create(VM&, JSGlobalObject*, …, NativeFunction, …)
// is called directly by the interpreter/JIT as
//
//	EncodedJSValue fn(JSGlobalObject*, CallFrame*)
//
// with the VM lock held and the arguments already on the frame.
//
// Two facts make the body of such a function nearly identical to a C-API
// callback on 64-bit builds:
//   - JSContextRef and JSGlobalObject* are the same pointer (verified at
//     probe time via JSContextGetGlobalObject(ctx) == ctx), and
//   - a JSValueRef IS the 64-bit encoded JSValue bit pattern, so call-frame
//     argument slots can be handed to public C-API functions unchanged, and a
//     JSValueRef result is returned by transmuting to EncodedJSValue.
//
// The only layout assumption is the CallFrame header (stable in JSC for
// years): 8-byte slots [callerFrame, returnPC, codeBlock, callee,
// argumentCountIncludingThis, this, arg0, …]. It is validated functionally at
// first use: a probe host function is registered and called with known
// arguments through the public C API, and must see the right count and values
// and return a recognizable result — all reads/writes of JS values go through
// C-API functions, so no NaN-boxing constants are assumed anywhere. Any
// failure (missing symbol, pointer-identity mismatch, probe mismatch) leaves
// host_function_create permanently returning ok=false and callers keep using
// C-API callbacks.

// Host_Function_Proc is JSC's NativeFunction: EncodedJSValue (*)(JSGlobalObject*, CallFrame*).
Host_Function_Proc :: #type proc "c" (global_object: rawptr, call_frame: [^]u64) -> i64

// CallFrame header slot indices (JSC CallFrame.h / CallFrameSlot), 8 bytes per
// slot. argumentCountIncludingThis is the low 32 bits of its slot. The callee
// slot holds the JSFunction cell being invoked — the probe validates it, and
// the runtime's generic native trampoline keys its dispatch on it.
CALL_FRAME_CALLEE_SLOT :: 3
CALL_FRAME_ARGC_SLOT :: 4
CALL_FRAME_THIS_SLOT :: 5
CALL_FRAME_FIRST_ARG_SLOT :: 6

when ODIN_OS == .Linux {
	foreign import libdl_host "system:dl"

	@(default_calling_convention = "c")
	foreign libdl_host {
		@(private = "file", link_name = "dlsym")
		host_dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
	}

	// JSFunction* JSC::JSFunction::create(VM&, JSGlobalObject*, unsigned length,
	//   const String& name, NativeFunction, ImplementationVisibility, Intrinsic,
	//   NativeFunction ctor, const DOMJIT::Signature*)
	// FunctionPtr<PtrTag,…> is one raw pointer (tags are no-ops off arm64e);
	// ImplementationVisibility::Public and NoIntrinsic are both 0. Returns a raw
	// GC cell pointer — no sret.
	@(private = "file")
	Create_Host_Fn_Proc :: #type proc "c" (
		vm: rawptr,
		global: rawptr,
		length: c.uint,
		name: ^rawptr,
		native_fn: rawptr,
		visibility: c.int,
		intrinsic: c.int,
		native_ctor: rawptr,
		signature: rawptr,
	) -> rawptr

	// JSLockHolder is a single RefPtr<VM> (8 bytes); construct/destruct it on a
	// local slot to hold the VM lock around the raw create call (C-API calls
	// lock per-call; a raw JSFunction::create allocates GC cells and must not
	// run unlocked).
	@(private = "file")
	Lock_Ctor_Proc :: #type proc "c" (holder: ^rawptr, global_object: rawptr)
	@(private = "file")
	Lock_Dtor_Proc :: #type proc "c" (holder: ^rawptr)

	// JSC::Exception* VM::throwException(JSGlobalObject*, JSValue) — JSValue is
	// one EncodedJSValue word, passed by value.
	@(private = "file")
	Vm_Throw_Proc :: #type proc "c" (vm: rawptr, global: rawptr, value: u64) -> rawptr

	// Thread-local: the probe registers and calls a host function on the
	// calling thread's (thread-confined) context, and g_probe_seen/g_probe_callee
	// are written by that probe callback on the same thread. Per-thread state
	// keeps concurrent worker startups from clobbering each other's probe.
	@(private = "file", thread_local)
	g_host_checked: bool
	@(private = "file", thread_local)
	g_host_ok: bool
	@(private = "file", thread_local)
	g_host_create: Create_Host_Fn_Proc
	@(private = "file", thread_local)
	g_host_lock_ctor: Lock_Ctor_Proc
	@(private = "file", thread_local)
	g_host_lock_dtor: Lock_Dtor_Proc
	@(private = "file", thread_local)
	g_vm_throw: Vm_Throw_Proc
	@(private = "file", thread_local)
	g_probe_seen: bool
	@(private = "file", thread_local)
	g_probe_callee: rawptr
	// JSC::callHostFunctionAsConstructor, the constructor slot of a non-constructor
	// host function; resolved on the first host_function_create that asks for one.
	@(private = "file", thread_local)
	g_not_ctor: rawptr
	@(private = "file", thread_local)
	g_not_ctor_checked: bool

	// debug_log reports probe outcomes on stderr when LAVA_HOSTFN_DEBUG is set —
	// the fallback is silent by design, so this is the diagnostic switch.
	@(private = "file")
	debug_log :: proc(msg: string) {
		if len(os.get_env("LAVA_HOSTFN_DEBUG", context.temp_allocator)) == 0 {
			return
		}

		os.write_string(os.stderr, msg)
		os.write_string(os.stderr, "\n")
	}

	@(private = "file")
	host_probe :: proc "c" (global: rawptr, cf: [^]u64) -> i64 {
		ctx := JSContextRef(global)
		// Guard the frame reads: if the layout assumption were wrong, the count
		// almost certainly won't be 3, and we bail before touching "arguments".
		argc := u32(cf[CALL_FRAME_ARGC_SLOT] & 0xFFFFFFFF)

		if argc == 3 && rawptr(uintptr(cf[CALL_FRAME_CALLEE_SLOT])) == g_probe_callee {
			a0 := JSValueRef(uintptr(cf[CALL_FRAME_FIRST_ARG_SLOT]))
			a1 := JSValueRef(uintptr(cf[CALL_FRAME_FIRST_ARG_SLOT + 1]))

			if JSValueIsNumber(ctx, a0) && JSValueIsString(ctx, a1) && JSValueToNumber(ctx, a0, nil) == 42 {
				s := JSValueToStringCopy(ctx, a1, nil)

				if s != nil {
					equal := JSStringIsEqualToUTF8CString(s, "ab")
					JSStringRelease(s)

					if equal {
						g_probe_seen = true
					}
				}
			}
		}

		return transmute(i64)JSValueMakeNumber(ctx, 7)
	}

	@(private = "file")
	create_raw :: proc(
		ctx: JSContextRef,
		name: string,
		fn: Host_Function_Proc,
		arity: int,
		ctor: rawptr = nil,
	) -> JSObjectRef {
		impl, name_ok := wtf_string_impl_from_ascii(name)

		if !name_ok {
			return nil
		}

		vm := JSContextGetGroup(ctx)

		if vm == nil {
			return nil
		}

		holder: rawptr
		g_host_lock_ctor(&holder, rawptr(ctx))
		// The same fn doubles as the constructor slot unless the caller chose one: most
		// natives are never `new`ed, and a non-null pointer can never null-deref if one is.
		fptr := g_host_create(
			vm,
			rawptr(ctx),
			c.uint(arity),
			&impl,
			transmute(rawptr)fn,
			0,
			0,
			ctor != nil ? ctor : transmute(rawptr)fn,
			nil,
		)
		g_host_lock_dtor(&holder)
		return JSObjectRef(fptr)
	}

	// ensure_host resolves the private-ABI symbols and validates the CallFrame
	// layout once per thread.
	//
	// g_host_checked latches only on a DEFINITIVE verdict — a symbol this JSC does
	// not export, or a probe/self-test mismatch. Those are facts about the linked
	// library and cannot change for the life of the process. A TRANSIENT failure
	// (create_raw returning nil because a WTF allocation failed) proves nothing and
	// leaves the flag unset, so the next injection retries: CLAUDE.md §4, and the
	// same rule the sibling private_string.odin states explicitly at string_alloc8
	// ("Transient create/tryCreate failures return ok=false for this call only —
	// g_ok is latched false only by ensure_resolved's self-test"). Demotion to the
	// C-API path is safe but PERMANENT for the thread, so one bad allocation must
	// not cost every later native on that thread its host-call path.
	@(private = "file")
	ensure_host :: proc(ctx: JSContextRef) {
		if g_host_checked {
			return
		}

		// TEST-ONLY switch, same shape and purpose as the deleted net.odin's
		// LAVA_NET_FORCE_READINESS: force the C-API fallback so CI can exercise the
		// "probe missed" half of this file on a box where the probe would succeed.
		// That direction has had no coverage since the macOS/Windows jobs were
		// disabled, which is exactly the direction a JSC upgrade renaming the mangled
		// symbol above would take. Deliberate configuration, so it latches.
		if len(os.get_env("LAVA_HOSTFN_DISABLE", context.temp_allocator)) != 0 {
			debug_log("hostfn: disabled by LAVA_HOSTFN_DISABLE")
			g_host_checked = true
			return
		}

		// Resolved once even across a transient retry: dlsym is the expensive half
		// and its answer is definitive either way.
		if g_host_create == nil {
			pc := host_dlsym(
				nil,
				"_ZN3JSC10JSFunction6createERNS_2VMEPNS_14JSGlobalObjectEjRKN3WTF6StringENS5_11FunctionPtrILNS5_6PtrTagE1EFlS4_PNS_9CallFrameEELNS5_18FunctionAttributesE2EEENS_24ImplementationVisibilityENS_9IntrinsicESF_PKNS_6DOMJIT9SignatureE",
			)
			pl := host_dlsym(nil, "_ZN3JSC12JSLockHolderC1EPNS_14JSGlobalObjectE")
			pd := host_dlsym(nil, "_ZN3JSC12JSLockHolderD1Ev")
			pt := host_dlsym(nil, "_ZN3JSC2VM14throwExceptionEPNS_14JSGlobalObjectENS_7JSValueE")

			if pc == nil || pl == nil || pd == nil || pt == nil {
				debug_log("hostfn: dlsym miss")
				g_host_checked = true // definitive: this JSC does not export the path
				return
			}

			g_host_create = transmute(Create_Host_Fn_Proc)pc
			g_host_lock_ctor = transmute(Lock_Ctor_Proc)pl
			g_host_lock_dtor = transmute(Lock_Dtor_Proc)pd
			g_vm_throw = transmute(Vm_Throw_Proc)pt
		}

		// APICast contract: JSContextRef IS the JSGlobalObject cell. It cannot be
		// checked by comparing against JSContextGetGlobalObject — that returns the
		// global *this* (toThis, possibly a proxy), a different object. But the
		// call itself dereferences ctx as a JSGlobalObject (globalObject->vm(),
		// methodTable()->toThis), so a non-nil result exercises the cast safely.
		if JSContextGetGlobalObject(ctx) == nil {
			debug_log("hostfn: GetGlobalObject nil")
			g_host_checked = true // definitive: the cast contract does not hold
			return
		}

		fn := create_raw(ctx, "__lava_hostcall_probe", host_probe, 2)

		if fn == nil {
			// Two distinct causes, only one transient. create_raw builds its name
			// through the private string bridge; if THAT probe latched off (missing
			// symbol / ABI self-test mismatch — the same JSC-upgrade scenario as the
			// dlsym miss above), every retry is doomed, so latch: definitive.
			if string_bridge_latched_off() {
				debug_log("hostfn: create_raw nil (string bridge latched off)")
				g_host_checked = true
				return
			}

			// Otherwise a WTF string-impl or GC-cell allocation failed. Nothing about
			// the ABI was disproved, so do NOT latch — this call falls back, the next
			// injection tries again. Neither arm here is pinnable by an in-repo test
			// (both need a fault injected inside JSC itself); accepted untested.
			debug_log("hostfn: create_raw nil (transient — not latching)")
			return
		}

		// Past this point every outcome is a verdict on the CallFrame layout, so the
		// result is permanent whichever way it goes.
		g_host_checked = true

		args := [2]JSValueRef{JSValueMakeNumber(ctx, 42), js_probe_string(ctx)}
		g_probe_callee = rawptr(fn)
		g_probe_seen = false
		res := JSObjectCallAsFunction(ctx, fn, nil, 2, &args[0], nil)

		if !g_probe_seen || res == nil {
			debug_log("hostfn: probe not seen / res nil")
			return
		}

		if !JSValueIsNumber(ctx, res) || JSValueToNumber(ctx, res, nil) != 7 {
			debug_log("hostfn: bad probe result")
			return
		}

		debug_log("hostfn: ACTIVE")
		g_host_ok = true
	}

	@(private = "file")
	js_probe_string :: proc(ctx: JSContextRef) -> JSValueRef {
		s := JSStringCreateWithUTF8CString("ab")
		defer JSStringRelease(s)
		return JSValueMakeString(ctx, s)
	}

	// host_function_create registers `fn` as a JSC host function named `name`.
	// The returned object is an ordinary JS function value (attach it with
	// JSObjectSetProperty). ok=false whenever the private path is unavailable —
	// callers must fall back to JSObjectMakeFunctionWithCallback.
	//
	// Params:
	//   ctor           What `new` runs: nil reuses `fn` (the long-standing default),
	//                  otherwise this native, which finds new.target in the frame's
	//                  `this` slot (JSC passes it there to a native constructor).
	//   constructible  false makes the function a non-constructor like a built-in
	//                  method: `new f()` throws JSC's own TypeError and
	//                  `class extends f` is refused. JSC marks a host function so
	//                  when its constructor is callHostFunctionAsConstructor; a JSC
	//                  that does not export it gives ok=false.
	host_function_create :: proc(
		ctx: JSContextRef,
		name: string,
		fn: Host_Function_Proc,
		arity: int,
		ctor: Host_Function_Proc = nil,
		constructible := true,
	) -> (
		function: JSObjectRef,
		ok: bool,
	) {
		ensure_host(ctx)

		if !g_host_ok {
			return nil, false
		}

		ctor_ptr := transmute(rawptr)ctor

		if !constructible {
			if !host_non_constructor_available() {
				return nil, false
			}

			ctor_ptr = g_not_ctor
		}

		function = create_raw(ctx, name, fn, arity, ctor_ptr)
		return function, function != nil
	}

	// host_non_constructor_available reports whether this JSC exports
	// callHostFunctionAsConstructor, which host_function_create(constructible = false)
	// needs. A fact about the library; resolved once per thread.
	host_non_constructor_available :: proc() -> bool {
		if !g_not_ctor_checked {
			g_not_ctor_checked = true
			g_not_ctor = host_dlsym(nil, "_ZN3JSC29callHostFunctionAsConstructorEPNS_14JSGlobalObjectEPNS_9CallFrameE")
		}

		return g_not_ctor != nil
	}

	// host_calls_active reports whether the private-ABI host-call path resolved on
	// this thread. Exported for TESTS only: a regression test that exercises the
	// host-native registry is silently vacuous if the probe missed (nothing is
	// ever registered, so nothing can go stale), and a probe miss is a realistic
	// outcome of a JSC upgrade renaming the mangled symbol this dlsyms.
	host_calls_active :: proc(ctx: JSContextRef) -> bool {
		ensure_host(ctx)
		return g_host_ok
	}

	// host_throw raises `value` as a JS exception from inside a host function —
	// the equivalent of the C-API callback machinery's *exception handling. The
	// host function should return the same value (its result is ignored once
	// the VM has a pending exception). Only meaningful while g_host_ok, i.e.
	// inside functions created by host_function_create.
	// Returns whether the exception was actually raised. Callers MUST check: every
	// guard below is a silent no-op, and a caller that returns `value` anyway hands
	// an Error object back as an ordinary result — the fail-open shape this exists
	// to prevent. The !g_host_ok guard is defense in depth for an arm that is
	// unreachable by construction: any function that can dispatch here was minted
	// by host_function_create AFTER the probe passed on this (context-confined)
	// thread, so every reachable miss runs with g_host_ok == true and takes the
	// raise — host_native_failclosed_test.odin's post-sweep assertion depends on
	// that. The guard survives for the forbidden cross-thread call and the
	// nil-value/nil-vm cases, where refusing to claim a raise is what keeps the
	// caller from returning the Error as a value.
	host_throw :: proc "contextless" (ctx: JSContextRef, value: JSValueRef) -> bool {
		if !g_host_ok || value == nil {
			return false
		}

		vm := JSContextGetGroup(ctx)

		if vm == nil {
			return false
		}

		g_vm_throw(vm, rawptr(ctx), transmute(u64)value)
		return true
	}
} else {
	host_function_create :: proc(
		_: JSContextRef,
		_: string,
		_: Host_Function_Proc,
		_: int,
		ctor: Host_Function_Proc = nil,
		constructible := true,
	) -> (
		function: JSObjectRef,
		ok: bool,
	) {
		return nil, false
	}

	host_non_constructor_available :: proc() -> bool {
		return false
	}

	// Honest stub: the host-call path does not exist off Linux, so the registry is
	// permanently empty there and any test gated on this must skip, not assert.
	host_calls_active :: proc(_: JSContextRef) -> bool {
		return false
	}

	// Honest stub: there is no private-ABI throw off Linux, so this never raises.
	host_throw :: proc "contextless" (_: JSContextRef, _: JSValueRef) -> bool {
		return false
	}
}
