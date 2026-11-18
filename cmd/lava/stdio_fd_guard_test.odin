#+build linux, darwin
package main

import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// The stdio writeSync binding must accept ONLY fd 1 and 2, and it must decide that
// BEFORE converting the number.
//
// Two distinct properties, and the second is the one that is easy to lose. `this.fd` is a
// plain writable property on the stream, so `process.stdout.fd = 7` reaches this native
// with an arbitrary number: a JS-supplied fd reaching a raw write(2) is a capability leak,
// because this binding is not a general fs.writeSync. And the conversion itself is the
// trap — a float->int conversion is undefined in Odin for NaN, ±Inf and out-of-range
// values, so `int(fd_num)` may land on ANY arm, 1 and 2 included. Comparing in f64 first
// is what makes `process.stdout.fd = NaN` reject instead of writing somewhere.
//
// LAVA-ONLY: node has no equivalent binding to diff against (its stdout owns the fd
// internally and `fd = 7` there produces an EBADF from the syscall, not a guard).
// Nothing referenced this guard before — grepping its message found only the Odin source
// — so it shipped in #326 with no test at all.

@(private = "file")
guard_eval :: proc(ctx: jsc.JSContextRef, src: cstring) -> jsc.JSValueRef {
	js_src := jsc.JSStringCreateWithUTF8CString(src)
	defer jsc.JSStringRelease(js_src)
	exc: jsc.JSValueRef
	return jsc.JSEvaluateScript(ctx, js_src, nil, nil, 1, &exc)
}

@(test)
stdio_write_sync_rejects_every_fd_but_1_and_2 :: proc(t: ^testing.T) {
	jsc.lava_jsc_init()
	gctx := jsc.JSGlobalContextCreate(nil)
	testing.expect(t, gctx != nil, "could not create a JSC global context")

	if gctx == nil {
		return
	}

	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	// An empty payload: the guard must reject on the fd alone, before any write is
	// attempted, so the case says nothing about what would have been written.
	payload := guard_eval(ctx, "new Uint8Array(0)")

	// Every one of these must be refused. 0, 3 and -1 are the capability half (0 is stdin,
	// 3 is whatever the process opened next); the rest are the conversion hazard.
	//
	// `1.5` and `2.9` are the two that actually discriminate, and it is worth naming which
	// ones do NOT. Mutating the guard to `switch int(fd_num)` fails on exactly those two —
	// truncation lands them on 1 and 2 — while NaN and ±Infinity reject either way, because
	// x86's cvttsd2si yields INT_MIN for them rather than something in range. The huge
	// values do not truncate at all here: Odin's `int` is 64-bit on this target, so 2^32+1
	// stays 2^32+1. They are kept because the guard must hold on a 32-bit target too, where
	// they WOULD fold onto 1 and 2, and because "undefined" means the arm is not
	// guaranteed anywhere — not because they are observed to break today.
	rejected := []cstring {
		"0",
		"3",
		"-1",
		"NaN",
		"Infinity",
		"-Infinity",
		"1.5",
		"2.9",
		"1e300",
		"-1e300",
		"4294967297",
		"4294967298",
	}
	for src in rejected {
		exc: jsc.JSValueRef
		args := [2]jsc.JSValueRef{guard_eval(ctx, src), payload}
		lava.stdio_write_sync_cb(ctx, nil, nil, 2, raw_data(args[:]), &exc)
		testing.expectf(t, exc != nil, "writeSync(%s, ...) was not rejected", src)
	}

	// And the two legitimate descriptors must still be accepted — a guard that refused
	// everything would pass every assertion above.
	for src in ([]cstring{"1", "2"}) {
		exc: jsc.JSValueRef
		args := [2]jsc.JSValueRef{guard_eval(ctx, src), payload}
		lava.stdio_write_sync_cb(ctx, nil, nil, 2, raw_data(args[:]), &exc)
		testing.expectf(t, exc == nil, "writeSync(%s, empty) must be accepted", src)
	}
}
