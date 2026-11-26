// crypto.getRandomValues' rejections with Chrome's shapes and text: a TypeError for a
// missing or non-view argument, a TypeMismatchError DOMException for a float view or a
// DataView, and a QuotaExceededError past 65536 bytes — the type check first. The
// constructor, name, legacy code and absence of an own `code` are the profile's error
// shape (CLAUDE.md §5); crypto-random.js prints only the names.
function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(
      label +
        ': ' +
        e.constructor.name +
        ' ' +
        e.name +
        ' code ' +
        e.code +
        ' own code ' +
        Object.prototype.hasOwnProperty.call(e, 'code') +
        ' ' +
        Object.prototype.toString.call(e),
    );
    print('  ' + JSON.stringify(e.message));
    if (e instanceof QuotaExceededError) print('  quota ' + e.quota + ' requested ' + e.requested);
  }
}
show('no argument', () => crypto.getRandomValues());
show('undefined', () => crypto.getRandomValues(undefined));
show('null', () => crypto.getRandomValues(null));
show('array', () => crypto.getRandomValues([1, 2]));
show('ArrayBuffer', () => crypto.getRandomValues(new ArrayBuffer(4)));
show('Float32Array', () => crypto.getRandomValues(new Float32Array(4)));
show('Float64Array', () => crypto.getRandomValues(new Float64Array(4)));
show('DataView', () => crypto.getRandomValues(new DataView(new ArrayBuffer(4))));
show('Uint8Array 65537', () => crypto.getRandomValues(new Uint8Array(65537)));
show('Uint32Array 16385', () => crypto.getRandomValues(new Uint32Array(16385)));
show('Float32Array 20000', () => crypto.getRandomValues(new Float32Array(20000)));
show('BigInt64Array', () => crypto.getRandomValues(new BigInt64Array(2)));
show('Uint8ClampedArray', () => crypto.getRandomValues(new Uint8ClampedArray(2)));
show('Uint16Array 32768', () => crypto.getRandomValues(new Uint16Array(32768)));
