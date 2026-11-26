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
  var DOMException = require('internal/domexception').DOMException;
  var webErrors = require('internal/web_errors');
  var web = webErrors.web;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;
  var pageError = webErrors.pageError;

  // An InvalidCharacterError DOMException (legacy code 5) on both surfaces — node's and
  // Chrome's shape alike. `nodeMessage` is node's text, which tells the bad-character
  // and bad-length cases apart; Chrome has one sentence per function for every reason
  // (tests/web/cases/base64-errors.expected). `op` defaults to atob, whose call sites
  // pass node's text alone.
  function errInvalidCharacter(nodeMessage, op) {
    if (op === undefined) {
      op = 'atob';
    }

    var message = nodeMessage;
    if (web) {
      message =
        context('Window', op) +
        (op === 'btoa'
          ? 'The string to be encoded contains characters outside of the Latin1 range.'
          : 'The string to be decoded is not correctly encoded.');
    }

    return pageError(new DOMException(message, 'InvalidCharacterError'));
  }

  // The argument check and DOMString conversion both share: Chrome's arity TypeError
  // and Symbol refusal on the Window surface, node's ERR_MISSING_ARGS and a template
  // literal (whose own TypeError a Symbol raises) on the Node one.
  function toInput(args, op) {
    if (!web) {
      if (args.length === 0) {
        throw ERR_MISSING_ARGS('input');
      }

      return `${args[0]}`;
    }

    if (args.length === 0) {
      throw typeError('Window', op, argumentsRequired(1, 0));
    }

    return toDOMString(args[0], 'Window', op);
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
   * @throws {TypeError} called with no argument (node: ERR_MISSING_ARGS), or a Symbol.
   * @throws {DOMException} InvalidCharacterError (5) — a character outside
   *         A-Za-z0-9+/= and ASCII whitespace, '=' not at the end or more than two,
   *         '=' when the length is not a multiple of 4, or a lone trailing character.
   * @node Mirrors lib/buffer.js atob: whitespace is TAB LF FF CR SPACE (not VT); node's
   *       messages are 'Invalid character' and 'The string to be decoded is not
   *       correctly encoded.' (node 26.13.0, tests/node-compat/cases/03-buffer.js).
   *       Window surface: Chrome 158's one message for every decode failure and its
   *       WebIDL TypeErrors, tests/web/cases/base64-errors.expected.
   * @deviates none
   */
  function atob(input) {
    input = toInput(arguments, 'atob');
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
   * @throws {TypeError} called with no argument (node: ERR_MISSING_ARGS), or a Symbol.
   * @throws {DOMException} InvalidCharacterError (5) — a code unit above 0xFF.
   * @node lib/buffer.js btoa (node 26.13.0, tests/node-compat/cases/03-buffer.js);
   *       Window surface as for atob.
   * @deviates none
   */
  function btoa(input) {
    input = toInput(arguments, 'btoa');
    if (P.RegExpMatches(NON_LATIN1_RE, input))
      throw errInvalidCharacter('Invalid character', 'btoa');
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
