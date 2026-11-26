// URL construction must survive a poisoned Array/String prototype and a poisoned
// Object.prototype or RegExp.prototype.exec: a browser's parser is native and
// immune, Lava's is JS routed through primordials and module-eval captures, so both
// must produce the correct URL. Each vector poisons one axis, runs one URL
// operation, restores, then prints. Ported from
// tests/node-compat/cases/54-url-pollution.js; its fileURLToPath vectors (E, X2) are
// Node-only, and a throw prints its name rather than its message.
//
// Each vector below is one that DID corrupt Lava before the url.js hardening:
//   A  Array.prototype.slice   -> relative-URL base path was mis-resolved
//   B  Array.prototype.at      -> IPv4 normalization silently disabled
//   C  String.prototype.normalize -> host substituted by the attacker
//   F  String.prototype.toLowerCase -> dot-segment removal skipped
//   G  Object.prototype[key]   -> a real port silently dropped

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

print(
  'A ' +
    underPollution(
      (s) => {
        s.v = Array.prototype.slice;
        Array.prototype.slice = () => ['PWNED'];
      },
      (s) => {
        Array.prototype.slice = s.v;
      },
      () => new URL('c/d', 'http://a.b/x/y/z').href,
    ),
);

print(
  'B ' +
    underPollution(
      (s) => {
        s.v = Array.prototype.at;
        Array.prototype.at = () => 'ZZZ';
      },
      (s) => {
        Array.prototype.at = s.v;
      },
      () => new URL('http://0300.0250.0.1/').href,
    ),
);

print(
  'C ' +
    underPollution(
      (s) => {
        s.v = String.prototype.normalize;
        String.prototype.normalize = () => 'evil.example';
      },
      (s) => {
        String.prototype.normalize = s.v;
      },
      () => new URL('http://über.example/').href,
    ),
);

print(
  'F ' +
    underPollution(
      (s) => {
        s.v = String.prototype.toLowerCase;
        String.prototype.toLowerCase = () => 'evil';
      },
      (s) => {
        String.prototype.toLowerCase = s.v;
      },
      () => new URL('http://example.com/a/../b').href,
    ),
);

print(
  'G ' +
    underPollution(
      () => {
        Object.prototype.foo = 8080;
      },
      () => {
        delete Object.prototype.foo;
      },
      () => new URL('foo://h:8080/p').href,
    ),
);

// --- RegExp.prototype.exec, the validator carrier -------------------------
//
// `RegExp.prototype.exec` is a writable data property, and the spec's RegExpExec
// abstract operation re-reads it off the RECEIVER before falling back to the
// builtin — so a plain assignment steers `re.test(...)` too, including a `test`
// captured pristine at module-eval. url.js's host and path validators are
// therefore only sound if they never route through a live regex method at all.
//
// A browser's URL is native and immune, so these are true differential vectors.
//
// The hosts here are lowercase or numeric ON PURPOSE. An uppercase host reaches
// `domainToASCII`, whose `/[。．｡]/g` replaceAll is a GLOBAL regex — a forged
// non-empty match never advances lastIndex, so it spins instead of answering.
// That residue is real, is on the network path, and is tracked in ROADMAP; a
// vector that hangs would pin nothing here.
const poisonExec = [
  (s) => {
    s.exec = RegExp.prototype.exec;
    const forged = ['forged'];
    forged.index = 0;
    forged.input = '';
    RegExp.prototype.exec = function () {
      return forged;
    };
  },
  (s) => {
    RegExp.prototype.exec = s.exec;
  },
];

// X1: `endsInANumber` decides whether a host is parsed as IPv4. Steered true,
// '4x' reads as numeric and parseInt('4x', 10) is 4, so the host silently becomes
// http://1.2.3.4/ — a host SUBSTITUTION, the same class as the constructor vector
// above.
print('X1 ' + underPollution(...poisonExec, () => new URL('http://1.2.3.4x/').href));

// X3: parseIPv4Number's radix validation — octal and dotted-quad shapes, where a
// steered digit check would accept a non-numeric label or reject a valid one.
print('X3 ' + underPollution(...poisonExec, () => new URL('http://0300.0250.0.1/').href));
print('X4 ' + underPollution(...poisonExec, () => new URL('http://1.2.3.4/').href));

// X5: relative resolution, which walks the leading-slash and tab/newline guards.
print('X5 ' + underPollution(...poisonExec, () => new URL('/a', 'http://h/b').href));

print('ok');
