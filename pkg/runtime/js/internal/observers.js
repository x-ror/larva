/**
 * @fileoverview IntersectionObserver and ResizeObserver (#14), over internal/layout's
 * estimated geometry — what lazy loaders and infinite scroll wait on.
 *
 * IntersectionObserver: a target's first observation, a task after observe(), reports
 * it intersecting (ratio 1) whenever it has a box at all, wherever the estimate put it,
 * so every lazy-loaded image and widget on the page loads without scrolling. From then
 * on its state follows the estimate: after a tree mutation or a scroll, a target whose
 * box now does (or no longer does) meet the viewport, grown by rootMargin, gets an
 * entry. So an infinite-scroll sentinel pushed below the fold by the page it loaded
 * reports leaving, and reports entering again once the page is scrolled to it.
 *
 * ResizeObserver: one entry per observed target, a task after observe(), with its
 * estimated size; never again (the viewport does not change, and re-measuring after a
 * mutation could feed a page's resize handler its own output forever).
 *
 * Instantiated eagerly (the loader names it), so every capture below is pristine.
 *
 * @module lava/internal/observers
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var layout = require('internal/layout');
  var reportException = require('internal/deferred').reportException;
  var ArrayIsArray = P.ArrayIsArray;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var NumberIsFinite = P.NumberIsFinite;
  var NumberP = P.Number;
  var ObjectFreeze = P.ObjectFreeze;
  var ReflectApply = P.ReflectApply;
  var StringP = P.String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var TypeErrorP = P.TypeError;
  var RangeErrorP = P.RangeError;
  var MathFloor = P.MathFloor;
  var MathTrunc = P.MathTrunc;
  var DOMException = require('internal/domexception').DOMException;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var toNumber = webErrors.toNumber;
  var typeError = webErrors.typeError;
  var isElement = layout.isElement;
  var viewport = layout.viewport;
  // Captured at this eager eval: the timer an observation is queued on, and the clock
  // an entry's `time` reads.
  var setTimeoutP = setTimeout;
  var performanceObject = performance;
  var performanceNow = performance.now;

  var INTERNAL = { __proto__: null };
  var IO = 'IntersectionObserver';
  var RO = 'ResizeObserver';

  function now() {
    return ReflectApply(performanceNow, performanceObject, []);
  }

  function invoke(callback, observer, entries) {
    try {
      ReflectApply(callback, observer, [entries, observer]);
    } catch (e) {
      reportException(e);
    }
  }

  // --- IntersectionObserver ---------------------------------------------------------

  // The observers with targets, in creation order: what an update visits.
  var intersection = [];
  var resize = [];
  var updateQueued = false;

  function queueUpdate() {
    if (updateQueued) return;
    if (intersection.length === 0 && resize.length === 0) return;
    updateQueued = true;
    setTimeoutP(update, 0);
  }

  layout.onInvalidate(function () {
    if (intersection.length !== 0) queueUpdate();
  });
  layout.onScroll(function () {
    if (intersection.length !== 0) queueUpdate();
  });

  function update() {
    updateQueued = false;
    var ios = sliceAll(intersection);
    for (var i = 0; i < ios.length; i++) evaluateIntersections(ios[i]);
    for (var j = 0; j < ios.length; j++) deliverIntersections(ios[j]);
    var ros = sliceAll(resize);
    for (var k = 0; k < ros.length; k++) deliverResizes(ros[k]);
  }

  function sliceAll(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) out[i] = a[i];
    return out;
  }

  function remove(list, item) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === item) {
        ArrayPrototypeSplice(list, i, 1);
        return;
      }
    }
  }

  function indexOfTarget(targets, el) {
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].el === el) return i;
    }

    return -1;
  }

  // rootMargin / scrollMargin: one to four `<n>px` or `<n>%` values, CSS margin order.
  // Answers [serialization, [[value, isPercent] x4]].
  function parseMargin(text, member) {
    var parts = [];
    var i = 0;
    while (i < text.length) {
      var c = StringPrototypeCharCodeAt(text, i);
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) {
        i++;
        continue;
      }

      var j = i;
      while (j < text.length) {
        var d = StringPrototypeCharCodeAt(text, j);
        if (d === 32 || d === 9 || d === 10 || d === 12 || d === 13) break;
        j++;
      }

      if (parts.length === 4) {
        throw pageError(
          new DOMException(
            context(IO) + 'Extra text found at the end of ' + member + '.',
            'SyntaxError',
          ),
        );
      }

      parts[parts.length] = marginValue(
        StringPrototypeToLowerCase(StringPrototypeSlice(text, i, j)),
        member,
      );
      i = j;
    }

    if (parts.length === 0) parts[0] = [0, false];
    var top = parts[0];
    var right = parts.length > 1 ? parts[1] : top;
    var bottom = parts.length > 2 ? parts[2] : top;
    var left = parts.length > 3 ? parts[3] : right;
    var sides = [top, right, bottom, left];
    var text2 = '';
    for (var k = 0; k < 4; k++)
      text2 += (k === 0 ? '' : ' ') + StringP(sides[k][0]) + (sides[k][1] ? '%' : 'px');
    return [text2, sides];
  }

  function marginValue(token, member) {
    var percent = false;
    var end = token.length;
    if (end > 1 && StringPrototypeSlice(token, end - 1, end) === '%') {
      percent = true;
      end--;
    } else if (end > 2 && StringPrototypeSlice(token, end - 2, end) === 'px') {
      end -= 2;
    } else {
      end = -1;
    }

    var n = end <= 0 ? NaN : NumberP(StringPrototypeSlice(token, 0, end));
    if (!NumberIsFinite(n)) {
      throw pageError(
        new DOMException(
          context(IO) + member + ' must be specified in absolute length units or percent.',
          'SyntaxError',
        ),
      );
    }

    // Blink keeps a px margin as an integer (`1.5px` reads back `1px`).
    return [percent ? n : MathTrunc(n), percent];
  }

  // threshold: a double or a sequence of them, each in [0, 1]; sorted.
  function readThresholds(value) {
    var list = [];
    if (value === undefined) {
      list[0] = 0;
    } else if (value !== null && typeof value === 'object') {
      if (ArrayIsArray(value)) {
        for (var i = 0; i < value.length; i++) list[i] = toNumber(value[i], IO);
      } else {
        // A non-array object is a sequence through its iterator.
        var n = 0;
        for (var v of value) list[n++] = toNumber(v, IO);
      }
    } else {
      list[0] = toNumber(value, IO);
    }

    for (var j = 0; j < list.length; j++) {
      var t = list[j];
      if (!NumberIsFinite(t)) {
        throw typeError(
          IO,
          undefined,
          "Failed to read the 'threshold' property from 'IntersectionObserverInit': The provided double value is non-finite.",
        );
      }

      if (!(t >= 0 && t <= 1)) {
        throw pageError(
          new RangeErrorP(context(IO) + 'Threshold values must be numbers between 0 and 1'),
        );
      }
    }

    if (list.length === 0) list[0] = 0;
    ArrayPrototypeSort(list, function (a, b) {
      return a - b;
    });
    return ObjectFreeze(list);
  }

  function marginPx(side, extent) {
    return side[1] ? (side[0] * extent) / 100 : side[0];
  }

  var ioState;
  var entryState;

  /**
   * IntersectionObserver: reports when its targets enter or leave the viewport, as the
   * estimate places them.
   * @param {Function} callback
   * @param {Object} [options] IntersectionObserverInit.
   * @throws {TypeError} Blink's text for a missing or non-callable callback, a root that
   *   is not an Element or Document, a target that is not an Element.
   * @throws {RangeError} `… Threshold values must be numbers between 0 and 1`.
   * @throws {DOMException} SyntaxError for a rootMargin that is not px/% values.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): options are read in WebIDL's
   *   order; thresholds come back sorted; rootMargin serializes as four sides;
   *   takeRecords() right after observe() is empty (the first observation is a task).
   * @deviates A target's FIRST observation reports it intersecting wherever it is
   *   (file comment) — Chrome reports a below-the-fold target not intersecting; and it
   *   is delivered before `load` when observe() ran before it (Larva's loop idles
   *   first), where Chrome's first rendering step comes after. Pinned by
   *   cmd/lava/window_layout_test.odin. An explicit `root` is accepted and the
   *   viewport used in its place.
   */
  class IntersectionObserver {
    #s;

    constructor(callback, options) {
      if (arguments.length < 1) throw typeError(IO, undefined, argumentsRequired(1, 0));
      if (typeof callback !== 'function') throw typeError(IO, undefined, notOfType(1, 'Function'));
      var delay = 0;
      var root = null;
      var margin = parseMargin('', 'rootMargin');
      var scrollMargin = parseMargin('', 'scrollMargin');
      var thresholds;
      var track = false;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') {
          throw typeError(IO, undefined, "parameter 2 is not of type 'IntersectionObserverInit'.");
        }

        var d = options.delay;
        if (d !== undefined) {
          d = toNumber(d, IO);
          delay = NumberIsFinite(d) ? (d < 0 ? -1 : 1) * MathFloor(d < 0 ? -d : d) : 0;
        }

        var r = options.root;
        if (r !== undefined && r !== null) {
          if (!isElement(r) && !layout.isDocument(r)) {
            throw typeError(
              IO,
              undefined,
              "Failed to read the 'root' property from 'IntersectionObserverInit': The provided value is not of type '(Document or Element)'.",
            );
          }

          root = r;
        }

        var m = options.rootMargin;
        if (m !== undefined) margin = parseMargin(toDOMString(m, IO), 'rootMargin');
        var sm = options.scrollMargin;
        if (sm !== undefined) scrollMargin = parseMargin(toDOMString(sm, IO), 'scrollMargin');
        thresholds = readThresholds(options.threshold);
        track = !!options.trackVisibility;
      } else {
        thresholds = readThresholds(undefined);
      }

      this.#s = {
        __proto__: null,
        observer: this,
        callback: callback,
        root: root,
        margin: margin,
        scrollMargin: scrollMargin,
        thresholds: thresholds,
        delay: delay,
        track: track,
        targets: [],
        records: [],
      };
    }

    static {
      ioState = function (o) {
        if (o === null || typeof o !== 'object' || !(#s in o)) throw illegalInvocation();
        return o.#s;
      };
    }

    get root() {
      return ioState(this).root;
    }

    get rootMargin() {
      return ioState(this).margin[0];
    }

    get scrollMargin() {
      return ioState(this).scrollMargin[0];
    }

    get thresholds() {
      return ioState(this).thresholds;
    }

    get delay() {
      return ioState(this).delay;
    }

    get trackVisibility() {
      return ioState(this).track;
    }

    disconnect() {
      var s = ioState(this);
      s.targets = [];
      remove(intersection, s);
    }

    observe(target) {
      var s = ioState(this);
      if (arguments.length < 1) throw typeError(IO, 'observe', argumentsRequired(1, 0));
      if (!isElement(target)) throw typeError(IO, 'observe', notOfType(1, 'Element'));
      if (indexOfTarget(s.targets, target) !== -1) return;
      s.targets[s.targets.length] = { __proto__: null, el: target, last: -1 };
      if (s.targets.length === 1) intersection[intersection.length] = s;
      queueUpdate();
    }

    takeRecords() {
      var s = ioState(this);
      var records = s.records;
      s.records = [];
      return records;
    }

    unobserve(target) {
      var s = ioState(this);
      if (arguments.length < 1) throw typeError(IO, 'unobserve', argumentsRequired(1, 0));
      if (!isElement(target)) throw typeError(IO, 'unobserve', notOfType(1, 'Element'));
      var at = indexOfTarget(s.targets, target);
      if (at === -1) return;
      ArrayPrototypeSplice(s.targets, at, 1);
      if (s.targets.length === 0) remove(intersection, s);
    }
  }

  function deliverIntersections(s) {
    if (s.records.length === 0) return;
    var records = s.records;
    s.records = [];
    invoke(s.callback, s.observer, records);
  }

  function meets(rect, top, right, bottom, left) {
    return (
      rect[1] <= bottom && rect[1] + rect[3] >= top && rect[0] <= right && rect[0] + rect[2] >= left
    );
  }

  function evaluateIntersections(s) {
    var vw = viewport.width;
    var vh = viewport.height;
    var m = s.margin[1];
    var top = -marginPx(m[0], vh);
    var right = vw + marginPx(m[1], vw);
    var bottom = vh + marginPx(m[2], vh);
    var left = -marginPx(m[3], vw);
    var rootBounds = [left, top, right - left, bottom - top];
    for (var i = 0; i < s.targets.length; i++) {
      var t = s.targets[i];
      var rect = layout.rectOf(t.el);
      // No box: not intersecting. A first observation: intersecting (file comment).
      // Otherwise: whether the box meets the root bounds.
      var state = 0;
      if (rect !== null) state = t.last === -1 || meets(rect, top, right, bottom, left) ? 1 : 0;
      if (state === t.last) continue;
      t.last = state;
      var r = rect === null ? [0, 0, 0, 0] : rect;
      s.records[s.records.length] = new IntersectionObserverEntry(INTERNAL, {
        __proto__: null,
        time: now(),
        rootBounds: layout.newRectReadOnly(
          rootBounds[0],
          rootBounds[1],
          rootBounds[2],
          rootBounds[3],
        ),
        boundingClientRect: layout.newRectReadOnly(r[0], r[1], r[2], r[3]),
        intersectionRect:
          state === 1
            ? layout.newRectReadOnly(r[0], r[1], r[2], r[3])
            : layout.newRectReadOnly(0, 0, 0, 0),
        isIntersecting: state === 1,
        ratio: state,
        target: t.el,
      });
    }
  }

  /**
   * IntersectionObserverEntry: one change of a target's intersection.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): members and order.
   * @deviates isVisible is always false (trackVisibility is not modeled).
   */
  class IntersectionObserverEntry {
    #e;

    constructor(token, e) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#e = e;
    }

    static {
      entryState = function (o) {
        if (o === null || typeof o !== 'object' || !(#e in o)) throw illegalInvocation();
        return o.#e;
      };
    }

    get time() {
      return entryState(this).time;
    }

    get rootBounds() {
      return entryState(this).rootBounds;
    }

    get boundingClientRect() {
      return entryState(this).boundingClientRect;
    }

    get intersectionRect() {
      return entryState(this).intersectionRect;
    }

    get isIntersecting() {
      return entryState(this).isIntersecting;
    }

    get isVisible() {
      entryState(this);
      return false;
    }

    get intersectionRatio() {
      return entryState(this).ratio;
    }

    get target() {
      return entryState(this).target;
    }
  }

  nativeShape.defineInterface({
    name: IO,
    impl: IntersectionObserver,
    length: 1,
    members: [
      'root',
      'rootMargin',
      'scrollMargin',
      'thresholds',
      'delay',
      'trackVisibility',
      'disconnect:0',
      'observe:1',
      'takeRecords:0',
      'unobserve:1',
      'constructor',
      '@@toStringTag',
    ],
  });
  nativeShape.defineInterface({
    name: 'IntersectionObserverEntry',
    impl: IntersectionObserverEntry,
    length: 0,
    illegal: true,
    members: [
      'time',
      'rootBounds',
      'boundingClientRect',
      'intersectionRect',
      'isIntersecting',
      'isVisible',
      'intersectionRatio',
      'target',
      'constructor',
      '@@toStringTag',
    ],
  });

  // --- ResizeObserver --------------------------------------------------------------

  var BOXES = { __proto__: null, 'content-box': 1, 'border-box': 1, 'device-pixel-content-box': 1 };
  var roState;
  var roEntryState;
  var sizeState;

  /**
   * ResizeObserver: one entry per observed target, a task after observe().
   * @param {Function} callback
   * @throws {TypeError} Blink's text for a missing or non-callable callback, a target
   *   that is not an Element, an unknown `box`.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page).
   * @deviates Never reports again after the first observation (file comment); the
   *   sizes are the estimate's. Delivered before `load`, as IntersectionObserver's.
   */
  class ResizeObserver {
    #s;

    constructor(callback) {
      if (arguments.length < 1) throw typeError(RO, undefined, argumentsRequired(1, 0));
      if (typeof callback !== 'function') throw typeError(RO, undefined, notOfType(1, 'Function'));
      var s = {
        __proto__: null,
        observer: this,
        callback: callback,
        targets: [],
        fresh: [],
      };
      this.#s = s;
    }

    static {
      roState = function (o) {
        if (o === null || typeof o !== 'object' || !(#s in o)) throw illegalInvocation();
        return o.#s;
      };
    }

    disconnect() {
      var s = roState(this);
      s.targets = [];
      s.fresh = [];
      remove(resize, s);
    }

    observe(target, options) {
      var s = roState(this);
      if (arguments.length < 1) throw typeError(RO, 'observe', argumentsRequired(1, 0));
      if (!isElement(target)) throw typeError(RO, 'observe', notOfType(1, 'Element'));
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') {
          throw typeError(RO, 'observe', "parameter 2 is not of type 'ResizeObserverOptions'.");
        }

        var box = options.box;
        if (box !== undefined) {
          box = toDOMString(box, RO, 'observe');
          if (BOXES[box] !== 1) {
            throw typeError(
              RO,
              'observe',
              "Failed to read the 'box' property from 'ResizeObserverOptions': The provided value '" +
                box +
                "' is not a valid enum value of type ResizeObserverBoxOptions.",
            );
          }
        }
      }

      if (indexOfTarget(s.targets, target) !== -1) return;
      s.targets[s.targets.length] = { __proto__: null, el: target };
      s.fresh[s.fresh.length] = target;
      if (s.targets.length === 1) resize[resize.length] = s;
      queueUpdate();
    }

    unobserve(target) {
      var s = roState(this);
      if (arguments.length < 1) throw typeError(RO, 'unobserve', argumentsRequired(1, 0));
      if (!isElement(target)) throw typeError(RO, 'unobserve', notOfType(1, 'Element'));
      var at = indexOfTarget(s.targets, target);
      if (at === -1) return;
      ArrayPrototypeSplice(s.targets, at, 1);
      for (var i = 0; i < s.fresh.length; i++) {
        if (s.fresh[i] === target) {
          ArrayPrototypeSplice(s.fresh, i, 1);
          break;
        }
      }

      if (s.targets.length === 0) remove(resize, s);
    }
  }

  function deliverResizes(s) {
    if (s.fresh.length === 0) return;
    var fresh = s.fresh;
    s.fresh = [];
    var entries = [];
    for (var i = 0; i < fresh.length; i++) entries[i] = resizeEntry(fresh[i]);
    invoke(s.callback, s.observer, entries);
  }

  function resizeEntry(el) {
    var rect = layout.rectOf(el);
    // An inline box has no content box to size (Chrome reports 0x0 for a <span>).
    var sized = rect !== null && rect[4] !== 1;
    var w = sized ? rect[2] : 0;
    var h = sized ? rect[3] : 0;
    var size = ObjectFreeze([new ResizeObserverSize(INTERNAL, w, h)]);
    var dpr = viewport.dpr;
    return new ResizeObserverEntry(INTERNAL, {
      __proto__: null,
      target: el,
      contentRect: layout.newRectReadOnly(0, 0, w, h),
      contentBoxSize: size,
      borderBoxSize: ObjectFreeze([new ResizeObserverSize(INTERNAL, w, h)]),
      devicePixelContentBoxSize: ObjectFreeze([new ResizeObserverSize(INTERNAL, w * dpr, h * dpr)]),
    });
  }

  class ResizeObserverEntry {
    #e;

    constructor(token, e) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#e = e;
    }

    static {
      roEntryState = function (o) {
        if (o === null || typeof o !== 'object' || !(#e in o)) throw illegalInvocation();
        return o.#e;
      };
    }

    get target() {
      return roEntryState(this).target;
    }

    get contentRect() {
      return roEntryState(this).contentRect;
    }

    get contentBoxSize() {
      return roEntryState(this).contentBoxSize;
    }

    get borderBoxSize() {
      return roEntryState(this).borderBoxSize;
    }

    get devicePixelContentBoxSize() {
      return roEntryState(this).devicePixelContentBoxSize;
    }
  }

  class ResizeObserverSize {
    #inline;
    #block;

    constructor(token, inline, block) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#inline = inline;
      this.#block = block;
    }

    static {
      sizeState = function (o) {
        if (o === null || typeof o !== 'object' || !(#inline in o)) throw illegalInvocation();
        return o;
      };
    }

    get inlineSize() {
      return sizeState(this).#inline;
    }

    get blockSize() {
      return sizeState(this).#block;
    }
  }

  nativeShape.defineInterface({
    name: RO,
    impl: ResizeObserver,
    length: 1,
    members: ['disconnect:0', 'observe:1', 'unobserve:1', 'constructor', '@@toStringTag'],
  });
  nativeShape.defineInterface({
    name: 'ResizeObserverEntry',
    impl: ResizeObserverEntry,
    length: 0,
    illegal: true,
    members: [
      'target',
      'contentRect',
      'contentBoxSize',
      'borderBoxSize',
      'devicePixelContentBoxSize',
      'constructor',
      '@@toStringTag',
    ],
  });
  nativeShape.defineInterface({
    name: 'ResizeObserverSize',
    impl: ResizeObserverSize,
    length: 0,
    illegal: true,
    members: ['inlineSize', 'blockSize', 'constructor', '@@toStringTag'],
  });
});
