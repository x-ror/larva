// A user `[util.inspect.custom]` hook that inspects a value pointing back at one of its
// ancestors must not make util.inspect or console.log throw.
//
// Shape: a parent-pointer tree. `outer.h` is an object whose hook returns
// `inspect(outer)`, so outer -> h -> outer -> h ... never ends unless the hook's inspect
// knows what it is already inside.
//
// node 24.22.1 recurses until the stack runs out, catches the overflow inside inspect and
// prints what it had: a 1.2 MB string ending in `h: [Object: Inspection interrupted
// prematurely. Maximum call stack size exceeded.]`, never a throw. Lava before #391
// printed `{ n: 1, h: [Circular *1] }`; at c5fd268 it THREW a RangeError, because the
// inspect handed to a hook now starts a fresh visited set (as node's does) and nothing
// caught the overflow. Lava now catches it at the hook boundary, as node does. Where the
// cut lands depends on stack size and node also breaks lines, so the lines below print
// the outcome and whether the marker is there, not the full string.
const util = require('node:util');

function make() {
  const outer = { n: 1 };
  class H {
    [util.inspect.custom](depth, options, inspect) {
      return inspect(outer);
    }
  }
  outer.h = new H();
  return outer;
}

function outcome(label, fn) {
  let s;
  try {
    s = fn();
  } catch (e) {
    console.log(label, 'threw', e.name);
    return;
  }
  console.log(label, 'returned', typeof s, s.includes('Inspection interrupted prematurely'));
}

outcome('util.inspect:', () => util.inspect(make()));
// console.log is pinned Lava-only (buffer_inspect_hook_ancestor_cycle in
// cmd/lava/buffer_inspect_extras_test.odin): its rendered text differs from node's by
// construction, and Lava's console.log writes natively rather than through
// process.stdout.write, so the text cannot be captured here and kept out of the compared
// stdout.
