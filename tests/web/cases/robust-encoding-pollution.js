// TextEncoder/TextDecoder must survive a poisoned prototype or a replaced global: a
// browser's codecs are native and immune, Lava's are JS routed through primordials
// and module-eval captures, so both must produce the same bytes and the same text.
// url.js delegates percent- and host-decoding to TextDecoder, so the `new URL(...)`
// lines are module-boundary vectors. Errors are compared by name only; their shape is
// encoding-errors.js.
// Ported from tests/node-compat/cases/55-encoding-pollution.js; its Buffer vectors
// (R1, R2, T's Buffer.prototype.toString) have no page counterpart, and U/W build
// their shared backing store from a TextEncoder result instead of the Buffer pool.
// The vector letters keep the original's (H and V retired there: call/apply are
// locked, pinned Lava-only in cmd/lava/function_call_lock_test.odin).
//
//   I  String.fromCharCode            J  Array.prototype.push (decoder accumulator)
//   K  charCodeAt/slice (BOM)         L  codePointAt (encodeInto)
//   M  toLowerCase/trim (labels)      N  Object.prototype as a label table
//   O  Object.prototype.fatal/...     P  replaced free globals
//   Q  the >0x2000 chunked branch     R  the String global under the codecs
//   S  Array.prototype[0] accessor    T  %TypedArray%.prototype.buffer
//   U  the window accessors           W  Ctor[Symbol.hasInstance] brands

function underPollution(setup, teardown, run) {
  const saved = {};
  setup(saved);
  let out;
  try {
    out = run();
  } catch (e) {
    out = 'THREW:' + e.name;
  } finally {
    teardown(saved);
  }
  return out;
}

// Save/restore one property, as a [setup, teardown] pair.
function poison(target, key, value) {
  return [
    (s) => {
      s.had = Object.prototype.hasOwnProperty.call(target, key);
      s.v = target[key];
      target[key] = value;
    },
    (s) => {
      if (s.had) target[key] = s.v;
      else delete target[key];
    },
  ];
}

// Held before any vector runs, so a test that replaces the global still has a
// genuine typed array to hand in (Node validates `dest` by brand, and that
// error's identity is a separate, pre-existing gap this case must not depend on).
const RealU8 = Uint8Array;

const U16_SMILE = [0x3d, 0xd8, 0x00, 0xde, 0x41, 0x00]; // 😀A

// A >0x2000-code-unit input, so unitsToString takes its chunked branch.
const BIG_LATIN = new Uint8Array(9000);
for (let i = 0; i < BIG_LATIN.length; i++) BIG_LATIN[i] = 0x41 + (i % 26);
function bigDigest(s) {
  return s.length + ':' + s.charCodeAt(0) + ':' + s.charCodeAt(8192) + ':' + s.charCodeAt(8999);
}

// --- I: replaced String.fromCharCode ----------------------------------------

print(
  'I1 ' +
    underPollution(
      ...poison(String, 'fromCharCode', () => 'PWNED'),
      () => new URL('http://%C3%BCber.example/').href,
    ),
);

print(
  'I2 ' +
    underPollution(...poison(String, 'fromCharCode', () => 'PWNED'), () =>
      JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x80, 0xe9]))),
    ),
);

// --- J: poisoned Array.prototype.push, on every decode path -----------------

const PUSH_STUB = function () {
  return 0;
};

print(
  'J1 ' +
    underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
      JSON.stringify(new TextDecoder('utf-16le').decode(new Uint8Array(U16_SMILE))),
    ),
);

// fatal utf-8: ASCII push + pushCodePoint BMP + pushCodePoint surrogate pair
print(
  'J2 ' +
    underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
      JSON.stringify(
        new TextDecoder('utf-8', { fatal: true }).decode(
          new Uint8Array([0x41, 0xc3, 0xbc, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]),
        ),
      ),
    ),
);

// streaming utf-8: invalid lead, bad-continuation re-process, final-flush U+FFFD
print(
  'J3 ' +
    underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () => {
      const d = new TextDecoder();
      return JSON.stringify(
        d.decode(new Uint8Array([0x41, 0xff, 0xe2, 0x41]), { stream: true }) +
          d.decode(new Uint8Array([0xe2, 0x82]), { stream: true }) +
          d.decode(),
      );
    }),
);

print(
  'J4 ' +
    underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
      JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x80, 0xe9]))),
    ),
);

// utf-16le error and flush sites: lone low, orphan high, odd trailing byte
print(
  'J5 ' +
    underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
      JSON.stringify(
        [
          [0x00, 0xdc, 0x41, 0x00],
          [0x3d, 0xd8, 0x41, 0x00],
          [0x41, 0x00, 0x42],
          [0x3d, 0xd8],
        ]
          .map((b) => new TextDecoder('utf-16le').decode(new Uint8Array(b)))
          .join('|'),
      ),
    ),
);

// --- K: poisoned String.prototype.charCodeAt / slice (BOM stripping) --------

print(
  'K1 ' +
    underPollution(...poison(String.prototype, 'charCodeAt', () => 0xfeff), () =>
      JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x42]))),
    ),
);

print(
  'K2 ' +
    underPollution(...poison(String.prototype, 'slice', () => 'PWNED'), () =>
      JSON.stringify(
        new TextDecoder('utf-16le').decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])),
      ),
    ),
);

// --- L: poisoned String.prototype.codePointAt (encodeInto's scanner) --------

print(
  'L ' +
    underPollution(...poison(String.prototype, 'codePointAt', () => 0x41), () => {
      const dest = new Uint8Array(8);
      const r = new TextEncoder().encodeInto('a😀b', dest);
      return JSON.stringify(r) + ' ' + Array.from(dest).join(',');
    }),
);

// --- M: poisoned label normalization ----------------------------------------
// The label is already lower-case and untrimmed so that Node resolves it on the
// exact-match path: Node's getEncodingFromLabel tries an exact Map hit first and
// only then falls back to a (pollutable) toLowerCase. It never calls
// String.prototype.trim — it has its own ASCII-only trimAsciiWhitespace, because
// String.prototype.trim would also strip non-ASCII whitespace. Lava normalizes
// every label, so before the hardening both vectors forged the encoding.

print(
  'M1 ' +
    underPollution(
      ...poison(String.prototype, 'toLowerCase', () => 'utf-8'),
      () => new TextDecoder('utf-16le').encoding,
    ),
);

print(
  'M2 ' +
    underPollution(
      ...poison(String.prototype, 'trim', () => 'utf-8'),
      () => new TextDecoder('utf-16le').encoding,
    ),
);

// --- N: Object.prototype as a source of forged encoding labels --------------

print(
  'N1 ' +
    underPollution(
      ...poison(Object.prototype, 'evil', 'utf-8'),
      () => new TextDecoder('evil').encoding,
    ),
);

// Same axis without any pollution at all: these label names resolve on a plain
// object's prototype chain, so a non-null-prototype table accepts them.
print(
  'N2 ' +
    (() => {
      try {
        return new TextDecoder('constructor').encoding;
      } catch (e) {
        return 'THREW:' + e.name;
      }
    })(),
);
print(
  'N3 ' +
    (() => {
      try {
        return new TextDecoder('__proto__').encoding;
      } catch (e) {
        return 'THREW:' + e.name;
      }
    })(),
);

// --- O: Object.prototype.fatal / ignoreBOM leaking into default options -----

print(
  'O1 ' + underPollution(...poison(Object.prototype, 'fatal', true), () => new TextDecoder().fatal),
);

print(
  'O2 ' +
    underPollution(...poison(Object.prototype, 'ignoreBOM', true), () =>
      JSON.stringify(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42]))),
    ),
);

// A decoder that IS fatal must still throw while Object.prototype is clean.
print(
  'O3 ' +
    (() => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff]));
      } catch (e) {
        return 'THREW:' + e.name;
      }
    })(),
);

// Object.prototype.get turns every plain property descriptor into an accessor
// descriptor — reachable from a JSON merge gadget, {"__proto__":{"get":1}}.
print(
  'O4 ' +
    underPollution(...poison(Object.prototype, 'get', 1), () => {
      const d = new TextDecoder('utf-16le');
      return d.encoding + '/' + d.fatal + '/' + new URL('http://%C3%BCber.example/').hostname;
    }),
);

print(
  'O5 ' +
    underPollution(...poison(Object.prototype, 'enumerable', true), () =>
      JSON.stringify(new TextDecoder()),
    ),
);

// --- P: replaced free globals (invisible to the primordials ratchet) --------

print(
  'P1 ' +
    underPollution(
      ...poison(globalThis, 'Uint8Array', function () {
        return { length: 3 };
      }),
      () =>
        Array.from(new TextEncoder().encode('AB')).join(',') +
        '/' +
        JSON.stringify(new TextEncoder().encodeInto('ab', new RealU8(4))),
    ),
);

print(
  'P2 ' +
    underPollution(...poison(globalThis, 'ArrayBuffer', function () {}), () =>
      JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x42]).buffer)),
    ),
);

print(
  'P3 ' +
    underPollution(...poison(ArrayBuffer, 'isView', () => false), () =>
      JSON.stringify(
        new TextDecoder('windows-1252').decode(new DataView(new Uint8Array([0x41, 0x42]).buffer)),
      ),
    ),
);

print(
  'P4 ' +
    underPollution(
      ...poison(globalThis, 'TypeError', function Impostor(m) {
        this.name = 'PWNED';
        this.message = m;
      }),
      () => {
        const names = [];
        const grab = (fn) => {
          try {
            fn();
            names.push('no-throw');
          } catch (e) {
            names.push(e.name);
          }
        };
        grab(() => new TextDecoder().decode(123));
        grab(() => TextEncoder());
        grab(() => new TextEncoder().encodeInto('a', {}));
        grab(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])));
        return names.join(',');
      },
    ),
);

print(
  'P5 ' +
    underPollution(
      ...poison(globalThis, 'RangeError', function Impostor(m) {
        this.name = 'PWNED';
        this.message = m;
      }),
      () => {
        try {
          new TextDecoder('no-such-encoding');
          return 'no-throw';
        } catch (e) {
          return e.name;
        }
      },
    ),
);

print(
  'P6 ' +
    underPollution(
      ...poison(Object, 'defineProperty', function (o, k, d) {
        o[k] = d && d.value;
        return o;
      }),
      () => {
        const d = new TextDecoder('utf-16le');
        return d.encoding + '/' + d.fatal + '/' + d.decode(new Uint8Array([0x41, 0x00]));
      },
    ),
);

// --- Q: the >0x2000 chunked unitsToString branch ----------------------------

print('Q1 ' + bigDigest(new TextDecoder('windows-1252').decode(BIG_LATIN)));

// Q2 (a poisoned Function.prototype.apply on this branch) retired with H.

print(
  'Q3 ' +
    underPollution(...poison(Array.prototype, 'slice', () => ['P'.charCodeAt(0)]), () =>
      bigDigest(new TextDecoder('windows-1252').decode(BIG_LATIN)),
    ),
);

// --- R: what sits under the codecs -------------------------------------------

// R1/R2 (a replaced Buffer.prototype.toString / Buffer.from) have no page counterpart.

// The String global and String.prototype.toLowerCase, under the codecs.
print(
  'R3 ' +
    underPollution(
      ...poison(globalThis, 'String', () => 'PWNED'),
      () =>
        Array.from(new TextEncoder().encode('AB')).join(',') +
        '/' +
        JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0x42]))),
    ),
);

print(
  'R4 ' +
    underPollution(
      ...poison(String.prototype, 'toLowerCase', () => 'pwned'),
      () =>
        Array.from(new TextEncoder().encode('AB')).join(',') +
        '/' +
        JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0x42]))),
    ),
);

print(
  'R5 ' +
    underPollution(...poison(Object.prototype, 'utf8', 'hex'), () =>
      Array.from(new TextEncoder().encode('AB')).join(','),
    ),
);

// --- S: the accessor axis on the code-unit accumulator ----------------------
// An accessor at Array.prototype[0] intercepts a store into a plain array's
// index 0 — a strictly weaker primitive than replacing push, and invisible to
// the primordials ratchet. Only the decoder's own accumulator is exercised here;
// url.js still builds its percent-decode byte arrays on plain arrays.

print(
  'S ' +
    (() => {
      let intercepted = 0;
      Object.defineProperty(Array.prototype, 0, {
        configurable: true,
        get() {
          return 0x42;
        },
        set() {
          intercepted++;
        },
      });
      let out;
      try {
        out = [
          new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0x00, 0x42, 0x00])),
          new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x80])),
          new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0x42, 0x43])),
        ].join('|');
      } catch (e) {
        out = 'THREW:' + e.name;
      } finally {
        delete Array.prototype[0];
      }
      return out + ' intercepted=' + intercepted;
    })(),
);

// T: a poisoned %TypedArray%.prototype.buffer getter must not swap in an attacker's
// backing store, on the utf-16le and windows-1252 decode paths.
print(
  'T ' +
    (() => {
      const taProto = Object.getPrototypeOf(Uint8Array.prototype);
      const bufferDesc = Object.getOwnPropertyDescriptor(taProto, 'buffer');
      const forged = new Uint16Array([0x21, 0x21, 0x21, 0x21]).buffer; // "!!!!"
      Object.defineProperty(taProto, 'buffer', {
        configurable: true,
        get() {
          return forged;
        },
      });
      let out;
      try {
        out =
          new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0x00, 0x42, 0x00])) +
          '|' +
          new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x42]));
      } catch (e) {
        out = 'THREW:' + e.name;
      } finally {
        Object.defineProperty(taProto, 'buffer', bufferDesc);
      }
      return out;
    })(),
);

print('ok');

// U: the WINDOW accessors, not just the backing store. Poisoning
// %TypedArray%.prototype.byteOffset/byteLength (and .length, and DataView's own
// trio) must not move the range the decoder reads: the neighbouring bytes of the
// same ArrayBuffer must not leak into the result.
//
// The VIEWS ARE BUILT BEFORE THE POISON, and that ordering is the whole test.
// Constructed after, `new DataView(mine.buffer, mine.byteOffset, 4)` reads
// `byteOffset` through the poisoned getter and the TEST hands the decoder a view
// that genuinely covers pool bytes 0..4 — at which point both runtimes correctly
// decode a window the test mis-built, node printed `SECR` and Lava printed
// something else, and the only thing being compared was pool layout, which this
// repo has already established is not pinnable. Built before, the real window is
// baked into the engine slots and the poison can only reach what the DECODER
// computes, which is the thing under test.
print(
  'U ' +
    (() => {
      const shared = new TextEncoder().encode('SECRET-NEIGHBOUR-DATA-0123456789mine');
      const neighbour = shared.subarray(0, 32);
      const mine = shared.subarray(32);
      const asDataView = new DataView(mine.buffer, mine.byteOffset, 4);
      const asInt8 = new Int8Array(mine.buffer, mine.byteOffset, 4);
      const taProto = Object.getPrototypeOf(Uint8Array.prototype);
      // A LIST, not a Map keyed by `obj + name`. Building that key coerced the
      // receiver to a string, and `String(%TypedArray%.prototype)` calls
      // %TypedArray%.prototype.join on an incompatible receiver and throws — before
      // the first defineProperty ran. So nothing was ever poisoned, the catch below
      // swallowed the TypeError, and this case printed `THREW:TypeError` on BOTH
      // runtimes: byte-identical, and asserting nothing about the decoder. Each
      // (obj, name) is poisoned exactly once here, so insertion order restores
      // cleanly and no key is needed at all.
      const saved = [];
      const poison = (obj, name, value) => {
        saved.push([obj, name, Object.getOwnPropertyDescriptor(obj, name)]);
        Object.defineProperty(obj, name, { configurable: true, get: () => value });
      };
      let out;
      try {
        poison(taProto, 'byteOffset', 0);
        poison(taProto, 'byteLength', 64);
        poison(taProto, 'length', 64);
        poison(DataView.prototype, 'byteOffset', 0);
        poison(DataView.prototype, 'byteLength', 64);
        out = [
          new TextDecoder().decode(mine),
          new TextDecoder().decode(asDataView),
          new TextDecoder().decode(asInt8),
        ].join('|');
      } catch (e) {
        out = 'THREW:' + e.name;
      } finally {
        for (const [obj, name, desc] of saved) Object.defineProperty(obj, name, desc);
      }
      return out + ' (n=' + neighbour.length + ')';
    })(),
);

// W: the BRANDS, not the window. `toBytes` routed on `input instanceof
// Uint8Array/ArrayBuffer/DataView`, and every one of those dispatches through
// `Ctor[Symbol.hasInstance]` — a configurable own property of the constructor, so
// a caller flips the answer in EITHER direction and steers the input into the
// wrong arm.
//
// A browser's decoder is native and immune on all 24 cells. Lava diverged on six of
// them, and the two silent ones are the worse half: forging Uint8Array's or
// ArrayBuffer's brand to TRUE made `decode()` return "" for valid input — an empty
// decode, no error — while forging DataView's or ArrayBuffer's to false threw.
//
// Every cell is asserted rather than a chosen few: which cell diverges depends on
// arm ORDER inside toBytes, so a reordering that breaks a different cell must not
// slip through. Same lesson as the DataView brand in structured_clone.js — brand
// from the prototype chain, which an already-constructed object cannot re-point.
print(
  'W ' +
    (() => {
      const b = new TextEncoder().encode('xxxxmine').subarray(4);
      const inputs = [
        ['u8', () => new Uint8Array([0x68, 0x69])],
        ['ab', () => new Uint8Array([0x68, 0x69]).buffer],
        ['dv', () => new DataView(b.buffer, b.byteOffset, 4)],
        ['i8', () => new Int8Array(b.buffer, b.byteOffset, 4)],
      ];
      const cells = [];
      for (const ctorName of ['Uint8Array', 'ArrayBuffer', 'DataView']) {
        const C = globalThis[ctorName];
        const had = Object.getOwnPropertyDescriptor(C, Symbol.hasInstance);
        for (const forged of [false, true]) {
          for (const [vname, make] of inputs) {
            const v = make();
            let out;
            try {
              Object.defineProperty(C, Symbol.hasInstance, {
                value: () => forged,
                configurable: true,
              });
              out = new TextDecoder().decode(v);
            } catch (e) {
              out = 'THREW:' + e.name;
            } finally {
              if (had) Object.defineProperty(C, Symbol.hasInstance, had);
              else delete C[Symbol.hasInstance];
            }
            cells.push(ctorName[0] + (forged ? 'T' : 'F') + vname + '=' + out);
          }
        }
      }
      return cells.join(' ');
    })(),
);
