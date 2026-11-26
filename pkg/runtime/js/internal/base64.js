/**
 * @fileoverview atob/btoa, the HTML forgiving-base64 pair — node keeps them in
 * lib/buffer.js. Re-exported from node:buffer (`buffer.atob === atob`, as in node), and
 * installs the `atob`/`btoa` globals itself, right after internal/file.js installs
 * `File`, so the Window surface has them without a node/ module.
 *
 * Instantiated eagerly: node/buffer.js requires it at its top level, before user code
 * runs, so the module-eval captures below are pristine (the loader also names it as a
 * root of its own).
 *
 * The codec is still Buffer's. A top-level `require('buffer')` would be a cycle
 * (node/buffer.js requires this file), so each call reads the constructor off the
 * loader's pristine table — `require.pristineBuffer.Buffer`, the very object node/buffer.js
 * binds as `Buffer`, attached before user code — and reads `.from` off it LIVE, as it did
 * when this code lived in node/buffer.js: node's btoa reads `Buffer.from` the same way,
 * so a replaced `Buffer.from` steers both runtimes alike.
 *
 * @module lava/internal/base64
 */

(function (require, module, _exports) {
  'use strict';

  var P = require('internal/primordials');
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var ERR_MISSING_ARGS = require('internal/errors').ERR_MISSING_ARGS;

  // Node throws a DOMException here; Lava has no DOMException (same gap as
  // structured_clone.js's DataCloneError), so this is an Error carrying the
  // DOMException's name and legacy numeric code.
  function errInvalidCharacter(message) {
    var e = new Error(message);
    e.name = 'InvalidCharacterError';
    e.code = 5;
    return e;
  }

  // One native regex scan instead of a per-char StringPrototypeCharCodeAt loop
  // (~63 ns/char through the caller1 wrapper). 200 btoa calls on 48 KiB of latin1
  // took 615 ms that way and 89 ms with the regex; 200 atob calls on 64 KiB of
  // base64, 2542 vs 1579 ms (medians of 5 interleaved launches per arm, darwin
  // arm64, -o:speed). Most of what is left is the Buffer round trip, not this
  // check. Non-global, so RegExpMatches never touches lastIndex (§5).
  // ATOB_SLOW_RE matches anything the fast path cannot take as-is: whitespace or a
  // non-alphabet character, a '=' followed by anything but '=', or three '='; atob
  // then falls back to the exact per-char loop, so error selection and messages
  // are unchanged.
  var ATOB_SLOW_RE = /[^A-Za-z0-9+/=]|=[^=]|===/;
  var NON_LATIN1_RE = /[^\u0000-\u00ff]/;

  /**
   * Base64 → latin1 per the HTML forgiving-base64 decode (global atob and node:buffer's
   * atob are the same function, as in Node).
   * @param {*} input Stringified with a template literal, like Node (`${input}`).
   * @returns {string}
   * @throws {TypeError} ERR_MISSING_ARGS — called with no argument.
   * @throws {Error} name InvalidCharacterError, code 5 — a character outside
   *         A-Za-z0-9+/= and ASCII whitespace, '=' not at the end or more than two,
   *         '=' when the length is not a multiple of 4, or a lone trailing character.
   * @node Mirrors lib/buffer.js atob: whitespace is TAB LF FF CR SPACE (not VT); the
   *       messages are 'Invalid character' and 'The string to be decoded is not
   *       correctly encoded.' (node 26.13.0, tests/node-compat/cases/03-buffer.js).
   * @deviates The error is an Error, not a DOMException (Lava has none); name, code
   *           and message match. Pinned by cmd/lava/atob_invalid_character_test.odin.
   */
  function atob(input) {
    if (arguments.length === 0) throw ERR_MISSING_ARGS('input');
    input = `${input}`;
    var nonWhitespace = 0;
    var equals = 0;
    if (!P.RegExpMatches(ATOB_SLOW_RE, input)) {
      // Fast path: only alphabet characters and at most two trailing '='. The
      // remainder rules below still apply.
      nonWhitespace = input.length;
      if (nonWhitespace > 0 && StringPrototypeCharCodeAt(input, nonWhitespace - 1) === 0x3d) {
        equals = 1;
        if (nonWhitespace > 1 && StringPrototypeCharCodeAt(input, nonWhitespace - 2) === 0x3d)
          equals = 2;
      }
    } else
      for (var i = 0; i < input.length; i++) {
        var c = StringPrototypeCharCodeAt(input, i);
        if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20) continue;
        var alnum =
          (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
        if (!alnum && c !== 0x2b && c !== 0x2f && c !== 0x3d)
          throw errInvalidCharacter('Invalid character');
        nonWhitespace++;
        if (c === 0x3d) equals++;
        else if (equals) throw errInvalidCharacter('Invalid character'); // '=' only at the end
        if (equals > 2) throw errInvalidCharacter('Invalid character');
      }
    // The lone-trailing-character test runs on the length WITHOUT the '=' and wins
    // over the padding test: node 26.13.0 answers 'not correctly encoded' for 'a=',
    // 'a==' and 'abcde=', and 'Invalid character' for 'ab=', 'abc==' and 'Zm9v='
    // (probed; pinned by tests/node-compat/cases/03-buffer.js).
    if ((nonWhitespace - equals) % 4 === 1)
      throw errInvalidCharacter('The string to be decoded is not correctly encoded.');
    if (equals && nonWhitespace % 4) throw errInvalidCharacter('Invalid character');
    var Buffer = require.pristineBuffer.Buffer;
    return Buffer.from(input, 'base64').toString('latin1');
  }

  /**
   * latin1 → Base64 (global btoa and node:buffer's btoa are the same function).
   * @param {*} input Stringified with a template literal, like Node.
   * @returns {string}
   * @throws {TypeError} ERR_MISSING_ARGS — called with no argument.
   * @throws {Error} name InvalidCharacterError, code 5 — a code unit above 0xFF.
   * @node lib/buffer.js btoa (node 26.13.0, tests/node-compat/cases/03-buffer.js).
   * @deviates Not a DOMException, as for atob; pinned by
   *           cmd/lava/atob_invalid_character_test.odin.
   */
  function btoa(input) {
    if (arguments.length === 0) throw ERR_MISSING_ARGS('input');
    input = `${input}`;
    if (P.RegExpMatches(NON_LATIN1_RE, input)) throw errInvalidCharacter('Invalid character');
    var Buffer = require.pristineBuffer.Buffer;
    return Buffer.from(input, 'latin1').toString('base64');
  }

  if (globalThis.atob === undefined) {
    globalThis.atob = atob;
  }
  if (globalThis.btoa === undefined) {
    globalThis.btoa = btoa;
  }

  module.exports = { atob: atob, btoa: btoa };
});
