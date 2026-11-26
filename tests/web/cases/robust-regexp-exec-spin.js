// Global-flag regex replaces under a poisoned RegExp.prototype.exec. A global
// RegExp[Symbol.replace] loops on RegExpExec and advances lastIndex only on an empty
// match, so a forged non-empty match never terminates: the call does not answer
// wrongly, it never returns. The forged exec gives up after 256 calls, so a spinning
// site prints THREW:RangeError instead of hanging. The poison is lifted before
// anything is printed.
// Ported from tests/node-compat/cases/59-global-replace-hangs.js: node:querystring and
// util.MIMEType are Node-only, so the page-reachable '+' decoder (URLSearchParams) and
// Blob's native line endings stand in for them — a browser is native and immune on both.
const realExec = RegExp.prototype.exec;
function under(fn) {
  const forged = ['forged'];
  forged.index = 0;
  forged.input = '';
  let spins = 0;
  RegExp.prototype.exec = function () {
    if (++spins > 256) throw new RangeError('forged exec spin');
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
print('plus=' + under(() => new URLSearchParams('a+b=1&c=2').get('a b')));
print('noplus=' + under(() => new URLSearchParams('a=1&b=2').get('b')));
print('many=' + under(() => new URLSearchParams('a+b+c=1+2+3').get('a b c')));
print('edges=' + under(() => JSON.stringify([...new URLSearchParams('+a=1&b+=2&c++d=3')])));
print('empty=' + under(() => JSON.stringify([...new URLSearchParams('a=&=b')])));
print('serialize=' + under(() => new URLSearchParams([['a b', 'c+d']]).toString()));
print('url search=' + under(() => new URL('http://h/?a+b=c+d').searchParams.get('a b')));
print('blob native=' + under(() => new Blob(['a\nb\r\nc'], { endings: 'native' }).size));
print('done');
