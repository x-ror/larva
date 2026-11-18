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
// a post-load poison must not steer URL port / framing conversion. Buffer.from
// base64 never called parseInt — the previous pin was decorative. Port parse is
// a real consumer of the captured binding (url.js is eager; http.js is lazy and
// is pinned by the parseint http-smoke phase instead).
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
results.push('b64=' + under(() => Buffer.from('dXNlcjpwYXNz', 'base64').toString()));
results.push('usp=' + under(() => String([...new URLSearchParams('a=😀')].length)));

// --- global-replace spins where node is NOT the oracle --------------------
//
// These three are here rather than in a compat case for the reason the file header
// gives: node 24 hangs on all of them under this same gadget, because its own
// path.matchesGlob, util.inspect-of-a-Buffer and Blob endings:'native' each run a
// global replace over JavaScript it does not route through primordials. Verified, not
// assumed — each was run under node with the poison installed and timed out.
//
// So hardening Lava here is a DEVIATION IN LAVA'S FAVOUR, and CLAUDE.md §1 requires a
// Lava-only test rather than a comment. The assertion is timing-free: the script simply
// has to finish. querystring is the ONLY one of the five that node oracles, and it is
// the only one in tests/node-compat/cases/59-global-replace-hangs.js; util.debuglog is
// Lava-only too and sits directly below, for a different reason.
results.push('glob=' + under(() => String(require('node:path').matchesGlob('a/b.txt', 'a/*.txt'))));
results.push('inspect=' + under(() => require('node:util').inspect(Buffer.from([1, 2, 3]))));
results.push('blob=' + under(() => String(new Blob(['x\r\ny'], { endings: 'native' }).size)));

// util.debuglog compiles NODE_DEBUG with three chained global replaces on the first
// CALL, so the poison goes in after the require. It is here rather than in the compat
// case for a reason unrelated to the spin: Lava has no process.stderr (nor
// process.stdout), so an ENABLED debuglog throws before it can write, and node prints
// instead — the outputs cannot match however the spin is fixed. What this pins is
// availability only: THREW means it returned, where before it consumed the string until
// the engine gave up. The missing process.stderr is a separate gap, recorded in ROADMAP.
// One env value for every debuglog assertion below: initDebugEnv compiles the pattern
// on the FIRST call and latches, so a later re-assignment is silently ignored. 'a.b'
// carries the regex special that must be escaped; 'foo*' carries the wildcard.
process.env.NODE_DEBUG = 'a.b,foo*';
const nodeUtil2 = require('node:util');
const debugLog = nodeUtil2.debuglog('foo');
// Asserts LIVENESS, not an error name: 'THREW:TypeError' would also match a captured
// primordial having gone undefined, and it inverts the day process.stderr lands (an open
// ROADMAP item), turning a pollution test red for a stdio change. Either outcome proves
// the pattern compile returned, which is the property under test.
const dl = under(() => {
  debugLog('x');
  return 'called';
});
results.push('debuglog=' + (dl === 'called' || dl === 'THREW:TypeError' ? 'returned' : dl));

// The enablement decision, UNPOISONED. Without this nothing observes debugEnvPattern at
// all: under the poison testEnabled reads the forged exec and answers true for every
// section, so the assertion above passes even with NODE_DEBUG unset — i.e. when the
// pattern is never compiled. These two lines are what make the poisoned probe honest,
// and they cover the escape branch ('.' is a regex special that must be escaped, so
// 'a.b' must not enable 'axb').
results.push('dbg-dot=' + String(nodeUtil2.debuglog('a.b').enabled));
results.push('dbg-nodot=' + String(nodeUtil2.debuglog('axb').enabled));
results.push('dbg-star=' + String(nodeUtil2.debuglog('foobar').enabled));
results.push('dbg-miss=' + String(nodeUtil2.debuglog('nope').enabled));

// punycode's RFC 3490 separator fold was the same global-replace shape. node hangs on it
// too, so it is Lava-only. new URL() does not route here (url.js has its own IDNA
// path), so this needs an explicit require to reach.
const puny = require('node:punycode');
results.push('puny-clean=' + puny.toASCII('münchen.de'));
// Availability only under the poison, deliberately. The separator fold no longer spins,
// but punycode.js still decides PER LABEL with live regexNonASCII/regexPunycode .test
// reads, so a forged exec makes it encode every label ('.de' becomes '.xn--de-'). That
// is the steering class, not the spin class this entry closes, and it is left to the
// file's own hardening pass — asserting the garbage value would pin the bug, not the fix.
const punyRes = under(() => puny.toASCII('münchen.de'));
results.push(
  'puny=' + (typeof punyRes === 'string' && punyRes !== 'THREW:RangeError' ? 'returned' : punyRes),
);

const want = [
  'inject=THREW:TypeError',
  'space=THREW:TypeError',
  'valid=v',
  'tab=http://example.com/x',
  'upper=http://example.com/',
  'cc-value=THREW:TypeError',
  'pi=8080',
  'b64=user:pass',
  'usp=1',
  'glob=true',
  'inspect=<Buffer 01 02 03>',
  'blob=3',
  'debuglog=returned',
  'dbg-dot=true',
  'dbg-nodot=false',
  'dbg-star=true',
  'dbg-miss=false',
  'puny-clean=xn--mnchen-3ya.de',
  'puny=returned',
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
