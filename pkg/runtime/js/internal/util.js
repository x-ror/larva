// node:util — the subset Lava needs today: inspect() for readable value
// rendering, and format()/formatWithOptions() for printf-style substitution.
// Pure JS, no native dependencies. Ported in spirit from Node's
// lib/internal/util/inspect.js but trimmed to the common cases.
(function (require, module) {
  'use strict';

  // Captured for debugEnvPattern below, which replaced three global-flag replaces on the
  // NODE_DEBUG path. This file is not otherwise hardened — see the ratchet baseline.
  var UtilPrimordials = require('primordials');
  var StringPrototypeCharCodeAt = UtilPrimordials.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = UtilPrimordials.StringPrototypeSlice;
  var StringPrototypeToUpperCase = UtilPrimordials.StringPrototypeToUpperCase;
  var StringPrototypeIndexOf = UtilPrimordials.StringPrototypeIndexOf;
  var StringPrototypeReplaceAll = UtilPrimordials.StringPrototypeReplaceAll;

  // Through the primordials table rather than the live `Symbol` global: this file is
  // evaluated lazily, so a module-eval read here is not the pre-user-code read §5's
  // exemption assumes (the same reasoning that moved fs.js's Buffer capture to loader.js).
  var SymbolFor = UtilPrimordials.SymbolFor;
  var customInspect = SymbolFor ? SymbolFor('nodejs.util.inspect.custom') : null;

  // node PICKS the quote character to avoid escaping rather than always using single
  // quotes. Its strEscape tests, in order: single by default; DOUBLE when the string
  // contains a single quote but no double; BACKTICK when it contains both AND contains
  // neither a backtick NOR the substring `${`; single-with-escapes otherwise. Verified on
  // node 24.18.1:
  //   plain         -> 'plain'          it's        -> "it's"
  //   say "hi"      -> 'say "hi"'       ' and "     -> `both ' and "`
  //   ` and ' and " -> 'all ` \' " '     a'b"c${d}   -> 'a\'b"c${d}'
  //
  // The `${` half is not cosmetic and an earlier revision omitted it: inspect output is
  // meant to read back as a literal, and a backtick-delimited string containing `${` is a
  // live template substitution. That revision also made this comment state the rule
  // without it, so the comment agreed with the code and neither agreed with node.
  //
  // ESCAPES, matching node's strEscape exactly. Measured on node 24.18.1 across the whole
  // C0 range, DEL/C1 and surrogates:
  //   \b \t \n \f \r      the five with short forms — note 0x0B is `\x0B`, NOT `\v`
  //   other c < 0x20        `\xNN`, UPPERCASE hex
  //   0x7F..0x9F            `\xNN` (DEL and the C1 block); 0xA0 stays literal
  //   unpaired surrogate    `\udXXX`, LOWERCASE hex — node ESCAPES it rather than
  //                         replacing it with U+FFFD, so the value stays lossless
  //   a valid pair          literal (an emoji prints as itself)
  //
  // This used to escape only the backslash and \n, which was a security gap and not a
  // cosmetic one: an unescaped `\x1B` makes any line built with util.inspect an
  // ANSI-injection vector, and a lone surrogate came back as U+FFFD — lossy, not merely
  // rendered differently. Raised on #330 review; #331 keeps the remaining half, the
  // missing maxArrayLength / maxStringLength caps.
  //
  // A code-unit loop rather than a regex, per §5, batching literal runs so the common case
  // (nothing to escape) costs one slice instead of per-character concatenation.
  var HEX_UPPER = '0123456789ABCDEF';
  var HEX_LOWER = '0123456789abcdef';
  function escByte(c) {
    return '\\x' + HEX_UPPER[(c >> 4) & 0xf] + HEX_UPPER[c & 0xf];
  }
  function escUnit(c) {
    return (
      '\\u' +
      HEX_LOWER[(c >> 12) & 0xf] +
      HEX_LOWER[(c >> 8) & 0xf] +
      HEX_LOWER[(c >> 4) & 0xf] +
      HEX_LOWER[c & 0xf]
    );
  }

  function quote(s) {
    var q = "'";
    if (StringPrototypeIndexOf(s, "'") !== -1) {
      if (StringPrototypeIndexOf(s, '"') === -1) q = '"';
      else if (StringPrototypeIndexOf(s, '`') === -1 && StringPrototypeIndexOf(s, '${') === -1)
        q = '`';
    }
    var delim = StringPrototypeCharCodeAt(q, 0);
    var out = '';
    var runStart = 0;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      var esc = null;
      if (c === 0x5c) esc = '\\\\';
      // Only the single quote can ever need this: the other two delimiters are chosen
      // precisely because they are absent from the string.
      else if (c === delim) esc = '\\' + q;
      else if (c === 0x08) esc = '\\b';
      else if (c === 0x09) esc = '\\t';
      else if (c === 0x0a) esc = '\\n';
      else if (c === 0x0c) esc = '\\f';
      else if (c === 0x0d) esc = '\\r';
      else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) esc = escByte(c);
      else if (c >= 0xd800 && c <= 0xdbff) {
        // A high surrogate is literal only when a low one follows; otherwise it is lone.
        var next = i + 1 < s.length ? StringPrototypeCharCodeAt(s, i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) i++; // consume the pair
        else esc = escUnit(c);
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        // Reached only when no high surrogate preceded — a paired low was consumed above.
        esc = escUnit(c);
      }
      if (esc !== null) {
        out += StringPrototypeSlice(s, runStart, i) + esc;
        runStart = i + 1;
      }
    }
    return q + out + StringPrototypeSlice(s, runStart) + q;
  }

  function inspect(v, opts, seen, depth) {
    opts = opts || {};
    seen = seen || [];
    depth = depth || 0;
    var maxDepth = opts.depth === undefined ? 2 : opts.depth === null ? Infinity : opts.depth;

    var t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return quote(v);
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') {
      var fn = v.name;
      return fn ? '[Function: ' + fn + ']' : '[Function (anonymous)]';
    }
    // Honor the util.inspect custom hook (Buffer renders as "<Buffer ..>"). Node
    // passes (depth, options, inspect) and formats whatever the hook returns:
    // a string is used verbatim, anything else (number, object, …) is inspected
    // in its place, and returning the object itself falls through to default
    // formatting.
    if (customInspect && typeof v[customInspect] === 'function') {
      var nested = seen.concat([v]);
      var recurse = function (val, o) {
        return inspect(val, o || opts, nested, depth + 1);
      };
      var custom = v[customInspect](depth, opts, recurse);
      if (custom !== v) {
        return typeof custom === 'string' ? custom : inspect(custom, opts, nested, depth);
      }
    }
    if (seen.indexOf(v) !== -1) return '[Circular *1]';
    if (v instanceof Error) return v.stack ? v.stack : v.name + ': ' + v.message;
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return v.toString();
    if (depth > maxDepth) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen = seen.concat([v]);

    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(inspect(v[i], opts, seen, depth + 1));
      return '[ ' + arr.join(', ') + ' ]';
    }
    if (typeof Map !== 'undefined' && v instanceof Map) {
      var mp = [];
      v.forEach(function (val, key) {
        mp.push(inspect(key, opts, seen, depth + 1) + ' => ' + inspect(val, opts, seen, depth + 1));
      });
      return 'Map(' + v.size + ') {' + (mp.length > 0 ? ' ' + mp.join(', ') + ' ' : '') + '}';
    }
    if (typeof Set !== 'undefined' && v instanceof Set) {
      var st = [];
      v.forEach(function (val) {
        st.push(inspect(val, opts, seen, depth + 1));
      });
      return 'Set(' + v.size + ') {' + (st.length > 0 ? ' ' + st.join(', ') + ' ' : '') + '}';
    }

    var keys = Object.keys(v);
    var ctor = v.constructor && v.constructor.name;
    var prefix = ctor && ctor !== 'Object' ? ctor + ' ' : '';
    if (keys.length === 0) return prefix + '{}';
    var props = [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
      props.push(name + ': ' + inspect(v[key], opts, seen, depth + 1));
    }
    return prefix + '{ ' + props.join(', ') + ' }';
  }

  function stringify(v) {
    return typeof v === 'string' ? v : inspect(v, {}, [], 1);
  }

  function formatWithOptions(opts, _f) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length === 0) return '';
    var first = args[0];
    // Node's short circuit, and it must come BEFORE the substitution loop rather
    // than inside it: a lone string argument is the answer, directives and all.
    // `format('%s')`, `format('%z')`, `format('100%')` and `format('%%')` all come
    // back untouched on node 24 (verified, not read off the docs).
    // Only `%%` used to get this wrong here — `%s` and friends were saved further
    // down by the "arguments exhausted" branch, which re-emits the directive, while
    // `%%` was folded unconditionally.
    // `typeof first === 'string'` matters: `format(5, '%%')` has no format string
    // at all, so node inspects and space-joins, leaving the later `%%` literal.
    if (args.length === 1 && typeof first === 'string') return first;
    var i = 1;
    var result;
    if (typeof first === 'string' && first.indexOf('%') !== -1) {
      result = '';
      for (var p = 0; p < first.length; p++) {
        var ch = first.charAt(p);
        if (ch === '%' && p + 1 < first.length) {
          var spec = first.charAt(p + 1);
          if (spec === '%') {
            result += '%';
            p++;
            continue;
          }
          if ('sdifjoOc'.indexOf(spec) !== -1) {
            if (i >= args.length) {
              result += '%' + spec;
              p++;
              continue;
            }
            var a = args[i++];
            p++;
            if (spec === 's') result += typeof a === 'string' ? a : stringify(a);
            else if (spec === 'd' || spec === 'i')
              result +=
                typeof a === 'bigint'
                  ? String(a) + 'n'
                  : typeof a === 'symbol'
                    ? 'NaN'
                    : String(Math.trunc(Number(a)));
            else if (spec === 'f') result += typeof a === 'symbol' ? 'NaN' : String(parseFloat(a));
            else if (spec === 'j') {
              try {
                result += JSON.stringify(a);
              } catch {
                result += '[Circular]';
              }
            } else if (spec === 'o' || spec === 'O') result += inspect(a, opts, [], 1);
            /* spec === "c": CSS directive, consumed and ignored */
            continue;
          }
        }
        result += ch;
      }
    } else {
      result = stringify(first);
    }
    for (; i < args.length; i++) result += ' ' + stringify(args[i]);
    return result;
  }

  function format(_f) {
    return formatWithOptions.apply(null, [{}].concat(Array.prototype.slice.call(arguments)));
  }

  // util.promisify — wrap a (…args, callback(err, value)) function as one returning a
  // Promise. Honors the util.promisify.custom symbol and copies the original's own
  // properties / prototype, matching Node (the multi-arg `customArgs` form is omitted).
  var kCustomPromisify = Symbol.for('nodejs.util.promisify.custom');

  function promisify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('The "original" argument must be of type function');
    }
    if (original[kCustomPromisify]) {
      var custom = original[kCustomPromisify];
      if (typeof custom !== 'function') {
        throw new TypeError('The "util.promisify.custom" property must be of type function');
      }
      return custom;
    }
    function fn() {
      var args = Array.prototype.slice.call(arguments);
      var self = this;
      return new Promise(function (resolve, reject) {
        args.push(function (err, value) {
          if (err) reject(err);
          else resolve(value);
        });
        Reflect.apply(original, self, args);
      });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisify, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  }
  promisify.custom = kCustomPromisify;

  // util.callbackify — the inverse: wrap an async/Promise-returning function as one
  // taking a Node-style (err, value) callback. Rejections are delivered on a fresh tick;
  // a falsy rejection reason is wrapped like Node.
  function callbackify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('The "original" argument must be of type function');
    }
    function callbackified() {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      if (typeof cb !== 'function') {
        throw new TypeError('The last argument must be of type function');
      }
      var self = this;
      Promise.resolve(Reflect.apply(original, self, args)).then(
        function (ret) {
          process.nextTick(cb.bind(self, null, ret));
        },
        function (rej) {
          var reason = rej;
          if (!reason) {
            reason = new Error('Promise was rejected with a falsy value');
            reason.reason = rej;
          }
          process.nextTick(cb.bind(self, reason));
        },
      );
    }
    Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
    Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original));
    return callbackified;
  }

  // util.inherits — set up classic prototypal inheritance and the `super_` back-link.
  function inherits(ctor, superCtor) {
    if (ctor == null || typeof ctor !== 'function') {
      throw new TypeError('The "ctor" argument must be of type function');
    }
    if (superCtor == null || typeof superCtor !== 'function') {
      throw new TypeError('The "superCtor" argument must be of type function');
    }
    if (superCtor.prototype === undefined) {
      throw new TypeError('The "superCtor.prototype" property must be of type object');
    }
    Object.defineProperty(ctor, 'super_', {
      value: superCtor,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }

  // util.deprecate — return a wrapper that emits a one-time deprecation warning, then
  // delegates to fn. Suppressed entirely when process.noDeprecation is set.
  function deprecate(fn, msg, code) {
    if (process.noDeprecation === true) return fn;
    var warned = false;
    function deprecated() {
      if (!warned) {
        warned = true;
        if (typeof process.emitWarning === 'function') {
          process.emitWarning(msg, 'DeprecationWarning', code);
        } else {
          console.error('DeprecationWarning: ' + msg);
        }
      }
      return Reflect.apply(fn, this, arguments);
    }
    return deprecated;
  }

  // util.isDeepStrictEqual — structural strict equality, matching Node's algorithm:
  // SameValue-ish primitives (NaN equal, +0 !== -0), matching prototype + [[Class]] tag,
  // special handling for Date/RegExp/Error/boxed primitives/Map/Set/ArrayBuffer/TypedArray/
  // DataView, recursive comparison of own enumerable string + symbol keys, and circular refs.
  var objTag = function (v) {
    return Object.prototype.toString.call(v);
  };

  function bytesEqual(x, y) {
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function ownEnumerableKeys(o) {
    var keys = Object.keys(o);
    var syms = Object.getOwnPropertySymbols(o);
    for (var i = 0; i < syms.length; i++) {
      if (Object.prototype.propertyIsEnumerable.call(o, syms[i])) keys.push(syms[i]);
    }
    return keys;
  }

  function keysEqual(a, b, aStack, bStack) {
    var aKeys = ownEnumerableKeys(a);
    if (aKeys.length !== ownEnumerableKeys(b).length) return false;
    for (var i = 0; i < aKeys.length; i++) {
      var k = aKeys[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepStrict(a[k], b[k], aStack, bStack)) return false;
    }
    return true;
  }

  function collectionEqual(aEntries, bEntries, withValue, aStack, bStack) {
    var used = new Array(bEntries.length);
    for (var i = 0; i < aEntries.length; i++) {
      var found = false;
      for (var j = 0; j < bEntries.length; j++) {
        if (used[j]) continue;
        var keyOk = deepStrict(aEntries[i][0], bEntries[j][0], aStack, bStack);
        var valOk = !withValue || deepStrict(aEntries[i][1], bEntries[j][1], aStack, bStack);
        if (keyOk && valOk) {
          used[j] = true;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function deepStrict(a, b, aStack, bStack) {
    if (a === b) return a !== 0 || Object.is(a, b); // +0 !== -0; everything else equal
    if (typeof a !== 'object' || a === null) {
      // primitive (or null) — equal only if both are NaN
      return typeof a === 'number' && a !== a && typeof b === 'number' && b !== b;
    }
    if (typeof b !== 'object' || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

    var tag = objTag(a);
    if (tag !== objTag(b)) return false;

    switch (tag) {
      case '[object Number]':
      case '[object Boolean]':
      case '[object String]':
      case '[object BigInt]':
      case '[object Symbol]': {
        var av = a.valueOf();
        var bv = b.valueOf();
        if (av === bv) return av !== 0 || Object.is(av, bv);
        return typeof av === 'number' && av !== av && bv !== bv;
      }
      case '[object Date]':
        return Object.is(a.getTime(), b.getTime());
      case '[object RegExp]':
        if (a.source !== b.source || a.flags !== b.flags) return false;
        break;
      case '[object Error]':
        if (a.name !== b.name || a.message !== b.message) return false;
        break;
      case '[object ArrayBuffer]':
        if (a.byteLength !== b.byteLength) return false;
        return bytesEqual(new Uint8Array(a), new Uint8Array(b));
      case '[object DataView]':
        if (a.byteLength !== b.byteLength) return false;
        return bytesEqual(
          new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
          new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
        );
    }

    // Typed arrays: element-wise (NaN-aware); then fall through to compare any extra keys.
    if (ArrayBuffer.isView(a) && tag !== '[object DataView]') {
      if (a.length !== b.length) return false;
      for (var t = 0; t < a.length; t++) {
        if (!(a[t] === b[t] || (a[t] !== a[t] && b[t] !== b[t]))) return false;
      }
    }

    // Circular-reference guard.
    for (var s = 0; s < aStack.length; s++) {
      if (aStack[s] === a) return bStack[s] === b;
    }
    aStack.push(a);
    bStack.push(b);

    var result;
    if (tag === '[object Map]') {
      if (a.size !== b.size) {
        result = false;
      } else {
        var aME = [];
        var bME = [];
        a.forEach(function (v, k) {
          aME.push([k, v]);
        });
        b.forEach(function (v, k) {
          bME.push([k, v]);
        });
        result = collectionEqual(aME, bME, true, aStack, bStack);
      }
    } else if (tag === '[object Set]') {
      if (a.size !== b.size) {
        result = false;
      } else {
        var aSE = [];
        var bSE = [];
        a.forEach(function (v) {
          aSE.push([v]);
        });
        b.forEach(function (v) {
          bSE.push([v]);
        });
        result = collectionEqual(aSE, bSE, false, aStack, bStack);
      }
    } else {
      result = keysEqual(a, b, aStack, bStack);
    }

    aStack.pop();
    bStack.pop();
    return result;
  }

  function isDeepStrictEqual(a, b) {
    return deepStrict(a, b, [], []);
  }

  // The live color table backing both util.inspect.colors and util.styleText. Exposed as
  // util.inspect.colors below, so a caller can add or change a style and have styleText
  // pick it up (Node parity). Null-prototype, so a key like 'constructor' resolves to
  // undefined rather than an inherited function. Names map to [openCode, closeCode].
  var inspectColors = {
    __proto__: null,
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    blink: [5, 25],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    doubleunderline: [21, 24],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    framed: [51, 54],
    overlined: [53, 55],
    gray: [90, 39],
    grey: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
    bgGray: [100, 49],
    bgGrey: [100, 49],
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49],
    // Aliases, as in Node's util.inspect.colors.
    blackBright: [90, 39],
    bgBlackBright: [100, 49],
    faint: [2, 22],
    conceal: [8, 28],
    strikeThrough: [9, 29],
    crossedOut: [9, 29],
    doubleUnderline: [21, 24],
    swapColors: [7, 27],
  };

  // ERR_INVALID_ARG_TYPE and ERR_INVALID_ARG_VALUE are both TypeErrors in Node, so
  // `err instanceof TypeError` works alongside `err.code`.
  function styleTextError(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  function styleText(format, text, options) {
    if (typeof text !== 'string') {
      throw styleTextError(
        'ERR_INVALID_ARG_TYPE',
        'The "text" argument must be of type string. Received ' + typeof text,
      );
    }
    var formats = Array.isArray(format) ? format : [format];
    var open = '';
    var close = '';
    for (var i = 0; i < formats.length; i++) {
      var f = formats[i];
      if (f === 'none') continue;
      // Read from the live inspectColors so a caller-added/overridden style is honored.
      var codes = typeof f === 'string' ? inspectColors[f] : undefined;
      if (codes === undefined) {
        throw styleTextError(
          'ERR_INVALID_ARG_VALUE',
          "The argument 'format' must be a valid style. Received " + inspect(f, {}, [], 1),
        );
      }
      open += '\x1b[' + codes[0] + 'm';
      close = '\x1b[' + codes[1] + 'm' + close; // closes unwind in reverse
    }

    options = options || {};
    var validateStream = options.validateStream;
    // null/undefined default to true (Node uses `?? true`); other falsy values force color.
    if (validateStream === undefined || validateStream === null) validateStream = true;
    // A falsy validateStream forces the codes (skips the TTY check); a truthy non-boolean
    // is rejected — Node only type-checks it on this path.
    if (validateStream) {
      if (typeof validateStream !== 'boolean') {
        throw styleTextError(
          'ERR_INVALID_ARG_TYPE',
          'The "options.validateStream" property must be of type boolean. Received ' +
            typeof validateStream,
        );
      }
      var stream =
        options.stream !== undefined
          ? options.stream
          : typeof process !== 'undefined'
            ? process.stdout
            : undefined;
      if (!stream || !stream.isTTY) return text;
    }
    return open + text + close;
  }

  // Node's ANSI/VT escape matcher (lib/internal/util.js): SGR colors, cursor moves, and
  // OSC sequences such as hyperlinks. An OSC string may be terminated by BEL () or
  // ST in either form (ESC \ = \, or the C1 byte ) — Node accepts all
  // three, so we do too. Reproduced so the stripped output is byte-identical to Node's.
  // Built once; String.prototype.replace with a global regex resets lastIndex per call.
  var ansiRegex = new RegExp(
    '[\\u001B\\u009B][[\\]()#;?]*' +
      '(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*' +
      '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))' +
      '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
    'g',
  );

  function stripVTControlCharacters(str) {
    if (typeof str !== 'string') {
      throw styleTextError(
        'ERR_INVALID_ARG_TYPE',
        'The "str" argument must be of type string. Received ' + typeof str,
      );
    }
    // Short-circuit when there is no ESC (7-bit) or CSI (8-bit) introducer at all.
    if (str.indexOf('\u001B') === -1 && str.indexOf('\u009B') === -1) return str;
    return str.replace(ansiRegex, '');
  }

  // util.toUSVString — coerce to a string of Unicode scalar values, replacing each lone
  // surrogate with U+FFFD. Matches Node: it string-coerces via `${value}` (the string hint,
  // so an object's toString wins over valueOf — `'' + value` would use the default hint and
  // diverge) then well-forms. A Symbol throws on coercion, as in Node.
  function toUSVString(value) {
    var str = `${value}`;
    if (typeof str.toWellFormed === 'function') return str.toWellFormed();
    // Fallback for engines without String.prototype.toWellFormed (ES2024).
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += str[i] + str[i + 1];
          i++;
        } else {
          out += '\uFFFD';
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out += '\uFFFD';
      } else {
        out += str[i];
      }
    }
    return out;
  }

  // --- util.debuglog / util.debug ---
  // NODE_DEBUG is a comma-separated list of sections (no whitespace trimming); `*` is a
  // wildcard and matching is case-insensitive. Node compiles it once into an anchored regex
  // (escape regex specials, then `*` -> `.*`, `,` -> alternation) tested against the
  // upper-cased section name.
  // debugEnvPattern compiles NODE_DEBUG into the body of that anchored regex in ONE
  // pass, where Node (and this file, before) chained three global replaces:
  //
  //   .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')   escape the regex specials
  //   .replace(/\*/g, '.*')                    '*' is the wildcard
  //   .replace(/,/g, '$|^')                    ',' separates sections
  //
  // Three global replaces are three spin-forever sites: under a forged
  // `RegExp.prototype.exec` a global replace never advances `lastIndex`, so it does not
  // answer wrongly, it never returns — and this one runs on the FIRST debuglog call, so
  // the process wedges at the point it tries to emit a diagnostic. node answers
  // correctly under the same poison, so it was a Lava-only defect; pinned by
  // tests/node-compat/cases/59-global-replace-hangs.js.
  //
  // Collapsing the three passes into one is sound because they cannot feed each other:
  // the escape set contains neither `*` nor `,`, so those survive step 1 untouched, and
  // neither `.*` nor `$|^` introduces a character a later step would rewrite.
  function debugEnvPattern(env) {
    var out = '';
    for (var i = 0; i < env.length; i++) {
      var c = StringPrototypeCharCodeAt(env, i);
      if (c === 0x2a) {
        out += '.*'; // '*' wildcard
      } else if (c === 0x2c) {
        out += '$|^'; // ',' section separator
      } else if (isRegExpSpecial(c)) {
        out += '\\' + StringPrototypeSlice(env, i, i + 1);
      } else {
        out += StringPrototypeSlice(env, i, i + 1);
      }
    }
    return StringPrototypeToUpperCase(out);
  }

  // The `[|\\{}()[\]^$+?.]` class, as code units. `*` and `,` are deliberately absent —
  // they are the two the caller rewrites rather than escapes.
  function isRegExpSpecial(c) {
    return (
      c === 0x7c || // |
      c === 0x5c || // \
      c === 0x7b || // {
      c === 0x7d || // }
      c === 0x28 || // (
      c === 0x29 || // )
      c === 0x5b || // [
      c === 0x5d || // ]
      c === 0x5e || // ^
      c === 0x24 || // $
      c === 0x2b || // +
      c === 0x3f || // ?
      c === 0x2e //    .
    );
  }

  var debugEnvRegex = /^$/;
  var debugEnvInitialized = false;
  function initDebugEnv() {
    if (debugEnvInitialized) return;
    debugEnvInitialized = true;
    var env = typeof process !== 'undefined' && process.env ? process.env.NODE_DEBUG : '';
    if (env) {
      debugEnvRegex = new RegExp('^' + debugEnvPattern(env) + '$', 'i');
    }
  }
  function testEnabled(section) {
    initDebugEnv();
    return debugEnvRegex.exec(section) !== null;
  }

  var debugImpls = { __proto__: null };
  function debuglogImpl(enabled, section) {
    if (debugImpls[section] === undefined) {
      if (enabled) {
        debugImpls[section] = function () {
          var args = [{}];
          for (var i = 0; i < arguments.length; i++) args[i + 1] = arguments[i];
          var msg = formatWithOptions.apply(null, args);
          var pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
          process.stderr.write(format('%s %d: %s\n', section, pid, msg));
        };
      } else {
        debugImpls[section] = function () {};
      }
    }
    return debugImpls[section];
  }

  function debuglog(set, cb) {
    var enabled;
    function init() {
      set = String(set).toUpperCase();
      enabled = testEnabled(set);
    }
    // The heavy impl is built lazily on the first call; the optional callback is invoked then
    // (once) with the real logger so callers can capture/replace it.
    var debug = function () {
      init();
      debug = debuglogImpl(enabled, set);
      if (typeof cb === 'function') {
        Object.defineProperty(debug, 'enabled', {
          get: function () {
            return enabled;
          },
          configurable: true,
          enumerable: true,
        });
        cb(debug);
      }
      return debug.apply(this, arguments);
    };
    var test = function () {
      init();
      test = function () {
        return enabled;
      };
      return enabled;
    };
    var logger = function () {
      if (enabled === false) return;
      return debug.apply(this, arguments);
    };
    Object.defineProperty(logger, 'enabled', {
      get: function () {
        return test();
      },
      configurable: true,
      enumerable: true,
    });
    return logger;
  }

  // Node's ERR_INVALID_ARG_TYPE "Received ..." clause: a primitive shows `type <typeof>
  // (<value>)`, null/undefined as-is, an object `an instance of <constructor>`.
  function receivedType(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'undefined') return 'undefined';
    if (t === 'object') {
      var name = v.constructor && v.constructor.name ? v.constructor.name : 'Object';
      return 'an instance of ' + name;
    }
    return 'type ' + t + ' (' + String(v) + ')';
  }

  function isAbortSignalLike(s) {
    return (
      s !== null &&
      typeof s === 'object' &&
      typeof s.addEventListener === 'function' &&
      typeof s.aborted === 'boolean'
    );
  }

  // util.aborted(signal, resource) — like Node, an async function: the returned Promise
  // fulfills when `signal` aborts (with the abort event) or immediately (with undefined) if it
  // is already aborted, and a bad argument REJECTS rather than throwing synchronously. The
  // `resource` must be an object/function — Node holds it weakly so the listener drops when the
  // resource is GC'd; the weak ref is not observable here, but the type check is.
  async function aborted(signal, resource) {
    if (!isAbortSignalLike(signal)) {
      throw styleTextError(
        'ERR_INVALID_ARG_TYPE',
        'The "signal" argument must be an instance of AbortSignal. Received ' +
          receivedType(signal),
      );
    }
    if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) {
      throw styleTextError(
        'ERR_INVALID_ARG_TYPE',
        'The "resource" argument must be of type object. Received ' + receivedType(resource),
      );
    }
    if (signal.aborted) return undefined;
    return new Promise(function (resolve) {
      // lava's AbortSignal.addEventListener ignores the options object, so `{ once: true }`
      // would not auto-remove the listener — wrap the resolver and remove it explicitly so
      // repeated aborted() calls on a long-lived signal cannot accumulate dead listeners.
      function onAbort(event) {
        signal.removeEventListener('abort', onAbort);
        resolve(event);
      }
      signal.addEventListener('abort', onAbort);
    });
  }

  function inspectPublic(v, opts) {
    return inspect(v, opts, [], 0);
  }
  // util.inspect.colors is the live style table (styleText reads it); util.inspect.custom
  // is the symbol a value implements to control its own inspection.
  inspectPublic.colors = inspectColors;
  if (customInspect) inspectPublic.custom = customInspect;

  module.exports = {
    inspect: inspectPublic,
    format: format,
    formatWithOptions: formatWithOptions,
    promisify: promisify,
    callbackify: callbackify,
    inherits: inherits,
    deprecate: deprecate,
    isDeepStrictEqual: isDeepStrictEqual,
    debuglog: debuglog,
    debug: debuglog, // Node aliases util.debug to util.debuglog
    aborted: aborted,
    parseArgs: require('parse_args').parseArgs,
    parseEnv: require('parse_env').parseEnv,
    MIMEType: require('mime').MIMEType,
    MIMEParams: require('mime').MIMEParams,
    styleText: styleText,
    stripVTControlCharacters: stripVTControlCharacters,
    toUSVString: toUSVString,
    // Node exposes the same object via require('node:util').types and
    // require('node:util/types'); many packages use the former.
    types: require('util/types'),
  };
});
