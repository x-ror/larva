/**
 * @fileoverview Reflected IDL attributes (HTML §2.6.1 "Reflecting content attributes in
 * IDL attributes") and DOMTokenList (DOM Standard §7.1) for the element interfaces
 * internal/dom defines.
 *
 * One declarative table, REFLECT, names each interface's reflected members in Blink's
 * prototype order, with the content attribute and the reflection kind of each: DOMString,
 * boolean, long and unsigned long (with their defaults), enumerated (keywords, missing and
 * invalid value defaults, nullable), USVString URL (resolved against the document base
 * URL), and DOMTokenList ([PutForwards=value]). The few members whose getter is not a
 * plain reflection (hidden, translate, spellcheck, draggable, script `async` and `text`,
 * a form's `action`, the hyperlink URL decomposition) are `custom` rows of the same
 * table. internal/dom asks `members` for an interface's rows: they become accessors on
 * its implementation prototype, which internal/native_shape then re-lays and wraps like
 * every other member. A WebIDL generator (docs/LARVA.md stage 4b) would emit this
 * table; until then it is hand-written, and holds only what is listed below.
 *
 * Every setter writes through internal/dom's observed setAttribute/removeAttribute
 * (internal/mutation_observer's wrappers), so a MutationObserver sees an IDL write as it
 * sees setAttribute. Every getter reads the content attribute afresh: nothing is cached,
 * so a reflected value cannot go stale against the tree.
 *
 * Required by internal/dom, so loaded with it — before a page's first script — and the
 * captures below are still pristine.
 *
 * @module lava/internal/dom_reflect
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var nativeShape = require('internal/native_shape');
  var DOMException = require('internal/domexception').DOMException;
  var URLP = require('internal/url').URL;
  var documentURL = require('internal/location').documentURL;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var ArrayPrototypeJoin = P.ArrayPrototypeJoin;
  var NumberP = P.Number;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ObjectGetPrototypeOf = P.ObjectGetPrototypeOf;
  var ReflectApply = P.ReflectApply;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToWellFormed = P.StringPrototypeToWellFormed;
  var TypeErrorP = P.TypeError;
  var WeakMapP = P.WeakMap;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var argumentsRequired = webErrors.argumentsRequired;
  var attributeContext = webErrors.attributeContext;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var toDOMStringIn = webErrors.toDOMStringIn;
  var typeError = webErrors.typeError;

  var EMPTY = [];
  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
  var INT_MAX = 2147483647;
  var INT_MIN = -2147483648;
  var LOWER = 'abcdefghijklmnopqrstuvwxyz';

  // URL's accessors, captured: URL.prototype is the page's to replace, and these read
  // URL records this file made (as internal/location does).
  function urlAccessor(name) {
    return ObjectGetOwnPropertyDescriptor(URLP.prototype, name);
  }
  var urlHref = urlAccessor('href').get;
  var urlOrigin = urlAccessor('origin').get;

  // The natives (internal/dom's, the mutating ones already wrapped for
  // MutationObserver), bound by install before any member here can run.
  var nInterface = null;
  var nDocument = null;
  var nNodeType = null;
  var nParent = null;
  var nFirstChild = null;
  var nNextSibling = null;
  var nData = null;
  var nLocalName = null;
  var nTextContent = null;
  var nSetTextContent = null;
  var nGetAttribute = null;
  var nSetAttribute = null;
  var nRemoveAttribute = null;
  var nQuery = null;
  // internal/dom's live list maker and its brand check (a list's {node, arg} record).
  var liveList = null;
  var listRecord = null;
  var listToken = null;

  // --- conversions and parsing --------------------------------------------------------

  function isAsciiWhitespace(c) {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
  }

  // ASCII lowercase: an enumerated attribute matches its keywords ASCII
  // case-insensitively, where toLowerCase would also fold U+212A KELVIN SIGN to `k`.
  function asciiLower(s) {
    var out = s;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (c >= 0x41 && c <= 0x5a) {
        out = '';
        for (var j = 0; j < s.length; j++) {
          var d = StringPrototypeCharCodeAt(s, j);
          out +=
            d >= 0x41 && d <= 0x5a
              ? StringPrototypeSlice(LOWER, d - 0x41, d - 0x40)
              : StringPrototypeSlice(s, j, j + 1);
        }

        return out;
      }
    }

    return out;
  }

  // HTML's "rules for parsing integers": leading ASCII whitespace, a sign, then digits up
  // to the first non-digit. null when there are no digits.
  function parseInteger(s) {
    var n = s.length;
    var i = 0;
    while (i < n && isAsciiWhitespace(StringPrototypeCharCodeAt(s, i))) i++;
    var negative = false;
    if (i < n) {
      var sign = StringPrototypeCharCodeAt(s, i);
      if (sign === 0x2d) {
        negative = true;
        i++;
      } else if (sign === 0x2b) {
        i++;
      }
    }

    var start = i;
    var v = 0;
    for (; i < n; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (c < 0x30 || c > 0x39) break;
      v = v * 10 + (c - 0x30);
    }

    if (i === start) return null;
    return negative && v !== 0 ? -v : v;
  }

  // WebIDL's ToNumber for an integer attribute's setter, under the setter's context.
  function toNumberIn(value, iface, name) {
    if (typeof value === 'symbol' || typeof value === 'bigint') {
      throw pageError(
        new TypeErrorP(
          attributeContext(iface, name, true) +
            'Cannot convert a ' +
            (typeof value === 'symbol' ? 'Symbol' : 'BigInt') +
            ' value to a number',
        ),
      );
    }

    return NumberP(value);
  }

  // The ordered set parser (DOM §2.3): ASCII-whitespace-separated tokens, first
  // occurrence kept.
  function tokensOf(node, attr) {
    var value = nGetAttribute(node, attr);
    var out = [];
    var n = 0;
    if (value === null) return out;
    var len = value.length;
    for (var i = 0; i < len;) {
      while (i < len && isAsciiWhitespace(StringPrototypeCharCodeAt(value, i))) i++;
      var start = i;
      while (i < len && !isAsciiWhitespace(StringPrototypeCharCodeAt(value, i))) i++;
      if (i > start) {
        var token = StringPrototypeSlice(value, start, i);
        if (!ArrayPrototypeIncludes(out, token)) out[n++] = token;
      }
    }

    return out;
  }

  // --- URLs ---------------------------------------------------------------------------

  function parseURL(text, base) {
    try {
      return new URLP(text, base);
    } catch {
      return null;
    }
  }

  // The document base URL (HTML §2.4.1): the first `base` element with an href, its
  // value parsed against the document's URL — or the document's URL when there is no
  // such element or its href does not parse. Looked up at every resolution, as the
  // frozen base URL a `base` change updates.
  function baseURL() {
    var doc = documentURL();
    var base = nQuery(nDocument(), 'base[href]', false);
    if (base !== null) {
      var url = parseURL(nGetAttribute(base, 'href'), doc);
      if (url !== null) return ReflectApply(urlHref, url, EMPTY);
    }

    return doc;
  }

  // A URL attribute's value as its getter answers it: parsed against the base URL and
  // serialized, or the value as it stands when it does not parse (HTML's "reflect" for
  // a USVString URL attribute; Chrome 158 answers the same).
  function resolved(value) {
    var url = parseURL(value, baseURL());
    return url === null ? value : ReflectApply(urlHref, url, EMPTY);
  }

  // --- brands -------------------------------------------------------------------------

  // Each interface's brand: `ok[i]` is true when the interface Odin wraps as names[i]
  // (pkg/runtime/dom.odin dom_interface_of) is it or inherits from it. Filled by install.
  // The wrapper's [[Prototype]] is the page's to change, so the brand is read from the
  // node, natively, never from the prototype chain.
  var brands = [];
  var brandCount = 0;

  function brandFor(proto) {
    var ok = [];
    brands[brandCount++] = { __proto__: null, proto: proto, ok: ok };
    return ok;
  }

  function check(o, ok) {
    if (ok[nInterface(o)] !== true) throw illegalInvocation();
  }

  // --- the reflection kinds -------------------------------------------------------------

  // Row constructors: `name` is the IDL attribute, `attr` the content attribute (the
  // name lowercased unless given).
  function row(kind, name, attr, opts) {
    return {
      __proto__: null,
      kind: kind,
      name: name,
      attr: attr === undefined ? asciiLower(name) : attr,
      opts: opts === undefined ? null : opts,
    };
  }

  function str(name, attr, opts) {
    return row('string', name, attr, opts);
  }

  function bool(name, attr) {
    return row('boolean', name, attr);
  }

  function url(name, attr) {
    return row('url', name, attr);
  }

  function long(name, attr, dflt) {
    return row('long', name, attr, { __proto__: null, dflt: dflt });
  }

  function ulong(name, attr, dflt) {
    return row('ulong', name, attr, { __proto__: null, dflt: dflt });
  }

  // An enumerated attribute: `keywords` maps a lowercased content value to the state
  // keyword the getter answers; `missing` and `invalid` are the defaults; `nullable`
  // makes the missing default null and a null write a removal (crossOrigin).
  function enumerated(name, attr, keywords, missing, invalid, nullable) {
    return row('enum', name, attr, {
      __proto__: null,
      keywords: keywords,
      missing: missing,
      invalid: invalid,
      nullable: nullable === true,
    });
  }

  // A DOMTokenList; what its `supports` accepts is supportedTokens'.
  function tokens(name, attr) {
    return row('tokens', name, attr);
  }

  function custom(name, get, set) {
    return row('custom', name, '', { __proto__: null, get: get, set: set });
  }

  function operation(name, fn) {
    return row('operation', name, '', { __proto__: null, fn: fn });
  }

  function keywordMap(list) {
    var map = { __proto__: null };
    for (var i = 0; i < list.length; i++) map[list[i]] = list[i];
    return map;
  }

  // The getter/setter pair for one row of `iface`, each checking `ok` first, then
  // converting, as Blink does (receiver, then value).
  function accessors(iface, r, ok) {
    var attr = r.attr;
    var name = r.name;
    var o = r.opts;
    var get;
    var set;
    switch (r.kind) {
      case 'string':
        get = function () {
          check(this, ok);
          var v = nGetAttribute(this, attr);
          return v === null ? '' : v;
        };
        set = function (value) {
          check(this, ok);
          // [LegacyNullToEmptyString] where the IDL says so (img border, iframe margins).
          var v = o !== null && o.nullEmpty && value === null ? '' : value;
          nSetAttribute(this, attr, toDOMStringIn(v, attributeContext(iface, name, true)));
        };
        break;
      case 'boolean':
        get = function () {
          check(this, ok);
          return nGetAttribute(this, attr) !== null;
        };
        set = function (value) {
          check(this, ok);
          if (value) nSetAttribute(this, attr, '');
          else nRemoveAttribute(this, attr);
        };
        break;
      case 'url':
        get = function () {
          check(this, ok);
          var v = nGetAttribute(this, attr);
          return v === null ? '' : resolved(v);
        };
        set = function (value) {
          check(this, ok);
          var v = toDOMStringIn(value, attributeContext(iface, name, true));
          nSetAttribute(this, attr, StringPrototypeToWellFormed(v));
        };
        break;
      case 'long':
        get = function () {
          check(this, ok);
          var v = nGetAttribute(this, attr);
          var n = v === null ? null : parseInteger(v);
          if (n !== null && n >= INT_MIN && n <= INT_MAX) return n;
          var dflt = o.dflt;
          return typeof dflt === 'function' ? dflt(this) : dflt;
        };
        set = function (value) {
          check(this, ok);
          // WebIDL `long`: ToNumber, then ToInt32 (NaN and the infinities are 0).
          nSetAttribute(this, attr, '' + (toNumberIn(value, iface, name) | 0));
        };
        break;
      case 'ulong':
        get = function () {
          check(this, ok);
          var v = nGetAttribute(this, attr);
          var n = v === null ? null : parseInteger(v);
          return n !== null && n >= 0 && n <= INT_MAX ? n : o.dflt;
        };
        set = function (value) {
          check(this, ok);
          // WebIDL `unsigned long` (ToUint32); past 2^31 - 1, the default is written.
          var n = toNumberIn(value, iface, name) >>> 0;
          nSetAttribute(this, attr, '' + (n > INT_MAX ? o.dflt : n));
        };
        break;
      case 'enum':
        get = function () {
          check(this, ok);
          var v = nGetAttribute(this, attr);
          if (v === null) return o.missing;
          var state = o.keywords[asciiLower(v)];
          return state === undefined ? o.invalid : state;
        };
        set = function (value) {
          check(this, ok);
          if (o.nullable && (value === null || value === undefined)) {
            nRemoveAttribute(this, attr);
            return;
          }

          nSetAttribute(this, attr, toDOMStringIn(value, attributeContext(iface, name, true)));
        };
        break;
      case 'tokens':
        get = function () {
          check(this, ok);
          return tokenList(this, attr);
        };
        // [PutForwards=value]: the write is the list's `value` setter's.
        set = function (value) {
          check(this, ok);
          nSetAttribute(
            this,
            attr,
            toDOMStringIn(value, attributeContext('DOMTokenList', 'value', true)),
          );
        };
        break;
      case 'custom':
        var read = o.get;
        var write = o.set;
        get = function () {
          check(this, ok);
          return read(this);
        };
        set =
          write === undefined
            ? undefined
            : function (value) {
                check(this, ok);
                write(this, value, iface, name);
              };
        break;
    }

    return { __proto__: null, get: get, set: set, enumerable: true, configurable: true };
  }

  /**
   * Defines `iface`'s reflected members on its implementation prototype and names them.
   * @param {string} iface An interface internal/dom defines (`HTMLAnchorElement`).
   * @param {Object} proto Its implementation prototype.
   * @returns {string[]} The member entries, in Blink's prototype order, for
   *   internal/native_shape (an operation as `name:length`); empty for an interface with
   *   no row.
   * @node Chrome 158, tests/dom/cases/dom-reflect-shape.page: the members are a subset of
   *   Object.getOwnPropertyNames of each prototype, in its order.
   * @deviates Only the members REFLECT lists exist; the rest of Blink's (event handlers,
   *   layout, form state such as HTMLInputElement.value and .checked) are absent.
   *   img width/height reflect the content attribute even for a rendered image, where
   *   Chrome answers its layout size (Larva has no layout); the cases read detached
   *   images, where the two agree.
   */
  function members(iface, proto) {
    var rows = REFLECT[iface];
    if (rows === undefined) return EMPTY;
    var ok = brandFor(proto);
    var names = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'operation') {
        ObjectDefineProperty(proto, r.name, {
          __proto__: null,
          value: operationOf(r.opts.fn, ok),
          writable: true,
          enumerable: true,
          configurable: true,
        });
        names[i] = r.name + ':0';
      } else {
        ObjectDefineProperty(proto, r.name, accessors(iface, r, ok));
        names[i] = r.name;
      }
    }

    return names;
  }

  function operationOf(fn, ok) {
    return {
      op() {
        check(this, ok);
        return fn(this);
      },
    }.op;
  }

  // --- the custom members -------------------------------------------------------------

  // HTMLElement.hidden: (boolean or unrestricted double or DOMString)?. `until-found`
  // (ASCII case-insensitive) is kept as a string; a falsy value removes the attribute;
  // anything else sets it empty.
  function getHidden(el) {
    var v = nGetAttribute(el, 'hidden');
    if (v === null) return false;
    return asciiLower(v) === 'until-found' ? 'until-found' : true;
  }

  function setHidden(el, value, iface, name) {
    if (
      value === null ||
      value === undefined ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      if (value) nSetAttribute(el, 'hidden', '');
      else nRemoveAttribute(el, 'hidden');
      return;
    }

    var s = toDOMStringIn(value, attributeContext(iface, name, true));
    if (asciiLower(s) === 'until-found') nSetAttribute(el, 'hidden', 'until-found');
    else if (s === '') nRemoveAttribute(el, 'hidden');
    else nSetAttribute(el, 'hidden', '');
  }

  // An inherited enumerated attribute (translate, spellcheck): the nearest element,
  // this one first, whose attribute is one of the true or false keywords decides; none
  // does, and it is true.
  function inherited(el, attr, yes, no) {
    for (var n = el; n !== null; n = nParent(n)) {
      if (nNodeType(n) !== ELEMENT_NODE) break;
      var v = nGetAttribute(n, attr);
      if (v === null) continue;
      v = asciiLower(v);
      if (v === '' || v === yes) return true;
      if (v === no) return false;
    }

    return true;
  }

  function getTranslate(el) {
    return inherited(el, 'translate', 'yes', 'no');
  }

  function setTranslate(el, value) {
    nSetAttribute(el, 'translate', value ? 'yes' : 'no');
  }

  function getSpellcheck(el) {
    return inherited(el, 'spellcheck', 'true', 'false');
  }

  function setSpellcheck(el, value) {
    nSetAttribute(el, 'spellcheck', value ? 'true' : 'false');
  }

  // draggable: `true`/`false`, else the element's default — an img, or an `a` with an
  // href, is draggable.
  function getDraggable(el) {
    var v = nGetAttribute(el, 'draggable');
    if (v !== null) {
      v = asciiLower(v);
      if (v === 'true') return true;
      if (v === 'false') return false;
    }

    var local = nLocalName(el);
    return local === 'img' || (local === 'a' && nGetAttribute(el, 'href') !== null);
  }

  function setDraggable(el, value) {
    nSetAttribute(el, 'draggable', value ? 'true' : 'false');
  }

  // tabIndex's default: 0 for the elements Chrome 158 makes focusable by default, -1
  // for every other (tests/dom/cases/dom-reflect-html-element.page).
  var FOCUSABLE = keywordMap([
    'a',
    'area',
    'button',
    'iframe',
    'input',
    'object',
    'select',
    'textarea',
  ]);

  function tabIndexDefault(el) {
    return FOCUSABLE[nLocalName(el)] === undefined ? -1 : 0;
  }

  // The concatenation of the element's Text children's data (script.text, HTML's
  // "child text content"), not of every descendant as textContent.
  function childText(el) {
    var out = '';
    for (var c = nFirstChild(el); c !== null; c = nNextSibling(c)) {
      if (nNodeType(c) === TEXT_NODE) out += nData(c);
    }

    return out;
  }

  function setText(el, value, iface, name) {
    nSetTextContent(el, toDOMStringIn(value, attributeContext(iface, name, true)));
  }

  function getTextContent(el) {
    return nTextContent(el);
  }

  // A script element's "force async" flag (HTML §4.12.1.1): set on one a script
  // created, unset by the parser (so absent here for a parser-inserted one), by an
  // `async` write and by any change to the async content attribute (noteAsync).
  var forceAsync = new WeakMapP();

  function getAsync(el) {
    return WeakMapPrototypeGet(forceAsync, el) === true || nGetAttribute(el, 'async') !== null;
  }

  function setAsync(el, value) {
    WeakMapPrototypeSet(forceAsync, el, false);
    if (value) nSetAttribute(el, 'async', '');
    else nRemoveAttribute(el, 'async');
  }

  // A form's action: the document's URL when the attribute is missing or empty — not
  // the base URL — else the attribute resolved.
  function getAction(el) {
    var v = nGetAttribute(el, 'action');
    return v === null || v === '' ? documentURL() : resolved(v);
  }

  function setAction(el, value, iface, name) {
    var v = toDOMStringIn(value, attributeContext(iface, name, true));
    nSetAttribute(el, 'action', StringPrototypeToWellFormed(v));
  }

  // HTMLHyperlinkElementUtils (HTML §4.6.4): the element's url, null when it has no
  // href or the href does not parse.
  function hyperlinkURL(el) {
    var href = nGetAttribute(el, 'href');
    return href === null ? null : parseURL(href, baseURL());
  }

  // A URL component getter and setter over the element's url: `none` is what the getter
  // answers with no url (`:` for protocol, else ''); a setter with no url does nothing,
  // and otherwise writes the changed URL back to href.
  function component(name, none) {
    var desc = urlAccessor(name);
    var getter = desc.get;
    var setter = desc.set;
    return custom(
      name,
      function (el) {
        var u = hyperlinkURL(el);
        return u === null ? none : ReflectApply(getter, u, EMPTY);
      },
      setter === undefined
        ? undefined
        : function (el, value, iface) {
            var v = StringPrototypeToWellFormed(
              toDOMStringIn(value, attributeContext(iface, name, true)),
            );
            var u = hyperlinkURL(el);
            if (u === null) return;
            ReflectApply(setter, u, [v]);
            nSetAttribute(el, 'href', ReflectApply(urlHref, u, EMPTY));
          },
    );
  }

  function getOrigin(el) {
    var u = hyperlinkURL(el);
    return u === null ? '' : ReflectApply(urlOrigin, u, EMPTY);
  }

  function hrefString(el) {
    var v = nGetAttribute(el, 'href');
    return v === null ? '' : resolved(v);
  }

  // --- the table ----------------------------------------------------------------------

  var REFERRER_POLICIES = keywordMap([
    '',
    'no-referrer',
    'no-referrer-when-downgrade',
    'same-origin',
    'origin',
    'strict-origin',
    'origin-when-cross-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url',
  ]);
  var CORS_SETTINGS = keywordMap(['anonymous', 'use-credentials']);
  CORS_SETTINGS[''] = 'anonymous';
  var FETCH_PRIORITIES = keywordMap(['high', 'low', 'auto']);
  var LOADING = keywordMap(['lazy', 'eager', 'auto']);
  var DECODING = keywordMap(['sync', 'async', 'auto']);
  var DIRECTIONS = keywordMap(['ltr', 'rtl', 'auto']);
  // The `as` values Chrome 158's HTMLLinkElement.as answers (probed in Chrome against a
  // wider candidate list; tests/dom/cases/dom-reflect-elements.page pins them).
  var LINK_AS = keywordMap(['fetch', 'font', 'image', 'script', 'style', 'track']);
  var INPUT_TYPES = keywordMap([
    'text',
    'search',
    'tel',
    'url',
    'email',
    'password',
    'datetime-local',
    'date',
    'month',
    'week',
    'time',
    'number',
    'range',
    'color',
    'checkbox',
    'radio',
    'file',
    'submit',
    'image',
    'reset',
    'button',
    'hidden',
  ]);
  var URLENCODED = 'application/x-www-form-urlencoded';
  var ENCTYPES = keywordMap([URLENCODED, 'multipart/form-data', 'text/plain']);
  var METHODS = keywordMap(['get', 'post', 'dialog']);
  var ON_OFF = keywordMap(['on', 'off']);
  // relList's supported tokens (DOMTokenList.supports), as Chrome 158 answers them.
  var LINK_REL = keywordMap([
    'alternate',
    'canonical',
    'dns-prefetch',
    'icon',
    'manifest',
    'modulepreload',
    'next',
    'preconnect',
    'prefetch',
    'preload',
    'prerender',
    'stylesheet',
    'apple-touch-icon',
    'apple-touch-icon-precomposed',
    'compression-dictionary',
  ]);
  var HYPERLINK_REL = keywordMap(['noopener', 'noreferrer', 'opener']);

  function referrerPolicy() {
    return enumerated('referrerPolicy', 'referrerpolicy', REFERRER_POLICIES, '', '');
  }

  function crossOrigin() {
    return enumerated('crossOrigin', 'crossorigin', CORS_SETTINGS, null, 'anonymous', true);
  }

  function fetchPriority() {
    return enumerated('fetchPriority', 'fetchpriority', FETCH_PRIORITIES, 'auto', 'auto');
  }

  function loading() {
    return enumerated('loading', 'loading', LOADING, 'auto', 'auto');
  }

  var NULL_EMPTY = { __proto__: null, nullEmpty: true };

  // Interface -> its reflected members, in Blink's order on the prototype (Chrome 158:
  // tests/dom/cases/dom-reflect-shape.page). Only the members listed exist.
  var REFLECT = {
    __proto__: null,
    Element: [tokens('classList', 'class'), str('slot')],
    HTMLElement: [
      str('title'),
      str('lang'),
      custom('translate', getTranslate, setTranslate),
      enumerated('dir', 'dir', DIRECTIONS, '', ''),
      custom('hidden', getHidden, setHidden),
      bool('inert'),
      str('accessKey'),
      custom('draggable', getDraggable, setDraggable),
      custom('spellcheck', getSpellcheck, setSpellcheck),
      bool('autofocus'),
      long('tabIndex', 'tabindex', tabIndexDefault),
    ],
    HTMLAnchorElement: [
      str('download'),
      str('ping'),
      str('rel'),
      tokens('relList', 'rel'),
      referrerPolicy(),
      custom('text', getTextContent, setText),
      str('coords'),
      str('charset'),
      str('name'),
      str('rev'),
      str('shape'),
      str('target'),
      url('href'),
      custom('origin', getOrigin),
      component('protocol', ':'),
      component('username', ''),
      component('password', ''),
      component('host', ''),
      component('hostname', ''),
      component('port', ''),
      component('pathname', ''),
      component('search', ''),
      component('hash', ''),
      str('hreflang'),
      str('type'),
      operation('toString', hrefString),
    ],
    HTMLImageElement: [
      str('alt'),
      url('src'),
      str('srcset'),
      str('sizes'),
      crossOrigin(),
      str('useMap'),
      bool('isMap'),
      ulong('width', 'width', 0),
      ulong('height', 'height', 0),
      referrerPolicy(),
      enumerated('decoding', 'decoding', DECODING, 'auto', 'auto'),
      fetchPriority(),
      loading(),
      str('name'),
      url('lowsrc'),
      str('align'),
      ulong('hspace', 'hspace', 0),
      ulong('vspace', 'vspace', 0),
      url('longDesc'),
      str('border', 'border', NULL_EMPTY),
    ],
    HTMLScriptElement: [
      url('src'),
      str('type'),
      bool('noModule'),
      str('charset'),
      custom('async', getAsync, setAsync),
      bool('defer'),
      crossOrigin(),
      custom('text', childText, setText),
      referrerPolicy(),
      fetchPriority(),
      str('event'),
      str('htmlFor', 'for'),
      str('integrity'),
    ],
    HTMLLinkElement: [
      bool('disabled'),
      url('href'),
      crossOrigin(),
      str('rel'),
      tokens('relList', 'rel'),
      str('media'),
      str('hreflang'),
      str('type'),
      enumerated('as', 'as', LINK_AS, '', ''),
      referrerPolicy(),
      tokens('sizes', 'sizes'),
      fetchPriority(),
      str('imageSrcset'),
      str('imageSizes'),
      str('charset'),
      str('rev'),
      str('target'),
      str('integrity'),
    ],
    HTMLInputElement: [
      str('accept'),
      str('alt'),
      bool('defaultChecked', 'checked'),
      str('dirName'),
      bool('disabled'),
      str('max'),
      str('min'),
      bool('multiple'),
      str('name'),
      str('pattern'),
      str('placeholder'),
      bool('readOnly'),
      bool('required'),
      url('src'),
      str('step'),
      enumerated('type', 'type', INPUT_TYPES, 'text', 'text'),
      str('defaultValue', 'value'),
    ],
    HTMLFormElement: [
      str('acceptCharset', 'accept-charset'),
      custom('action', getAction, setAction),
      enumerated('autocomplete', 'autocomplete', ON_OFF, 'on', 'on'),
      enumerated('enctype', 'enctype', ENCTYPES, URLENCODED, URLENCODED),
      enumerated('encoding', 'enctype', ENCTYPES, URLENCODED, URLENCODED),
      enumerated('method', 'method', METHODS, 'get', 'get'),
      str('name'),
      bool('noValidate'),
      str('target'),
      str('rel'),
      tokens('relList', 'rel'),
    ],
    HTMLMetaElement: [
      str('name'),
      str('httpEquiv', 'http-equiv'),
      str('content'),
      str('media'),
      str('scheme'),
    ],
    HTMLIFrameElement: [
      url('src'),
      str('srcdoc'),
      str('name'),
      bool('allowFullscreen'),
      str('width'),
      str('height'),
      referrerPolicy(),
      str('allow'),
      loading(),
      str('align'),
      str('scrolling'),
      str('frameBorder'),
      url('longDesc'),
      str('marginHeight', 'marginheight', NULL_EMPTY),
      str('marginWidth', 'marginwidth', NULL_EMPTY),
    ],
  };

  // --- DOMTokenList -------------------------------------------------------------------

  // An element's token lists, one per content attribute, made on first read and the
  // same object after (`el.classList === el.classList`), as Blink caches them.
  var tokenLists = new WeakMapP();

  function tokenList(el, attr) {
    var lists = WeakMapPrototypeGet(tokenLists, el);
    if (lists === undefined) {
      lists = { __proto__: null };
      WeakMapPrototypeSet(tokenLists, el, lists);
    }

    var list = lists[attr];
    if (list === undefined) {
      list = liveList(DOMTokenList, tokensOf, el, attr);
      lists[attr] = list;
    }

    return list;
  }

  // The brand check of every DOMTokenList member: the list's {node, arg} record.
  function recordOf(o) {
    var rec = listRecord(o);
    if (rec.compute !== tokensOf) throw illegalInvocation();
    return rec;
  }

  // A token argument, validated as add/remove/toggle/replace validate it.
  function validToken(token, op) {
    if (token === '') {
      throw pageError(
        new DOMException(
          context('DOMTokenList', op) + 'The token provided must not be empty.',
          'SyntaxError',
        ),
      );
    }

    for (var i = 0; i < token.length; i++) {
      if (isAsciiWhitespace(StringPrototypeCharCodeAt(token, i))) {
        throw pageError(
          new DOMException(
            context('DOMTokenList', op) +
              "The token provided ('" +
              token +
              "') contains HTML space characters, which are not valid in tokens.",
            'InvalidCharacterError',
          ),
        );
      }
    }
  }

  // Every argument converted, in order, then each validated (DOM's add and remove).
  function tokenArgs(args, op) {
    var out = [];
    for (var i = 0; i < args.length; i++) out[i] = toDOMString(args[i], 'DOMTokenList', op);
    for (var j = 0; j < out.length; j++) validToken(out[j], op);
    return out;
  }

  // DOM's update steps: the set serialized into the attribute — except that with no
  // attribute and an empty set nothing is written. `always` skips that exception, as
  // Blink's add does (tests/dom/cases/dom-reflect-tokenlist.page: add() with no token
  // creates `class=""`).
  function update(rec, set, always) {
    if (!always && set.length === 0 && nGetAttribute(rec.node, rec.arg) === null) return;
    nSetAttribute(rec.node, rec.arg, ArrayPrototypeJoin(set, ' '));
  }

  function removeAt(set, at) {
    for (var i = at; i < set.length - 1; i++) set[i] = set[i + 1];
    set.length = set.length - 1;
  }

  function indexIn(set, token) {
    for (var i = 0; i < set.length; i++) {
      if (set[i] === token) return i;
    }

    return -1;
  }

  /**
   * DOMTokenList (DOM Standard §7.1): classList, relList and link `sizes`, live over the
   * content attribute. Illegal to construct, as in Chrome.
   * @node Chrome 158, tests/dom/cases/dom-reflect-tokenlist.page: ops, errors, shape,
   *   indexed own properties, MutationObserver records.
   * @deviates A list is internal/dom's live-list Proxy, so its brand is a WeakMap entry,
   *   not a private field; nothing a page reads tells the two apart.
   */
  class DOMTokenList {
    constructor(token) {
      if (listToken === null || token !== listToken) throw illegalInvocation();
    }

    get length() {
      var rec = recordOf(this);
      return tokensOf(rec.node, rec.arg).length;
    }

    get value() {
      var rec = recordOf(this);
      var v = nGetAttribute(rec.node, rec.arg);
      return v === null ? '' : v;
    }

    set value(value) {
      var rec = recordOf(this);
      nSetAttribute(
        rec.node,
        rec.arg,
        toDOMStringIn(value, attributeContext('DOMTokenList', 'value', true)),
      );
    }

    item(index) {
      var rec = recordOf(this);
      if (arguments.length < 1) throw typeError('DOMTokenList', 'item', argumentsRequired(1, 0));
      var v = tokensOf(rec.node, rec.arg)[index >>> 0];
      return v === undefined ? null : v;
    }

    contains(token) {
      var rec = recordOf(this);
      if (arguments.length < 1)
        throw typeError('DOMTokenList', 'contains', argumentsRequired(1, 0));
      return ArrayPrototypeIncludes(
        tokensOf(rec.node, rec.arg),
        toDOMString(token, 'DOMTokenList', 'contains'),
      );
    }

    add() {
      var rec = recordOf(this);
      var args = tokenArgs(arguments, 'add');
      var set = tokensOf(rec.node, rec.arg);
      for (var i = 0; i < args.length; i++) {
        if (!ArrayPrototypeIncludes(set, args[i])) set[set.length] = args[i];
      }

      update(rec, set, true);
    }

    remove() {
      var rec = recordOf(this);
      var args = tokenArgs(arguments, 'remove');
      var set = tokensOf(rec.node, rec.arg);
      for (var i = 0; i < args.length; i++) {
        var at = indexIn(set, args[i]);
        if (at !== -1) removeAt(set, at);
      }

      update(rec, set, false);
    }

    toggle(token, force) {
      var rec = recordOf(this);
      if (arguments.length < 1) throw typeError('DOMTokenList', 'toggle', argumentsRequired(1, 0));
      token = toDOMString(token, 'DOMTokenList', 'toggle');
      var forced = force !== undefined;
      var want = !!force;
      validToken(token, 'toggle');
      var set = tokensOf(rec.node, rec.arg);
      var at = indexIn(set, token);
      if (at !== -1) {
        if (forced && want) return true;
        removeAt(set, at);
        update(rec, set, false);
        return false;
      }

      if (forced && !want) return false;
      set[set.length] = token;
      update(rec, set, false);
      return true;
    }

    replace(token, newToken) {
      var rec = recordOf(this);
      if (arguments.length < 2) {
        throw typeError('DOMTokenList', 'replace', argumentsRequired(2, arguments.length));
      }

      token = toDOMString(token, 'DOMTokenList', 'replace');
      newToken = toDOMString(newToken, 'DOMTokenList', 'replace');
      if (token === '' || newToken === '') validToken('', 'replace');
      validToken(token, 'replace');
      validToken(newToken, 'replace');
      var set = tokensOf(rec.node, rec.arg);
      var at = indexIn(set, token);
      if (at === -1) return false;
      // The ordered set's replace: the first of token and newToken becomes newToken, and
      // every other occurrence of either goes.
      var other = indexIn(set, newToken);
      if (other !== -1 && other < at) {
        removeAt(set, at);
      } else {
        set[at] = newToken;
        if (other !== -1 && other !== at) removeAt(set, other);
      }

      update(rec, set, false);
      return true;
    }

    supports(token) {
      var rec = recordOf(this);
      if (arguments.length < 1)
        throw typeError('DOMTokenList', 'supports', argumentsRequired(1, 0));
      token = toDOMString(token, 'DOMTokenList', 'supports');
      var supported = supportedTokens(rec.node, rec.arg);
      if (supported === null)
        throw typeError('DOMTokenList', 'supports', 'DOMTokenList has no supported tokens.');
      return supported[asciiLower(token)] !== undefined;
    }

    toString() {
      var rec = recordOf(this);
      var v = nGetAttribute(rec.node, rec.arg);
      return v === null ? '' : v;
    }

    forEach(callback) {
      var rec = recordOf(this);
      if (arguments.length < 1) throw typeError('DOMTokenList', 'forEach', argumentsRequired(1, 0));
      if (typeof callback !== 'function') {
        throw typeError(
          'DOMTokenList',
          'forEach',
          'The callback provided as parameter 1 is not a function.',
        );
      }

      var thisArg = arguments[1];
      for (var i = 0; ; i++) {
        var set = tokensOf(rec.node, rec.arg);
        if (i >= set.length) break;
        ReflectApply(callback, thisArg, [set[i], i, this]);
      }
    }

    *entries() {
      var rec = recordOf(this);
      for (var i = 0; ; i++) {
        var set = tokensOf(rec.node, rec.arg);
        if (i >= set.length) return;
        yield [i, set[i]];
      }
    }

    *keys() {
      var rec = recordOf(this);
      for (var i = 0; ; i++) {
        if (i >= tokensOf(rec.node, rec.arg).length) return;
        yield i;
      }
    }

    *values() {
      var rec = recordOf(this);
      for (var i = 0; ; i++) {
        var set = tokensOf(rec.node, rec.arg);
        if (i >= set.length) return;
        yield set[i];
      }
    }
  }

  // The tokens `supports` accepts: relList's, by element; null for a list with none
  // (classList, sizes), whose supports throws.
  function supportedTokens(el, attr) {
    if (attr !== 'rel') return null;
    var local = nLocalName(el);
    if (local === 'link') return LINK_REL;
    return HYPERLINK_REL;
  }

  nativeShape.defineInterface({
    name: 'DOMTokenList',
    impl: DOMTokenList,
    length: 0,
    illegal: true,
    members: [
      'entries:0',
      'keys:0',
      'values:0',
      'forEach:1',
      'length',
      'value',
      'add:0',
      'contains:1',
      'item:1',
      'remove:0',
      'replace:2',
      'supports:1',
      'toggle:1',
      'toString:0',
      '@@iterator=values',
      'constructor',
      '@@toStringTag',
    ],
  });

  /**
   * Binds the natives and internal/dom's list machinery, and fills every brand.
   * @param {Object} n The natives, the mutating ones already observed.
   * @param {string[]} names The interfaces Odin wraps nodes as, in its order.
   * @param {Object[]} protos Their prototypes, in the same order.
   */
  function install(n, names, protos) {
    nInterface = n.interface;
    nDocument = n.document;
    nNodeType = n.nodeType;
    nParent = n.parent;
    nFirstChild = n.firstChild;
    nNextSibling = n.nextSibling;
    nData = n.data;
    nLocalName = n.localName;
    nTextContent = n.textContent;
    nSetTextContent = n.setTextContent;
    nGetAttribute = n.getAttribute;
    nSetAttribute = n.setAttribute;
    nRemoveAttribute = n.removeAttribute;
    nQuery = n.query;
    liveList = n.liveList;
    listRecord = n.listRecord;
    listToken = n.listToken;
    for (var b = 0; b < brandCount; b++) {
      var brand = brands[b];
      for (var i = 0; i < names.length; i++) {
        var hit = false;
        for (var p = protos[i]; p !== null; p = ObjectGetPrototypeOf(p)) {
          if (p === brand.proto) {
            hit = true;
            break;
          }
        }

        brand.ok[i] = hit;
      }
    }
  }

  /**
   * Notes a script element a script created (document.createElement): its force-async
   * flag starts set, so `async` reads true until written.
   * @param {Object} el
   */
  function scriptCreated(el) {
    WeakMapPrototypeSet(forceAsync, el, true);
  }

  /**
   * Notes a change to an element's content attribute `name` through setAttribute: an
   * `async` one unsets the force-async flag.
   * @param {Object} el
   * @param {string} name As the page gave it; matched ASCII case-insensitively.
   */
  function attributeChanged(el, name) {
    if (asciiLower(name) === 'async') WeakMapPrototypeSet(forceAsync, el, false);
  }

  /**
   * attributeChanged for removeAttribute, called before the removal: removing an
   * attribute the element does not have changes nothing, so the flag stays (Chrome 158,
   * tests/dom/cases/dom-reflect-elements.page).
   * @param {Object} el
   * @param {string} name As the page gave it.
   */
  function attributeRemoving(el, name) {
    if (asciiLower(name) === 'async' && nGetAttribute(el, name) !== null) {
      WeakMapPrototypeSet(forceAsync, el, false);
    }
  }

  module.exports = ObjectFreeze({
    __proto__: null,
    members: members,
    install: install,
    scriptCreated: scriptCreated,
    attributeChanged: attributeChanged,
    attributeRemoving: attributeRemoving,
  });
});
