// Blob and the blob: URL registry must not call a REPLACED global or prototype method
// at call time. Every spy forwards to the original, so the only observable is whether
// it was called; the log is printed after the spies are lifted. The object-URL id is
// printed only by its shape.
// Ported from tests/node-compat/cases/78-blob-pristine-reads.js (node:crypto,
// node:buffer.resolveObjectURL and process.platform have no page counterpart).
const log = [];
let armed = false;
const RA = Reflect.apply;
const restore = [];
function spyMethod(owner, key, label) {
  const orig = owner[key];
  restore.push(() => (owner[key] = orig));
  owner[key] = function (...args) {
    if (armed) log.push(label);
    return RA(orig, this, args);
  };
}
spyMethod(globalThis.crypto, 'randomUUID', 'crypto.randomUUID');
spyMethod(ArrayBuffer, 'isView', 'ArrayBuffer.isView');
spyMethod(Map.prototype, 'set', 'Map.prototype.set');
spyMethod(Map.prototype, 'get', 'Map.prototype.get');
spyMethod(Map.prototype, 'delete', 'Map.prototype.delete');
spyMethod(String.prototype, 'charCodeAt', 'String.prototype.charCodeAt');
spyMethod(String.prototype, 'toLowerCase', 'String.prototype.toLowerCase');
const StringOrig = String;
globalThis.String = function (v) {
  if (armed) log.push('String');
  return StringOrig(v);
};
Object.defineProperty(ArrayBuffer, Symbol.hasInstance, {
  configurable: true,
  value(v) {
    if (armed) log.push('ArrayBuffer[Symbol.hasInstance]');
    return Function.prototype[Symbol.hasInstance].call(ArrayBuffer, v);
  },
});

armed = true;
const u8 = new Uint8Array([0x61, 0x62, 0x63, 0x64]);
const blob = new Blob(
  ['x\ny', u8.subarray(1, 3), new DataView(u8.buffer, 2, 2), new ArrayBuffer(2), 7],
  { type: 'Text/Plain' },
);
const url = URL.createObjectURL(blob);
URL.revokeObjectURL(url);
armed = false;

globalThis.String = StringOrig;
delete ArrayBuffer[Symbol.hasInstance];
for (const r of restore) r();
print('log: ' + JSON.stringify(log));
print('size: ' + blob.size + ' type: ' + blob.type);
print('url shape: ' + url.startsWith('blob:' + ORIGIN + '/'));
