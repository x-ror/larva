// node:fs — a thin JS layer over the Odin-backed primitives.
//
// WHY THIS FILE EXISTS. Until now `node:fs` was assembled natively in require.odin and
// was the one built-in with no JS layer at all (ARCHITECTURE.md §3.4 names it the
// native-direct outlier). That cost a Node-contract bug that survived a year: the read
// primitives hand back whatever `make_uint8_array` produced — a plain `Uint8Array` — where
// node returns a **Buffer**. The bytes were always right; only the prototype was wrong,
// and the failure mode is the bad one. `Uint8Array.prototype.toString` ignores its
// argument, so `fs.readFileSync(p).toString('hex')` returned `"116,121"` instead of
// `"7479"`: plausible-looking output, no throw.
//
// Tagging belongs here rather than in the native. The native would have to hold a
// protected `Buffer.prototype` per context and sweep it from destroy_runtime_state like
// every other JSC-handle cache (CLAUDE.md §4); in JS it is one `Buffer.from` over the same
// backing store. See issue #329, and #242 for the rest of the normalization this layer
// makes possible (writeFile encoding/flag/mode, SharedArrayBuffer views, a real DataView
// brand check).
//
// ZERO COPY. `Buffer.from(arrayBuffer, byteOffset, length)` shares memory by spec — it
// does NOT copy, verified on node 26.13.0 and here (mutating the Buffer is visible through
// the original view). A copy would be a per-file-size regression on the hottest fs call
// there is, and CLAUDE.md ranks memory second only to conformance.
//
// Everything else is re-exported by identity: same function objects the native branch
// installed, so nothing about the other 13 entry points changes.
(function (require, module, exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var TypeErrorG = P.TypeError;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;

  // `Buffer` is a module export, not an intrinsic, so it is not in the primordials table —
  // and it must NOT be captured here. This module is LAZY: its factory runs on the user's
  // first require('fs'), so a capture at this line reads whatever `require('buffer')`
  // holds by then, and that is the same mutable object user code holds. A dependency's
  // top-level `require('buffer').Buffer = shim` would then steer, and disclose, every
  // later fs read. An earlier revision did exactly that and justified it with "buffer.js
  // is eager-loaded" — true of the MODULE, not of this capture.
  //
  // loader.js snapshots Buffer right after it instantiates the module, where the ordering
  // is provable, and hands it to every internal module as `require.pristineBuffer`. This
  // used to arrive through fs's own `natives` object; unified so there is ONE mechanism —
  // http.js, net.js, https.js and os.js all needed the same thing (#333).
  var PristineBuffer = require.pristineBuffer;
  var BufferFrom = PristineBuffer.from;
  var BufferIsEncoding = PristineBuffer.isEncoding;
  var BufferPrototypeToString = PristineBuffer.bufferToString;

  // Node renders the offending value with util.inspect in BOTH templates, so a string
  // comes out quoted and everything else bare. Verified against node 26.13.0 (probe,
  // 2026-11-16):
  //   'bogus' -> 'bogus'     123 -> 123        true -> true      1n -> 1n
  //   {}      -> {}          {a:1} -> { a: 1 } [] -> []         Symbol(x) -> Symbol(x)
  // An earlier version of this quoted everything, which was wrong for every non-string.
  // NOT matched: node renders a null-prototype object as `[Object: null prototype] {}`
  // where Lava's inspect gives `{}` — a util.inspect gap, listed in #331, so this line
  // does not claim parity for it.
  //
  // Memoized on first use. `util` is not eager-loaded (instantiating it costs ~3.5 ms of
  // startup for a string only ever built when a call is already failing), so this cannot
  // get the loader-time guarantee the Buffer capture above has. The residual is bounded to
  // MESSAGE TEXT — no file bytes flow through it — and reading it live per call, as an
  // earlier revision did, was strictly worse. Tracked with the other live-module captures
  // (http.js, net.js, stream.js, https.js, os.js all have the same shape).
  var inspectFn = null;
  function inspectValue(value) {
    if (inspectFn === null) inspectFn = require('util').inspect;
    return inspectFn(value);
  }

  // Node's ERR_INVALID_ARG_TYPE "Received" clause has THREE branches, not two
  // (determineSpecificType). Measured on node 26.13.0 (probe, 2026-11-16):
  //   null / undefined      -> named bare:            Received null
  //   an object             -> its constructor:       Received an instance of Object
  //                            (Array, Date, RegExp, Map, Buffer, a user class …;
  //                             a null-prototype object has no constructor and falls
  //                             back to the inspected form)
  //   anything else         -> type + inspected:      Received type number (123)
  //                            with a string longer than 28 chars cut to its first 25
  //                            plus "..." BEFORE inspecting.
  // An earlier revision implemented only the first and third and asserted in this comment
  // that they were the whole rule. The object branch is the reachable one: it is what
  // `fs.readFile(path, {encoding:'utf8'})` with a forgotten callback produces.
  var RECEIVED_STR_MAX = 25;
  function received(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
      // node's determineSpecificType reads the RECEIVER's own `.constructor.name` for this
      // message, so reading it is what parity requires — a captured getter would answer for
      // the wrong object. A forged constructor changes the text of an error already being
      // thrown, nothing else.
      var ctor = value.constructor; // primordials-ok: accessor
      if (typeof ctor === 'function' && ctor.name) return 'an instance of ' + ctor.name;
      return inspectValue(value);
    }
    var shown = value;
    if (typeof shown === 'string' && shown.length > RECEIVED_STR_MAX + 3) {
      shown = StringPrototypeSlice(shown, 0, RECEIVED_STR_MAX) + '...';
    }
    return 'type ' + typeof value + ' (' + inspectValue(shown) + ')';
  }

  function errInvalidArgType(message) {
    var err = new TypeErrorG(message);
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  /**
   * Re-tags a native read result as a Buffer, sharing its backing store.
   * @param {*} value Whatever the native returned — a Uint8Array for a binary read, a
   *                  string when an encoding was supplied, or an error/undefined.
   * @returns {*} A Buffer for the Uint8Array case; `value` untouched otherwise.
   * @node readFileSync/readFile return a Buffer with no encoding and a string with one
   *       (verified on node 26.13.0, including `{encoding: null}` -> Buffer).
   * @deviates none
   */
  function asBuffer(value) {
    // A string (an encoding was supplied) or a non-view passes straight through: the
    // native decides which shape to return, and this layer must not second-guess it.
    if (typeof value !== 'object' || value === null) return value;
    // Read the window through the captured getters rather than `.buffer`/`.byteOffset`
    // (§5's accessor class). The value comes from our own native here, so this is
    // belt-and-braces — but the same helper is where #242's user-supplied views will
    // land, and a live read there is the exact bug fixed in #326 (6c63c33).
    return BufferFrom(
      TypedArrayPrototypeGetBuffer(value),
      TypedArrayPrototypeGetByteOffset(value),
      TypedArrayPrototypeGetByteLength(value),
    );
  }

  /**
   * Rejects a `path` node would reject.
   * @param {*} path
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — anything but a string, a Buffer/Uint8Array
   *         or a URL.
   * @node Message verified on node 26.13.0: `The "path" argument must be of type string
   *       or an instance of Buffer or URL. Received an instance of Object`.
   * @deviates Two values are accepted here that the native then mishandles, because
   *       rejecting them would be a NEW divergence: a `file:` URL is stringified rather
   *       than resolved (ENOENT where node reads the file), and a number is a file
   *       DESCRIPTOR on node (`readFileSync(123)` -> EBADF) but reaches the native as the
   *       filename "123". Both pre-date this layer; tracked as #334, together with
   *       `options.signal`/`flag` being accepted and ignored.
   */
  function validatePath(path) {
    if (typeof path === 'string') return;
    // A NUMBER is a file descriptor, not a bad path — node's readFileSync(fd) is a
    // documented form (`readFileSync(123)` gives EBADF, not ERR_INVALID_ARG_TYPE).
    // Rejecting it here would have been a new divergence in the validation added to
    // remove one; it is passed through unchanged. See @deviates.
    if (typeof path === 'number') return;
    if (typeof path === 'object' && path !== null) {
      // A Buffer is a Uint8Array; URL is matched structurally rather than by identity so a
      // realm-crossing URL still passes, as it does on node.
      if (ArrayBufferIsView(path)) return;
      // Same reason, plus `instanceof URL` is forgeable through Symbol.hasInstance and
      // would not survive a realm crossing. Worst case a forged `constructor.name` gets a
      // bogus value PAST validation, where the native then fails it as an ordinary bad
      // path — the pre-validation behavior, not a new hole.
      var ctor = path.constructor; // primordials-ok: accessor
      if (typeof ctor === 'function' && ctor.name === 'URL') return;
    }
    throw errInvalidArgType(
      'The "path" argument must be of type string or an instance of Buffer or URL. ' +
        'Received ' +
        received(path),
    );
  }

  /**
   * Extracts and validates the encoding from a read `options` argument.
   * @param {string|{encoding?: string|null}|null|undefined} options
   * @returns {string|null} The encoding name, or null for a binary (Buffer) read.
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — options is neither a string nor an object.
   * @throws {TypeError} ERR_INVALID_ARG_VALUE — the encoding name is not recognized.
   * @node Messages verified against node 26.13.0:
   *       `readFileSync(p, 123)` -> 'The "options" argument must be one of type string or
   *       object. Received type number (123)'; `readFileSync(p, 'bogus')` -> "The argument
   *       'encoding' is invalid encoding. Received 'bogus'". `{}`, `null` and `undefined`
   *       all mean binary.
   * @deviates none
   */
  function readEncoding(options) {
    // node's getOptions treats null, undefined AND a function as "no options" — a callback
    // sitting in the options slot is not an error, and neither is an array (it takes the
    // object branch and has no `.encoding`). Verified: readFileSync(p, function(){}) and
    // readFileSync(p, []) both return a Buffer on node 26.13.0.
    if (options === null || options === undefined || typeof options === 'function') {
      return null;
    }
    var encoding;
    if (typeof options === 'string') {
      encoding = options;
    } else if (typeof options === 'object') {
      encoding = options.encoding;
    } else {
      throw errInvalidArgType(
        'The "options" argument must be one of type string or object. Received ' +
          received(options),
      );
    }
    // EVERY falsy encoding means binary, not just null/undefined: node's assertEncoding is
    // guarded `if (encoding && !Buffer.isEncoding(encoding))`, and readFileSync returns
    // `options.encoding ? buffer.toString(...) : buffer`. So '', false, 0 and NaN all hand
    // back a Buffer. An earlier revision here short-circuited on null/undefined only and
    // threw for the rest — which broke code that used to work, since the pre-JS-layer
    // native treated a non-string encoding as binary and returned data.
    if (!encoding) return null;
    // 'buffer' is node's documented "give me a Buffer" spelling for readdir/readlink, so
    // getOptions skips validation for it and lets it reach Buffer#toString, which throws
    // ERR_UNKNOWN_ENCODING rather than ERR_INVALID_ARG_VALUE. Different code AND message,
    // on a name that legitimately appears in shared option objects.
    if (encoding !== 'buffer' && !BufferIsEncoding(encoding)) {
      var e2 = new TypeErrorG(
        "The argument 'encoding' is invalid encoding. Received " + inspectValue(encoding),
      );
      e2.code = 'ERR_INVALID_ARG_VALUE';
      throw e2;
    }
    return encoding;
  }

  // Decoding happens HERE, not in the native, and that is the point of routing reads
  // through this layer at all. The native ignored the encoding argument outright — it
  // decoded everything as UTF-8, so `readFileSync(p, 'hex')` returned the file's text
  // instead of its hex — and its UTF-8 conversion returned an EMPTY STRING for input it
  // could not decode, where node substitutes U+FFFD. Buffer's codecs already handle every
  // encoding node accepts, lossily and correctly, and are covered by the buffer oracle
  // cases; asking the native for bytes and decoding here reuses all of that and deletes
  // the second implementation rather than fixing it twice.
  function decode(bytes, encoding) {
    var buf = asBuffer(bytes);
    return encoding === null ? buf : BufferPrototypeToString(buf, encoding);
  }

  /**
   * Reads `path` synchronously.
   * @param {string|Buffer|URL} path
   * @param {string|{encoding?: string|null}|null} [options] An encoding name, or an object
   *        carrying one. Every FALSY encoding (and a function, and an array) means binary.
   * @returns {Buffer|string} A Buffer when no encoding applies, else the decoded string.
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — path is not a string/Buffer/URL, or options
   *         is neither a string nor an object.
   * @throws {TypeError} ERR_INVALID_ARG_VALUE — the encoding name is not recognized.
   * @throws {TypeError} ERR_UNKNOWN_ENCODING — the name is `'buffer'`, which node lets
   *         through validation so Buffer#toString rejects it.
   * @node Returns a Buffer, not a bare Uint8Array; decoding is lossy for invalid UTF-8
   *       (U+FFFD), never `""`. Verified against node 26.13.0.
   * @deviates A `file:` URL path is not resolved — it reaches the native as its string
   *       form and fails ENOENT where node reads the file. Pre-existing; see the fs entry
   *       in ROADMAP.
   */
  function readFileSync(path, options) {
    validatePath(path);
    var encoding = readEncoding(options);
    // Always ask the native for BYTES. It has no string path any more (the encoding-aware
    // branch was deleted in this change, not merely bypassed), and decoding lives in
    // decode() above.
    return decode(native.readFileSync(path), encoding);
  }

  /**
   * Reads `path`, delivering the result to `callback`.
   * @param {string|Buffer|URL} path
   * @param {string|{encoding?: string|null}|null|Function} [options] Omitted when the
   *        callback is passed in this position.
   * @param {(err: Error|null, data: Buffer|string) => void} callback
   * @returns {undefined}
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — cb is not a function. Validated BEFORE the
   *         options, and against `callback || options`, so `readFile(p, 'bogus')` reports
   *         the STRING as the bad callback rather than complaining about the encoding.
   *         Verified on node 26.13.0; the reverse order would report a plausible but
   *         different error for the commonest mistake there is, a forgotten callback.
   * @throws {TypeError} Both encoding errors above, thrown SYNCHRONOUSLY — they do not
   *         surface in the callback.
   * @node The callback receives a Buffer with no encoding and a string with one.
   * @deviates none
   */
  function readFile(path, options, callback) {
    var cb = callback || options;
    if (typeof cb !== 'function') {
      throw errInvalidArgType(
        'The "cb" argument must be of type function. Received ' + received(cb),
      );
    }
    validatePath(path);
    var encoding = readEncoding(typeof options === 'function' ? null : options);
    return native.readFile(path, function (err, data) {
      // ONE argument on the error path, as node does (`callback(err)`). The native's
      // completion always builds a 2-slot argument array, so calling `cb(err, data)` here
      // made `arguments.length` 2 where node reports 1 — visible to any rest-parameter or
      // arity check in user code.
      if (err) {
        cb(err);
        return;
      }
      cb(null, decode(data, encoding));
    });
  }

  exports.readFileSync = readFileSync;
  exports.readFile = readFile;

  // The remaining primitives are re-exported by identity — same function objects, so
  // `.name`, `.length` and object identity are whatever the native installed, exactly as
  // before this layer existed. Listed explicitly rather than copied in a loop so adding a
  // native without deciding whether it needs normalization is a visible edit here.
  var PASSTHROUGH = [
    'writeFile',
    'writeFileSync',
    'openSync',
    'closeSync',
    'existsSync',
    'mkdirSync',
    'mkdtempSync',
    'rmSync',
    'rmdirSync',
    'unlinkSync',
    'renameSync',
    'statSync',
    'readdirSync',
  ];
  for (var i = 0; i < PASSTHROUGH.length; i++) {
    var name = PASSTHROUGH[i];
    // Plain assignment, not a copied descriptor: the native installs these as ordinary
    // writable/enumerable/configurable properties and node's fs exports are the same.
    exports[name] = native[name];
  }

  // `fs.promises` is deliberately NOT defined here. It is missing either way, and a
  // throwing getter would be worse than the absence: `if (fs.promises)` is ordinary
  // feature detection, and it must stay falsy rather than throw.
  //
  // exports is left mutable — node's fs module is not frozen, and monkey-patching it
  // (test doubles, instrumentation) is common enough in the ecosystem that freezing
  // would itself be a deviation.
  module.exports = exports;
});
