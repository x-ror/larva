// internal/url — the URL Standard parser (percent-encoding, host/IPv4/IPv6, the state
// machine), `URL` and `URLSearchParams`. The IDNA mapping and its Punycode codec are
// internal/idna and internal/punycode (node's lib/internal/idna.js); they throw
// nothing, so the host parser that calls them stays here with every throw it
// feeds, and no frame leaves node:internal/url. Implemented in JS (as Node does for
// the parsing-heavy modules like node:path) so the fiddly state-machine semantics
// match the URL Standard and Node byte-for-byte. JavaScriptCore's bare engine ships
// no URL/URLSearchParams (those are WebCore APIs), so the whole surface lives here.
//
// node/url.js stays the public entry: it keeps `pathToFileURL` and `format`, whose
// throws node frames in `node:url`, and assembles the exports. The `URL`/
// `URLSearchParams` globals are installed HERE, at the end of module-eval, so the
// Window surface gets them without a node/ module: the loader instantiates this file
// at the slot node/url.js held (node/url.js requires it first thing on the Node
// surface), so the install order is unchanged. Everything thrown from this file frames
// `node:internal/url`, as node's does (pinned by
// tests/node-compat/cases/87-url-internal-modules.js). Not publicly requireable.
//
// The documented IDNA deviation (UTS-46 approximated, not the full ICU mapping) is
// stated where the mapping lives, in internal/idna.js.
(function (require, module, _exports) {
  'use strict';

  // --- Pollution-safe intrinsics -------------------------------------------
  // URL parsing runs on attacker-influenced strings while user code may have
  // poisoned shared prototypes/globals. Prototype methods route through the
  // pristine primordials table; free globals and statics are captured HERE, at
  // module-eval, which the loader runs before any user code — so these bindings
  // are pristine and cannot be re-pointed later (a poisoned Math.floor, String,
  // decodeURIComponent, or String.prototype.normalize otherwise silently
  // substitutes hosts / disables IPv4 normalization; see the URL vector audit).
  var P = require('internal/primordials');
  var defineInterface = require('internal/native_shape').defineInterface;
  // Every regex below runs over a caller-supplied URL, so none may go through
  // `re.test(...)`: `RegExp.prototype.exec` is a writable data property and the
  // spec's RegExpExec re-reads it off the receiver, so a plain assignment steers
  // `test` as well — a captured `test` included. primordials exports no
  // `RegExpPrototypeTest` for exactly that reason.
  //
  // The last GLOBAL regex in this file was toUSVString's, now a code-unit walk.
  var reTest = P.RegExpMatches;
  var allChars = P.allChars;
  var isAsciiDigit = P.isAsciiDigit;
  var isAsciiHexDigit = P.isAsciiHexDigit;
  var isAsciiOctalDigit = P.isAsciiOctalDigit;
  var ArrayPrototypePush = P.ArrayPrototypePush;
  var ArrayPrototypePop = P.ArrayPrototypePop;
  var ArrayPrototypeShift = P.ArrayPrototypeShift;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var ArrayPrototypeJoin = P.ArrayPrototypeJoin;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var ArrayPrototypeMap = P.ArrayPrototypeMap;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeCodePointAt = P.StringPrototypeCodePointAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeReplace = P.StringPrototypeReplace;
  var StringPrototypeReplaceAll = P.StringPrototypeReplaceAll;
  var StringPrototypeSplit = P.StringPrototypeSplit;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeToUpperCase = P.StringPrototypeToUpperCase;
  var StringPrototypeNormalize = P.StringPrototypeNormalize;
  var StringPrototypeSubstr = P.StringPrototypeSubstr;
  var ObjectCreate = P.ObjectCreate;
  var ObjectKeys = P.ObjectKeys;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ArrayFrom = P.ArrayFrom;
  // Free globals / statics, captured pristine at module-eval.
  var StringG = String;
  var SymbolIterator = Symbol.iterator;
  var TypeErrorG = P.TypeError;
  // Chrome's error text (Blink's WebIDL wording, no `code`).
  var webErrors = require('internal/web_errors');
  var context = webErrors.context;
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var notOfType = webErrors.notOfType;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var StringFromCharCode = String.fromCharCode;
  var StringFromCodePoint = String.fromCodePoint;
  var MathFloor = Math.floor;
  var MathPow = Math.pow;
  var parseIntG = P.parseInt;
  var isFiniteG = isFinite;
  var TextEncoderG = TextEncoder;
  var TextDecoderG = TextDecoder;

  // TextEncoder/TextDecoder are installed by internal/encoding.js. This module is
  // eagerly instantiated to install the URL/URLSearchParams globals, so the codecs
  // are created lazily (on first parse/serialize) rather than at module-eval time —
  // that keeps url.js robust to the loader's eager-instantiation order, since no
  // URL operation runs until user code, by which point every builtin has loaded.
  var encoderInstance = null;
  var decoderInstance = null;
  var fatalDecoderInstance = null;
  function encoder() {
    return encoderInstance || (encoderInstance = new TextEncoderG());
  }
  function decoder() {
    return decoderInstance || (decoderInstance = new TextDecoderG('utf-8'));
  }
  function fatalDecoder() {
    return (
      fatalDecoderInstance || (fatalDecoderInstance = new TextDecoderG('utf-8', { fatal: true }))
    );
  }

  // The IDNA half (separator fold, UTS-46 approximation, Punycode) lives in
  // internal/idna, as node's does in lib/internal/idna.js. Captured at module-eval
  // so parseHost calls straight into it, with no wrapper on the URL parse path;
  // FAILURE is the sentinel idna returns, so every `=== FAILURE` below stays one
  // identity compare against the same object.
  var idna = require('internal/idna');
  var FAILURE = idna.FAILURE;
  var domainToASCII = idna.domainToASCII;

  // ------------------------------------------------------------------ //
  // Percent-encoding                                                    //
  // ------------------------------------------------------------------ //

  // stripChars: `replace(/[…]/g, '')` without a RegExp.
  //
  // A GLOBAL regex replace is the sharpest shape of the exec re-read, and it does
  // not merely answer wrongly: `RegExp.prototype[Symbol.replace]` loops on
  // RegExpExec and advances `lastIndex` only on an EMPTY match, so a forged
  // non-empty result never terminates. Measured on `bin/lava` before this change,
  // with `RegExp.prototype.exec` replaced: `new URL('http://EXAMPLE.com/')` never
  // returned and reached 1.4 GB RSS in four seconds, and a remote server's
  // `Location:` header reaching `new URL(location, req.url)` hung the client.
  // Routing through a captured `exec` would fix the steering and keep the spin.
  //
  // `pred` is a code-point predicate, so the caller keeps its character set
  // explicit and no RegExp exists to poison. Returns the input unchanged when
  // nothing matches, which is the common case for both callers.
  function stripChars(s, pred) {
    var n = s.length;
    var i = 0;
    for (; i < n; i++) {
      if (pred(StringPrototypeCharCodeAt(s, i))) break;
    }
    if (i === n) return s;
    var out = StringPrototypeSlice(s, 0, i);
    for (; i < n; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (!pred(c)) out += StringFromCharCode(c);
    }
    return out;
  }

  function isTabOrNewline(c) {
    return c === 0x09 || c === 0x0a || c === 0x0d;
  }

  // The WHATWG percent-encode sets, each a predicate over a code point. Every set
  // is a superset of the C0-control set (control chars and everything past 0x7E).
  function inC0ControlSet(cp) {
    return cp <= 0x1f || cp > 0x7e;
  }
  function trimC0ControlOrSpace(str) {
    var start = 0;
    var end = str.length;
    while (start < end && StringPrototypeCharCodeAt(str, start) <= 0x20) start++;
    while (end > start && StringPrototypeCharCodeAt(str, end - 1) <= 0x20) end--;
    return start === 0 && end === str.length ? str : str.slice(start, end);
  }
  function inFragmentSet(cp) {
    return (
      inC0ControlSet(cp) || cp === 0x20 || cp === 0x22 || cp === 0x3c || cp === 0x3e || cp === 0x60
    );
  }
  function inQuerySet(cp) {
    return (
      inC0ControlSet(cp) || cp === 0x20 || cp === 0x22 || cp === 0x23 || cp === 0x3c || cp === 0x3e
    );
  }
  function inSpecialQuerySet(cp) {
    return inQuerySet(cp) || cp === 0x27;
  }
  function inPathSet(cp) {
    return inQuerySet(cp) || cp === 0x3f || cp === 0x60 || cp === 0x7b || cp === 0x7d;
  }
  function inUserinfoSet(cp) {
    return (
      inPathSet(cp) ||
      cp === 0x2f ||
      cp === 0x3a ||
      cp === 0x3b ||
      cp === 0x3d ||
      cp === 0x40 ||
      cp === 0x5b ||
      cp === 0x5c ||
      cp === 0x5d ||
      cp === 0x5e ||
      cp === 0x7c
    );
  }

  // Precomputed per-byte artifacts for the hot per-character encode path:
  // PCT[b] is '%XX', ASCII_CHAR[b] the one-character string. Built once.
  var PCT = new Array(256);
  var ASCII_CHAR = new Array(128);
  for (var pctB = 0; pctB < 256; pctB++) {
    var pctHex = pctB.toString(16).toUpperCase();
    PCT[pctB] = '%' + (pctHex.length === 1 ? '0' + pctHex : pctHex);
    if (pctB < 128) ASCII_CHAR[pctB] = StringFromCharCode(pctB);
  }

  function percentEncodeByte(b) {
    return PCT[b];
  }

  // Encode ONE code point against `inSet` without round-tripping through a
  // string or TextEncoder. The parser's state machine calls this once per
  // character of userinfo/path/query/fragment, so it is the hottest loop in
  // the whole parse; every set encodes all non-ASCII (> 0x7E), so the UTF-8
  // bytes are hand-rolled from the code point.
  function percentEncodeCp(cp, inSet) {
    if (cp < 0x80) return inSet(cp) ? PCT[cp] : ASCII_CHAR[cp];
    if (cp < 0x800) return PCT[0xc0 | (cp >> 6)] + PCT[0x80 | (cp & 0x3f)];
    if (cp < 0x10000)
      return PCT[0xe0 | (cp >> 12)] + PCT[0x80 | ((cp >> 6) & 0x3f)] + PCT[0x80 | (cp & 0x3f)];
    return (
      PCT[0xf0 | (cp >> 18)] +
      PCT[0x80 | ((cp >> 12) & 0x3f)] +
      PCT[0x80 | ((cp >> 6) & 0x3f)] +
      PCT[0x80 | (cp & 0x3f)]
    );
  }

  // UTF-8 percent-encode a string: code points in `inSet` (or any non-ASCII, since
  // the sets all include >0x7E) are encoded to their UTF-8 bytes; the rest pass
  // through. Iterates by code point so astral characters encode as four bytes.
  function utf8PercentEncode(str, inSet) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var cp = StringPrototypeCodePointAt(str, i);
      if (cp > 0xffff) i++; // consumed a surrogate pair
      out += percentEncodeCp(cp, inSet);
    }
    return out;
  }

  // One-character string for a code point without the StringFromCodePoint
  // host-call for ASCII — the state machine appends to its buffer through this.
  function cpToStr(cp) {
    return cp < 0x80 ? ASCII_CHAR[cp] : StringFromCodePoint(cp);
  }

  // Percent-decode a string to its raw byte sequence. Non-%XX characters
  // contribute their own UTF-8 bytes so raw multibyte input survives.
  function percentDecodeBytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = StringPrototypeCharCodeAt(str, i);
      if (
        c === 0x25 &&
        i + 2 < str.length &&
        isAsciiHexDigit(StringPrototypeCharCodeAt(str, i + 1)) &&
        isAsciiHexDigit(StringPrototypeCharCodeAt(str, i + 2))
      ) {
        ArrayPrototypePush(bytes, parseIntG(StringPrototypeSubstr(str, i + 1, 2), 16));
        i += 2;
      } else {
        var cp = StringPrototypeCodePointAt(str, i);
        if (cp > 0xffff) i++;
        var enc = encoder().encode(StringFromCodePoint(cp));
        for (var k = 0; k < enc.length; k++) ArrayPrototypePush(bytes, enc[k]);
      }
    }
    return new Uint8Array(bytes);
  }

  // Lenient percent-decode (invalid UTF-8 → U+FFFD), used for query/form parsing.
  function percentDecode(str) {
    return decoder().decode(percentDecodeBytes(str));
  }

  // Strict percent-decode for host parsing: invalid UTF-8 is a parse failure, as
  // the URL Standard's domain-to-ASCII step rejects it (Node throws to match).
  function percentDecodeHostStrict(str) {
    try {
      return fatalDecoder().decode(percentDecodeBytes(str));
    } catch {
      return FAILURE;
    }
  }

  // ------------------------------------------------------------------ //
  // Host parsing                                                        //
  // ------------------------------------------------------------------ //

  // Forbidden host code points (opaque hosts) and the stricter forbidden domain
  // set (special-scheme hosts), per the URL Standard.
  function isForbiddenHostCodePoint(cp) {
    return (
      cp === 0x00 ||
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      cp === 0x20 ||
      cp === 0x23 ||
      cp === 0x2f ||
      cp === 0x3a ||
      cp === 0x3c ||
      cp === 0x3e ||
      cp === 0x3f ||
      cp === 0x40 ||
      cp === 0x5b ||
      cp === 0x5c ||
      cp === 0x5d ||
      cp === 0x5e ||
      cp === 0x7c
    );
  }
  function isForbiddenDomainCodePoint(cp) {
    return isForbiddenHostCodePoint(cp) || cp <= 0x1f || cp === 0x25 || cp === 0x7f;
  }

  function parseIPv4Number(input) {
    if (input === '') return FAILURE;
    var radix = 10;
    if (input.length >= 2 && input[0] === '0' && (input[1] === 'x' || input[1] === 'X')) {
      radix = 16;
      input = input.slice(2);
    } else if (input.length >= 2 && input[0] === '0') {
      radix = 8;
      input = input.slice(1);
    }
    if (input === '') return 0;
    // Was three regex literals re-created per call (4-5x per dotted-quad parse) plus
    // an exec crossing each; now neither.
    if (
      !allChars(
        input,
        radix === 10 ? isAsciiDigit : radix === 16 ? isAsciiHexDigit : isAsciiOctalDigit,
      )
    )
      return FAILURE;
    var n = parseIntG(input, radix);
    if (!isFiniteG(n)) return FAILURE;
    return n;
  }

  function endsInANumber(input) {
    var parts = StringPrototypeSplit(input, '.');
    if (parts[parts.length - 1] === '') {
      if (parts.length === 1) return false;
      ArrayPrototypePop(parts);
    }
    var last = parts[parts.length - 1];
    if (allChars(last, isAsciiDigit)) return true;
    return parseIPv4Number(last) !== FAILURE;
  }

  function serializeIPv4(n) {
    var out = '';
    for (var i = 1; i <= 4; i++) {
      out = StringG(n % 256) + out;
      if (i !== 4) out = '.' + out;
      n = MathFloor(n / 256);
    }
    return out;
  }

  function parseIPv4(input) {
    var parts = StringPrototypeSplit(input, '.');
    if (parts[parts.length - 1] === '') {
      if (parts.length > 1) ArrayPrototypePop(parts);
    }
    if (parts.length > 4) return FAILURE;
    var numbers = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parseIPv4Number(parts[i]);
      if (n === FAILURE) return FAILURE;
      ArrayPrototypePush(numbers, n);
    }
    for (var j = 0; j < numbers.length; j++) {
      if (numbers[j] > 255 && j !== numbers.length - 1) return FAILURE;
    }
    if (numbers[numbers.length - 1] >= MathPow(256, 5 - numbers.length)) return FAILURE;
    var ipv4 = ArrayPrototypePop(numbers);
    var counter = 0;
    for (var m = 0; m < numbers.length; m++) {
      ipv4 += numbers[m] * MathPow(256, 3 - counter);
      counter++;
    }
    return serializeIPv4(ipv4);
  }

  function parseIPv6(input) {
    var address = [0, 0, 0, 0, 0, 0, 0, 0];
    var pieceIndex = 0;
    var compress = null;
    var cps = [];
    for (var s = 0; s < input.length; s++)
      ArrayPrototypePush(cps, StringPrototypeCharCodeAt(input, s));
    var pointer = 0;
    function c() {
      return pointer < cps.length ? cps[pointer] : -1;
    }
    if (c() === 0x3a) {
      // ':'
      if (cps[pointer + 1] !== 0x3a) return FAILURE;
      pointer += 2;
      pieceIndex++;
      compress = pieceIndex;
    }
    while (c() !== -1) {
      if (pieceIndex === 8) return FAILURE;
      if (c() === 0x3a) {
        if (compress !== null) return FAILURE;
        pointer++;
        pieceIndex++;
        compress = pieceIndex;
        continue;
      }
      var value = 0;
      var length = 0;
      while (length < 4 && isAsciiHexDigit(c())) {
        value = value * 16 + parseIntG(StringFromCharCode(c()), 16);
        pointer++;
        length++;
      }
      if (c() === 0x2e) {
        // '.', embedded IPv4
        if (length === 0) return FAILURE;
        pointer -= length;
        if (pieceIndex > 6) return FAILURE;
        var numbersSeen = 0;
        while (c() !== -1) {
          var ipv4Piece = null;
          if (numbersSeen > 0) {
            if (c() === 0x2e && numbersSeen < 4) pointer++;
            else return FAILURE;
          }
          if (c() < 0x30 || c() > 0x39) return FAILURE;
          while (c() >= 0x30 && c() <= 0x39) {
            var num = c() - 0x30;
            if (ipv4Piece === null) ipv4Piece = num;
            else if (ipv4Piece === 0) return FAILURE;
            else ipv4Piece = ipv4Piece * 10 + num;
            if (ipv4Piece > 255) return FAILURE;
            pointer++;
          }
          address[pieceIndex] = address[pieceIndex] * 0x100 + ipv4Piece;
          numbersSeen++;
          if (numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
        }
        if (numbersSeen !== 4) return FAILURE;
        break;
      } else if (c() === 0x3a) {
        pointer++;
        if (c() === -1) return FAILURE;
      } else if (c() !== -1) {
        return FAILURE;
      }
      address[pieceIndex] = value;
      pieceIndex++;
    }
    if (compress !== null) {
      var swaps = pieceIndex - compress;
      pieceIndex = 7;
      while (pieceIndex !== 0 && swaps > 0) {
        var tmp = address[compress + swaps - 1];
        address[compress + swaps - 1] = address[pieceIndex];
        address[pieceIndex] = tmp;
        pieceIndex--;
        swaps--;
      }
    } else if (compress === null && pieceIndex !== 8) {
      return FAILURE;
    }
    return '[' + serializeIPv6(address) + ']';
  }

  function serializeIPv6(address) {
    var output = '';
    // Find the longest run (length > 1) of zero pieces to compress.
    var longestIdx = -1;
    var longestLen = 0;
    var curIdx = -1;
    var curLen = 0;
    for (var i = 0; i < 8; i++) {
      if (address[i] === 0) {
        if (curIdx === -1) curIdx = i;
        curLen++;
        if (curLen > longestLen) {
          longestLen = curLen;
          longestIdx = curIdx;
        }
      } else {
        curIdx = -1;
        curLen = 0;
      }
    }
    var compress = longestLen > 1 ? longestIdx : -1;
    var ignore0 = false;
    for (var p = 0; p < 8; p++) {
      if (ignore0 && address[p] === 0) continue;
      else if (ignore0) ignore0 = false;
      if (compress === p) {
        output += p === 0 ? '::' : ':';
        ignore0 = true;
        continue;
      }
      output += address[p].toString(16);
      if (p !== 7) output += ':';
    }
    return output;
  }

  function parseOpaqueHost(input) {
    for (var i = 0; i < input.length; i++) {
      var cp = StringPrototypeCodePointAt(input, i);
      if (cp > 0xffff) i++;
      if (isForbiddenHostCodePoint(cp)) return FAILURE;
    }
    return utf8PercentEncode(input, inC0ControlSet);
  }

  // A host that is already a lowercase ASCII domain — no percent escapes, no
  // uppercase (IDNA maps case), no Unicode, no punycode label to expand —
  // percent-decodes and IDNA-maps to itself. This is nearly every real-world
  // URL, and it skips the per-parse percentDecode → TextDecoder → domainToASCII
  // round-trip that otherwise dominates host parsing.
  var SIMPLE_HOST_RE = /^[a-z0-9._-]+$/;

  function parseHost(input, isSpecial) {
    if (input[0] === '[') {
      if (input[input.length - 1] !== ']') return FAILURE;
      return parseIPv6(input.slice(1, -1));
    }
    if (!isSpecial) return parseOpaqueHost(input);
    if (reTest(SIMPLE_HOST_RE, input) && input.indexOf('xn--') === -1) {
      if (endsInANumber(input)) return parseIPv4(input);
      return input;
    }
    var domain = percentDecodeHostStrict(input);
    if (domain === FAILURE) return FAILURE;
    var ascii = domainToASCII(domain);
    if (ascii === FAILURE) return FAILURE;
    for (var i = 0; i < ascii.length; i++) {
      if (isForbiddenDomainCodePoint(StringPrototypeCharCodeAt(ascii, i))) return FAILURE;
    }
    if (endsInANumber(ascii)) return parseIPv4(ascii);
    return ascii;
  }

  // ------------------------------------------------------------------ //
  // URL record + serialization                                         //
  // ------------------------------------------------------------------ //

  // null prototype: SPECIAL_SCHEMES[scheme] is read for arbitrary schemes, so a
  // normal object would inherit a poisoned Object.prototype key (e.g.
  // Object.prototype.foo = 8080 makes the default-port check match and silently
  // drop a real port). __proto__:null cuts the chain — a non-special scheme reads
  // undefined, as it must.
  var SPECIAL_SCHEMES = {
    __proto__: null,
    ftp: 21,
    file: null,
    http: 80,
    https: 443,
    ws: 80,
    wss: 443,
  };

  function isSpecialScheme(scheme) {
    return Object.prototype.hasOwnProperty.call(SPECIAL_SCHEMES, scheme);
  }

  function newRecord() {
    // A plain literal, NOT a null-proto object: this record is accessed only via
    // fixed, hard-coded field names (url.scheme, url.host, …), never by an
    // attacker-controlled key, so it is not exposed to prototype-key pollution
    // and needs no null prototype. (null-proto is reserved for the lookup MAPS
    // keyed by external strings, e.g. SPECIAL_SCHEMES.)
    return {
      scheme: '',
      username: '',
      password: '',
      host: null,
      port: null,
      path: [], // array of segments, or a string when opaque
      query: null,
      fragment: null,
      opaque: false, // true => path is an opaque string
    };
  }

  function recordIsSpecial(url) {
    return isSpecialScheme(url.scheme);
  }

  function includesCredentials(url) {
    return url.username !== '' || url.password !== '';
  }

  function cannotHaveUsernamePasswordPort(url) {
    return url.host === null || url.host === '' || url.scheme === 'file';
  }

  function serializePath(url) {
    if (url.opaque) return url.path;
    if (url.path.length === 0) return '';
    return '/' + ArrayPrototypeJoin(url.path, '/');
  }

  function serializeHostPort(url) {
    if (url.host === null) return '';
    var out = url.host;
    if (url.port !== null) out += ':' + url.port;
    return out;
  }

  function serializeURL(url, excludeFragment) {
    var output = url.scheme + ':';
    if (url.host !== null) {
      output += '//';
      if (includesCredentials(url)) {
        output += url.username;
        if (url.password !== '') output += ':' + url.password;
        output += '@';
      }
      output += serializeHostPort(url);
    }
    if (url.host === null && !url.opaque && url.path.length > 1 && url.path[0] === '') {
      // Avoid the first empty segment being parsed back as an authority.
      output += '/.';
    }
    output += serializePath(url);
    if (url.query !== null) output += '?' + url.query;
    if (!excludeFragment && url.fragment !== null) output += '#' + url.fragment;
    return output;
  }

  function serializeOrigin(url) {
    switch (url.scheme) {
      case 'http':
      case 'https':
      case 'ws':
      case 'wss':
      case 'ftp':
        return url.scheme + '://' + serializeHostPort(url);
      case 'blob': {
        var pathStr = url.opaque ? url.path : serializePath(url);
        var inner = basicURLParse(pathStr);
        return inner === FAILURE ? 'null' : serializeOrigin(inner);
      }
      default:
        return 'null';
    }
  }

  // ------------------------------------------------------------------ //
  // The basic URL parser (state machine, with state-override support)   //
  // ------------------------------------------------------------------ //

  var SCHEME_START = 0,
    SCHEME = 1,
    NO_SCHEME = 2,
    SPECIAL_RELATIVE_OR_AUTHORITY = 3,
    PATH_OR_AUTHORITY = 4,
    RELATIVE = 5,
    RELATIVE_SLASH = 6,
    SPECIAL_AUTHORITY_SLASHES = 7,
    SPECIAL_AUTHORITY_IGNORE_SLASHES = 8,
    AUTHORITY = 9,
    HOST = 10,
    PORT = 11,
    FILE = 12,
    FILE_SLASH = 13,
    FILE_HOST = 14,
    PATH_START = 15,
    PATH = 16,
    OPAQUE_PATH = 17,
    QUERY = 18,
    FRAGMENT = 19,
    // The hostname setter shares the HOST state machine but must stop before a
    // port (it returns at a top-level ':'). A distinct constant flags that.
    HOSTNAME = 20;

  function isASCIIAlpha(cp) {
    return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
  }
  function isASCIIAlphanumeric(cp) {
    return isASCIIAlpha(cp) || isAsciiDigit(cp);
  }
  function isSingleDot(seg) {
    return seg === '.' || StringPrototypeToLowerCase(seg) === '%2e';
  }
  function isDoubleDot(seg) {
    var l = StringPrototypeToLowerCase(seg);
    return l === '..' || l === '.%2e' || l === '%2e.' || l === '%2e%2e';
  }
  function isWindowsDriveLetter(s) {
    return (
      s.length === 2 &&
      isASCIIAlpha(StringPrototypeCharCodeAt(s, 0)) &&
      (StringPrototypeCharCodeAt(s, 1) === 0x3a || StringPrototypeCharCodeAt(s, 1) === 0x7c)
    );
  }
  function isNormalizedWindowsDriveLetter(s) {
    return (
      s.length === 2 &&
      isASCIIAlpha(StringPrototypeCharCodeAt(s, 0)) &&
      StringPrototypeCharCodeAt(s, 1) === 0x3a
    );
  }
  function startsWithWindowsDriveLetter(str, i) {
    var rest = str.slice(i);
    return (
      rest.length >= 2 &&
      isWindowsDriveLetter(rest.slice(0, 2)) &&
      (rest.length === 2 ||
        rest[2] === '/' ||
        rest[2] === '\\' ||
        rest[2] === '?' ||
        rest[2] === '#')
    );
  }

  // Returns a url record on success, or FAILURE. `base` is a url record or
  // undefined; `url`/`stateOverride` drive the setter path.
  function basicURLParse(input, base, url, stateOverride) {
    if (url === undefined) {
      url = newRecord();
      // Remove leading/trailing C0 control or space (only when not a setter).
      input = trimC0ControlOrSpace(input);
    }
    // Remove all ASCII tab or newline (guarded: almost no real input has them,
    // and replaceAll would re-scan + re-allocate on every parse).
    input = stripChars(input, isTabOrNewline);

    // Code POINTS as numbers, one pass, surrogate-aware — same iteration as
    // ArrayFrom(input).map(c => c.codePointAt(0)) without allocating a
    // single-character string per code point (the old form dominated the whole
    // parse: one string alloc + one codePointAt call per character per read).
    var cps = [];
    for (var ci = 0; ci < input.length;) {
      var cc = StringPrototypeCodePointAt(input, ci);
      ArrayPrototypePush(cps, cc);
      ci += cc > 0xffff ? 2 : 1;
    }
    var pointer = 0;
    // The hostname override runs the HOST state but is flagged via stateOverride
    // so the HOST case knows to stop before a port.
    var state =
      stateOverride === HOSTNAME
        ? HOST
        : stateOverride !== undefined
          ? stateOverride
          : SCHEME_START;
    var buffer = '';
    var atSignSeen = false;
    var insideBrackets = false;
    var passwordTokenSeen = false;
    var special = recordIsSpecial(url);

    function cp(idx) {
      return idx < cps.length ? cps[idx] : -1;
    }
    function remaining(n) {
      // The code point n positions past the current pointer (n === 0 is the
      // character immediately following the one being processed).
      return pointer + 1 + n < cps.length ? cps[pointer + 1 + n] : -1;
    }

    for (; pointer <= cps.length; pointer++) {
      var c = cp(pointer);
      switch (state) {
        case SCHEME_START:
          if (isASCIIAlpha(c)) {
            buffer += StringFromCharCode(c | 0x20);
            state = SCHEME;
          } else if (stateOverride === undefined) {
            state = NO_SCHEME;
            pointer--;
          } else {
            return FAILURE;
          }
          break;

        case SCHEME:
          if (isASCIIAlphanumeric(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
            buffer += StringFromCharCode(c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
          } else if (c === 0x3a) {
            if (stateOverride !== undefined) {
              var bufSpecial = isSpecialScheme(buffer);
              if (special && !bufSpecial) return url;
              if (!special && bufSpecial) return url;
              if ((includesCredentials(url) || url.port !== null) && buffer === 'file') return url;
              if (url.scheme === 'file' && url.host === '') return url;
            }
            url.scheme = buffer;
            if (stateOverride !== undefined) {
              if (url.port === SPECIAL_SCHEMES[url.scheme]) url.port = null;
              return url;
            }
            buffer = '';
            special = recordIsSpecial(url);
            if (url.scheme === 'file') {
              state = FILE;
            } else if (special && base !== undefined && base.scheme === url.scheme) {
              state = SPECIAL_RELATIVE_OR_AUTHORITY;
            } else if (special) {
              state = SPECIAL_AUTHORITY_SLASHES;
            } else if (remaining(0) === 0x2f) {
              state = PATH_OR_AUTHORITY;
              pointer++;
            } else {
              url.opaque = true;
              url.path = '';
              state = OPAQUE_PATH;
            }
          } else if (stateOverride === undefined) {
            buffer = '';
            state = NO_SCHEME;
            pointer = -1;
          } else {
            return FAILURE;
          }
          break;

        case NO_SCHEME:
          if (base === undefined || (base.opaque && c !== 0x23)) {
            return FAILURE;
          } else if (base.opaque && c === 0x23) {
            url.scheme = base.scheme;
            url.path = base.path;
            url.opaque = true;
            url.query = base.query;
            url.fragment = '';
            state = FRAGMENT;
          } else if (base.scheme !== 'file') {
            state = RELATIVE;
            pointer--;
          } else {
            state = FILE;
            pointer--;
          }
          break;

        case SPECIAL_RELATIVE_OR_AUTHORITY:
          if (c === 0x2f && remaining(0) === 0x2f) {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
            pointer++;
          } else {
            state = RELATIVE;
            pointer--;
          }
          break;

        case PATH_OR_AUTHORITY:
          if (c === 0x2f) {
            state = AUTHORITY;
          } else {
            state = PATH;
            pointer--;
          }
          break;

        case RELATIVE:
          url.scheme = base.scheme;
          special = recordIsSpecial(url);
          if (c === 0x2f) {
            state = RELATIVE_SLASH;
          } else if (special && c === 0x5c) {
            state = RELATIVE_SLASH;
          } else {
            url.username = base.username;
            url.password = base.password;
            url.host = base.host;
            url.port = base.port;
            url.path = ArrayPrototypeSlice(base.path);
            url.query = base.query;
            if (c === 0x3f) {
              url.query = '';
              state = QUERY;
            } else if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            } else if (c !== -1) {
              url.query = null;
              ArrayPrototypePop(url.path);
              state = PATH;
              pointer--;
            }
          }
          break;

        case RELATIVE_SLASH:
          if (special && (c === 0x2f || c === 0x5c)) {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
          } else if (c === 0x2f) {
            state = AUTHORITY;
          } else {
            url.username = base.username;
            url.password = base.password;
            url.host = base.host;
            url.port = base.port;
            state = PATH;
            pointer--;
          }
          break;

        case SPECIAL_AUTHORITY_SLASHES:
          if (c === 0x2f && remaining(0) === 0x2f) {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
            pointer++;
          } else {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
            pointer--;
          }
          break;

        case SPECIAL_AUTHORITY_IGNORE_SLASHES:
          if (c !== 0x2f && c !== 0x5c) {
            state = AUTHORITY;
            pointer--;
          }
          break;

        case AUTHORITY:
          if (c === 0x40) {
            if (atSignSeen) buffer = '%40' + buffer;
            atSignSeen = true;
            for (var bi = 0; bi < buffer.length; bi++) {
              var bcp = StringPrototypeCodePointAt(buffer, bi);
              if (bcp > 0xffff) bi++;
              if (bcp === 0x3a && !passwordTokenSeen) {
                passwordTokenSeen = true;
                continue;
              }
              var encoded = utf8PercentEncode(StringFromCodePoint(bcp), inUserinfoSet);
              if (passwordTokenSeen) url.password += encoded;
              else url.username += encoded;
            }
            buffer = '';
          } else if (
            c === -1 ||
            c === 0x2f ||
            c === 0x3f ||
            c === 0x23 ||
            (special && c === 0x5c)
          ) {
            if (atSignSeen && buffer === '') return FAILURE;
            pointer -= ArrayFrom(buffer).length + 1;
            buffer = '';
            state = HOST;
          } else {
            buffer += cpToStr(c);
          }
          break;

        case HOST:
          if (stateOverride !== undefined && url.scheme === 'file') {
            pointer--;
            state = FILE_HOST;
          } else if (c === 0x3a && !insideBrackets) {
            if (buffer === '') return FAILURE;
            // The hostname setter (HOSTNAME override) stops before a port.
            if (stateOverride === HOSTNAME) return url;
            var host = parseHost(buffer, special);
            if (host === FAILURE) return FAILURE;
            url.host = host;
            buffer = '';
            state = PORT;
          } else if (
            c === -1 ||
            c === 0x2f ||
            c === 0x3f ||
            c === 0x23 ||
            (special && c === 0x5c)
          ) {
            pointer--;
            if (special && buffer === '') return FAILURE;
            if (
              stateOverride !== undefined &&
              buffer === '' &&
              (includesCredentials(url) || url.port !== null)
            )
              return url;
            var host2 = parseHost(buffer, special);
            if (host2 === FAILURE) return FAILURE;
            url.host = host2;
            buffer = '';
            state = PATH_START;
            if (stateOverride !== undefined) return url;
          } else {
            if (c === 0x5b) insideBrackets = true;
            else if (c === 0x5d) insideBrackets = false;
            buffer += cpToStr(c);
          }
          break;

        case PORT:
          if (isAsciiDigit(c)) {
            buffer += StringFromCharCode(c);
          } else if (
            c === -1 ||
            c === 0x2f ||
            c === 0x3f ||
            c === 0x23 ||
            (special && c === 0x5c) ||
            stateOverride !== undefined
          ) {
            if (buffer !== '') {
              var portNum = parseIntG(buffer, 10);
              if (portNum > 65535) return FAILURE;
              url.port = portNum === SPECIAL_SCHEMES[url.scheme] ? null : portNum;
              buffer = '';
            }
            if (stateOverride !== undefined) return url;
            state = PATH_START;
            pointer--;
          } else {
            return FAILURE;
          }
          break;

        case FILE:
          url.scheme = 'file';
          special = true;
          url.host = '';
          if (c === 0x2f || c === 0x5c) {
            state = FILE_SLASH;
          } else if (base !== undefined && base.scheme === 'file') {
            url.host = base.host;
            url.path = ArrayPrototypeSlice(base.path);
            url.query = base.query;
            if (c === 0x3f) {
              url.query = '';
              state = QUERY;
            } else if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            } else if (c !== -1) {
              url.query = null;
              if (!startsWithWindowsDriveLetter(input, pointer)) {
                shortenPath(url);
              } else {
                url.path = [];
              }
              state = PATH;
              pointer--;
            }
          } else {
            state = PATH;
            pointer--;
          }
          break;

        case FILE_SLASH:
          if (c === 0x2f || c === 0x5c) {
            state = FILE_HOST;
          } else {
            if (
              base !== undefined &&
              base.scheme === 'file' &&
              !startsWithWindowsDriveLetter(input, pointer)
            ) {
              if (isNormalizedWindowsDriveLetter(base.path[0] || '')) {
                ArrayPrototypePush(url.path, base.path[0]);
              } else {
                url.host = base.host;
              }
            }
            state = PATH;
            pointer--;
          }
          break;

        case FILE_HOST:
          if (c === -1 || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
            pointer--;
            if (stateOverride === undefined && isWindowsDriveLetter(buffer)) {
              state = PATH;
            } else if (buffer === '') {
              url.host = '';
              if (stateOverride !== undefined) return url;
              state = PATH_START;
            } else {
              var fhost = parseHost(buffer, special);
              if (fhost === FAILURE) return FAILURE;
              if (fhost === 'localhost') fhost = '';
              url.host = fhost;
              if (stateOverride !== undefined) return url;
              buffer = '';
              state = PATH_START;
            }
          } else {
            buffer += cpToStr(c);
          }
          break;

        case PATH_START:
          if (special) {
            state = PATH;
            if (c !== 0x2f && c !== 0x5c) pointer--;
          } else if (stateOverride === undefined && c === 0x3f) {
            url.query = '';
            state = QUERY;
          } else if (stateOverride === undefined && c === 0x23) {
            url.fragment = '';
            state = FRAGMENT;
          } else if (c !== -1) {
            state = PATH;
            if (c !== 0x2f) pointer--;
          } else if (stateOverride !== undefined && url.host === null) {
            ArrayPrototypePush(url.path, '');
          }
          break;

        case PATH:
          if (
            c === -1 ||
            c === 0x2f ||
            (special && c === 0x5c) ||
            (stateOverride === undefined && (c === 0x3f || c === 0x23))
          ) {
            if (isDoubleDot(buffer)) {
              shortenPath(url);
              if (c !== 0x2f && !(special && c === 0x5c)) ArrayPrototypePush(url.path, '');
            } else if (isSingleDot(buffer)) {
              if (c !== 0x2f && !(special && c === 0x5c)) ArrayPrototypePush(url.path, '');
            } else {
              if (url.scheme === 'file' && url.path.length === 0 && isWindowsDriveLetter(buffer)) {
                buffer = buffer[0] + ':';
              }
              ArrayPrototypePush(url.path, buffer);
            }
            buffer = '';
            if (c === 0x3f) {
              url.query = '';
              state = QUERY;
            } else if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            }
          } else {
            buffer += percentEncodeCp(c, inPathSet);
          }
          break;

        case OPAQUE_PATH:
          if (c === 0x3f) {
            url.query = '';
            state = QUERY;
          } else if (c === 0x23) {
            url.fragment = '';
            state = FRAGMENT;
          } else if (c !== -1) {
            url.path += percentEncodeCp(c, inC0ControlSet);
          }
          break;

        case QUERY:
          if ((stateOverride === undefined && c === 0x23) || c === -1) {
            var querySet = special ? inSpecialQuerySet : inQuerySet;
            url.query += utf8PercentEncode(buffer, querySet);
            buffer = '';
            if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            }
          } else if (c !== -1) {
            buffer += cpToStr(c);
          }
          break;

        case FRAGMENT:
          if (c !== -1) {
            url.fragment += percentEncodeCp(c, inFragmentSet);
          }
          break;
      }
      if (pointer > cps.length) break;
    }
    return url;
  }

  function shortenPath(url) {
    if (url.opaque) return;
    var path = url.path;
    if (url.scheme === 'file' && path.length === 1 && isNormalizedWindowsDriveLetter(path[0])) {
      return;
    }
    ArrayPrototypePop(path);
  }

  // The constructor's parse. The arguments convert in order, `url` then `base`, and only
  // `undefined` skips the base: `null` is the string "null", an invalid base, as in
  // Chrome (tests/web/cases/url-webidl.expected).
  function parseURLOrThrow(input, base) {
    var str = typeof input === 'string' ? input : toStringArg(input, 'URL');
    var baseStr;
    var baseRecord;
    if (base !== undefined) {
      baseStr = typeof base === 'string' ? base : toStringArg(base, 'URL');
      baseRecord = basicURLParse(baseStr);
      if (baseRecord === FAILURE) throw invalidURL(true);
    }
    var record = basicURLParse(str, baseRecord);
    if (record === FAILURE) throw invalidURL(false);
    return record;
  }

  // canParse/parse: the constructor's conversions, which throw (a Symbol argument), and
  // its parse, which does not — FAILURE for a bad `url` or a bad `base`.
  function parseURLOrFailure(input, base, op) {
    var str = typeof input === 'string' ? input : toStringArg(input, 'URL', op);
    var baseRecord;
    if (base !== undefined) {
      baseRecord = basicURLParse(typeof base === 'string' ? base : toStringArg(base, 'URL', op));
      if (baseRecord === FAILURE) return FAILURE;
    }
    return basicURLParse(str, baseRecord);
  }

  // The constructor's parse failure: Chrome's TypeError, which names the base when it is
  // the base that failed (tests/web/cases/url-errors.expected).
  function invalidURL(badBase) {
    return typeError('URL', undefined, badBase ? 'Invalid base URL' : 'Invalid URL');
  }

  // The href setter's parse failure: Chrome's attribute-setter TypeError.
  function invalidHref() {
    return pageError(new TypeErrorG(setterContext('href') + 'Invalid URL'));
  }

  // Blink's prefix for an error raised while setting a URL attribute. web_errors'
  // context() covers operations and constructors; an attribute setter is URL's alone.
  function setterContext(attr) {
    return "Failed to set the '" + attr + "' property on 'URL': ";
  }

  // WebIDL's string conversion of a non-string argument: ToString, which throws on a
  // Symbol where String() would answer "Symbol(…)" — and "Symbol(x)" parses, as a URL
  // with an opaque path. `attr` names the URL attribute being set; otherwise iface/op
  // place the error as web_errors' context() does.
  function toStringArg(value, iface, op, attr) {
    if (typeof value === 'symbol') {
      var detail = 'Cannot convert a Symbol value to a string';
      if (attr !== undefined) throw pageError(new TypeErrorG(setterContext(attr) + detail));
      throw typeError(iface, op, detail);
    }

    return StringG(value);
  }

  // A member called on something that is not a URL / URLSearchParams (`this` is null,
  // a primitive, or an object without the private slot): Blink's "Illegal invocation".
  function invalidThis() {
    return illegalInvocation();
  }

  // ------------------------------------------------------------------ //
  // application/x-www-form-urlencoded                                   //
  // ------------------------------------------------------------------ //

  function isFormUrlencodedSafe(cp) {
    return (
      cp === 0x2a ||
      cp === 0x2d ||
      cp === 0x2e ||
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      cp === 0x5f ||
      (cp >= 0x61 && cp <= 0x7a)
    );
  }

  function formUrlencodedByteSerialize(str) {
    var bytes = encoder().encode(str);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 0x20) out += '+';
      else if (isFormUrlencodedSafe(b)) out += StringFromCharCode(b);
      else out += percentEncodeByte(b);
    }
    return out;
  }

  function formUrlencodedParse(input) {
    var sequences = input === '' ? [] : StringPrototypeSplit(input, '&');
    var output = [];
    for (var i = 0; i < sequences.length; i++) {
      var bytes = sequences[i];
      if (bytes === '') continue;
      var name, value;
      var eq = bytes.indexOf('=');
      if (eq === -1) {
        name = bytes;
        value = '';
      } else {
        name = bytes.slice(0, eq);
        value = bytes.slice(eq + 1);
      }
      name = percentDecode(StringPrototypeReplaceAll(name, '+', ' '));
      value = percentDecode(StringPrototypeReplaceAll(value, '+', ' '));
      ArrayPrototypePush(output, [name, value]);
    }
    return output;
  }

  function formUrlencodedSerialize(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      if (i > 0) out += '&';
      out +=
        formUrlencodedByteSerialize(list[i][0]) + '=' + formUrlencodedByteSerialize(list[i][1]);
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // URLSearchParams                                                     //
  // ------------------------------------------------------------------ //

  var kList = Symbol('list');
  var kURLObject = Symbol('urlObject');

  function URLSearchParams(init) {
    this[kList] = [];
    this[kURLObject] = null;
    if (init === undefined || init === null) return;
    if (typeof init === 'object' || typeof init === 'function') {
      if (init instanceof URLSearchParams) {
        var src = init[kList];
        for (var i = 0; i < src.length; i++)
          ArrayPrototypePush(this[kList], [src[i][0], src[i][1]]);
        return;
      }
      if (typeof init[Symbol.iterator] === 'function') {
        var idx = 0;
        for (var pair of init) {
          if (typeof pair !== 'object' && typeof pair !== 'function') {
            throw initError('The provided value cannot be converted to a sequence.');
          }
          if (typeof pair[SymbolIterator] !== 'function') {
            throw initError('The object must have a callable @@iterator property.');
          }
          var arr = [];
          for (var v of pair) ArrayPrototypePush(arr, v);
          if (arr.length !== 2) {
            // Blink's text repeats the context prefix; copied from the recording.
            throw initError(
              context('URLSearchParams') + 'Sequence initializer must only contain pair elements',
            );
          }
          ArrayPrototypePush(this[kList], [
            toUSVString(arr[0], 'URLSearchParams'),
            toUSVString(arr[1], 'URLSearchParams'),
          ]);
          idx++;
        }
        return;
      }
      // Record of string -> string.
      var keys = ObjectKeys(init);
      for (var k = 0; k < keys.length; k++) {
        ArrayPrototypePush(this[kList], [
          toUSVString(keys[k], 'URLSearchParams'),
          toUSVString(init[keys[k]], 'URLSearchParams'),
        ]);
      }
      return;
    }
    // String init: strip a single leading '?'.
    var str = toUSVString(init, 'URLSearchParams');
    if (str[0] === '?') str = str.slice(1);
    this[kList] = formUrlencodedParse(str);
  }

  // A sequence-initializer error from the constructor: Chrome's, with the context prefix.
  function initError(detail) {
    return typeError('URLSearchParams', undefined, detail);
  }

  // The list behind a URLSearchParams receiver, or the foreign-receiver error. One
  // load on the success path, the one every member made already.
  function listOf(sp) {
    var list = sp === null || sp === undefined ? undefined : sp[kList];
    if (list === undefined) throw invalidThis();
    return list;
  }

  // Blink's argument-count check for a URLSearchParams operation. Node checks only
  // append/set (with its own text, kept), so it is the Window surface's alone.
  function requireArgs(op, required, present) {
    if (present < required)
      throw typeError('URLSearchParams', op, argumentsRequired(required, present));
  }

  // Convert to a USVString: stringify, then replace any unpaired surrogate with
  // U+FFFD (per WHATWG). The fast path skips strings with no surrogate at all.
  //
  // A code-unit walk, not a GLOBAL regex replace. The pre-scan below is not a guard
  // against the poison it looks like one against: a VALID pair — any emoji in a
  // remote query string — sets `hasSurrogate` too, and the global replace then
  // never terminates under a forged `RegExp.prototype.exec`, because
  // `Symbol.replace` advances `lastIndex` only on an empty match. Measured:
  // `new URLSearchParams('a=<emoji>')` and `url.hash = 'x<emoji>'` both hung, and
  // `new URLSearchParams(remoteQuery)` is on the network path.
  //
  // The pre-scan stays because it is the common case and it now decides a real fast
  // path — most strings have no surrogate at all and are returned untouched.
  //
  // iface/op/attr place a Symbol's conversion error (toStringArg); internal callers
  // pass only strings and omit them.
  function toUSVString(value, iface, op, attr) {
    var str = typeof value === 'string' ? value : toStringArg(value, iface, op, attr);
    var n = str.length;
    var hasSurrogate = false;
    for (var i = 0; i < n; i++) {
      var c = StringPrototypeCharCodeAt(str, i);
      if (c >= 0xd800 && c <= 0xdfff) {
        hasSurrogate = true;
        break;
      }
    }
    if (!hasSurrogate) return str;
    var out = StringPrototypeSlice(str, 0, i);
    for (; i < n; i++) {
      var cu = StringPrototypeCharCodeAt(str, i);
      if (cu < 0xd800 || cu > 0xdfff) {
        out += StringFromCharCode(cu);
        continue;
      }
      if (cu <= 0xdbff && i + 1 < n) {
        var lo = StringPrototypeCharCodeAt(str, i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          // A valid pair is kept verbatim.
          out += StringFromCharCode(cu) + StringFromCharCode(lo);
          i++;
          continue;
        }
      }
      out += '\uFFFD'; // lone high or lone low surrogate
    }
    return out;
  }

  // append/set called with fewer than two arguments: Blink's count.
  function missingNameValue(op, present) {
    return typeError('URLSearchParams', op, argumentsRequired(2, present));
  }

  function spUpdate(sp) {
    var urlObj = sp[kURLObject];
    if (urlObj === null) return;
    var serialized = formUrlencodedSerialize(sp[kList]);
    urlObj[kRecord].query = serialized === '' ? null : serialized;
  }

  ObjectDefineProperty(URLSearchParams.prototype, 'append', {
    configurable: true,
    writable: true,
    value: function append(name, value) {
      var list = listOf(this);
      if (arguments.length < 2) throw missingNameValue('append', arguments.length);
      ArrayPrototypePush(list, [
        toUSVString(name, 'URLSearchParams', 'append'),
        toUSVString(value, 'URLSearchParams', 'append'),
      ]);
      spUpdate(this);
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'delete', {
    configurable: true,
    writable: true,
    value: function del(name) {
      var list = listOf(this);
      requireArgs('delete', 1, arguments.length);
      var n = toUSVString(name, 'URLSearchParams', 'delete');
      if (arguments.length > 1 && arguments[1] !== undefined) {
        var val = toUSVString(arguments[1], 'URLSearchParams', 'delete');
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i][0] === n && list[i][1] === val) ArrayPrototypeSplice(list, i, 1);
        }
      } else {
        for (var j = list.length - 1; j >= 0; j--) {
          if (list[j][0] === n) ArrayPrototypeSplice(list, j, 1);
        }
      }
      spUpdate(this);
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'get', {
    configurable: true,
    writable: true,
    value: function get(name) {
      var list = listOf(this);
      requireArgs('get', 1, arguments.length);
      var n = toUSVString(name, 'URLSearchParams', 'get');
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === n) return list[i][1];
      }
      return null;
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'getAll', {
    configurable: true,
    writable: true,
    value: function getAll(name) {
      var list = listOf(this);
      requireArgs('getAll', 1, arguments.length);
      var n = toUSVString(name, 'URLSearchParams', 'getAll');
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === n) ArrayPrototypePush(out, list[i][1]);
      }
      return out;
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'has', {
    configurable: true,
    writable: true,
    value: function has(name) {
      var list = listOf(this);
      requireArgs('has', 1, arguments.length);
      var n = toUSVString(name, 'URLSearchParams', 'has');
      if (arguments.length > 1 && arguments[1] !== undefined) {
        var val = toUSVString(arguments[1], 'URLSearchParams', 'has');
        for (var i = 0; i < list.length; i++) {
          if (list[i][0] === n && list[i][1] === val) return true;
        }
        return false;
      }
      for (var j = 0; j < list.length; j++) {
        if (list[j][0] === n) return true;
      }
      return false;
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'set', {
    configurable: true,
    writable: true,
    value: function set(name, value) {
      var list = listOf(this);
      if (arguments.length < 2) throw missingNameValue('set', arguments.length);
      var n = toUSVString(name, 'URLSearchParams', 'set');
      var v = toUSVString(value, 'URLSearchParams', 'set');
      // Set the first matching tuple in place and drop the rest (URL Standard).
      var found = false;
      for (var i = 0; i < list.length;) {
        if (list[i][0] === n) {
          if (found) {
            ArrayPrototypeSplice(list, i, 1);
            continue;
          }
          list[i][1] = v;
          found = true;
        }
        i++;
      }
      if (!found) ArrayPrototypePush(list, [n, v]);
      spUpdate(this);
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'sort', {
    configurable: true,
    writable: true,
    value: function sort() {
      // Stable sort by code units of the name only.
      ArrayPrototypeSort(listOf(this), function (a, b) {
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
      spUpdate(this);
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'forEach', {
    configurable: true,
    writable: true,
    value: function forEach(callback, thisArg) {
      var list = listOf(this);
      if (typeof callback !== 'function') {
        requireArgs('forEach', 1, arguments.length);
        throw typeError('URLSearchParams', 'forEach', notOfType(1, 'Function'));
      }

      // Read length lazily so callbacks that append are observed (per spec).
      for (var i = 0; i < list.length; i++) {
        callback.call(thisArg, list[i][1], list[i][0], this);
      }
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'keys', {
    configurable: true,
    writable: true,
    value: function keys() {
      return makeSearchParamsIterator(this, 'key');
    },
  });
  ObjectDefineProperty(URLSearchParams.prototype, 'values', {
    configurable: true,
    writable: true,
    value: function values() {
      return makeSearchParamsIterator(this, 'value');
    },
  });
  ObjectDefineProperty(URLSearchParams.prototype, 'entries', {
    configurable: true,
    writable: true,
    value: function entries() {
      return makeSearchParamsIterator(this, 'key+value');
    },
  });
  ObjectDefineProperty(URLSearchParams.prototype, Symbol.iterator, {
    configurable: true,
    writable: true,
    value: URLSearchParams.prototype.entries,
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'size', {
    configurable: true,
    enumerable: true,
    get: function size() {
      return listOf(this).length;
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, 'toString', {
    configurable: true,
    writable: true,
    value: function toString() {
      return formUrlencodedSerialize(listOf(this));
    },
  });

  ObjectDefineProperty(URLSearchParams.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'URLSearchParams',
  });

  function makeSearchParamsIterator(sp, kind) {
    listOf(sp);
    var index = 0;
    var iterator = {
      next: function next() {
        var list = sp[kList];
        if (index >= list.length) {
          return { value: undefined, done: true };
        }
        var entry = list[index];
        index++;
        var value;
        if (kind === 'key') value = entry[0];
        else if (kind === 'value') value = entry[1];
        else value = [entry[0], entry[1]];
        return { value: value, done: false };
      },
    };
    iterator[Symbol.iterator] = function () {
      return this;
    };
    ObjectDefineProperty(iterator, Symbol.toStringTag, {
      configurable: true,
      value: 'URLSearchParams Iterator',
    });
    return iterator;
  }

  // Build a URLSearchParams bound to a URL record (no constructor side effects).
  function newBoundSearchParams(urlObj) {
    var sp = ObjectCreate(URLSearchParams.prototype);
    sp[kList] = urlObj[kRecord].query === null ? [] : formUrlencodedParse(urlObj[kRecord].query);
    sp[kURLObject] = urlObj;
    return sp;
  }

  // ------------------------------------------------------------------ //
  // URL                                                                 //
  // ------------------------------------------------------------------ //

  var kRecord = Symbol('record');
  var kSearchParams = Symbol('searchParams');

  function URL(input, base) {
    if (!(this instanceof URL)) {
      throw new TypeError("Class constructor URL cannot be invoked without 'new'");
    }
    if (arguments.length === 0) throw typeError('URL', undefined, argumentsRequired(1, 0));
    this[kRecord] = parseURLOrThrow(input, base);
    this[kSearchParams] = null;
  }

  // The record behind a URL receiver, or the foreign-receiver error. One load on the
  // success path, the one every member made already.
  function recordOf(url) {
    var record = url === null || url === undefined ? undefined : url[kRecord];
    if (record === undefined) throw invalidThis();
    return record;
  }

  function refreshSearchParams(url) {
    if (url[kSearchParams] !== null) {
      var sp = url[kSearchParams];
      sp[kList] = url[kRecord].query === null ? [] : formUrlencodedParse(url[kRecord].query);
    }
  }

  ObjectDefineProperty(URL.prototype, 'href', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeURL(recordOf(this));
    },
    set: function (value) {
      recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'href');
      var record = basicURLParse(str);
      if (record === FAILURE) throw invalidHref();
      this[kRecord] = record;
      refreshSearchParams(this);
    },
  });

  ObjectDefineProperty(URL.prototype, 'origin', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeOrigin(recordOf(this));
    },
  });

  ObjectDefineProperty(URL.prototype, 'protocol', {
    configurable: true,
    enumerable: true,
    get: function () {
      return recordOf(this).scheme + ':';
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'protocol');
      basicURLParse(str + ':', undefined, url, SCHEME_START);
    },
  });

  ObjectDefineProperty(URL.prototype, 'username', {
    configurable: true,
    enumerable: true,
    get: function () {
      return recordOf(this).username;
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'username');
      if (cannotHaveUsernamePasswordPort(url)) return;
      url.username = utf8PercentEncode(str, inUserinfoSet);
    },
  });

  ObjectDefineProperty(URL.prototype, 'password', {
    configurable: true,
    enumerable: true,
    get: function () {
      return recordOf(this).password;
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'password');
      if (cannotHaveUsernamePasswordPort(url)) return;
      url.password = utf8PercentEncode(str, inUserinfoSet);
    },
  });

  ObjectDefineProperty(URL.prototype, 'host', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeHostPort(recordOf(this));
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'host');
      if (url.opaque) return;
      basicURLParse(str, undefined, url, HOST);
    },
  });

  ObjectDefineProperty(URL.prototype, 'hostname', {
    configurable: true,
    enumerable: true,
    get: function () {
      var url = recordOf(this);
      return url.host === null ? '' : url.host;
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'hostname');
      if (url.opaque) return;
      basicURLParse(str, undefined, url, HOSTNAME);
    },
  });

  ObjectDefineProperty(URL.prototype, 'port', {
    configurable: true,
    enumerable: true,
    get: function () {
      var url = recordOf(this);
      return url.port === null ? '' : StringG(url.port);
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'port');
      if (cannotHaveUsernamePasswordPort(url)) return;
      if (str === '') {
        url.port = null;
        return;
      }
      basicURLParse(str, undefined, url, PORT);
    },
  });

  ObjectDefineProperty(URL.prototype, 'pathname', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializePath(recordOf(this));
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'pathname');
      if (url.opaque) return;
      url.path = [];
      basicURLParse(str, undefined, url, PATH_START);
    },
  });

  ObjectDefineProperty(URL.prototype, 'search', {
    configurable: true,
    enumerable: true,
    get: function () {
      var q = recordOf(this).query;
      return q === null || q === '' ? '' : '?' + q;
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'search');
      if (str === '') {
        url.query = null;
        refreshSearchParams(this);
        return;
      }
      if (str[0] === '?') str = str.slice(1);
      url.query = '';
      basicURLParse(str, undefined, url, QUERY);
      refreshSearchParams(this);
    },
  });

  ObjectDefineProperty(URL.prototype, 'searchParams', {
    configurable: true,
    enumerable: true,
    get: function () {
      recordOf(this);
      if (this[kSearchParams] === null) {
        this[kSearchParams] = newBoundSearchParams(this);
      }
      return this[kSearchParams];
    },
  });

  ObjectDefineProperty(URL.prototype, 'hash', {
    configurable: true,
    enumerable: true,
    get: function () {
      var f = recordOf(this).fragment;
      return f === null || f === '' ? '' : '#' + f;
    },
    set: function (value) {
      var url = recordOf(this);
      var str = toUSVString(value, 'URL', undefined, 'hash');
      if (str === '') {
        url.fragment = null;
        return;
      }
      if (str[0] === '#') str = str.slice(1);
      url.fragment = '';
      basicURLParse(str, undefined, url, FRAGMENT);
    },
  });

  ObjectDefineProperty(URL.prototype, 'toString', {
    configurable: true,
    writable: true,
    value: function toString() {
      return serializeURL(recordOf(this));
    },
  });

  ObjectDefineProperty(URL.prototype, 'toJSON', {
    configurable: true,
    writable: true,
    value: function toJSON() {
      return serializeURL(recordOf(this));
    },
  });

  ObjectDefineProperty(URL.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'URL',
  });

  // canParse / parse statics (Node 19+/22+).
  ObjectDefineProperty(URL, 'canParse', {
    configurable: true,
    writable: true,
    value: function canParse(input, base) {
      if (arguments.length === 0) throw typeError('URL', 'canParse', argumentsRequired(1, 0));
      return parseURLOrFailure(input, base, 'canParse') !== FAILURE;
    },
  });

  ObjectDefineProperty(URL, 'parse', {
    configurable: true,
    writable: true,
    value: function parse(input, base) {
      if (arguments.length === 0) throw typeError('URL', 'parse', argumentsRequired(1, 0));
      var record = parseURLOrFailure(input, base, 'parse');
      if (record === FAILURE) return null;
      // The constructor's object without its second parse.
      var url = ObjectCreate(URL.prototype);
      url[kRecord] = record;
      url[kSearchParams] = null;
      return url;
    },
  });

  // Preserve the object-URL statics internal/blob.js attaches to globalThis.URL (it
  // runs first and stubs URL). Copy any it already set onto the real class so
  // `URL.createObjectURL`/`revokeObjectURL` keep working.
  var priorURL = globalThis.URL;
  if (priorURL && typeof priorURL === 'object') {
    if (typeof priorURL.createObjectURL === 'function') {
      URL.createObjectURL = priorURL.createObjectURL;
    }
    if (typeof priorURL.revokeObjectURL === 'function') {
      URL.revokeObjectURL = priorURL.revokeObjectURL;
    }
  }

  // The interface objects a page sees (internal/native_shape): Blink's member order
  // and lengths, recorded from Chrome 158 in tests/web/cases/shape-url.expected.
  var PublicURL = defineInterface({
    name: 'URL',
    impl: URL,
    length: 1,
    statics: ['canParse:1', 'parse:1', 'createObjectURL:1', 'revokeObjectURL:1'],
    members: [
      'origin',
      'protocol',
      'username',
      'password',
      'host',
      'hostname',
      'port',
      'pathname',
      'search',
      'searchParams',
      'hash',
      'href',
      'toJSON:0',
      'toString:0',
      'constructor',
      '@@toStringTag',
    ],
  });
  var PublicURLSearchParams = defineInterface({
    name: 'URLSearchParams',
    impl: URLSearchParams,
    length: 0,
    members: [
      'size',
      'append:2',
      'delete:1',
      'get:1',
      'getAll:1',
      'has:1',
      'set:2',
      'sort:0',
      'toString:0',
      'entries:0',
      'forEach:1',
      'keys:0',
      'values:0',
      'constructor',
      '@@toStringTag',
      '@@iterator=entries',
    ],
  });

  module.exports = {
    URL: PublicURL,
    URLSearchParams: PublicURLSearchParams,
  };
});
