#+build !linux
package lava_runtime

import jsc "lava:pkg/jsc"

// node:net is Linux-first (net.odin). On other platforms the native bindings are empty,
// so js/node/net.js surfaces a clear "unavailable" error when used, and the shared
// teardown hooks are no-ops. Restore alongside the Windows/macOS reactor work.
//
// Net_Server / Net_Connection are defined here as empty stubs because Runtime_State
// (globals.odin, shared across platforms) holds registries of them; without these the
// non-Linux build cannot compile even the unavailable path.
Net_Server :: struct {}
Net_Connection :: struct {}

make_net_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	return jsc.JSObjectMake(ctx, nil, nil)
}

// node:https is Linux-first too (tls_server.odin). Empty bindings so js/node/https.js surfaces
// a clear "unavailable" error instead of referencing missing native procs.
make_https_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	return jsc.JSObjectMake(ctx, nil, nil)
}

net_shutdown_active :: proc(state: ^Runtime_State) {}

// The registries are make()d unconditionally in new_runtime_state (shared across platforms); free
// their (empty here) backings so the non-Linux build doesn't leak the map headers at teardown.
net_destroy_state :: proc(state: ^Runtime_State) {
	if state == nil do return
	delete(state.net_servers)
	delete(state.net_conns)
	delete(state.tls_server_ctxs)
}
