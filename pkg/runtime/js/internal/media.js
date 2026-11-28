/**
 * @fileoverview `matchMedia` and MediaQueryList (#14): media queries evaluated against
 * the client profile's viewport and screen (pkg/profile, through internal/layout), so a
 * page's responsive branch picks the profile's device.
 *
 * Evaluated: the media types (`all`, `screen` match; `print` and the rest do not),
 * `not`/`only`, `and`, comma lists, and the features width, height, device-width,
 * device-height, aspect-ratio, device-aspect-ratio, orientation, resolution,
 * -webkit-device-pixel-ratio (each with min-/max- and the `>=`-style range form),
 * prefers-color-scheme (light), prefers-reduced-motion, prefers-contrast,
 * prefers-reduced-transparency, prefers-reduced-data (no-preference), forced-colors,
 * inverted-colors (none), pointer/any-pointer (fine), hover/any-hover (hover),
 * color/color-index/monochrome, color-gamut (srgb), dynamic-range (standard),
 * display-mode (browser), scripting (enabled), update (fast), grid (0). An unknown
 * feature keeps its text and matches nothing; a query that does not parse is `not all`.
 *
 * The viewport never changes, so a MediaQueryList's `change` never fires: listeners
 * and onchange are kept, as Chrome keeps them, and never called.
 *
 * Instantiated eagerly (the loader names it), so every capture below is pristine.
 *
 * @module lava/internal/media
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var eventTarget = require('internal/event_target');
  var layout = require('internal/layout');
  var NumberIsFinite = P.NumberIsFinite;
  var NumberP = P.Number;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeTrim = P.StringPrototypeTrim;
  var TypeErrorP = P.TypeError;
  var EventTargetImpl = eventTarget.EventTargetImpl;
  var argumentsRequired = webErrors.argumentsRequired;
  var illegalInvocation = webErrors.illegalInvocation;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;
  var attachHandler = eventTarget.attachHandler;
  var detachHandler = eventTarget.detachHandler;
  var viewport = layout.viewport;
  // Captured at this eager eval: what addListener/removeListener forward to.
  var addEventListenerP = eventTarget.EventTarget.prototype.addEventListener;
  var removeEventListenerP = eventTarget.EventTarget.prototype.removeEventListener;
  var ReflectApply = P.ReflectApply;

  var INTERNAL = { __proto__: null };
  var NOT_ALL = 'not all';

  // --- parsing -----------------------------------------------------------------------

  function isSpace(c) {
    return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  }

  function lower(s) {
    return StringPrototypeToLowerCase(s);
  }

  // A media query list's queries: split at the commas outside parentheses.
  function splitList(text) {
    var out = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i <= text.length; i++) {
      var c = i < text.length ? StringPrototypeCharCodeAt(text, i) : 44;
      if (c === 40) depth++;
      else if (c === 41) depth--;
      else if (c === 44 && (depth <= 0 || i === text.length)) {
        out[out.length] = StringPrototypeTrim(StringPrototypeSlice(text, start, i));
        start = i + 1;
      }
    }

    return out;
  }

  // One query's tokens: words and parenthesized feature groups.
  function tokens(query) {
    var out = [];
    var i = 0;
    while (i < query.length) {
      var c = StringPrototypeCharCodeAt(query, i);
      if (isSpace(c)) {
        i++;
        continue;
      }

      if (c === 40) {
        var depth = 1;
        var j = i + 1;
        while (j < query.length && depth > 0) {
          var d = StringPrototypeCharCodeAt(query, j);
          if (d === 40) depth++;
          else if (d === 41) depth--;
          j++;
        }

        // An unclosed group is closed by the end of the query, as CSS closes it.
        out[out.length] = {
          __proto__: null,
          group: true,
          text: StringPrototypeSlice(query, i + 1, depth === 0 ? j - 1 : j),
        };
        i = j;
        continue;
      }

      var k = i;
      while (
        k < query.length &&
        !isSpace(StringPrototypeCharCodeAt(query, k)) &&
        StringPrototypeCharCodeAt(query, k) !== 40
      ) {
        k++;
      }

      out[out.length] = {
        __proto__: null,
        group: false,
        text: lower(StringPrototypeSlice(query, i, k)),
      };
      i = k;
    }

    return out;
  }

  // A parsed query: { text, evaluate() } or null when it does not parse.
  function parseQuery(query) {
    var t = tokens(query);
    if (t.length === 0) return null;
    var i = 0;
    var negate = false;
    var prefix = '';
    var type = null;
    if (!t[0].group && (t[0].text === 'not' || t[0].text === 'only')) {
      negate = t[0].text === 'not';
      prefix = t[0].text + ' ';
      i++;
      if (i >= t.length || t[i].group) return null;
    }

    if (i < t.length && !t[i].group) {
      type = t[i].text;
      if (type === 'and' || type === 'or' || type === 'not' || type === 'only') return null;
      i++;
    } else if (prefix !== '') {
      return null;
    }

    var features = [];
    var parts = type === null ? [] : [prefix + type];
    var needAnd = type !== null;
    for (; i < t.length; i++) {
      var tok = t[i];
      if (needAnd) {
        if (tok.group || tok.text !== 'and') return null;
        needAnd = false;
        continue;
      }

      if (!tok.group) return null;
      var f = parseFeature(tok.text);
      if (f === null) return null;
      features[features.length] = f;
      parts[parts.length] = '(' + f.text + ')';
      needAnd = true;
    }

    if (!needAnd) return null;
    var text = '';
    for (var p = 0; p < parts.length; p++) text += (p === 0 ? '' : ' and ') + parts[p];
    return { __proto__: null, text: text, type: type, negate: negate, features: features };
  }

  // `name`, `name: value` or `name <op> value`; the text is Blink's serialization
  // (lower-cased, `: ` between name and value).
  function parseFeature(text) {
    text = StringPrototypeTrim(text);
    var colon = -1;
    var op = -1;
    for (var i = 0; i < text.length; i++) {
      var c = StringPrototypeCharCodeAt(text, i);
      if (c === 58) {
        colon = i;
        break;
      }

      if (c === 60 || c === 62 || c === 61) {
        op = i;
        break;
      }
    }

    if (colon !== -1) {
      var name = lower(StringPrototypeTrim(StringPrototypeSlice(text, 0, colon)));
      var value = lower(
        collapse(StringPrototypeTrim(StringPrototypeSlice(text, colon + 1, text.length))),
      );
      if (name === '' || value === '') return null;
      return { __proto__: null, text: name + ': ' + value, name: name, op: ':', value: value };
    }

    if (op !== -1) {
      var left = lower(StringPrototypeTrim(StringPrototypeSlice(text, 0, op)));
      var end = op + 1;
      if (end < text.length && StringPrototypeCharCodeAt(text, end) === 61) end++;
      var sign = StringPrototypeSlice(text, op, end);
      var right = lower(
        collapse(StringPrototypeTrim(StringPrototypeSlice(text, end, text.length))),
      );
      if (left === '' || right === '') return null;
      return {
        __proto__: null,
        text: left + ' ' + sign + ' ' + right,
        name: left,
        op: sign,
        value: right,
      };
    }

    var bare = lower(text);
    if (bare === '') return null;
    return { __proto__: null, text: bare, name: bare, op: '', value: '' };
  }

  // Inner runs of white space as one space: `16 / 9` stays readable when re-serialized.
  function collapse(s) {
    var out = '';
    var space = false;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (isSpace(c)) {
        space = true;
        continue;
      }

      if (space && out !== '') out += ' ';
      space = false;
      out += StringPrototypeSlice(s, i, i + 1);
    }

    return out;
  }

  // --- evaluation ----------------------------------------------------------------------

  // A length in px; NaN when it is not one.
  function length(v) {
    var end = v.length;
    while (end > 0) {
      var c = StringPrototypeCharCodeAt(v, end - 1);
      if (c >= 97 && c <= 122) end--;
      else break;
    }

    var unit = StringPrototypeSlice(v, end, v.length);
    var n = end === 0 ? NaN : NumberP(StringPrototypeSlice(v, 0, end));
    if (!NumberIsFinite(n)) return NaN;
    if (unit === 'px' || (unit === '' && n === 0)) return n;
    if (unit === 'em' || unit === 'rem') return n * 16;
    if (unit === 'vw') return (n * viewport.width) / 100;
    if (unit === 'vh') return (n * viewport.height) / 100;
    if (unit === 'in') return n * 96;
    if (unit === 'cm') return (n * 96) / 2.54;
    if (unit === 'mm') return (n * 96) / 25.4;
    if (unit === 'pt') return (n * 96) / 72;
    if (unit === 'pc') return n * 16;
    return NaN;
  }

  // A resolution in dppx.
  function resolution(v) {
    var end = v.length;
    while (end > 0) {
      var c = StringPrototypeCharCodeAt(v, end - 1);
      if (c >= 97 && c <= 122) end--;
      else break;
    }

    var unit = StringPrototypeSlice(v, end, v.length);
    var n = end === 0 ? NaN : NumberP(StringPrototypeSlice(v, 0, end));
    if (!NumberIsFinite(n)) return NaN;
    if (unit === 'dppx' || unit === 'x') return n;
    if (unit === 'dpi') return n / 96;
    if (unit === 'dpcm') return (n * 2.54) / 96;
    return NaN;
  }

  // `16/9` as a number.
  function ratio(v) {
    var slash = -1;
    for (var i = 0; i < v.length; i++) {
      if (StringPrototypeCharCodeAt(v, i) === 47) slash = i;
    }

    if (slash === -1) return NumberP(v);
    var a = NumberP(StringPrototypeTrim(StringPrototypeSlice(v, 0, slash)));
    var b = NumberP(StringPrototypeTrim(StringPrototypeSlice(v, slash + 1, v.length)));
    return b === 0 ? NaN : a / b;
  }

  function compare(actual, op, wanted) {
    if (wanted !== wanted) return false;
    if (op === ':' || op === '=') return actual === wanted;
    if (op === 'min') return actual >= wanted;
    if (op === 'max') return actual <= wanted;
    if (op === '>=') return actual >= wanted;
    if (op === '<=') return actual <= wanted;
    if (op === '>') return actual > wanted;
    if (op === '<') return actual < wanted;
    return false;
  }

  // A discrete feature's value in the profile's environment.
  var DISCRETE = {
    __proto__: null,
    'prefers-color-scheme': 'light',
    'prefers-reduced-motion': 'no-preference',
    'prefers-contrast': 'no-preference',
    'prefers-reduced-transparency': 'no-preference',
    'prefers-reduced-data': 'no-preference',
    'forced-colors': 'none',
    'inverted-colors': 'none',
    pointer: 'fine',
    'any-pointer': 'fine',
    hover: 'hover',
    'any-hover': 'hover',
    'color-gamut': 'srgb',
    'dynamic-range': 'standard',
    'video-dynamic-range': 'standard',
    'display-mode': 'browser',
    scripting: 'enabled',
    update: 'fast',
    'overflow-block': 'scroll',
    'overflow-inline': 'scroll',
  };
  // The value a discrete feature has in its boolean context `(hover)`: false only for
  // these.
  var FALSE_IN_BOOLEAN = {
    __proto__: null,
    'no-preference': 1,
    none: 1,
  };

  function evaluateFeature(f) {
    var name = f.name;
    var op = f.op;
    var value = f.value;
    if (op === '<' || op === '>' || op === '<=' || op === '>=' || op === '=') {
      return range(name, op, value);
    }

    var prefix = '';
    if (
      StringPrototypeSlice(name, 0, 4) === 'min-' ||
      StringPrototypeSlice(name, 0, 4) === 'max-'
    ) {
      prefix = StringPrototypeSlice(name, 0, 3);
      name = StringPrototypeSlice(name, 4, name.length);
    } else if (
      StringPrototypeSlice(name, 0, 12) === '-webkit-min-' ||
      StringPrototypeSlice(name, 0, 12) === '-webkit-max-'
    ) {
      prefix = StringPrototypeSlice(name, 8, 11);
      name = '-webkit-' + StringPrototypeSlice(name, 12, name.length);
    }

    if (prefix !== '' && op !== ':') return false;
    var actual = numeric(name);
    if (actual !== null) {
      if (op === '') return actual !== 0;
      return compare(actual, prefix === '' ? ':' : prefix, parseValue(name, value));
    }

    if (prefix !== '') return false;
    var d = DISCRETE[name];
    if (d !== undefined) {
      if (op === '') return FALSE_IN_BOOLEAN[d] !== 1;
      return value === d;
    }

    if (name === 'orientation') {
      var o = viewport.height >= viewport.width ? 'portrait' : 'landscape';
      return op === '' ? true : value === o;
    }

    return false;
  }

  // `(width >= 600px)` and `(600px <= width)`.
  function range(left, op, right) {
    var name = left;
    var value = right;
    if (numeric(left) === null && numeric(right) !== null) {
      name = right;
      value = left;
      op = op === '<' ? '>' : op === '>' ? '<' : op === '<=' ? '>=' : op === '>=' ? '<=' : op;
    }

    var actual = numeric(name);
    return actual === null ? false : compare(actual, op, parseValue(name, value));
  }

  // A numeric feature's value in the profile's environment; null for any other name.
  function numeric(name) {
    switch (name) {
      case 'width':
        return viewport.width;
      case 'height':
        return viewport.height;
      case 'device-width':
        return viewport.screenWidth;
      case 'device-height':
        return viewport.screenHeight;
      case 'aspect-ratio':
        return viewport.width / viewport.height;
      case 'device-aspect-ratio':
        return viewport.screenWidth / viewport.screenHeight;
      case 'resolution':
      case '-webkit-device-pixel-ratio':
        return viewport.dpr;
      case 'color':
        return 8;
      case 'color-index':
      case 'monochrome':
      case 'grid':
        return 0;
    }

    return null;
  }

  function parseValue(name, value) {
    if (name === 'aspect-ratio' || name === 'device-aspect-ratio') return ratio(value);
    if (name === 'resolution') return resolution(value);
    if (name === '-webkit-device-pixel-ratio' || name === 'color' || name === 'color-index') {
      return NumberP(value);
    }

    if (name === 'monochrome' || name === 'grid') return NumberP(value);
    return length(value);
  }

  function evaluateQuery(q) {
    var match = q.type === null || q.type === 'all' || q.type === 'screen';
    for (var i = 0; match && i < q.features.length; i++) match = evaluateFeature(q.features[i]);
    return q.negate ? !match : match;
  }

  // The list's serialization and whether any query matches.
  function evaluate(text) {
    var parts = splitList(text);
    var media = '';
    var matches = false;
    if (parts.length === 1 && parts[0] === '') return [media, true];
    for (var i = 0; i < parts.length; i++) {
      var q = parseQuery(parts[i]);
      var serialized = q === null ? NOT_ALL : q.text;
      media += (i === 0 ? '' : ', ') + serialized;
      if (q !== null && evaluateQuery(q)) matches = true;
    }

    return [media, matches];
  }

  // --- MediaQueryList --------------------------------------------------------------

  var isList;
  var readChangeHandler;

  /**
   * MediaQueryList: a parsed media query list and whether it matches the profile.
   * @node Chrome 158 (tests/web/cases/media-query.expected): the serialization
   *   (lower-cased, `: ` in a feature, `, ` between queries, `not all` for a query that
   *   does not parse) and the matches of the environment-independent queries.
   * @deviates The environment is the profile's: a real desktop's pointer:fine and
   *   hover:hover where headless Chrome answers none. `change` never fires.
   */
  class MediaQueryList extends EventTargetImpl {
    #media;
    #matches;
    #onchange = null;
    #handler = null;

    constructor(token, media, matches) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      super();
      this.#media = media;
      this.#matches = matches;
    }

    static {
      isList = function (o) {
        if (o === null || typeof o !== 'object' || !(#media in o)) throw illegalInvocation();
      };
      readChangeHandler = function (target) {
        return target.#onchange;
      };
    }

    get media() {
      isList(this);
      return this.#media;
    }

    get matches() {
      isList(this);
      return this.#matches;
    }

    get onchange() {
      isList(this);
      return this.#onchange;
    }

    set onchange(fn) {
      isList(this);
      this.#onchange =
        (typeof fn === 'object' && fn !== null) || typeof fn === 'function' ? fn : null;
      if (this.#onchange !== null && this.#handler === null) {
        this.#handler = attachHandler(this, 'change', readChangeHandler);
      } else if (this.#onchange === null && this.#handler !== null) {
        detachHandler(this, 'change', this.#handler);
        this.#handler = null;
      }
    }

    addListener(callback) {
      isList(this);
      if (arguments.length < 1)
        throw typeError('MediaQueryList', 'addListener', argumentsRequired(1, 0));
      if (callback === null || callback === undefined) return;
      ReflectApply(addEventListenerP, this, ['change', callback]);
    }

    removeListener(callback) {
      isList(this);
      if (arguments.length < 1) {
        throw typeError('MediaQueryList', 'removeListener', argumentsRequired(1, 0));
      }

      if (callback === null || callback === undefined) return;
      ReflectApply(removeEventListenerP, this, ['change', callback]);
    }
  }

  nativeShape.defineInterface({
    name: 'MediaQueryList',
    impl: MediaQueryList,
    length: 0,
    illegal: true,
    parent: eventTarget.EventTarget,
    members: [
      'media',
      'matches',
      'onchange',
      'addListener:1',
      'removeListener:1',
      'constructor',
      '@@toStringTag',
    ],
  });

  /**
   * window.matchMedia(query).
   * @param {string} query
   * @returns {MediaQueryList}
   * @throws {TypeError} `Failed to execute 'matchMedia' on 'Window': 1 argument
   *   required, but only 0 present.`
   * @node Chrome 158 (tests/web/cases/media-query.expected).
   * @deviates See MediaQueryList.
   */
  function matchMedia(query) {
    if (arguments.length < 1) throw typeError('Window', 'matchMedia', argumentsRequired(1, 0));
    var r = evaluate(toDOMString(query, 'Window', 'matchMedia'));
    return new MediaQueryList(INTERNAL, r[0], r[1]);
  }

  nativeShape.defineOperation('matchMedia', matchMedia, 1);
});
