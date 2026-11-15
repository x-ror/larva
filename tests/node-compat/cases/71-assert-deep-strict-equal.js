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
