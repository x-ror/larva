// Linux-only: the private-ABI host-call path is compiled only for Linux
// (pkg/jsc/host_function.odin), so off Linux nothing is ever registered in the
// host-native registry and every assertion below would be vacuous.
#+build linux
package main

import "core:c"
import "core:mem"
import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Coverage for the host-native registry's decision branches. Each test here was
// chosen by MUTATION: delete the line it pins and the rest of the suite still
// passes, which is what made these worth writing rather than assumed-covered.
// cmd/lava/host_native_failclosed_test.odin pins the dispatcher itself; this file
// pins what surrounds it — the sweep's context filter, the dedupe that keeps the
// registry small, the stateless-context refusal, and the allocation-failure path.
//
// The helpers below (answer_cb, eval_text, make_context, host_path_active,
// failing_allocator) are package-visible on purpose: the sibling #+build linux
// tests (host_native_failclosed_test.odin, module_cache_rollback_test.odin)
// share them instead of carrying byte-identical copies.

answer_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	return jsc.JSValueMakeNumber(ctx, 42)
}

other_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	return jsc.JSValueMakeNumber(ctx, 7)
}

eval_text :: proc(ctx: jsc.JSContextRef, source: string) -> (string, bool) {
	c_src, err := strings.clone_to_cstring(source, context.temp_allocator)
	if err != nil do return "", false
	js_src := jsc.JSStringCreateWithUTF8CString(c_src)
	defer jsc.JSStringRelease(js_src)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, js_src, nil, nil, 1, &exception)
	if exception != nil || value == nil do return "", false
	// jsc_value_to_string_or_default hands back an OWNED context.allocator buffer.
	// The test runner installs a per-test tracking allocator and reports whatever is
	// still live when the test ends, so a helper that keeps it would print a leak on
	// every assertion here and bury a real one in the code under test.
	owned, got := lava.jsc_value_to_string_or_default(ctx, value)
	if !got do return "", true // empty string: nothing was allocated
	defer delete(owned)
	copied, clone_err := strings.clone(owned, context.temp_allocator)
	if clone_err != nil do return "", false
	return copied, true
}

// Context is a bare JSC global context plus the JSClass it needs for the private
// slot. Both must outlive the Runtime_State that points into them.
Context :: struct {
	class: jsc.JSClassRef,
	gctx:  jsc.JSGlobalContextRef,
	ctx:   jsc.JSContextRef,
}

make_context :: proc() -> (Context, bool) {
	class := lava.make_global_class()
	gctx := jsc.JSGlobalContextCreate(class)
	if gctx == nil {
		jsc.JSClassRelease(class)
		return {}, false
	}
	return Context{class = class, gctx = gctx, ctx = cast(jsc.JSContextRef)gctx}, true
}

destroy_context :: proc(c: Context) {
	jsc.JSGlobalContextRelease(c.gctx)
	jsc.JSClassRelease(c.class)
}

// host_path_active reports whether the private-ABI path resolved. Every test in
// this file asserts on it rather than skipping quietly: a silently vacuous
// regression test is the failure mode this whole area keeps hitting.
host_path_active :: proc(t: ^testing.T, ctx: jsc.JSContextRef) -> bool {
	if jsc.host_calls_active(ctx) do return true
	testing.expect(t, false, "private-ABI host-call path inactive — this test cannot observe what it pins")
	return false
}

// The sweep filters on `key.ctx == rawptr(ctx)`. Dropping that filter makes it
// tear down EVERY context's registrations, and the whole existing suite still
// passes, because no other test has two live contexts on one thread — the
// configuration where "sweep one context" and "sweep everything" differ at all.
@(test)
host_native_sweep_is_scoped_to_its_context :: proc(t: ^testing.T) {
	a, a_ok := make_context()
	testing.expect(t, a_ok, "could not create the first JSC global context")
	if !a_ok do return
	defer destroy_context(a)

	b, b_ok := make_context()
	testing.expect(t, b_ok, "could not create the second JSC global context")
	if !b_ok do return
	defer destroy_context(b)

	if !host_path_active(t, a.ctx) do return

	state_a := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(a.ctx), cast(rawptr)state_a)
	lava.capture_error_intrinsics(a.ctx, state_a)

	state_b := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(b.ctx), cast(rawptr)state_b)
	lava.capture_error_intrinsics(b.ctx, state_b)
	defer lava.destroy_runtime_state(b.ctx, state_b)

	lava.inject_native_function(a.ctx, jsc.JSContextGetGlobalObject(a.ctx), "probe", answer_cb)
	lava.inject_native_function(b.ctx, jsc.JSContextGetGlobalObject(b.ctx), "probe", answer_cb)

	both_a, ok_a := eval_text(a.ctx, "String(probe())")
	both_b, ok_b := eval_text(b.ctx, "String(probe())")
	testing.expectf(t, ok_a && both_a == "42", "context A did not dispatch: %q", both_a)
	testing.expectf(t, ok_b && both_b == "42", "context B did not dispatch: %q", both_b)

	// Tear down A only. B shares the thread and therefore the same two thread-local
	// tables, and its function object is still rooted on its own globalThis.
	lava.destroy_runtime_state(a.ctx, state_a)

	after, ok_after := eval_text(b.ctx, "String(probe())")
	testing.expectf(t, ok_after && after == "42", "tearing down context A broke context B's registry: %q", after)
}

// The cache exists so per-instance injections (the fs.Stats methods) reuse one
// function object instead of minting one per call. Nothing pinned that: the
// "<=86 entries" reasoning in the sweep's history was an assumption about the
// dedupe, never a test of it.
@(test)
host_native_create_dedupes_per_callback_and_name :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")
	if !ok do return
	defer destroy_context(c)

	if !host_path_active(t, c.ctx) do return

	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(c.ctx), cast(rawptr)state)
	defer lava.destroy_runtime_state(c.ctx, state)

	first := lava.host_native_create(c.ctx, "probe", answer_cb)
	testing.expect(t, first != nil, "host_native_create returned nil on the host path")
	if first == nil do return

	same := lava.host_native_create(c.ctx, "probe", answer_cb)
	testing.expect(t, same == first, "same (callback, name) minted a second function object")

	// A different name for the same callback is a different binding and must NOT
	// share a cell — the dispatch table is keyed by the cell address, so collapsing
	// these would make one name dispatch as the other.
	renamed := lava.host_native_create(c.ctx, "probe2", answer_cb)
	testing.expect(t, renamed != nil && renamed != first, "a different name reused the same cell")

	different := lava.host_native_create(c.ctx, "probe", other_cb)
	testing.expect(t, different != nil && different != first, "a different callback reused the same cell")
}

// Pins the host path's construct-result divergence require.odin documents:
// create_raw reuses the call callback as the constructor slot, so `new` on a
// host-path native evaluates to the CALL result — here answer_cb's 42, where
// Node (like any ordinary function) yields an object. The oracle suite cannot
// assert this (node runs the same script and returns the object), so this is
// the pin that makes a JSC upgrade or refactor changing [[Construct]] loud.
// Move require.odin's comment and this assert together.
@(test)
host_native_construct_returns_call_result :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")
	if !ok do return
	defer destroy_context(c)

	if !host_path_active(t, c.ctx) do return

	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(c.ctx), cast(rawptr)state)
	defer lava.destroy_runtime_state(c.ctx, state)

	lava.inject_native_function(c.ctx, jsc.JSContextGetGlobalObject(c.ctx), "probe", answer_cb)
	text, ok_eval := eval_text(c.ctx, "(function(){ var r = new probe(); return typeof r + ':' + String(r); })()")
	testing.expectf(t, ok_eval && text == "number:42", "host-path construct result changed: %q", text)
}

// A context with no Runtime_State has no allocator to clone the name through and
// nothing that would ever free the entry, so host_native_create declines. This is
// the branch whose REVERSION survives the whole suite: every other test attaches
// a state first, so nothing else ever reaches it.
@(test)
host_native_create_declines_without_state :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")
	if !ok do return
	defer destroy_context(c)

	if !host_path_active(t, c.ctx) do return

	// Deliberately no JSObjectSetPrivate: this is the bare embedder context.
	fn := lava.host_native_create(c.ctx, "probe", answer_cb)
	testing.expect(t, fn == nil, "stateless context was allowed to cache a host native")

	// And the caller's fallback still produces a working binding — declining must
	// degrade, not break. inject_native_function takes the C-API path on nil.
	lava.inject_native_function(c.ctx, jsc.JSContextGetGlobalObject(c.ctx), "probe", answer_cb)
	text, ok_eval := eval_text(c.ctx, "String(probe())")
	testing.expectf(t, ok_eval && text == "42", "C-API fallback binding did not work: %q", text)

	// Pins the documented fallback divergence (require.odin): the public C API
	// cannot carry an arity, so `.length` is 0 here where the host path (and Node)
	// report the declared arity. The oracle case (56-native-function-arity.js)
	// cannot assert this — node runs the same script and reports Node's arity — so
	// this is the one place the fallback value is pinned. If it ever changes,
	// update the require.odin comment and case 56 together.
	len_text, ok_len := eval_text(c.ctx, "String(probe.length)")
	testing.expectf(t, ok_len && len_text == "0", "C-API fallback .length was not 0: %q", len_text)
}

// --- allocation-failure injection --------------------------------------------

// failing_allocator fails every ALLOCATION and succeeds at every free.
//
// mem.nil_allocator() does NOT work for this: it returns (nil, nil), so
// strings.clone reports no error and silently yields "" — the injected fault
// disappears and the test passes for the wrong reason. An injector has to return
// .Out_Of_Memory. Frees must still succeed because the code under test rolls back
// through this same allocator, and an error there would mask the failure being
// injected rather than exercise it.
failing_alloc_proc :: proc(
	allocator_data: rawptr,
	mode: mem.Allocator_Mode,
	size, alignment: int,
	old_memory: rawptr,
	old_size: int,
	loc := #caller_location,
) -> (
	[]byte,
	mem.Allocator_Error,
) {
	#partial switch mode {
	case .Free, .Free_All:
		return nil, nil
	case .Query_Features:
		return nil, nil
	}
	return nil, .Out_Of_Memory
}

failing_allocator :: proc() -> mem.Allocator {
	return mem.Allocator{procedure = failing_alloc_proc, data = nil}
}

// An out-of-memory registry must decline and fall back, not half-register and not
// leak the GC root it took. Reverting host_native_create's clone-failure rollback
// (the JSValueUnprotect before `return nil`) leaves a protected function object
// behind on every failed injection; nothing else in the suite reaches that line,
// because it only runs when an allocation fails.
@(test)
host_native_create_survives_allocation_failure :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")
	if !ok do return
	defer destroy_context(c)

	if !host_path_active(t, c.ctx) do return

	// Built normally, so its maps and its own allocation come from the real
	// allocator; only the name-clone allocator is faulted. Overwriting the field
	// after construction is the whole injection — no production seam needed.
	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(c.ctx), cast(rawptr)state)
	real_allocator := state.allocator
	state.allocator = failing_allocator()
	defer {
		// Restore before teardown: destroy_runtime_state frees the module cache keys
		// through this field, and it must be the allocator that actually owns them.
		state.allocator = real_allocator
		lava.destroy_runtime_state(c.ctx, state)
	}

	fn := lava.host_native_create(c.ctx, "probe", answer_cb)
	testing.expect(t, fn == nil, "registry cached an entry it could not allocate a name for")

	// The binding still has to work — an OOM in our cache is not an OOM in JSC.
	lava.inject_native_function(c.ctx, jsc.JSContextGetGlobalObject(c.ctx), "probe", answer_cb)
	text, ok_eval := eval_text(c.ctx, "String(probe())")
	testing.expectf(t, ok_eval && text == "42", "binding broke when the registry could not cache it: %q", text)
}

// host_throw's contract is that its RETURN says whether the exception was really
// raised; host_dispatch and host_dispatch_fail both branch on it rather than
// returning a value they only hope is an exception. The nil guard is the arm that
// is reachable in-process (make_js_error returns nil under OOM). The !g_host_ok
// arm is NOT reachable here and is not pretended to be: contexts are
// thread-confined, so a thread that can call a host function is by construction a
// thread where the probe succeeded. It is covered instead by the whole
// test-lava-nohostfn leg, where g_host_ok is false for every thread.
@(test)
host_throw_reports_whether_it_raised :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")
	if !ok do return
	defer destroy_context(c)

	testing.expect(
		t,
		!jsc.host_throw(c.ctx, nil),
		"host_throw claimed it raised a nil exception — callers would return it as a value",
	)
}
