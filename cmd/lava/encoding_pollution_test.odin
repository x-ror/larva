#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Proves the parts of the encoding.js hardening (pkg/runtime/js/internal/
// encoding.js) where Lava is deliberately STRONGER than Node, which is exactly
// what a node-compat oracle cannot express: Node 24's getEncodingFromLabel falls
// back to a raw `label.toLowerCase()` and its Buffer-side encoding lookup is
// likewise reachable, so a differential case would have to be shaped around
// Node's own weakness (see tests/node-compat/cases/55-encoding-pollution.js,
// whose M1/M2 use an already-lower-case label so Node hits its exact-match path).
// Here we assert the property itself.
//
// The script self-asserts (throws on any wrong value) and restores every
// intrinsic before printing, so a clean eval (status Ok, exit 0) means the codec
// stayed correct throughout the pollution.
ENCODING_POLLUTION_SCRIPT :: `
'use strict';
const realToLowerCase = String.prototype.toLowerCase;
const realTrim = String.prototype.trim;
const realFromCharCode = String.fromCharCode;
const realPush = Array.prototype.push;
const realBufferFrom = Buffer.from;
const realBufferToString = Buffer.prototype.toString;
const realString = globalThis.String;
const taProto = Object.getPrototypeOf(Uint8Array.prototype);
const realBufferDesc = Object.getOwnPropertyDescriptor(taProto, 'buffer');

// Indexed writes, not push: Array.prototype.push is one of the intrinsics this
// script poisons, so the harness must not depend on it either.
const results = [];
let n = 0;
function record(name, fn) {
  try {
    results[n++] = name + '=' + fn();
  } catch (e) {
    results[n++] = name + '=THREW:' + e.name;
  }
}

String.prototype.toLowerCase = function () { return 'utf-8'; };
String.prototype.trim = function () { return 'utf-8'; };
String.fromCharCode = function () { return 'PWNED'; };
// Function.prototype.apply is no longer poisoned here: since #450 it is locked
// before user code, so the assignment throws (pinned by function_call_lock_test).
Array.prototype.push = function () { return 0; };
Buffer.from = function () { return new Uint8Array([0x50]); };
Buffer.prototype.toString = function () { return 'PWNED'; };
globalThis.String = function () { return 'PWNED'; };
// The %TypedArray%.prototype.buffer ACCESSOR — the axis a null prototype cannot
// close. Node 24 is itself poisonable here: its windows-1252 decode reads the
// caller's .buffer through this live getter and returns the forged bytes
// (observed: "!\x00"), which is why this lives in the Lava-only test and not
// the oracle. Lava must read .buffer only through the getter captured at
// module-eval (unitsToString and the utf-8 fastpath in encoding.js).
const forgedBuffer = new Uint16Array([0x21, 0x21, 0x21, 0x21]).buffer;
Object.defineProperty(taProto, 'buffer', {
  configurable: true,
  get() { return forgedBuffer; },
});

// A mixed-case, ASCII-padded label: Node resolves this through the pollutable
// toLowerCase fallback and would answer 'utf-8'. Lava normalizes through
// primordials, so the real encoding must survive.
record('label', function () { return new TextDecoder('  UTF-16LE  ').encoding; });
record('utf16', function () {
  return new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0x00, 0x42, 0x00]));
});
record('win1252', function () {
  return new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x80]));
});
record('fatal', function () {
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0x41, 0xc3, 0xbc]));
});
record('fastpath', function () {
  return new TextDecoder().decode(new Uint8Array([0x41, 0x42]));
});
record('encode', function () {
  return Array.prototype.join.call(Array.from(new TextEncoder().encode('AB')), ',');
});

String.prototype.toLowerCase = realToLowerCase;
String.prototype.trim = realTrim;
String.fromCharCode = realFromCharCode;
Array.prototype.push = realPush;
Buffer.from = realBufferFrom;
Buffer.prototype.toString = realBufferToString;
globalThis.String = realString;
Object.defineProperty(taProto, 'buffer', realBufferDesc);

const want = [
  'label=utf-16le',
  'utf16=AB',
  'win1252=A€',
  'fatal=Aü',
  'fastpath=AB',
  'encode=65,66',
];
for (let i = 0; i < want.length; i++) {
  if (results[i] !== want[i]) {
    throw new Error('want ' + want[i] + ' got ' + results[i]);
  }
}
console.log('encoding-pollution ok');
`

@(test)
encoding_pollution_immunity :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(ENCODING_POLLUTION_SCRIPT, "<encoding-pollution-test>", &loop, false)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}
