// util.inspect, util.format/formatWithOptions, util.stripVTControlCharacters and the
// util.inspect.colors table — where node keeps them: lib/internal/util/inspect.js. Pure
// JS, no native dependencies; ported in spirit from node's file but trimmed to the
// common cases. node/util re-exports these and reads `inspectColors` for styleText;
// internal/util/debuglog formats through format/formatWithOptions.
(function (require, module) {
  'use strict';

  var UtilPrimordials = require('internal/primordials');
  var ERR_INVALID_ARG_TYPE = require('internal/errors').ERR_INVALID_ARG_TYPE;
  var StringPrototypeCharCodeAt = UtilPrimordials.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = UtilPrimordials.StringPrototypeSlice;
  var StringPrototypeIndexOf = UtilPrimordials.StringPrototypeIndexOf;

  // Through the primordials table rather than the live `Symbol` global: this file is
  // evaluated lazily, so a module-eval read here is not the pre-user-code read §5's
  // exemption assumes (the same reasoning that moved fs.js's Buffer capture to loader.js).
  var SymbolFor = UtilPrimordials.SymbolFor;
  var customInspect = SymbolFor ? SymbolFor('nodejs.util.inspect.custom') : null;

  // node PICKS the quote character to avoid escaping rather than always using single
  // quotes. Its strEscape tests, in order: single by default; DOUBLE when the string
  // contains a single quote but no double; BACKTICK when it contains both AND contains
  // neither a backtick NOR the substring `${`; single-with-escapes otherwise. Verified on
  // node 26.13.0 (probe, 2026-11-16):
  //   plain         -> 'plain'          it's        -> "it's"
  //   say "hi"      -> 'say "hi"'       ' and "     -> `both ' and "`
  //   ` and ' and " -> 'all ` \' " '     a'b"c${d}   -> 'a\'b"c${d}'
  //
  // The `${` half is not cosmetic and an earlier revision omitted it: inspect output is
  // meant to read back as a literal, and a backtick-delimited string containing `${` is a
  // live template substitution. That revision also made this comment state the rule
  // without it, so the comment agreed with the code and neither agreed with node.
  //
  // ESCAPES, matching node's strEscape exactly. Measured on node 26.13.0 across the whole
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
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++; // consume the pair
        } else {
          esc = escUnit(c);
        }
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
    // back untouched on node 26.13.0 (verified by
    // tests/node-compat/cases/57-format-single-arg.js, not read off the docs).
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

  // Node's ANSI/VT escape matcher (lib/internal/util.js): SGR colors, cursor moves, and
  // OSC sequences such as hyperlinks. An OSC string may be terminated by BEL () or
  // ST in either form (ESC \ = \, or the C1 byte ) — Node accepts all
  // three, so we do too. Reproduced so the stripped output is byte-identical to Node's.
  // Built once; String.prototype.replace with a global regex resets lastIndex per call.
  // A literal, not `new RegExp(...)`: util is LAZY, so a module-eval `RegExp` read here
  // takes whatever user code left on globalThis (#426). Same pattern as Node's string
  // form, its U+005C escape spelled as an escaped backslash (the same one character).
  // Not `new P.RegExp` either: scripts/check-global-replace.mjs only recognises a bare
  // `RegExp` callee or a literal, so that spelling hides the binding from that gate.
  // prettier-ignore
  var ansiRegex = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\u0007|\u001B\\|\u009C))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

  function stripVTControlCharacters(str) {
    if (typeof str !== 'string') {
      throw ERR_INVALID_ARG_TYPE('str', 'string', str);
    }
    // Short-circuit when there is no ESC (7-bit) or CSI (8-bit) introducer at all.
    if (str.indexOf('\u001B') === -1 && str.indexOf('\u009B') === -1) return str;
    return str.replace(ansiRegex, '');
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
    stripVTControlCharacters: stripVTControlCharacters,
    inspectColors: inspectColors,
  };
});
