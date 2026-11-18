// Linux-only: the private-ABI host-call path is compiled only for Linux
// (pkg/jsc/host_function.odin), so off Linux nothing is ever registered in the
// host-native registry and a dispatch miss cannot occur.
#+build linux
package main

import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Pins the fail-CLOSED dispatcher (host_dispatch_fail, pkg/runtime/
// host_natives.odin). host_natives_release_context is exported and produces
// exactly the inconsistent-registry state while globalThis keeps the function
// object reachable, so the miss needs no production seam and no test-only hook.
// Shared helpers (make_context, eval_text, answer_cb, host_path_active) live in
// host_native_registry_test.odin.
//
// Why it is worth pinning: several natives write through a caller-supplied
// buffer and signal nothing on return, so a dispatcher answering `undefined` is
// silently WRONG rather than merely unhelpful — randomBytes would hand back
// zeroed bytes as CSPRNG output (the canonical write-up: host_dispatch_fail).
//
// Three assertions, each pinning a distinct failure this has already had:
//   1. a registered native dispatches (otherwise the rest proves nothing);
//   2. after the sweep the call THROWS, and with our message — reverting the
//      fail-closed branch gives "NO THROW: undefined", and dropping the sweep's
//      delete_key(&g_host_native_cbs, ...) gives "NO THROW: 42" because the stale
//      callee entry keeps dispatching;
//   3. the VM still works afterwards — this is what pins the private-ABI contract
//      that host_throw actually RAISED. Returning the Error object as an ordinary
//      value (which is what a bare `return exception` does when host_throw
//      no-ops) is fail-open again, not a throw.
@(test)
host_native_dispatch_miss_fails_closed :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")

	if !ok {
		return
	}

	defer destroy_context(c)

	// Without the private-ABI path nothing is registered, so there is no miss to
	// observe and every assertion below would pass vacuously.
	if !host_path_active(t, c.ctx) {
		return
	}

	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(c.ctx), cast(rawptr)state)
	lava.capture_error_intrinsics(c.ctx, state)
	defer lava.destroy_runtime_state(c.ctx, state)

	lava.inject_native_function(c.ctx, jsc.JSContextGetGlobalObject(c.ctx), "probe", answer_cb)

	before, ok_before := eval_text(c.ctx, "String(probe())")
	testing.expectf(t, ok_before && before == "42", "registered native did not dispatch: %q", before)

	// Drop this context's registrations while the JS function object stays rooted
	// on globalThis — the registry is now inconsistent and the next call misses.
	lava.host_natives_release_context(c.ctx, state.allocator)

	after, ok_after := eval_text(
		c.ctx,
		"(function(){ try { return 'NO THROW: ' + probe(); } catch (e) { return 'threw: ' + e.message; } })()",
	)
	testing.expectf(
		t,
		ok_after && strings.has_prefix(after, "threw: lava: host native dispatch failed"),
		"dispatch miss did not fail closed: %q",
		after,
	)

	// The raise must leave the VM usable: a pending-but-uncleared exception, or an
	// empty JSValue returned in place of one, would break the next evaluation.
	healthy, ok_healthy := eval_text(c.ctx, "String(1 + 1)")
	testing.expectf(t, ok_healthy && healthy == "2", "VM unusable after the raise: %q", healthy)
}
