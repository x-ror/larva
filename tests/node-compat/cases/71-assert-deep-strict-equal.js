// assert.deepStrictEqual / notDeepStrictEqual delegate to util.isDeepStrictEqual (#103).
const assert = require('node:assert');

function checkEqual(label, a, b) {
  let ok = true;
  try {
    assert.deepStrictEqual(a, b);
  } catch (e) {
    ok = false;
  }
  console.log(label + ': eq=' + ok);
}

checkEqual('Set objects equal', new Set([{ a: 1 }]), new Set([{ a: 1 }]));
checkEqual('Set objects diff', new Set([{ a: 1 }]), new Set([{ a: 2 }]));
checkEqual('Map obj keys equal', new Map([[{ k: 1 }, 2]]), new Map([[{ k: 1 }, 2]]));
checkEqual('Map obj keys diff', new Map([[{ k: 1 }, 2]]), new Map([[{ k: 1 }, 3]]));
// Primitive keys/members are looked up directly; object ones are scanned pairwise.
checkEqual('Map prim key, value diff', new Map([['a', { x: 1 }]]), new Map([['a', { x: 2 }]]));
checkEqual('Map prim key, value deep eq', new Map([['a', { x: 1 }]]), new Map([['a', { x: 1 }]]));
checkEqual('Map prim key missing', new Map([['a', 1]]), new Map([['b', 1]]));
checkEqual('Map 1 vs "1" key', new Map([[1, 1]]), new Map([['1', 1]]));
checkEqual('Map NaN key', new Map([[NaN, 1]]), new Map([[NaN, 1]]));
checkEqual('Map -0 vs 0 key', new Map([[-0, 1]]), new Map([[0, 1]]));
checkEqual(
  'Map undefined value vs missing',
  new Map([['a', undefined]]),
  new Map([['b', undefined]]),
);
checkEqual('Set prim diff', new Set([1, 2]), new Set([1, 3]));
checkEqual('Set prim vs object', new Set([1, { a: 1 }]), new Set([{ a: 1 }, { a: 1 }]));
checkEqual('Set mixed reordered', new Set([{ a: 1 }, 'x', 2]), new Set([2, 'x', { a: 1 }]));
checkEqual('Set fn identity', new Set([() => 1]), new Set([() => 1]));
checkEqual(
  'Map 16k equal',
  new Map(Array.from({ length: 16000 }, (_, i) => [i, i])),
  new Map(Array.from({ length: 16000 }, (_, i) => [i, i])),
);
checkEqual('Error equal', new Error('boom'), new Error('boom'));
checkEqual('Error diff class', new TypeError('boom'), new Error('boom'));
checkEqual('Boxed Number equal', new Number(1), new Number(1));
checkEqual('Boxed Number diff', new Number(1), new Number(2));
checkEqual('Int8 vs Uint8', new Int8Array([1, 2]), new Uint8Array([1, 2]));
checkEqual('NaN', NaN, NaN);
checkEqual('+0 vs -0', +0, -0);

const s = Symbol('x');
checkEqual('Symbol key equal', { [s]: 1 }, { [s]: 1 });
checkEqual('Symbol key diff', { [s]: 1 }, { [s]: 2 });

class A {
  constructor(x) {
    this.x = x;
  }
}
class B {
  constructor(x) {
    this.x = x;
  }
}
checkEqual('Proto diff', new A(1), new B(1));

const c1 = {};
c1.self = c1;
const c2 = {};
c2.self = c2;
checkEqual('Circular', c1, c2);

assert.throws(() => assert.notDeepStrictEqual(new Set([{ a: 1 }]), new Set([{ a: 1 }])), {
  code: 'ERR_ASSERTION',
});
console.log('notDeepStrictEqual threw ERR_ASSERTION');
