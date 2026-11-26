#+build !linux
package jsc

// Honest stubs: the RunLoop drive (runloop_linux.odin) adopts a GLib GMainContext, which
// only WebKitGTK's JavaScriptCore uses. macOS's JSC runs its RunLoop on CFRunLoop and the
// Windows build on its own; neither is driven, so FinalizationRegistry cleanups and
// WebAssembly.compile settlement stay as they were there (never run, never settle).

Runloop_Drive :: enum u8 {
	Unset,
	Adopted,
	Not_Adopted,
	Torn_Down,
}

runloop_before_vm :: proc() -> (pushed: bool) {
	return false
}

runloop_after_vm :: proc(pushed: bool, group: JSContextGroupRef) {}

runloop_drive :: proc() -> Runloop_Drive {
	return .Not_Adopted
}

runloop_fd :: proc() -> (fd: i32, ok: bool) {
	return -1, false
}

runloop_sync :: proc() -> (timeout_ms: int, ok: bool) {
	return -1, false
}

runloop_due :: proc() -> bool {
	return false
}

runloop_dispatch :: proc() -> bool {
	return false
}

runloop_thread_teardown :: proc() {}

// No synchronous collector is resolved off Linux; the public call only hints.
collect_garbage_now :: proc(ctx: JSContextRef) -> bool {
	if ctx != nil {
		JSGarbageCollect(ctx)
	}

	return false
}
