package lava_runtime

import "base:runtime"
import "core:c"
import "core:mem"
import "core:strings"
import jsc "lava:pkg/jsc"

// Generic host-call registration for every injected native. Explicit per-proc
// wrappers (buffer_host.odin) bake their callback into a dedicated entry
// point; everything else goes through one shared trampoline that recovers the
// callback from the frame's callee slot — the JSFunction cell being invoked —
// via a pointer-keyed table. Created functions are protected (their address IS
// the dispatch key, so the cell must never be collected and reused) and cached
// per (context, callback, name), so per-instance injections like the fs.Stats
// methods reuse one function object instead of minting a new one per call —
// like methods living on a prototype.

// host_dispatch adapts JSC's internal calling convention to a C-API-shaped
// callback: argument slots ARE JSValueRefs on 64-bit, the callee/this cells
// pass as the function/thisObject parameters (nil when `this` is not a cell —
// the callbacks that read it only ever receive objects), and a callback-set
// exception becomes a real VM throw, matching JSCallbackFunction.
host_dispatch :: proc "c" (
	global: rawptr,
	cf: [^]u64,
	cb: jsc.JSObjectCallAsFunctionCallback,
) -> i64 {
	context = runtime.default_context() // valid allocator for the overflow slice below
	ctx := jsc.JSContextRef(global)
	argc := int(u32(cf[jsc.CALL_FRAME_ARGC_SLOT] & 0xFFFFFFFF)) - 1 // minus `this`
	if argc < 0 do argc = 0
	// Deliver every argument. Fixed stack buffer for the common small case; a
	// genuinely variadic caller (setTimeout(fn, delay, ...args)) that overflows
	// it uses a temp slice rather than being silently truncated.
	stack_args: [16]jsc.JSValueRef
	args: []jsc.JSValueRef = stack_args[:]
	if argc > len(stack_args) {
		overflow, alloc_err := make([]jsc.JSValueRef, argc, context.temp_allocator)
		// Fail closed, same rule as a dispatch miss: a nil slice faults at &args[0]
		// and a truncated one would run the native against arguments it was never
		// passed. Reachable only at >16 args under temp-arena OOM.
		if alloc_err != nil do return host_dispatch_fail(ctx, "lava: host native dispatch failed (argument allocation)")
		args = overflow
	}
	for i in 0 ..< argc {
		args[i] = jsc.JSValueRef(uintptr(cf[jsc.CALL_FRAME_FIRST_ARG_SLOT + i]))
	}
	callee := host_cell_object(cf[jsc.CALL_FRAME_CALLEE_SLOT])
	this := host_cell_object(cf[jsc.CALL_FRAME_THIS_SLOT])
	exception: jsc.JSValueRef
	ret := cb(ctx, callee, this, c.size_t(argc), &args[0], &exception)
	if exception != nil {
		// Same rule as host_dispatch_fail: never return a value we know is not an
		// exception. Here g_host_ok is implied (we got here via a table hit, so
		// registration ran on this thread), but the check costs nothing and keeps
		// the two sites from drifting.
		if !jsc.host_throw(ctx, exception) do return transmute(i64)jsc.JSValueMakeUndefined(ctx)
		return transmute(i64)exception
	}
	if ret == nil do return transmute(i64)jsc.JSValueMakeUndefined(ctx)
	return transmute(i64)ret
}

@(private = "file")
host_cell_object :: proc "contextless" (bits: u64) -> jsc.JSObjectRef {
	if bits == 0 || (bits & jsc.VALUE_NOT_CELL_MASK) != 0 do return nil
	return jsc.JSObjectRef(uintptr(bits))
}

// js_int_arg reads an integer argument without a C-API call when it is an
// immediate int32 (the common case for offsets/lengths from the JS layer).
js_int_arg :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> int {
	if x, ok := jsc.value_int32(ctx, v); ok do return int(x)
	return int(jsc.JSValueToNumber(ctx, v, nil))
}

// js_int_value encodes an integer result without a C-API call when possible.
js_int_value :: proc(ctx: jsc.JSContextRef, v: int) -> jsc.JSValueRef {
	if v >= -2147483648 && v <= 2147483647 {
		if r, ok := jsc.make_int32(ctx, i32(v)); ok do return r
	}
	return jsc.JSValueMakeNumber(ctx, f64(v))
}

@(private = "file")
Host_Native_Key :: struct {
	ctx:  rawptr,
	cb:   rawptr,
	name: string,
}

// Thread-local: a JSC context is thread-confined, so a worker's registered
// functions (JSObjectRefs) and the callee->callback dispatch table belong to
// that worker's thread. Per-thread maps mean registration and the per-call
// dispatch lookup never touch another worker's state — no locks on the dispatch
// path, and no data race when N workers build their bindings concurrently
// (the failure the removed process-global interning risked). The dispatch
// callback runs on the ctx-owning thread, so it reads the same thread's table.
//
// Both tables are swept per context by host_natives_release_context, called from
// destroy_runtime_state while the context is still alive. Without that sweep the
// entries outlive the context they were registered for, and JSC hands the SAME
// address to a later JSGlobalContextCreate: the {ctx, cb, name} key then collides
// with a dead context's entry, the cache returns a JSObjectRef into freed memory,
// and the new VM's object at that address is called instead (observed: the
// `allocUninit` binding resolving to Map.prototype.values, plus segfaults and
// tracking-allocator bad frees, from the 3rd-4th eval in one process).
//
// The BACKING of both maps is bound explicitly to a process-lifetime allocator,
// never implicitly to the ambient one. Odin binds a zero-valued map's allocator
// on its first grow (base/runtime/dynamic_map_internal.odin: `if
// m.allocator.procedure == nil { m.allocator = context.allocator }`), and the
// first insert happens inside setup_module_environment under the CALLER's
// context. These tables are thread-lived and never deleted, so an implicit bind
// captures an allocator that dies long before they do: under the Odin test
// runner (a per-test tracking allocator over a rollback stack that is
// free_all'd between tests) or an embedder's per-eval arena, every later insert
// writes through a reclaimed backing and corrupts whatever now occupies it.
// Same rule Runtime_State.module_cache already follows (globals.odin).
@(private = "file", thread_local) g_host_native_fns: map[Host_Native_Key]jsc.JSObjectRef
@(private = "file", thread_local) g_host_native_cbs: map[rawptr]jsc.JSObjectCallAsFunctionCallback
@(private = "file", thread_local) g_host_tables_bound: bool

// bind_host_tables gives both tables a backing allocator that outlives them,
// before anything can insert. runtime.default_allocator() is the only lifetime
// that matches a thread-lived table: state.allocator dies with the eval, and the
// ambient one is whatever the caller happened to install.
//
// The two `make` errors are DELIBERATELY dropped, and that was checked rather
// than assumed. make(map, cap, alloc) routes through make_map_cap, which sets
// context.allocator = alloc and calls reserve_map; map_reserve_dynamic then binds
// m.allocator BEFORE the allocation that can fail
// (base/runtime/dynamic_map_internal.odin: `if m.allocator.procedure == nil {
// m.allocator = context.allocator }`, then map_alloc_dynamic). So a failed
// reserve still leaves the table bound to default_allocator with data == 0 — it
// is NOT the #317 implicit-capture bug, and the very next insert simply retries
// the grow. That insert is checked (host_native_create below), so an allocation
// failure surfaces there as a declined cache and a C-API fallback, never as a
// half-built registry. The flag therefore stays set on the failing path on
// purpose: re-running the reserve on every injection would buy nothing.
@(private = "file")
bind_host_tables :: proc() {
	if g_host_tables_bound do return
	g_host_tables_bound = true
	g_host_native_fns, _ = make(
		map[Host_Native_Key]jsc.JSObjectRef,
		64,
		runtime.default_allocator(),
	)
	g_host_native_cbs, _ = make(
		map[rawptr]jsc.JSObjectCallAsFunctionCallback,
		64,
		runtime.default_allocator(),
	)
}

// host_native_thread_teardown frees this thread's tables, for a thread that is about
// to end (a page dispatcher worker): they are thread_local and heap-bound, so a thread
// that exits without this leaks them. Every context on the thread must already be
// destroyed — destroy_runtime_state sweeps a context's entries, so nothing live can
// still be keyed here. A later call on the same thread binds fresh tables.
host_native_thread_teardown :: proc() {
	if !g_host_tables_bound do return
	delete(g_host_native_fns)
	delete(g_host_native_cbs)
	g_host_native_fns = nil
	g_host_native_cbs = nil
	g_host_tables_bound = false
}

@(private = "file")
generic_native_host_cb :: proc "c" (global: rawptr, cf: [^]u64) -> i64 {
	// NO `context =` here on purpose. make_js_error takes an implicit context, and
	// LLVM materialises runtime.default_context() in the ENTRY block — 16 extra
	// instructions and a 152-byte frame paid on every dispatch (102,963 of them for
	// bench/micro/encoding.js, zero misses). Keeping the cold path in its own
	// #force_no_inline proc restores the previous codegen instruction-for-instruction.
	cb, found := g_host_native_cbs[rawptr(uintptr(cf[jsc.CALL_FRAME_CALLEE_SLOT]))]
	if !found {
		return host_dispatch_fail(
			jsc.JSContextRef(global),
			"lava: host native dispatch failed (unregistered callee)",
		)
	}
	return host_dispatch(global, cf, cb)
}

// host_dispatch_fail FAILS CLOSED. Returning undefined here is silently wrong,
// not merely unhelpful: several natives write through a caller-supplied buffer
// and signal nothing on return, so a no-op call is indistinguishable from a
// successful one at the call site. buffer.js's fromString is the live example —
// it writes into a slice of the allocUnsafe pool and discards the result, so a
// missed native returns uninitialized pool memory (a freed request body, a key)
// as if it were the decoded string. The CSPRNG entry points had the same shape
// (a zeroed Buffer.alloc handed back as random bytes, and getRandomValues worse
// still, leaving the CALLER's array untouched); crypto.js now checks
// randomFill's return itself as a second layer, but that is a JS-side decision
// this layer cannot rely on. A miss means our own registry is inconsistent.
//
// This is the ONLY layer that can close those, and the reason is a convention
// worth stating so it stops being re-litigated: a native signals failure by
// setting `exception^` (a real throw), never by its return value. Audited
// 2026-07-28 — net.end/close/closeServer/startConnection, dns.lookup and
// sqlite.close/finalize all `return jsc.JSValueMakeUndefined(ctx)` on success and
// on failure alike, so the JS call sites that "discard the result" are discarding
// nothing. The two exceptions are documented at their natives: net.write's bool
// is BACKPRESSURE, not failure (Node's Socket.end ignores it too), and
// crypto.randomFill returns the view it filled, which crypto.js does check.
// Anything that wants a checkable failure signal has to add one deliberately.
@(private = "file")
host_dispatch_fail :: #force_no_inline proc "c" (ctx: jsc.JSContextRef, why: string) -> i64 {
	context = runtime.default_context()
	exception := make_js_error(ctx, why)
	// Both guards matter. make_js_error can return nil under OOM; returning it
	// would hand JSC the EMPTY JSValue with no pending exception, which is its
	// TDZ sentinel and isCell()-true — a segfault or a bogus "cannot access
	// before initialization" leaking into JS. And host_throw reports whether it
	// actually raised — its no-op arms are unreachable by construction from a
	// dispatch (see the contract at host_throw, pkg/jsc/host_function.odin), but
	// a caller that skipped the check would return the Error object as an
	// ordinary VALUE the moment that reasoning rots, and that is fail-open
	// again. Undefined is the honest answer when we cannot raise: wrong, but not
	// a crash and not a forged success.
	if exception == nil do return transmute(i64)jsc.JSValueMakeUndefined(ctx)
	if !jsc.host_throw(ctx, exception) do return transmute(i64)jsc.JSValueMakeUndefined(ctx)
	return transmute(i64)exception
}

// host_native_create returns a host-registered function for `cb`, creating and
// caching it on first use.
//
// Params:
//   ctx    Thread-confined JSC context that will own the binding; also part of
//          the cache key, so entries die with their context (see the sweep).
//   name   Binding name, cloned through the Runtime_State allocator.
//   cb     C-API-shaped callback the shared trampoline dispatches to.
//   arity  Becomes the function's `.length`.
// Returns:
//   The cached-or-new function object; nil when the host-call path is
//   unavailable or the registry declined, and the caller must fall back to
//   JSObjectMakeFunctionWithCallback (inject_native_function already does).
// Node:
//   `.length` is observable only for the natives injected as globals —
//   setTimeout/setInterval report 2, the rest 1 (verified against node 24).
// Deviates:
//   The C-API fallback reports 0 and cannot carry an arity through the public
//   API; analysis at inject_native_function (require.odin). Pinned by
//   tests/node-compat/cases/56-native-function-arity.js in the default
//   configuration, and by host_native_create_declines_without_state for the
//   fallback value itself.
//
// `arity` is part of the cache key only indirectly: the key is (ctx, cb, name),
// and a given callback is always injected under one name with one arity, so two
// arities for one name would collide. Nothing does that today and the naming
// makes it obvious if anything tries.
host_native_create :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	cb: jsc.JSObjectCallAsFunctionCallback,
	arity: int = 1,
) -> jsc.JSObjectRef {
	key := Host_Native_Key{rawptr(ctx), transmute(rawptr)cb, name}
	// Lookup first: the hit path is hot (measured ~60k hits per 20k fs.statSync,
	// three per Stats instance) and must not pay for anything below it.
	if fn, hit := g_host_native_fns[key]; hit do return fn

	// State FIRST, before anything is created. Names are cloned through the
	// Runtime_State's allocator, not the ambient one: this runs from
	// inject_native_function, which is reachable both from ordinary eval-time setup
	// AND from inside native_require_cb (a proc "c" whose context is reset to
	// runtime.default_context()). The sweep frees through that same state
	// allocator, so the two must be SYMMETRIC — no ambient fallback. Without a
	// state there is nothing that will ever free the entry, so decline to cache and
	// let the caller take the C-API path (it already handles a nil return, and
	// carries `.length` across — see inject_native_function, which also records the
	// one way the two paths still differ).
	//
	// Hoisted above the creation because none of it is needed to answer nil: a
	// stateless (embedder) context used to mint a JSFunction, protect it, bind two
	// maps and then discard all three on EVERY injection.
	state := get_state_from_ctx(ctx)
	if state == nil do return nil

	fn, ok := jsc.host_function_create(ctx, name, generic_native_host_cb, arity)
	if !ok || fn == nil do return nil
	jsc.JSValueProtect(ctx, jsc.JSValueRef(fn))
	bind_host_tables()
	alloc := state.allocator
	cloned, clone_err := strings.clone(name, alloc)
	if clone_err != nil {
		// Raw unprotect on purpose, unlike the sweep below: a mid-run rollback of
		// the protect taken above, with the context fully healthy.
		// unprotect_before_eval_exit's Windows carve-out is about FINAL teardown
		// racing the VM's GC/JIT workers; using it here would leak a root instead.
		jsc.JSValueUnprotect(ctx, jsc.JSValueRef(fn))
		return nil
	}
	key.name = cloned // outlive the caller's (possibly temp) string
	// CHECKED inserts. A bare `m[k] = v` discards the allocator error, and a half
	// -inserted pair is worse than no cache: an entry in cbs that fns does not
	// know about is unreachable from the sweep (it walks fns keys), so it would
	// outlive its context keyed by a dead cell address — the exact stale-dispatch
	// state this registry was fixed to prevent. Either both land or neither does.
	// map_insert returns the stored value's pointer, nil exactly when the grow
	// allocation failed (base/runtime/dynamic_map_internal.odin). map_entry is the
	// alternative and returns a typed Allocator_Error; nil is sufficient here.
	if map_insert(&g_host_native_fns, key, fn) == nil {
		delete(cloned, alloc)
		jsc.JSValueUnprotect(ctx, jsc.JSValueRef(fn))
		return nil
	}
	if map_insert(&g_host_native_cbs, rawptr(fn), cb) == nil {
		delete_key(&g_host_native_fns, key)
		delete(cloned, alloc)
		jsc.JSValueUnprotect(ctx, jsc.JSValueRef(fn))
		return nil
	}
	return fn
}

// host_natives_release_context drops every registration made for `ctx`. MUST run
// while `ctx` is still alive (JSValueUnprotect needs it) and before any later
// JSGlobalContextCreate can reuse the address — destroy_runtime_state is that
// point. `alloc` is the Runtime_State allocator the names were cloned through.
host_natives_release_context :: proc(ctx: jsc.JSContextRef, alloc: mem.Allocator) {
	// Single pass, allocation-free. Odin documents `delete_key` as safe DURING map
	// iteration (base/runtime/core_builtin.odin: "It is safe to use `delete_key`
	// while iterating a map") — erase is tombstone-only and relocates nothing;
	// only INSERTING during a range is unsafe, and this loop never inserts. An
	// earlier revision of this sweep collected the victims into a temp [dynamic]
	// first, whose make/append errors were discarded, so an allocation failure
	// would silently leave live entries keyed by a dead context — the exact
	// use-after-free this sweep exists to prevent, with no diagnostic.
	for key, fn in g_host_native_fns {
		if key.ctx != rawptr(ctx) do continue
		// Through the shared helper, NOT a raw JSValueUnprotect: it skips the
		// unprotect on Windows on purpose (final teardown races the VM's GC/JIT
		// workers and exits 127; the VM is intentionally leaked there anyway).
		// Dropping the table entries and the owned names is still correct on
		// every platform — only the root release is Windows-conditional.
		unprotect_before_eval_exit(ctx, jsc.JSValueRef(fn))
		delete_key(&g_host_native_cbs, rawptr(fn))
		delete_key(&g_host_native_fns, key)
		// After the erase: the key copy is ours, but the map must not be asked to
		// hash a freed string.
		delete(key.name, alloc)
	}
}
