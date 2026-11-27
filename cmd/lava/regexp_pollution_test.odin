package main

// Lava-only: the network-facing validators must survive a replaced
// `RegExp.prototype.exec`, on the axes where node CANNOT be the oracle.
//
// Why this is not an oracle case. node's URL is native C++ and immune, so
// tests/node-compat/cases/54-url-pollution.js covers the URL half as a real
// differential. The HEADER half cannot go there: undici's header-name validator is
// JavaScript, so under the same poison node 24 ACCEPTS
// `Headers.set('X-Evil: 1\r\nInjected', 'v')` while Lava rejects it. That is a
// deliberate deviation in Lava's favour, and CLAUDE.md §1 requires a deviation to be
// pinned by a Lava-only test rather than left to a comment. This is that test.
//
// The second axis is availability, not validation, and it is the one a review
// caught: `RegExp.prototype[Symbol.replace]` in GLOBAL mode loops on RegExpExec and
// only advances `lastIndex` on an empty match, so a forged non-empty result never
// terminates. Before the fix, `new Headers().set('X-Ok', 'v')` — a valid header —
// never returned under this poison, and the URL path reached 1.4 GB RSS in four
// seconds. Both now answer promptly, which is what the timing-free assertions below
// actually check: the script simply has to finish.

import "core:testing"
import lava "lava:pkg/runtime"
import "lava:pkg/runtime/eventloop"

REGEXP_POLLUTION_SCRIPT :: `
const real = RegExp.prototype.exec;
const forged = ['forged'];
forged.index = 0;
forged.input = '';

// Poison for the duration of one call, then restore before inspecting — reading the
// result through the poisoned prototype would tell us nothing about the runtime.
// underUnbounded stays unbounded for the fetch header-trim pin whose manifest entry
// expects 'timed out'; under() caps forged exec spins at 256 iterations so the
// remaining global-replace mutation pins fail fast with THREW:RangeError.
function underWithLimit(fn, maxSpins) {
  let spins = 0;
  RegExp.prototype.exec = function () {
    if (maxSpins > 0 && ++spins > maxSpins) {
      throw new RangeError('forged exec spin');
    }
    return forged;
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    out = 'THREW:' + e.name;
  } finally {
    RegExp.prototype.exec = real;
  }
  return out;
}

function under(fn) {
  return underWithLimit(fn, 256);
}

function underUnbounded(fn) {
  return underWithLimit(fn, 0);
}

const results = [];

// A header name carrying CRLF is header injection on the wire. Lava must reject it
// even with the validator's carrier replaced; node accepts it here.
results.push(
  'inject=' +
    under(() => {
      const h = new Headers();
      h.set('X-Evil: 1\r\nInjected', 'v');
      return 'ACCEPTED';
    }),
);

// A space is the cheaper, more common shape of the same vector.
results.push(
  'space=' +
    under(() => {
      const h = new Headers();
      h.set('a b', 'v');
      return 'ACCEPTED';
    }),
);

// A VALID header must still work. This is the availability half: it used to hang
// forever in normalizeHeaderValue's global replaceAll, so reaching this line at all
// is the assertion.
results.push(
  'valid=' +
    underUnbounded(() => {
      const h = new Headers();
      h.set('X-Ok', '  v  ');
      return h.get('x-ok');
    }),
);

// The same spin on the URL path, via the tab/newline strip.
results.push('tab=' + under(() => new URL('http://exa\tmple.com/x').href));

// And the IDNA separator fold, which an uppercase host reaches.
results.push('upper=' + under(() => new URL('http://EXAMPLE.com/').href));

// --- the SECOND carrier: String.prototype.charCodeAt ---------------------
//
// Routing a validator off RegExp says nothing about what it reads instead. These
// scans are hand-rolled charCode loops, which reads as safe and is not: charCodeAt
// is a writable data property like any other. node cannot oracle this — it rejects
// the injected value for its own reasons — so it belongs here, not in a case.
const realCCA = String.prototype.charCodeAt;
function underCharCode(fn) {
  // Lies ONLY about CR/LF/NUL. A blanket liar would break the runtime's own parsing
  // and the assertion would pass for an unrelated reason.
  String.prototype.charCodeAt = function (i) {
    const c = realCCA.call(this, i);
    return c === 13 || c === 10 || c === 0 ? 0x41 : c;
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    out = 'THREW:' + e.name;
  } finally {
    String.prototype.charCodeAt = realCCA;
  }
  return out;
}

results.push(
  'cc-value=' +
    underCharCode(() => {
      const h = new Headers();
      h.set('x-ok', 'a\r\nInjected: yes');
      return 'ACCEPTED';
    }),
);

// --- the THIRD carrier: a replaced global used for CONVERSION -------------
// A validator can be unpoisonable while the conversion beside it is not.
// parseInt is captured on primordials at bootstrap (before this script runs), so
// a post-load poison must not steer URL port conversion. Port parse is a real
// consumer of the captured binding (url.js is eager).
const realParseInt = globalThis.parseInt;
results.push(
  'pi=' +
    (() => {
      globalThis.parseInt = function () {
        return 7;
      };
      let out;
      try {
        out = new URL('http://h:8080/').port;
      } catch (e) {
        out = 'THREW:' + e.name;
      } finally {
        globalThis.parseInt = realParseInt;
      }
      return out;
    })(),
);

// --- two more global-replace spins, on carriers the first pass missed -----
results.push('usp=' + under(() => String([...new URLSearchParams('a=😀')].length)));

// --- a global-replace spin where node is NOT the oracle -------------------
//
// Blob endings:'native' ran a global replace; node 24 hangs on it under this same
// gadget (verified: run under node with the poison installed, it timed out), so
// hardening Lava here is a DEVIATION IN LAVA'S FAVOUR, pinned here rather than by an
// oracle. The assertion is timing-free: the script simply has to finish.
results.push('blob=' + under(() => String(new Blob(['x\r\ny'], { endings: 'native' }).size)));

const want = [
  'inject=THREW:TypeError',
  'space=THREW:TypeError',
  'valid=v',
  'tab=http://example.com/x',
  'upper=http://example.com/',
  'cc-value=THREW:TypeError',
  'pi=8080',
  'usp=1',
  'blob=3',
];
if (results.length !== want.length) {
  throw new Error('results ' + results.length + ' vs want ' + want.length);
}
for (let i = 0; i < want.length; i++) {
  if (results[i] !== want[i]) {
    throw new Error('want ' + want[i] + ' got ' + results[i]);
  }
}
console.log('regexp-pollution ok');
`

@(test)
regexp_pollution_immunity :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(REGEXP_POLLUTION_SCRIPT, "<regexp-pollution-test>", &loop, false)
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
