/**
 * @fileoverview The page's URL and its session history: the `location` (Location) and
 * `history` (History) globals and DOMStringList (location.ancestorOrigins), installed at
 * module-eval (#13).
 *
 * The page URL is what the embedder gave (`lava run --origin=`, this factory's fourth
 * argument): a URL, or an origin, which is then the URL of its root. No value, or one
 * that does not parse, makes the page about:blank with an opaque origin.
 *
 * Larva has one document per page and never replaces it, so this is the part of
 * navigation that stays inside the document: a fragment navigation (`location.hash`,
 * assign/replace/href to the same URL with a different fragment), pushState and
 * replaceState, and traversal between the entries those made. Each updates the URL
 * every getter here reads and the session history behind `history`. A navigation to
 * any other document is not performed (see Location's @deviates).
 *
 * Instantiated eagerly (the loader names it), so every capture below is pristine.
 *
 * @module lava/internal/location
 */

(function (require, module, _exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var DOMException = require('internal/domexception').DOMException;
  var cloneFor = require('internal/structured_clone').cloneFor;
  var URLP = require('internal/url').URL;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var NumberP = P.Number;
  var StringP = P.String;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ReflectApply = P.ReflectApply;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var TypeErrorP = P.TypeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var attributeContext = webErrors.attributeContext;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;
  var wrapGetter = nativeShape.wrapGetter;
  var wrapOperation = nativeShape.wrapOperation;
  var wrapSetter = nativeShape.wrapSetter;

  // Captured at this eager eval, before page code: Object.prototype.valueOf, which
  // Location carries as an own member, and Array.prototype.values, DOMStringList's
  // iterator; the timer a traversal is queued on.
  var ObjectPrototypeValueOf = P.Object.prototype.valueOf;
  var ArrayPrototypeValues = P.Array.prototype.values;
  var setTimeoutP = setTimeout;

  // URL's accessors, captured: the URL interface's prototype is the page's to replace,
  // and these read the page's own URL.
  function urlAccessor(name) {
    return ObjectGetOwnPropertyDescriptor(URLP.prototype, name);
  }
  var urlHref = urlAccessor('href').get;
  var urlOrigin = urlAccessor('origin').get;
  var urlProtocol = urlAccessor('protocol').get;
  var urlUsername = urlAccessor('username').get;
  var urlPassword = urlAccessor('password').get;
  var urlHost = urlAccessor('host').get;
  var urlHostname = urlAccessor('hostname').get;
  var urlPort = urlAccessor('port').get;
  var urlPathname = urlAccessor('pathname').get;
  var urlSearch = urlAccessor('search').get;
  var urlHash = urlAccessor('hash').get;
  // The setters Location's own setters delegate to, by attribute name.
  var URL_SETTERS = {
    __proto__: null,
    protocol: urlAccessor('protocol').set,
    host: urlAccessor('host').set,
    hostname: urlAccessor('hostname').set,
    port: urlAccessor('port').set,
    pathname: urlAccessor('pathname').set,
    search: urlAccessor('search').set,
    hash: urlAccessor('hash').set,
  };
  var EMPTY = [];

  var LOCATION = 'Location';
  var HISTORY = 'History';
  var BLANK = 'about:blank';
  var SCROLL_MODES = ['auto', 'manual'];

  // The platform makes the one Location, History and the DOMStringList through this
  // token; the interface objects a page reaches refuse construction themselves.
  var INTERNAL = { __proto__: null };

  function read(getter, url) {
    return ReflectApply(getter, url, EMPTY);
  }

  function parse(text, base) {
    try {
      return base === undefined ? new URLP(text) : new URLP(text, base);
    } catch {
      return null;
    }
  }

  function withoutFragment(href) {
    var at = StringPrototypeIndexOf(href, '#', 0);
    return at === -1 ? href : StringPrototypeSlice(href, 0, at);
  }

  // --- the session -------------------------------------------------------------------
  //
  // The page's session history: one entry per pushState or fragment navigation, each
  // {url, state, scroll}. Only this document's entries: Larva has no earlier document to
  // go back to. `current` is the active entry's URL, the document's URL.

  var pageURL = parse(native && typeof native.url === 'string' ? native.url : '');
  if (pageURL === null) pageURL = new URLP(BLANK);
  var entries = [{ __proto__: null, url: pageURL, state: null, scroll: 'auto' }];
  var index = 0;
  var current = pageURL;

  // HTML's "not completely loaded": until then a Location-object navigation replaces
  // the entry instead of adding one (the Location-object navigate algorithm), which
  // Chrome does for a fragment set by a page's top-level script. Larva fires no load
  // event; the native answers true while the top-level script runs (window_env.odin).
  var nativeLoading = native && typeof native.loading === 'function' ? native.loading : null;
  function loading() {
    return nativeLoading !== null && nativeLoading() === true;
  }

  function entry(url, state, scroll) {
    return { __proto__: null, url: url, state: state, scroll: scroll };
  }

  function addEntry(url, state) {
    var scroll = entries[index].scroll;
    entries.length = index + 1;
    index++;
    ArrayPrototypePush1(entries, entry(url, state, scroll));
    current = url;
  }

  function replaceEntry(url, state) {
    entries[index] = entry(url, state, entries[index].scroll);
    current = url;
  }

  // HTML's "navigate", for the one case Larva performs: `url` differs from the
  // document's URL at most in a non-null fragment ("navigate to a fragment"). Every
  // other URL would load a new document; see Location's @deviates.
  function navigate(url, replace) {
    var href = read(urlHref, url);
    var now = read(urlHref, current);
    if (StringPrototypeIndexOf(href, '#', 0) === -1) return;
    if (withoutFragment(href) !== withoutFragment(now)) return;
    // The new entry's classic history state is null, in both forms.
    if (replace || href === now || loading()) replaceEntry(url, null);
    else addEntry(url, null);
  }

  // WebIDL's DOMString conversion under any context `prefix` (a setter's, too).
  function stringWith(value, prefix) {
    if (typeof value === 'symbol') {
      throw pageError(new TypeErrorP(prefix + 'Cannot convert a Symbol value to a string'));
    }

    return StringP(value);
  }

  // A URL operand of assign/replace/href, parsed against the document's URL.
  function navigationURL(value, prefix) {
    var text = stringWith(value, prefix);
    var url = parse(text, current);
    if (url === null) {
      throw pageError(
        new DOMException(prefix + "'" + text + "' is not a valid URL.", 'SyntaxError'),
      );
    }

    return url;
  }

  // --- DOMStringList ---------------------------------------------------------------

  var isStringList;

  /**
   * DOMStringList: a read-only list of strings. Larva makes one, the empty
   * location.ancestorOrigins of a top-level page.
   * @node n/a — Chrome 158, tests/web/cases/shape-location.expected.
   * @deviates No indexed properties (`list[0]`): the only list Larva makes is empty.
   */
  class DOMStringList {
    #items;

    constructor(token, items) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#items = items;
    }

    static {
      isStringList = function (o) {
        return typeof o === 'object' && o !== null && #items in o;
      };
    }

    get length() {
      if (!isStringList(this)) throw illegalInvocation();
      return this.#items.length;
    }

    contains(string) {
      if (!isStringList(this)) throw illegalInvocation();
      if (arguments.length < 1) {
        throw typeError('DOMStringList', 'contains', argumentsRequired(1, 0));
      }

      return ArrayPrototypeIncludes(this.#items, toDOMString(string, 'DOMStringList', 'contains'));
    }

    item(index) {
      if (!isStringList(this)) throw illegalInvocation();
      if (arguments.length < 1) {
        throw typeError('DOMStringList', 'item', argumentsRequired(1, 0));
      }

      // WebIDL `unsigned long`: ToNumber, then modulo 2^32.
      var i = NumberP(index) >>> 0;
      return i < this.#items.length ? this.#items[i] : null;
    }
  }

  var PublicDOMStringList = nativeShape.defineInterface({
    name: 'DOMStringList',
    impl: DOMStringList,
    length: 0,
    illegal: true,
    members: ['length', 'contains:1', 'item:1', 'constructor', '@@toStringTag'],
  });
  // A legacy indexed iterable's iterator is %Array.prototype.values% itself.
  ObjectDefineProperty(PublicDOMStringList.prototype, P.Symbol.iterator, {
    __proto__: null,
    value: ArrayPrototypeValues,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // --- Location ----------------------------------------------------------------------

  var isLocation;

  /**
   * Location: the document's URL, read and navigated through the `location` global.
   * Every member is an own, non-configurable property of the one instance
   * ([LegacyUnforgeable]); the prototype holds only `constructor` and @@toStringTag.
   * @node n/a — Chrome 158, tests/web/cases/shape-location.expected (shape),
   *   location-basic.expected (getters under the fixture page URL),
   *   location-errors.expected (Blink's texts).
   * @deviates A navigation to another document — assign/replace/href/a component
   *   setter whose URL differs from the document's in more than the fragment, and
   *   reload() — is not performed: the page keeps its document and its URL, which is
   *   what a page in Chrome also observes until the new document commits, except that
   *   here it never does. Neither `hashchange` nor `popstate` fires: the window is not
   *   an EventTarget yet (stage 4b). An invalid URL's text in a SyntaxError is the
   *   input as given, where Blink prints its own partial parse (`http://[` reads
   *   `http://[/`). Pinned by cmd/lava/window_env_test.odin.
   */
  class Location {
    #brand = true;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
    }

    static {
      isLocation = function (o) {
        return typeof o === 'object' && o !== null && #brand in o;
      };
    }
  }

  nativeShape.defineInterface({
    name: LOCATION,
    impl: Location,
    length: 0,
    illegal: true,
    members: ['constructor', '@@toStringTag'],
  });

  var ancestorOrigins = new DOMStringList(INTERNAL, []);

  function urlGetter(getter) {
    return function () {
      if (!isLocation(this)) throw illegalInvocation();
      return read(getter, current);
    };
  }

  function setHref(value) {
    if (!isLocation(this)) throw illegalInvocation();
    navigate(navigationURL(value, attributeContext(LOCATION, 'href', true)), false);
  }

  // A component setter (`location.pathname = …`): the document's URL with that one
  // component set as URL's setter sets it, then navigated to.
  function componentSetter(name) {
    var set = URL_SETTERS[name];
    return function (value) {
      if (!isLocation(this)) throw illegalInvocation();
      var text = stringWith(value, attributeContext(LOCATION, name, true));
      var copy;
      if (name === 'hash') {
        // Location's hash setter, unlike URL's, leaves an empty fragment, not none:
        // `location.hash = ''` navigates to `…#`. The input, less one leading '#',
        // parsed in the fragment state is what a '#'-relative reference resolves to.
        if (StringPrototypeCharCodeAt(text, 0) === 0x23)
          text = StringPrototypeSlice(text, 1, text.length);
        copy = parse('#' + text, current);
        // The fragment the URL already has is no navigation at all, not even a replace.
        if (read(urlHref, copy) === read(urlHref, current)) return;
      } else {
        copy = new URLP(read(urlHref, current));
        ReflectApply(set, copy, [text]);
      }

      navigate(copy, false);
    };
  }

  var LOCATION_MEMBERS = [
    [
      'ancestorOrigins',
      function () {
        if (!isLocation(this)) throw illegalInvocation();
        return ancestorOrigins;
      },
      null,
    ],
    ['href', urlGetter(urlHref), setHref],
    ['origin', urlGetter(urlOrigin), null],
    ['protocol', urlGetter(urlProtocol), componentSetter('protocol')],
    ['host', urlGetter(urlHost), componentSetter('host')],
    ['hostname', urlGetter(urlHostname), componentSetter('hostname')],
    ['port', urlGetter(urlPort), componentSetter('port')],
    ['pathname', urlGetter(urlPathname), componentSetter('pathname')],
    ['search', urlGetter(urlSearch), componentSetter('search')],
    ['hash', urlGetter(urlHash), componentSetter('hash')],
  ];

  var LOCATION_OPERATIONS = [
    [
      'assign',
      1,
      function (url) {
        if (!isLocation(this)) throw illegalInvocation();
        if (arguments.length < 1) throw typeError(LOCATION, 'assign', argumentsRequired(1, 0));
        navigate(navigationURL(url, context(LOCATION, 'assign')), false);
      },
    ],
    [
      'reload',
      0,
      function () {
        if (!isLocation(this)) throw illegalInvocation();
        // Not performed: see Location's @deviates.
      },
    ],
    [
      'replace',
      1,
      function (url) {
        if (!isLocation(this)) throw illegalInvocation();
        if (arguments.length < 1) throw typeError(LOCATION, 'replace', argumentsRequired(1, 0));
        navigate(navigationURL(url, context(LOCATION, 'replace')), true);
      },
    ],
    [
      'toString',
      0,
      function () {
        if (!isLocation(this)) throw illegalInvocation();
        return read(urlHref, current);
      },
    ],
  ];

  // The [LegacyUnforgeable] members, own and non-configurable on the instance, in
  // Blink's order: valueOf, the attributes, the operations, @@toPrimitive.
  function defineUnforgeable(target) {
    ObjectDefineProperty(target, 'valueOf', {
      __proto__: null,
      value: ObjectPrototypeValueOf,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    for (var i = 0; i < LOCATION_MEMBERS.length; i++) {
      var m = LOCATION_MEMBERS[i];
      ObjectDefineProperty(target, m[0], {
        __proto__: null,
        get: wrapGetter(m[0], m[1]),
        set: m[2] === null ? undefined : wrapSetter(m[0], m[2]),
        enumerable: true,
        configurable: false,
      });
    }

    for (var j = 0; j < LOCATION_OPERATIONS.length; j++) {
      var op = LOCATION_OPERATIONS[j];
      ObjectDefineProperty(target, op[0], {
        __proto__: null,
        value: wrapOperation(op[0], op[2], op[1]),
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }

    ObjectDefineProperty(target, P.Symbol.toPrimitive, {
      __proto__: null,
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  var locationObject = new Location(INTERNAL);
  defineUnforgeable(locationObject);

  // window.location: [LegacyUnforgeable] too (enumerable, non-configurable), and
  // [PutForwards=href]: assigning it sets location.href.
  ObjectDefineProperty(globalThis, 'location', {
    __proto__: null,
    get: wrapGetter('location', function () {
      return locationObject;
    }),
    set: wrapSetter('location', function (value) {
      ReflectApply(setHref, locationObject, [value]);
    }),
    enumerable: true,
    configurable: false,
  });

  // --- History -----------------------------------------------------------------------

  var isHistory;

  // HTML's "can have its URL rewritten": pushState may change the path, query and
  // fragment of an http(s) document's URL, only the fragment of any other.
  function canRewrite(doc, target) {
    if (
      read(urlProtocol, doc) !== read(urlProtocol, target) ||
      read(urlUsername, doc) !== read(urlUsername, target) ||
      read(urlPassword, doc) !== read(urlPassword, target) ||
      read(urlHost, doc) !== read(urlHost, target)
    ) {
      return false;
    }

    var scheme = read(urlProtocol, target);
    if (scheme === 'http:' || scheme === 'https:') return true;
    return (
      read(urlPathname, doc) === read(urlPathname, target) &&
      read(urlSearch, doc) === read(urlSearch, target)
    );
  }

  // The shared steps of pushState and replaceState, in HTML's order: the conversions,
  // the state's serialization, then the URL.
  function pushOrReplace(target, args, op) {
    if (!isHistory(target)) throw illegalInvocation();
    if (args.length < 2) throw typeError(HISTORY, op, argumentsRequired(2, args.length));
    var data = args[0];
    toDOMString(args[1], HISTORY, op);
    var urlArg = args.length > 2 ? args[2] : undefined;
    var text = urlArg === undefined || urlArg === null ? null : toDOMString(urlArg, HISTORY, op);
    var state = cloneFor(data, HISTORY, op);
    var url = current;
    if (text !== null) {
      url = parse(text, current);
      if (url === null || !canRewrite(current, url)) {
        throw pageError(
          new DOMException(
            context(HISTORY, op) +
              "A history state object with URL '" +
              (url === null ? text : read(urlHref, url)) +
              "' cannot be created in a document with origin '" +
              read(urlOrigin, current) +
              "' and URL '" +
              read(urlHref, current) +
              "'.",
            'SecurityError',
          ),
        );
      }
    }

    return { __proto__: null, url: url, state: state };
  }

  // HTML's "traverse the history by a delta", queued as Chrome queues it: the step is
  // taken from the active entry when the task runs, and a step outside this
  // document's entries is dropped.
  function traverse(delta) {
    setTimeoutP(function () {
      var target = index + delta;
      if (target < 0 || target >= entries.length) return;
      index = target;
      current = entries[target].url;
    }, 0);
  }

  /**
   * History: the session history of this document's entries.
   * @node n/a — Chrome 158, tests/web/cases/shape-location.expected (shape),
   *   history-state.expected (pushState/replaceState/traversal, relative to the
   *   initial length), location-errors.expected (Blink's texts).
   * @deviates `length` counts this document's entries only, starting at 1 (Chrome's
   *   headless recorder starts at 2, its initial about:blank entry). go(0) — a reload
   *   — and a traversal past this document's entries do nothing. No `popstate` or
   *   `hashchange` fires (stage 4b). Pinned by cmd/lava/window_env_test.odin.
   */
  class History {
    #brand = true;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
    }

    static {
      isHistory = function (o) {
        return typeof o === 'object' && o !== null && #brand in o;
      };
    }

    get length() {
      if (!isHistory(this)) throw illegalInvocation();
      return entries.length;
    }

    get scrollRestoration() {
      if (!isHistory(this)) throw illegalInvocation();
      return entries[index].scroll;
    }

    set scrollRestoration(value) {
      if (!isHistory(this)) throw illegalInvocation();
      var mode = stringWith(value, attributeContext(HISTORY, 'scrollRestoration', true));
      // An enumeration attribute ignores a value outside the enumeration.
      if (ArrayPrototypeIncludes(SCROLL_MODES, mode)) entries[index].scroll = mode;
    }

    get state() {
      if (!isHistory(this)) throw illegalInvocation();
      return entries[index].state;
    }

    back() {
      if (!isHistory(this)) throw illegalInvocation();
      traverse(-1);
    }

    forward() {
      if (!isHistory(this)) throw illegalInvocation();
      traverse(1);
    }

    go(delta) {
      if (!isHistory(this)) throw illegalInvocation();
      // WebIDL `long`: ToNumber, then ToInt32.
      var d = delta === undefined ? 0 : NumberP(delta) | 0;
      // go(0) reloads: not performed, see @deviates.
      if (d !== 0) traverse(d);
    }

    pushState(data, unused) {
      var r = pushOrReplace(this, arguments, 'pushState');
      addEntry(r.url, r.state);
    }

    replaceState(data, unused) {
      var r = pushOrReplace(this, arguments, 'replaceState');
      replaceEntry(r.url, r.state);
    }
  }

  nativeShape.defineInterface({
    name: HISTORY,
    impl: History,
    length: 0,
    illegal: true,
    members: [
      'length',
      'scrollRestoration',
      'state',
      'back:0',
      'forward:0',
      'go:0',
      'pushState:2',
      'replaceState:2',
      'constructor',
      '@@toStringTag',
    ],
  });

  var historyObject = new History(INTERNAL);
  nativeShape.defineGlobalAttribute('history', function () {
    return historyObject;
  });
});
