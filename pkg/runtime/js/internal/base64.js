/**
 * @fileoverview atob/btoa, the HTML forgiving-base64 pair. Installs the `atob`/`btoa`
 * globals itself, right after internal/file.js installs `File`.
 *
 * Instantiated eagerly by the loader, before page code runs, so the module-eval
 * captures below are pristine. The codec is the buffer natives (`natives`, the codec
 * bindings globals.odin hands this file).
 *
 * @module lava/internal/base64
 */

(function (require, module, _exports, natives) {
  'use strict';

  var P = require('internal/primordials');
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var DOMException = require('internal/domexception').DOMException;
  var webErrors = require('internal/web_errors');
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;
  var pageError = webErrors.pageError;
  // Captured at module-eval, so a page cannot steer them.
  var base64DecodeNative = natives.base64Decode;
  var base64EncodeNative = natives.base64Encode;
  var latin1EncodeNative = natives.latin1Encode;
  var latin1DecodeNative = natives.latin1Decode;
  var StringFromCharCode = String.fromCharCode;
  var StringPrototypeSlice = P.StringPrototypeSlice;

  // An InvalidCharacterError DOMException (legacy code 5), with Chrome's one sentence
  // per function for every reason (tests/web/cases/base64-errors.expected).
  function errInvalidCharacter(op) {
    var message =
      context('Window', op) +
      (op === 'btoa'
        ? 'The string to be encoded contains characters outside of the Latin1 range.'
        : 'The string to be decoded is not correctly encoded.');
    return pageError(new DOMException(message, 'InvalidCharacterError'));
  }

  // The argument check and DOMString conversion both share: Chrome's arity TypeError
  // and Symbol refusal.
  function toInput(args, op) {
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
   * Base64 → latin1 per the HTML forgiving-base64 decode.
   * @param {*} input A DOMString.
   * @returns {string}
   * @throws {TypeError} called with no argument, or a Symbol.
   * @throws {DOMException} InvalidCharacterError (5) — a character outside
   *         A-Za-z0-9+/= and ASCII whitespace, '=' not at the end or more than two,
   *         '=' when the length is not a multiple of 4, or a lone trailing character.
   * @node Whitespace is TAB LF FF CR SPACE (not VT). Chrome 158's one message for every
   *       decode failure and its WebIDL TypeErrors, tests/web/cases/base64-errors.expected.
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
        if (!alnum && c !== 0x2b && c !== 0x2f && c !== 0x3d) throw errInvalidCharacter('atob');
        nonWhitespace++;
        if (c === 0x3d) equals++;
        else if (equals) throw errInvalidCharacter('atob'); // '=' only at the end
        if (equals > 2) throw errInvalidCharacter('atob');
      }
    // The lone-trailing-character test runs on the length WITHOUT the '='.
    if ((nonWhitespace - equals) % 4 === 1) throw errInvalidCharacter('atob');
    if (equals && nonWhitespace % 4) throw errInvalidCharacter('atob');
    return latin1DecodeNative(
      base64DecodeNative(canonicalBase64(input, nonWhitespace === input.length)),
    );
  }

  /**
   * latin1 → Base64.
   * @param {*} input A DOMString.
   * @returns {string}
   * @throws {TypeError} called with no argument, or a Symbol.
   * @throws {DOMException} InvalidCharacterError (5) — a code unit above 0xFF.
   * @node As for atob (tests/web/cases/base64-errors.expected).
   * @deviates none
   */
  function btoa(input) {
    input = toInput(arguments, 'btoa');
    if (P.RegExpMatches(NON_LATIN1_RE, input)) throw errInvalidCharacter('btoa');
    return base64EncodeNative(latin1EncodeNative(input));
  }

  // The padded, whitespace-free form base64Decode requires (buffer.odin: anything else
  // decodes to nothing) of an input atob already validated: alphabet characters, then
  // at most two '='. `noWhitespace` lets an input with nothing to strip skip the
  // per-character pass; the '=' are dropped and the padding rebuilt either way, since
  // forgiving-base64 accepts the unpadded form.
  function canonicalBase64(input, noWhitespace) {
    var out = '';
    if (noWhitespace) {
      out = input;
      while (out.length > 0 && StringPrototypeCharCodeAt(out, out.length - 1) === 0x3d) {
        out = StringPrototypeSlice(out, 0, out.length - 1);
      }
    } else {
      for (var i = 0; i < input.length; i++) {
        var c = StringPrototypeCharCodeAt(input, i);
        if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20 || c === 0x3d) {
          continue;
        }
        out += StringFromCharCode(c);
      }
    }
    while (out.length % 4 !== 0) {
      out += '=';
    }
    return out;
  }

  // The globals a page sees: internal/native_shape's operations around these two
  // (native toString, no `prototype`, length 1; tests/web/cases/shape-operations).
  var nativeShape = require('internal/native_shape');
  module.exports = {
    atob: nativeShape.defineOperation('atob', atob, 1),
    btoa: nativeShape.defineOperation('btoa', btoa, 1),
  };
});
