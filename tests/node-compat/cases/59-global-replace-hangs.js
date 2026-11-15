// Global-flag regex replaces under a poisoned `RegExp.prototype.exec`.
//
// This is the availability half of the pollution work, and the class #322 closed for
// url.js/fetch.js without finishing the tree. `RegExp.prototype[Symbol.replace]` in
// GLOBAL mode loops on RegExpExec and only advances `lastIndex` on an EMPTY match, so a
// forged non-empty result never terminates: the call does not answer wrongly, it never
// returns. The observable assertion is therefore just that this file finishes.
//
// Only the surface where node is a real oracle lives here. node's querystring routes
// its own regexes through captured primordials and answers correctly under the same
// poison, so any divergence is Lava's:
//
//   querystring.parse('a+b=1')   node: {'a b':'1'}   Lava before the fix: hang
//
// The other four global-flag sites are NOT here, for two different reasons, both of
// which make an oracle case impossible:
//
//   path.matchesGlob, util.inspect of a Buffer, `new Blob([…], {endings:'native'})`
//     node 24 HANGS on all three under this same gadget — its own implementations run
//     the same shape of global replace — so it cannot be the oracle, and hardening Lava
//     there is a deviation in Lava's favour.
//   util.debuglog (the NODE_DEBUG pattern, three chained global replaces)
//     blocked by something unrelated: `process.stderr` does not exist in Lava at all
//     (nor does `process.stdout`), so an enabled debuglog throws before it can print,
//     poisoned or not. Fixing the spin does not make the outputs match.
//
// All four are pinned Lava-only in cmd/lava/regexp_pollution_test.odin, per CLAUDE.md §1.
//
// Poison is restored before anything is printed — reading a result through the
// poisoned prototype would say nothing about the runtime.

const realExec = RegExp.prototype.exec;

function under(fn) {
  const forged = ['forged'];
  forged.index = 0;
  forged.input = '';
  let spins = 0;
  RegExp.prototype.exec = function () {
    if (++spins > 256) {
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
    RegExp.prototype.exec = realExec;
  }
  return out;
}

// 1. The remote-reachable one. `querystring.parse` is public `node:querystring`, and a
// '+' in a query string is all it takes to reach the global replace — so a server doing
// parse(req.url.split('?')[1]) wedges on a crafted request once any dependency has
// assigned RegExp.prototype.exec.
const qs = require('node:querystring');
console.log('plus=' + under(() => qs.parse('a+b=1&c=2')['a b']));

// The '+' guard is an indexOf, so a query with no '+' never entered the replace and was
// never at risk. Pinning it keeps a "fix" that simply stops decoding from passing.
console.log('noplus=' + under(() => qs.parse('a=1&b=2').b));

// Several '+' in one value, and a '+' in the KEY as well as the value — the loop has to
// terminate for every occurrence, not just the first.
console.log('many=' + under(() => qs.parse('a+b+c=1+2+3')['a b c']));

// `unescape` is a DIFFERENT decoder — it percent-decodes only and never maps '+'
// (querystring.js:22), so it never reached the replace. Kept as a Node-parity pin, not
// as coverage of this class: it prints `a+b` with the fix, without it, and with
// decodeComponent deleted. An earlier comment here claimed it was "the same decoder
// reached directly", which is what a reader would have trusted.
console.log('unesc=' + under(() => qs.unescape('a+b')));

// The boundaries replaceCharAll's own callers never exercise: a '+' at index 0, at the
// end of a key, and two consecutive. The rewrite is a hand-written scan, so these are
// where an off-by-one lives.
console.log('edges=' + under(() => JSON.stringify(qs.parse('+a=1&b+=2&c++d=3'))));

// Zero-length components hit the `s.length === 0` early return above the replace.
console.log('empty=' + under(() => JSON.stringify(qs.parse('a=&=b'))));

// The MIMEType serializer escapes quotes and backslashes. It was a global replace too,
// reachable from a remote Content-Type, and node answers correctly under this same
// gadget — so it belongs in the oracle half, not the Lava-only pins. Constructed clean
// so the poison lands on toString(), which is where the spin was.
const mimeVal = new (require('node:util').MIMEType)('text/plain;charset="a b"');
console.log('mime=' + under(() => String(mimeVal)));
const mimeEsc = new (require('node:util').MIMEType)('text/plain;p="a\\"b"');
console.log('mime-esc=' + under(() => String(mimeEsc)));

console.log('done');
