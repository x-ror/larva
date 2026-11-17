#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins a deliberate §1 deviation where Lava is STRICTER than node:
// Function.prototype.call/apply/bind are locked realm-wide before user code runs
// (primordials.js lockIntrinsics, called from bootstrap/loader.js). node lets a
// script replace them; Lava throws. That is a §1 deviation, so no oracle case can
// express it — node prints "assigned" where Lava prints "THREW" — and it lives here.
//
// The shape is node's own `--frozen-intrinsics` (node 26, verified with
// scratch probe.js): an accessor whose setter throws on Function.prototype itself
// in BOTH modes, and defines an own data property on any other receiver, so
// `f.call = x` on an ordinary function behaves exactly as it does in plain node.
// A non-writable DATA property would be cheaper to write and is wrong in two ways
// the checks below each catch: sloppy `Function.prototype.call = x` would no-op
// silently instead of throwing, and `f.call = x` on an ordinary function would
// throw in strict code (the override mistake) where node succeeds.
//
// Every check is recorded and compared at the end rather than thrown at first
// failure, so a mutation's red output names the check it broke (the manifest's
// expect_detail matches on that name).
FUNCTION_CALL_LOCK_SCRIPT :: `
const FP = Function.prototype;
const real = { call: FP.call, apply: FP.apply, bind: FP.bind };
const results = [];
function record(name, fn) {
  let out;
  try {
    out = String(fn());
  } catch (e) {
    out = 'THREW:' + e.name;
  }
  results[results.length] = name + '=' + out;
}

// Sloppy assignment on Function.prototype: a plain data lock no-ops here silently,
// which is exactly the outcome this lock exists to rule out.
for (const k of ['call', 'apply', 'bind']) {
  record('sloppy-' + k, function () {
    FP[k] = function () { return 'POISON'; };
    return 'assigned';
  });
  record('strict-' + k, function () {
    'use strict';
    FP[k] = function () { return 'POISON'; };
    return 'assigned';
  });
  record('define-' + k, function () {
    Object.defineProperty(FP, k, { value: function () { return 'POISON'; } });
    return 'defined';
  });
  record('intact-' + k, function () { return FP[k] === real[k]; });
}
record('names', function () {
  return [FP.call.name, FP.call.length, FP.apply.name, FP.apply.length, FP.bind.name, FP.bind.length].join(',');
});

// The override mistake: assigning to an ORDINARY function's inherited call/apply/
// bind must create an own data property, as in node, and must not leak to others.
record('own-strict', function () {
  'use strict';
  function f() {}
  f.call = function () { return 'own'; };
  const d = Object.getOwnPropertyDescriptor(f, 'call');
  return [f.call(), d.writable, d.enumerable, d.configurable, (function g() {}).call === real.call].join(',');
});
record('own-sloppy', function () {
  function f() {}
  f.apply = function () { return 'own'; };
  return [f.apply(), Object.prototype.hasOwnProperty.call(f, 'apply')].join(',');
});

// #450's table: every builtin that used to break under a replaced .call, run
// after the replacement attempts above so it proves the lock held.
record('usp', function () { return new URLSearchParams('a=1').get('a'); });
record('format', function () { return require('util').format('%s', 'x'); });
record('buffer', function () { return Buffer.from('hi').toString('hex'); });
record('url', function () { return new URL('http://a/b').pathname; });
record('decode', function () { return new TextDecoder().decode(new Uint8Array([104, 105])); });
record('decode16', function () {
  return new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0, 0x42, 0]));
});
// Vectors H1-H4 and Q2 of tests/node-compat/cases/55-encoding-pollution.js, which
// poisoned Function.prototype.apply (String.fromCharCode.apply once rewrote a
// decoded host to http://a/). node accepts that assignment and Lava now refuses it,
// so they moved here; the expected values are node 26's output for the same calls.
record('h1', function () { return new URL('http://%C3%BCber.example/').href; });
record('h2', function () {
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xc3, 0xbc, 0x62, 0x65, 0x72])) === 'über';
});
record('h3', function () {
  return new TextDecoder('utf-16le').decode(new Uint8Array([0x3d, 0xd8, 0x00, 0xde, 0x41, 0x00])) === '😀A';
});
record('h4', function () { return Array.from(new TextEncoder().encode('ü€😀')).join(','); });
record('q2', function () {
  const big = new Uint8Array(9000);
  for (let i = 0; i < big.length; i++) big[i] = 0x41 + (i % 26);
  const s = new TextDecoder('windows-1252').decode(big);
  return s.length + ':' + s.charCodeAt(0) + ':' + s.charCodeAt(8192) + ':' + s.charCodeAt(8999);
});

// #494: the captured intrinsics themselves. Locking the three slots on
// Function.prototype does not stop a script from giving the HELD function an own
// 'call': 'Function.prototype.apply.call = evil' steered every
// 'apply.call(listener, …)' in events.js (node runs the listener). lockIntrinsics()
// now makes call/apply/bind non-extensible, so neither an own property nor a
// re-pointed prototype can change what a read off them finds.
// The same hole on every OTHER method primordials wraps: 'Array.prototype.push.call
// = evil' steered the callerN 'fn.call(t, …)' wrappers. lockIntrinsics() makes
// exactly the wrapped set non-extensible too (the wrappers keep 'fn.call', which is
// the only spelling JSC inlines); a method nobody wraps (Array.prototype.at) keeps
// node's default behavior. Buffer.prototype.toString is wrapped by the loader AFTER
// the lock (pristineBuffer), so it pins the lock-on-wrap path.
// The deviation rows (ext … setproto) are node --frozen-intrinsics' answers (node
// 26.13, probed); default node answers true / length|name / assigned / assigned /
// assigned / 1 / assigned / set.
const evil = function () { return 'HIJACK'; };
record('ext', function () {
  return [Object.isExtensible(real.call), Object.isExtensible(real.apply), Object.isExtensible(real.bind)].join(',');
});
record('keys', function () {
  return [real.call, real.apply, real.bind].map(function (f) { return Object.getOwnPropertyNames(f).join('|'); }).join(',');
});
// Through lockMethod's setter, which defines an own property: on a non-extensible
// receiver that throws in sloppy code too, as under --frozen-intrinsics.
record('own-call-sloppy', function () { FP.apply.call = evil; return 'assigned'; });
record('own-apply-strict', function () { 'use strict'; FP.call.apply = evil; return 'assigned'; });
record('own-bind-strict', function () { 'use strict'; FP.bind.bind = evil; return 'assigned'; });
// A key with no inherited setter: plain [[Set]] on a non-extensible object.
record('new-key-sloppy', function () { FP.bind.x = 1; return FP.bind.x; });
record('new-key-strict', function () { 'use strict'; FP.bind.x = 1; return 'assigned'; });
// Re-pointing the prototype is the other way to change what 'apply.call' reads.
record('setproto', function () {
  Object.setPrototypeOf(real.apply, { __proto__: FP, call: evil });
  return 'set';
});
record('wrapped-ext', function () {
  return [Object.isExtensible(Array.prototype.push), Object.isExtensible(String.prototype.charCodeAt),
    Object.isExtensible(Buffer.prototype.toString), Object.isExtensible(Array.prototype.at)].join(',');
});
record('push-own-sloppy', function () { Array.prototype.push.call = evil; return 'assigned'; });
record('push-fresh-sloppy', function () { Array.prototype.push.x = 1; return Array.prototype.push.x; });
record('at-own', function () {
  Array.prototype.at.call = evil;
  return Object.getOwnPropertyDescriptor(Array.prototype.at, 'call').value === evil;
});
// The #494 probe: every attempt is made (and may throw on Lava), then the wrappers
// must still run the real push/charCodeAt.
record('push-hijack', function () {
  let hit = 0;
  const bump = function () { hit++; return 0; };
  try { Array.prototype.push.call = bump; } catch (e) {}
  try { Object.setPrototypeOf(String.prototype.charCodeAt, { __proto__: FP, call: bump }); } catch (e) {}
  const u = new URLSearchParams('a=1&b=2');
  u.append('c', '3');
  return [hit, u.toString(), new URL('http://a/b?c').href].join(' ');
});
record('emit-hijack', function () {
  const EE = require('events');
  const e = new EE();
  const got = [];
  e.on('x', function (a) { got[got.length] = 'listener:' + a; });
  e.emit('x', 1);
  return got.join(',');
});
const want = [
  'sloppy-call=THREW:TypeError', 'strict-call=THREW:TypeError', 'define-call=THREW:TypeError', 'intact-call=true',
  'sloppy-apply=THREW:TypeError', 'strict-apply=THREW:TypeError', 'define-apply=THREW:TypeError', 'intact-apply=true',
  'sloppy-bind=THREW:TypeError', 'strict-bind=THREW:TypeError', 'define-bind=THREW:TypeError', 'intact-bind=true',
  'names=call,1,apply,2,bind,1',
  'own-strict=own,true,true,true,true',
  'own-sloppy=own,true',
  'usp=1', 'format=x', 'buffer=6869', 'url=/b', 'decode=hi', 'decode16=AB',
  'h1=http://xn--ber-goa.example/', 'h2=true', 'h3=true', 'h4=195,188,226,130,172,240,159,152,128',
  'q2=9000:65:67:68',
  'ext=false,false,false', 'keys=length|name,length|name,length|name',
  'own-call-sloppy=THREW:TypeError', 'own-apply-strict=THREW:TypeError', 'own-bind-strict=THREW:TypeError',
  'new-key-sloppy=undefined', 'new-key-strict=THREW:TypeError', 'setproto=THREW:TypeError',
  'wrapped-ext=false,false,false,true', 'push-own-sloppy=THREW:TypeError', 'push-fresh-sloppy=undefined', 'at-own=true',
  'push-hijack=0 a=1&b=2&c=3 http://a/b?c',
  'emit-hijack=listener:1',
];
const bad = [];
for (let i = 0; i < want.length; i++) {
  if (results[i] !== want[i]) bad[bad.length] = 'want ' + want[i] + ' got ' + results[i];
}
if (bad.length !== 0) throw new Error(bad.join('; '));

// Moved from tests/runtime/eventloop/cases/11-scheduler-hardening.js, which used to
// poison call/apply before scheduling: nextTick must still forward its arguments
// and queueMicrotask must still run. The exit code carries a miss.
let hits = 0;
process.nextTick(function (a, b) { if (a + b === 'xy') hits += 1; }, 'x', 'y');
queueMicrotask(function () { hits += 10; });
setTimeout(function () { if (hits !== 11) process.exitCode = 3; }, 0);
console.log('function-call-lock ok');
`

@(test)
function_call_lock :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(FUNCTION_CALL_LOCK_SCRIPT, "<function-call-lock-test>", &loop, false)
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
