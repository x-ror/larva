/**
 * @fileoverview The `performance` global: the Performance interface (High Resolution
 * Time's now()/timeOrigin/toJSON) and User Timing Level 3 (mark/measure, the entry
 * buffer and PerformanceEntry/PerformanceMark/PerformanceMeasure), installed at
 * module-eval.
 *
 * The clock is native (globals.odin make_performance_bindings, this factory's fourth
 * argument): one process-wide origin, so now() stays comparable across workers. All
 * the rest is here, shaped by internal/native_shape as Blink's.
 *
 * The buffer holds marks and measures only. Chrome's also holds the page's navigation,
 * paint, visibility-state and resource entries, which Larva does not record; nor does
 * it have `timing`, `navigation`, `memory` or `eventCounts` (shape-performance's
 * known gap). Resource timing is therefore an empty buffer: clearResourceTimings and
 * setResourceTimingBufferSize do nothing, and `resourcetimingbufferfull` never fires.
 *
 * Instantiated eagerly (the loader names it), so every capture below is pristine.
 *
 * @module lava/internal/performance
 */

(function (require, module, _exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var eventTarget = require('internal/event_target');
  var DOMException = require('internal/domexception').DOMException;
  var cloneFor = require('internal/structured_clone').cloneFor;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var NumberIsFinite = P.NumberIsFinite;
  var NumberP = P.Number;
  var TypeErrorP = P.TypeError;
  var EventTargetImpl = eventTarget.EventTargetImpl;
  var attachHandler = eventTarget.attachHandler;
  var detachHandler = eventTarget.detachHandler;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;

  var nativeNow = native.now;
  var TIME_ORIGIN = native.timeOrigin;

  var PERFORMANCE = 'Performance';
  var MARK = 'mark';
  var MEASURE = 'measure';
  var BUFFER_FULL = 'resourcetimingbufferfull';
  // PerformanceEntry.navigationId: Blink's id of the navigation that made the entry. A
  // page in Larva is one navigation, so every entry carries the same one.
  var NAVIGATION_ID = 1;

  // The PerformanceTiming attribute names, which User Timing refuses as a mark name
  // and resolves as a timestamp in measure(). Larva has no PerformanceTiming, so only
  // navigationStart (the time origin, 0) resolves; the rest are the "not happened yet"
  // InvalidAccessError a page also gets from Chrome for an event still to come.
  var TIMING_NAMES = {
    __proto__: null,
    navigationStart: true,
    unloadEventStart: true,
    unloadEventEnd: true,
    redirectStart: true,
    redirectEnd: true,
    fetchStart: true,
    domainLookupStart: true,
    domainLookupEnd: true,
    connectStart: true,
    connectEnd: true,
    secureConnectionStart: true,
    requestStart: true,
    responseStart: true,
    responseEnd: true,
    domLoading: true,
    domInteractive: true,
    domContentLoadedEventStart: true,
    domContentLoadedEventEnd: true,
    domComplete: true,
    loadEventStart: true,
    loadEventEnd: true,
  };

  // The platform mints entries and the one Performance object through this token; a
  // page reaches native_shape's interface objects, which refuse construction themselves
  // (PerformanceMark aside, whose public constructor converts its own arguments).
  var INTERNAL = { __proto__: null };

  // The performance entry buffer: marks and measures in the order they were made.
  // Readers sort a copy by startTime (stably, so a tie keeps that order, as Chrome's).
  var entries = [];

  // Brand readers, assigned in the static blocks below.
  var isEntry;
  var entryName;
  var entryType;
  var entryStart;
  var isMark;
  var isMeasure;
  var isPerformance;
  var readHandler;

  function syntaxError(op, detail) {
    return pageError(new DOMException(context(PERFORMANCE, op) + detail, 'SyntaxError'));
  }

  // WebIDL `double`: ToNumber, refusing NaN and the infinities with Blink's text for a
  // dictionary member.
  function toDouble(value, iface, op, dict, member) {
    var n = NumberP(value);
    if (!NumberIsFinite(n)) {
      throw typeError(
        iface,
        op,
        "Failed to read the '" +
          member +
          "' property from '" +
          dict +
          "': The provided double value is non-finite.",
      );
    }

    return n;
  }

  // A `detail` member: null when absent or null, otherwise a structured clone.
  function cloneDetail(detail, iface, op) {
    if (detail === undefined || detail === null) return null;
    return cloneFor(detail, iface, op);
  }

  /**
   * PerformanceEntry: the name, type, start and duration every entry carries, in
   * private fields.
   * @node n/a — Chrome 158, tests/web/cases/shape-performance.expected and
   *   perf-user-timing.expected (toJSON's members and order).
   * @deviates navigationId is always 1 (Chrome's numbers its navigations).
   */
  class PerformanceEntry {
    #name;
    #entryType;
    #startTime;
    #duration;

    constructor(token, name, type, startTime, duration) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#name = name;
      this.#entryType = type;
      this.#startTime = startTime;
      this.#duration = duration;
    }

    static {
      isEntry = function (o) {
        return typeof o === 'object' && o !== null && #name in o;
      };
      entryName = function (e) {
        return e.#name;
      };
      entryType = function (e) {
        return e.#entryType;
      };
      entryStart = function (e) {
        return e.#startTime;
      };
    }

    get name() {
      if (!isEntry(this)) throw illegalInvocation();
      return this.#name;
    }

    get entryType() {
      if (!isEntry(this)) throw illegalInvocation();
      return this.#entryType;
    }

    get startTime() {
      if (!isEntry(this)) throw illegalInvocation();
      return this.#startTime;
    }

    get duration() {
      if (!isEntry(this)) throw illegalInvocation();
      return this.#duration;
    }

    get navigationId() {
      if (!isEntry(this)) throw illegalInvocation();
      return NAVIGATION_ID;
    }

    toJSON() {
      if (!isEntry(this)) throw illegalInvocation();
      return {
        name: this.#name,
        entryType: this.#entryType,
        startTime: this.#startTime,
        duration: this.#duration,
        navigationId: NAVIGATION_ID,
      };
    }
  }

  // PerformanceMarkOptions and the mark's name, converted and checked as User Timing's
  // "mark constructor steps": the dictionary first (detail, then startTime —
  // lexicographic), then the timing-name check, the negative start, the detail clone.
  function convertMark(markName, markOptions, iface, op) {
    var name = toDOMString(markName, iface, op);
    var detail;
    var startTime;
    if (markOptions !== undefined && markOptions !== null) {
      if (typeof markOptions !== 'object' && typeof markOptions !== 'function') {
        throw typeError(iface, op, "The provided value is not of type 'PerformanceMarkOptions'.");
      }

      detail = markOptions.detail;
      startTime = markOptions.startTime;
      if (startTime !== undefined) {
        startTime = toDouble(startTime, iface, op, 'PerformanceMarkOptions', 'startTime');
      }
    }

    if (TIMING_NAMES[name] === true) {
      throw pageError(
        new DOMException(
          context(iface, op) +
            "'" +
            name +
            "' is part of the PerformanceTiming interface, and cannot be used as a mark name.",
          'SyntaxError',
        ),
      );
    }

    if (startTime === undefined) {
      startTime = nativeNow();
    } else if (startTime < 0) {
      throw typeError(iface, op, "'" + name + "' cannot have a negative start time.");
    }

    return {
      __proto__: null,
      name: name,
      startTime: startTime,
      detail: cloneDetail(detail, iface, op),
    };
  }

  /**
   * new PerformanceMark(markName, markOptions) — a mark that is not in the buffer.
   * @throws {TypeError} `Failed to construct 'PerformanceMark': 1 argument required,
   *   but only 0 present.`; a negative or non-finite startTime; a non-object options.
   * @throws {DOMException} SyntaxError for a PerformanceTiming name, DataCloneError for
   *   a detail that cannot be cloned.
   * @node n/a — Chrome 158, tests/web/cases/perf-user-timing.expected.
   * @deviates none
   */
  class PerformanceMark extends PerformanceEntry {
    #detail;

    constructor(markName, markOptions, startTime, detail) {
      var name = markOptions;
      if (markName !== INTERNAL) {
        if (arguments.length < 1) {
          throw typeError('PerformanceMark', undefined, argumentsRequired(1, arguments.length));
        }

        var mark = convertMark(markName, markOptions, 'PerformanceMark', undefined);
        name = mark.name;
        startTime = mark.startTime;
        detail = mark.detail;
      }

      super(INTERNAL, name, MARK, startTime, 0);
      this.#detail = detail;
    }

    static {
      isMark = function (o) {
        return typeof o === 'object' && o !== null && #detail in o;
      };
    }

    get detail() {
      if (!isMark(this)) throw illegalInvocation();
      return this.#detail;
    }
  }

  class PerformanceMeasure extends PerformanceEntry {
    #detail;

    constructor(token, name, startTime, duration, detail) {
      super(token, name, MEASURE, startTime, duration);
      this.#detail = detail;
    }

    static {
      isMeasure = function (o) {
        return typeof o === 'object' && o !== null && #detail in o;
      };
    }

    get detail() {
      if (!isMeasure(this)) throw illegalInvocation();
      return this.#detail;
    }
  }

  // A (DOMString or DOMHighResTimeStamp) member of PerformanceMeasureOptions.
  function convertTime(value, member) {
    if (value === undefined) return undefined;
    if (typeof value === 'number') {
      return toDouble(value, PERFORMANCE, MEASURE, 'PerformanceMeasureOptions', member);
    }

    return toDOMString(value, PERFORMANCE, MEASURE);
  }

  // User Timing's "convert a mark to a timestamp": a mark name is the latest mark of
  // that name's startTime, a number must not be negative.
  function markTimestamp(mark, measureName) {
    if (typeof mark === 'number') {
      if (mark < 0) {
        throw typeError(
          PERFORMANCE,
          MEASURE,
          "'" + measureName + "' cannot have a negative time stamp.",
        );
      }

      return mark;
    }

    if (TIMING_NAMES[mark] === true) {
      if (mark === 'navigationStart') return 0;
      throw pageError(
        new DOMException(
          context(PERFORMANCE, MEASURE) +
            "'" +
            mark +
            "' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.",
          'InvalidAccessError',
        ),
      );
    }

    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      if (entryType(e) === MARK && entryName(e) === mark) return entryStart(e);
    }

    throw syntaxError(MEASURE, "The mark '" + mark + "' does not exist.");
  }

  function byStartTime(a, b) {
    return entryStart(a) - entryStart(b);
  }

  // The buffer's entries matching `name` and `type` (undefined matches any), sorted by
  // startTime, in a fresh array each call.
  function filterEntries(name, type) {
    var out = [];
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (name !== undefined && entryName(e) !== name) continue;
      if (type !== undefined && entryType(e) !== type) continue;
      out[n++] = e;
    }

    return ArrayPrototypeSort(out, byStartTime);
  }

  // Drops the buffer's entries of `type` named `name` (any name when undefined).
  function clearEntries(type, name) {
    var kept = [];
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (entryType(e) === type && (name === undefined || entryName(e) === name)) continue;
      kept[n++] = e;
    }

    entries = kept;
  }

  /**
   * Performance (High Resolution Time, User Timing): the one instance is `performance`.
   * @node n/a — Chrome 158: tests/web/cases/perf-now.expected, perf-user-timing.expected
   *   (mark/measure arguments, errors and entry order) and shape-performance.expected.
   * @deviates toJSON() has timeOrigin only (Chrome's adds timing and navigation, which
   *   Larva does not implement); the buffer holds no navigation, paint or resource
   *   entries; interactionCount is always 0 (a headless page has no user input). Pinned
   *   by perf-user-timing (it prints only the mark and measure entries) and the
   *   shape-performance known gap.
   */
  class Performance extends EventTargetImpl {
    #onresourcetimingbufferfull = null;
    // The listener entry the handler occupies while it is non-null.
    #handler = null;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      super();
    }

    static {
      isPerformance = function (o) {
        return typeof o === 'object' && o !== null && #handler in o;
      };
      readHandler = function (target) {
        return target.#onresourcetimingbufferfull;
      };
    }

    get timeOrigin() {
      if (!isPerformance(this)) throw illegalInvocation();
      return TIME_ORIGIN;
    }

    get onresourcetimingbufferfull() {
      if (!isPerformance(this)) throw illegalInvocation();
      return this.#onresourcetimingbufferfull;
    }

    set onresourcetimingbufferfull(fn) {
      if (!isPerformance(this)) throw illegalInvocation();
      this.#onresourcetimingbufferfull = typeof fn === 'function' ? fn : null;
      if (this.#onresourcetimingbufferfull !== null && this.#handler === null) {
        this.#handler = attachHandler(this, BUFFER_FULL, readHandler);
      } else if (this.#onresourcetimingbufferfull === null && this.#handler !== null) {
        detachHandler(this, BUFFER_FULL, this.#handler);
        this.#handler = null;
      }
    }

    clearMarks(markName) {
      if (!isPerformance(this)) throw illegalInvocation();
      var name =
        markName === undefined ? undefined : toDOMString(markName, PERFORMANCE, 'clearMarks');
      clearEntries(MARK, name);
    }

    clearMeasures(measureName) {
      if (!isPerformance(this)) throw illegalInvocation();
      var name =
        measureName === undefined
          ? undefined
          : toDOMString(measureName, PERFORMANCE, 'clearMeasures');
      clearEntries(MEASURE, name);
    }

    // No resource entries are recorded (the file comment).
    clearResourceTimings() {
      if (!isPerformance(this)) throw illegalInvocation();
    }

    getEntries() {
      if (!isPerformance(this)) throw illegalInvocation();
      return filterEntries(undefined, undefined);
    }

    getEntriesByName(name, type) {
      if (!isPerformance(this)) throw illegalInvocation();
      if (arguments.length < 1) {
        throw typeError(PERFORMANCE, 'getEntriesByName', argumentsRequired(1, 0));
      }

      var n = toDOMString(name, PERFORMANCE, 'getEntriesByName');
      var t = type === undefined ? undefined : toDOMString(type, PERFORMANCE, 'getEntriesByName');
      return filterEntries(n, t);
    }

    getEntriesByType(type) {
      if (!isPerformance(this)) throw illegalInvocation();
      if (arguments.length < 1) {
        throw typeError(PERFORMANCE, 'getEntriesByType', argumentsRequired(1, 0));
      }

      return filterEntries(undefined, toDOMString(type, PERFORMANCE, 'getEntriesByType'));
    }

    mark(markName, markOptions) {
      if (!isPerformance(this)) throw illegalInvocation();
      if (arguments.length < 1) throw typeError(PERFORMANCE, MARK, argumentsRequired(1, 0));
      var m = convertMark(markName, markOptions, PERFORMANCE, MARK);
      var entry = new PerformanceMark(INTERNAL, m.name, m.startTime, m.detail);
      entries[entries.length] = entry;
      return entry;
    }

    // User Timing's measure(): the options dictionary's members are read in
    // lexicographic order (detail, duration, end, start), then endMark, then the
    // checks and the two timestamps — end first, as the standard orders them.
    measure(measureName, startOrMeasureOptions, endMark) {
      if (!isPerformance(this)) throw illegalInvocation();
      if (arguments.length < 1) throw typeError(PERFORMANCE, MEASURE, argumentsRequired(1, 0));
      var name = toDOMString(measureName, PERFORMANCE, MEASURE);
      var startString;
      var detail;
      var duration;
      var end;
      var start;
      var o = startOrMeasureOptions;
      if (o === undefined || o === null || typeof o === 'object' || typeof o === 'function') {
        if (o !== undefined && o !== null) {
          detail = o.detail;
          duration = o.duration;
          if (duration !== undefined) {
            duration = toDouble(
              duration,
              PERFORMANCE,
              MEASURE,
              'PerformanceMeasureOptions',
              'duration',
            );
          }

          end = convertTime(o.end, 'end');
          start = convertTime(o.start, 'start');
        }
      } else {
        startString = toDOMString(o, PERFORMANCE, MEASURE);
      }

      var endName = endMark === undefined ? undefined : toDOMString(endMark, PERFORMANCE, MEASURE);
      var nonEmpty =
        detail !== undefined || duration !== undefined || end !== undefined || start !== undefined;
      var prefix = 'If a non-empty PerformanceMeasureOptions object was passed, ';
      if (nonEmpty) {
        if (endName !== undefined) {
          throw typeError(PERFORMANCE, MEASURE, prefix + '|end_mark| must not be passed.');
        }

        if (start === undefined && end === undefined) {
          throw typeError(
            PERFORMANCE,
            MEASURE,
            prefix + "at least one of its 'start' or 'end' properties must be present.",
          );
        }

        if (start !== undefined && duration !== undefined && end !== undefined) {
          throw typeError(
            PERFORMANCE,
            MEASURE,
            prefix +
              "it must not have all of its 'start', 'duration', and 'end' properties defined",
          );
        }
      }

      var endTime;
      if (endName !== undefined) endTime = markTimestamp(endName, name);
      else if (end !== undefined) endTime = markTimestamp(end, name);
      else if (start !== undefined && duration !== undefined) {
        endTime = markTimestamp(start, name) + duration;
      } else endTime = nativeNow();

      var startTime;
      if (start !== undefined) startTime = markTimestamp(start, name);
      else if (duration !== undefined && end !== undefined) {
        startTime = markTimestamp(end, name) - duration;
      } else if (startString !== undefined) startTime = markTimestamp(startString, name);
      else startTime = 0;

      var entry = new PerformanceMeasure(
        INTERNAL,
        name,
        startTime,
        endTime - startTime,
        cloneDetail(detail, PERFORMANCE, MEASURE),
      );
      entries[entries.length] = entry;
      return entry;
    }

    // No resource entries are recorded, so there is no buffer size to keep; the
    // argument is still required, as Blink's.
    setResourceTimingBufferSize(maxSize) {
      if (!isPerformance(this)) throw illegalInvocation();
      if (arguments.length < 1) {
        throw typeError(PERFORMANCE, 'setResourceTimingBufferSize', argumentsRequired(1, 0));
      }

      NumberP(maxSize);
    }

    toJSON() {
      if (!isPerformance(this)) throw illegalInvocation();
      return { timeOrigin: TIME_ORIGIN };
    }

    now() {
      if (!isPerformance(this)) throw illegalInvocation();
      return nativeNow();
    }

    get interactionCount() {
      if (!isPerformance(this)) throw illegalInvocation();
      return 0;
    }
  }

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-performance.expected). Performance's `timing`,
  // `navigation`, `memory` and `eventCounts` would sit between `constructor` and
  // interactionCount.
  var PublicPerformanceEntry = nativeShape.defineInterface({
    name: 'PerformanceEntry',
    impl: PerformanceEntry,
    length: 0,
    illegal: true,
    members: [
      'name',
      'entryType',
      'startTime',
      'duration',
      'navigationId',
      'toJSON:0',
      'constructor',
      '@@toStringTag',
    ],
  });
  nativeShape.defineInterface({
    name: 'PerformanceMark',
    impl: PerformanceMark,
    length: 1,
    parent: PublicPerformanceEntry,
    members: ['detail', 'constructor', '@@toStringTag'],
  });
  nativeShape.defineInterface({
    name: 'PerformanceMeasure',
    impl: PerformanceMeasure,
    length: 0,
    illegal: true,
    parent: PublicPerformanceEntry,
    members: ['detail', 'constructor', '@@toStringTag'],
  });
  nativeShape.defineInterface({
    name: 'Performance',
    impl: Performance,
    length: 0,
    illegal: true,
    parent: eventTarget.EventTarget,
    members: [
      'timeOrigin',
      'onresourcetimingbufferfull',
      'clearMarks:0',
      'clearMeasures:0',
      'clearResourceTimings:0',
      'getEntries:0',
      'getEntriesByName:1',
      'getEntriesByType:1',
      'mark:1',
      'measure:1',
      'setResourceTimingBufferSize:1',
      'toJSON:0',
      'now:0',
      'constructor',
      'interactionCount',
      '@@toStringTag',
    ],
  });

  var performanceObject = new Performance(INTERNAL);
  nativeShape.defineGlobalAttribute(
    'performance',
    function () {
      return performanceObject;
    },
    true,
  );
});
