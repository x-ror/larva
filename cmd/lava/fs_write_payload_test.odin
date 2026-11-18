#+build linux, darwin
package main

import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Regression guard for a TOCTOU in fs_resolve_write_payload's DataView arm — the same
// argument-coercion re-entrancy family as cmd/lava/buffer_reentrancy_test.odin, reached
// through a property read rather than a valueOf.
//
// JSC's C API has no DataView byte accessor, so the resolver reads `.byteOffset` and
// `.byteLength` off the object. Those are ordinary property reads, and on an object
// carrying its OWN accessors they run arbitrary JS — which can resize (or transfer) the
// backing ArrayBuffer before returning. The resolver captured the buffer's byte length
// BEFORE those reads and validated the window against that stale number, then took the
// base pointer after. A getter that shrinks the buffer therefore passed a bounds check
// against a size that no longer existed.
//
// Measured before the fix, via `fs.writeFileSync(out, dv)` on a 4096-byte resizable
// ArrayBuffer whose byteOffset getter calls `ab.resize(8)`:
//
//   node   live buffer 4096   file 4096 bytes   (getters never run: internal slots)
//   lava   live buffer    8   file 4096 bytes   <- 4088 bytes of out-of-bounds heap
//
// The bytes landed in a file the script chose, so this was an arbitrary-length heap
// disclosure, not just a crash.
//
// LAVA-ONLY, and it cannot be an oracle case: node reads a DataView's window from its
// internal slots and ignores own accessors entirely, so the two runtimes disagree on
// this input no matter which of them is right. Lava rejects the window (empty payload)
// where node writes the real 4096 bytes; that residual parity gap is recorded in
// ROADMAP, and closing it needs a cached pristine DataView getter. What this test pins is
// the memory-safety half: the resolver must never hand back a slice longer than the
// buffer that is live when the pointer is taken.

@(private = "file")
payload_eval :: proc(ctx: jsc.JSContextRef, src: cstring) -> jsc.JSValueRef {
	js_src := jsc.JSStringCreateWithUTF8CString(src)
	defer jsc.JSStringRelease(js_src)
	exc: jsc.JSValueRef
	return jsc.JSEvaluateScript(ctx, js_src, nil, nil, 1, &exc)
}

@(test)
fs_write_payload_rejects_a_window_resized_by_its_own_getter :: proc(t: ^testing.T) {
	jsc.lava_jsc_init()
	gctx := jsc.JSGlobalContextCreate(nil)
	testing.expect(t, gctx != nil, "could not create a JSC global context")
	if gctx == nil do return
	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	// Resizable ArrayBuffers are the shrink primitive here; without them there is
	// nothing to exercise.
	resizable := jsc.JSValueToBoolean(
		ctx,
		payload_eval(ctx, "new ArrayBuffer(8, { maxByteLength: 8 }).resizable === true"),
	)
	if !resizable do return

	// A genuine DataView over a 4096-byte resizable buffer, carrying an own byteOffset
	// getter that shrinks the backing to 8 bytes and an own byteLength that keeps
	// claiming the original 4096.
	dv := payload_eval(
		ctx,
		`(function () {
  var ab = new ArrayBuffer(4096, { maxByteLength: 4096 });
  new Uint8Array(ab).fill(0x41);
  var dv = new DataView(ab);
  Object.defineProperty(dv, 'byteOffset', {
    configurable: true,
    get: function () { ab.resize(8); return 0; },
  });
  Object.defineProperty(dv, 'byteLength', { configurable: true, get: function () { return 4096; } });
  globalThis.__ab = ab;
  return dv;
})()`,
	)
	testing.expect(t, dv != nil, "could not build the DataView under test")

	bytes, owned, ok := lava.fs_resolve_write_payload(ctx, dv)
	testing.expect(t, ok, "a DataView must resolve, not report an invalid type")
	testing.expect(t, !owned, "a DataView window is borrowed, never owned")

	// The buffer is 8 bytes live by the time the pointer is taken. Anything longer is
	// memory past the allocation — which is what shipped, at 4096.
	live := int(jsc.JSValueToNumber(ctx, payload_eval(ctx, "globalThis.__ab.byteLength"), nil))
	testing.expectf(t, live == 8, "the getter should have resized the backing to 8, got %d", live)
	testing.expectf(
		t,
		len(bytes) <= live,
		"resolver returned %d bytes over a %d-byte live buffer: out-of-bounds read",
		len(bytes),
		live,
	)
}
