// Blob and the blob: URL registry must not read a REPLACED global at call time.
//
// internal/blob.js is eager (node/buffer.js requires it before user code), so a capture
// at its module-eval is pristine; a read inside a method is not. Before this case, Lava
// read every name below live: the object-URL id came from whatever
// `globalThis.crypto.randomUUID` was by then (a predictable id is a guessable blob: URL),
// `endings: 'native'` re-read `process.platform` per construction, and the registry,
// part classifier and type normaliser went through replaceable globals and prototype
// methods. Node takes all of them from primordials or bindings; measured on node 26.13.0,
// every log below is empty and the platform is the one the process started with.
//
// A spy forwards to the original, so the only observable is whether it was CALLED — the
// output stays deterministic (no uuid is ever printed, only its shape).
//
// Deliberately NOT here, because node reads them live and Lava does not, so the logs
// would differ by construction: the %TypedArray% / DataView buffer, byteOffset and
// byteLength accessors (node's Blob reads them off every view part; Lava takes the
// engine slots — pinned Lava-only by cmd/lava/blob_class_test.odin). Also absent:
// ArrayBuffer[Symbol.species] / .constructor, which BOTH read through
// ArrayBufferPrototypeSlice.
const log = [];
let armed = false;
const RA = Reflect.apply;

function spyMethod(owner, key, label) {
  const orig = owner[key];
  owner[key] = function (...args) {
    if (armed) log.push(label);
    return RA(orig, this, args);
  };
}

const platform = process.platform;

spyMethod(globalThis.crypto, 'randomUUID', 'globalThis.crypto.randomUUID');
spyMethod(require('crypto'), 'randomUUID', "require('crypto').randomUUID");
spyMethod(ArrayBuffer, 'isView', 'ArrayBuffer.isView');
spyMethod(Map.prototype, 'set', 'Map.prototype.set');
spyMethod(Map.prototype, 'get', 'Map.prototype.get');
spyMethod(Map.prototype, 'delete', 'Map.prototype.delete');
spyMethod(String.prototype, 'charCodeAt', 'String.prototype.charCodeAt');
spyMethod(String.prototype, 'toLowerCase', 'String.prototype.toLowerCase');

// A replaced String global and a forged ArrayBuffer[Symbol.hasInstance] are both plain
// writes user code can make; the classifier must not consult either.
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
Object.defineProperty(process, 'platform', { value: platform === 'win32' ? 'linux' : 'win32' });

armed = true;
const u8 = new Uint8Array([0x61, 0x62, 0x63, 0x64]);
const blob = new Blob(
  ['x\ny', u8.subarray(1, 3), new DataView(u8.buffer, 2, 2), new ArrayBuffer(2), 7],
  { type: 'Text/Plain', endings: 'native' },
);
const url = URL.createObjectURL(blob);
const back = require('buffer').resolveObjectURL(url);
URL.revokeObjectURL(url);
const gone = require('buffer').resolveObjectURL(url);
armed = false;

globalThis.String = StringOrig;
console.log('log:', JSON.stringify(log));
console.log('size:', blob.size, 'type:', blob.type);
console.log(
  'native endings follow the startup platform:',
  blob.size === (platform === 'win32' ? 11 : 10),
);
console.log(
  'url shape:',
  /^blob:nodedata:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(url),
);
console.log('resolved:', back instanceof Blob, back && back.size, 'after revoke:', gone);
