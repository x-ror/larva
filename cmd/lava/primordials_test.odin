#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Proves the primordials hardening (pkg/runtime/js/internal/primordials.js): a
// script that overwrites the Array/Object intrinsics EventEmitter uses internally
// must not be able to break it. This is a Lava-only test, NOT a node-compat oracle
// case: Node's own EventEmitter is *not* immune here (its _addListener calls a raw
// Array.prototype.push), so Lava is deliberately stronger than Node and the two
// diverge — which an oracle could not express. The script self-asserts (throws on
// any wrong value) and restores the intrinsics before printing, so a clean eval
// (status Ok, exit 0) means EventEmitter stayed correct throughout the pollution.
POLLUTION_SCRIPT :: `
'use strict';
const EventEmitter = require('node:events');

const realPush = Array.prototype.push;
const realUnshift = Array.prototype.unshift;
const realSlice = Array.prototype.slice;
const realSplice = Array.prototype.splice;
const realMap = Array.prototype.map;
const realCreate = Object.create;
const speciesDesc = Object.getOwnPropertyDescriptor(Array, Symbol.species);
const boom = function () {
  throw new Error('intrinsic pollution leaked into a built-in');
};

Array.prototype.push = boom;
Array.prototype.unshift = boom;
Array.prototype.slice = boom;
Array.prototype.splice = boom;
Array.prototype.map = boom;
Object.create = boom;
// Poison Array[Symbol.species] too: slice/map/splice consult it, so a clean run
// proves EventEmitter copies its listener arrays without going through species.
Object.defineProperty(Array, Symbol.species, {
  configurable: true,
  get: function () {
    throw new Error('species pollution leaked into a built-in');
  },
});

let calls = 0;
const ee = new EventEmitter();
const a = function () { calls = calls + 1; };
const b = function () { calls = calls + 1; };
const c = function () { calls = calls + 1; };
const d = function () { calls = calls + 1; };

ee.on('e', a);
ee.on('e', b);
ee.on('e', c);
ee.prependListener('e', d);
ee.emit('e');
ee.removeListener('e', b);
const namesLen = ee.eventNames().length;
const listenerCount = ee.listeners('e').length;
ee.emit('e');

Array.prototype.push = realPush;
Array.prototype.unshift = realUnshift;
Array.prototype.slice = realSlice;
Array.prototype.splice = realSplice;
Array.prototype.map = realMap;
Object.create = realCreate;
Object.defineProperty(Array, Symbol.species, speciesDesc);

if (calls !== 7) throw new Error('calls=' + calls);
if (namesLen !== 1) throw new Error('namesLen=' + namesLen);
if (listenerCount !== 3) throw new Error('listenerCount=' + listenerCount);
console.log('primordials-pollution ok');
`

@(test)
primordials_pollution_immunity :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(POLLUTION_SCRIPT, "<primordials-test>", &loop, false)
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

// The events-module invariants the post-#485 rewrite added on top of the test above,
// one row each so a mutation's red output names what it broke (expect_detail matches
// the row). Lava-only for the same reason: node fails on-queue (its FixedQueue slots
// are index writes into a holey Array, so an Array.prototype index setter sees them).
// The other four rows also hold on node 26.13 (probed with this script) and were red
// on the pre-rewrite events.js:
//   setter0/1        emit()'s snapshot was built by index writes into [], so an
//                    Array.prototype[0|1] setter threw or silently DROPPED a listener.
//   promise-statics  once()/on() settled through the live Promise.reject/resolve,
//                    which a script can replace.
//   options-proto    on() without options read signal off Object.prototype.
//   on-queue         events.on() queued through push/shift into an Array.
EVENTS_POLLUTION_SCRIPT :: `
'use strict';
const EventEmitter = require('node:events');
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

// emit()'s snapshot of a listener array is an array literal, so an index accessor
// on Array.prototype never sees it. Index 0 and 1 are the slots the copy writes
// first; a copy built by index writes into [] hands every listener to the setter.
for (const idx of ['0', '1']) {
  record('setter' + idx, function () {
    let stolen = 0;
    Object.defineProperty(Array.prototype, idx, {
      configurable: true,
      set: function () { stolen++; },
      get: function () { return undefined; },
    });
    try {
      let calls = 0;
      const ee = new EventEmitter();
      ee.on('e', function () { calls++; });
      ee.on('e', function () { calls++; });
      ee.emit('e');
      return calls + ',' + stolen + ',' + ee.listeners('e').length + ',' + ee.rawListeners('e').length;
    } finally {
      delete Array.prototype[idx];
    }
  });
}

// once() and events.on() reject/resolve through captured Promise statics, not the
// live Promise.reject / Promise.resolve a script can replace.
record('promise-statics', function () {
  const realResolve = Promise.resolve;
  const realReject = Promise.reject;
  Promise.resolve = function () { throw new Error('Promise.resolve leaked'); };
  Promise.reject = function () { throw new Error('Promise.reject leaked'); };
  try {
    const a = EventEmitter.once(new EventEmitter(), 'x', 5);
    const it = EventEmitter.on(new EventEmitter(), 'x');
    const b = it.return();
    a.then(null, function () {});
    return (a instanceof Promise) + ',' + (b instanceof Promise);
  } finally {
    Promise.resolve = realResolve;
    Promise.reject = realReject;
  }
});

// events.on() with no options must not read 'signal' off Object.prototype.
record('options-proto', function () {
  Object.prototype.signal = 5;
  try {
    const it = EventEmitter.on(new EventEmitter(), 'x');
    return typeof it.next;
  } finally {
    delete Object.prototype.signal;
  }
});

// events.on()'s queues are not Arrays: neither a replaced push/shift nor an index
// setter on Array.prototype can drop or read a queued event.
const asyncChecks = (async function () {
  const realPush = Array.prototype.push;
  const realShift = Array.prototype.shift;
  let stolen = 0;
  Array.prototype.push = function () { throw new Error('push leaked'); };
  Array.prototype.shift = function () { throw new Error('shift leaked'); };
  Object.defineProperty(Array.prototype, '0', {
    configurable: true,
    set: function () { stolen++; },
    get: function () { return undefined; },
  });
  let got;
  try {
    const ee = new EventEmitter();
    const it = EventEmitter.on(ee, 'v');
    ee.emit('v', 'a');
    ee.emit('v', 'b');
    const first = await it.next();
    const second = await it.next();
    await it.return();
    got = first.value + '|' + second.value + ',' + stolen;
  } catch (e) {
    got = 'THREW:' + e.name;
  } finally {
    Array.prototype.push = realPush;
    Array.prototype.shift = realShift;
    delete Array.prototype[0];
  }
  results[results.length] = 'on-queue=' + got;
})();

asyncChecks.then(function () {
  const want = ['setter0=2,0,2,2', 'setter1=2,0,2,2', 'promise-statics=true,true', 'options-proto=function', 'on-queue=a|b,0'];
  const bad = [];
  for (let i = 0; i < want.length; i++) {
    if (results[i] !== want[i]) bad[bad.length] = 'want ' + want[i] + ' got ' + results[i];
  }
  if (bad.length !== 0) throw new Error(bad.join('; '));
  console.log('events-pollution ok');
});
`

@(test)
events_pollution_immunity :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(EVENTS_POLLUTION_SCRIPT, "<events-pollution-test>", &loop, false)
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

// primordials is an internal-only module: internal factories require() it, but it
// must not leak through the public resolver (it would shadow a user package named
// "primordials" and wrongly answer require('node:primordials')). This evals user
// code and asserts both specifiers fail with MODULE_NOT_FOUND while a genuine
// builtin still resolves. A clean run means the loader's publicReq gate holds.
HIDDEN_FROM_REQUIRE_SCRIPT :: `
'use strict';
function notFound(fn) {
  try {
    fn();
    return false;
  } catch (e) {
    return e && e.code === 'MODULE_NOT_FOUND';
  }
}
if (!notFound(function () { require('primordials'); }))
  throw new Error("require('primordials') must not resolve");
if (!notFound(function () { require('node:primordials'); }))
  throw new Error("require('node:primordials') must not resolve");
if (typeof require('node:events') !== 'function')
  throw new Error('a real builtin must still resolve');
console.log('primordials-hidden ok');
`

@(test)
primordials_hidden_from_user_require :: proc(t: ^testing.T) {
	loop := eventloop.init()
	result := lava.eval(HIDDEN_FROM_REQUIRE_SCRIPT, "<primordials-hidden-test>", &loop, false)
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
