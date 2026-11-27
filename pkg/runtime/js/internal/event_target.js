/**
 * @fileoverview EventTarget, Event and CustomEvent (DOM Standard §2): for targets that
 * are not nodes — a page's `new EventTarget()`, its subclasses, and AbortSignal
 * (internal/abort) — installed as globals at module-eval; and for a page's DOM nodes
 * (internal/dom), which register as host targets (setHostTargets) and dispatch along
 * the tree, capture, target and bubble (dispatchPath).
 *
 * The oracle is Chrome 158 (tests/web/cases/events-target.expected, shape-events), and
 * where Blink and the standard part ways on a target with no parent, this follows
 * Blink: a dispatch runs the target's listeners in registration order whatever their
 * `capture`, only stopImmediatePropagation() stops it (a stop-propagation flag set
 * beforehand, by cancelBubble, does not), and neither stop flag is cleared when the
 * dispatch ends (`cancelBubble` still reads true afterwards).
 *
 * State lives in private fields, so an Event's only own property is Chrome's
 * [LegacyUnforgeable] `isTrusted` accessor and a target has none; the brand readers in
 * the static blocks are the one way the rest of this file reaches them, and they are
 * what answers "Illegal invocation" for a foreign receiver. AbortSignal derives from
 * the implementation class here and reaches the listener list through
 * attachHandler/fireEvent, never through the public methods a page can replace.
 *
 * A listener that throws is reported as the page's uncaught error (internal/deferred
 * reportException) and the dispatch goes on with the next one.
 *
 * Instantiated eagerly (the loader names it before internal/abort, which derives from
 * it), so every capture below is pristine.
 *
 * @module lava/internal/event_target
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var nativeShape = require('internal/native_shape');
  var DOMException = require('internal/domexception').DOMException;
  var reportException = require('internal/deferred').reportException;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ReflectApply = P.ReflectApply;
  var TypeErrorP = P.TypeError;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  // Captured at this eager eval, as is the origin timeStamp counts from.
  var DateNow = Date.now;
  var TIME_ORIGIN = DateNow();
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;

  var NONE = 0;
  var CAPTURING_PHASE = 1;
  var AT_TARGET = 2;
  var BUBBLING_PHASE = 3;
  var PHASES = { __proto__: null, NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 };
  var PHASE_NAMES = ['NONE', 'CAPTURING_PHASE', 'AT_TARGET', 'BUBBLING_PHASE'];
  var SIGNAL_TEXT =
    "Failed to read the 'signal' property from 'AddEventListenerOptions': Failed to convert value to 'AbortSignal'.";

  // Hands pre-converted state from a subclass's constructor (CustomEvent's, an
  // internally fired event's) to Event's. Module-private: no page argument is it.
  var INTERNAL = { __proto__: null };

  // Brand readers, assigned in the static blocks below.
  var eventState;
  var isEvent;
  var listenersOf;
  var detailOf;

  // Host targets: the DOM's node wrappers (internal/dom, stage 4), which pkg/runtime/dom.odin
  // makes natively — JSObjectMake, then the interface prototype — so no constructor runs
  // and they carry no #listeners. internal/dom names them once per page through
  // setHostTargets: `hostBrand(o)` is true for a wrapper, `hostParent(o)` is the node an
  // event propagates to next (null past the document). Their listener lists live here,
  // keyed by the wrapper; a wrapper lives as long as its page (it is protected until the
  // page closes), so an entry never outlives what it describes.
  var hostBrand = null;
  var hostParent = null;
  var hostListeners = new P.WeakMap();

  // internal/abort derives from this module, so its brand check is bound on first use
  // (a require inside a function: the sanctioned late binding).
  var abort = null;
  function abortModule() {
    if (abort === null) abort = require('internal/abort');
    return abort;
  }

  /**
   * new Event(type, eventInitDict)
   * @param {*} type DOMString.
   * @param {{bubbles?: boolean, cancelable?: boolean, composed?: boolean}} [eventInitDict]
   * @throws {TypeError} `Failed to construct 'Event': 1 argument required, but only 0
   *   present.`; `… Cannot convert a Symbol value to a string`; `… The provided value
   *   is not of type 'EventInit'.` for a non-object dictionary.
   * @node n/a — Chrome 158, tests/web/cases/events-target.expected: the dictionary's
   *   members are read in lexicographic order, each once.
   * @deviates timeStamp counts milliseconds of Date.now() from this module's eval,
   *   which runs before any page code: performance.now() is installed after the
   *   module loader and is page-replaceable by the time an Event is made. A page
   *   subtracting it from performance.now() sees the few milliseconds between the two.
   */
  class Event {
    #s;

    constructor(type, eventInitDict) {
      var state;
      if (type === INTERNAL) {
        state = eventInitDict;
      } else {
        if (arguments.length < 1) throw typeError('Event', undefined, argumentsRequired(1, 0));
        state = newState(toDOMString(type, 'Event'));
        readEventInit(state, eventInitDict, 'Event', 'EventInit');
      }

      this.#s = state;
      ObjectDefineProperty(this, 'isTrusted', IS_TRUSTED_DESC);
    }

    get type() {
      return eventState(this).type;
    }

    get target() {
      return eventState(this).target;
    }

    get currentTarget() {
      return eventState(this).currentTarget;
    }

    get eventPhase() {
      return eventState(this).phase;
    }

    get bubbles() {
      return eventState(this).bubbles;
    }

    get cancelable() {
      return eventState(this).cancelable;
    }

    get defaultPrevented() {
      return eventState(this).canceled;
    }

    get composed() {
      return eventState(this).composed;
    }

    get timeStamp() {
      return eventState(this).timeStamp;
    }

    get srcElement() {
      return eventState(this).target;
    }

    get returnValue() {
      return !eventState(this).canceled;
    }

    set returnValue(value) {
      var state = eventState(this);
      if (!value) cancel(state);
    }

    get cancelBubble() {
      return eventState(this).stopPropagation;
    }

    set cancelBubble(value) {
      var state = eventState(this);
      if (value) state.stopPropagation = true;
    }

    composedPath() {
      var state = eventState(this);
      if (state.currentTarget === null) return [];
      // A node's dispatch: the whole propagation path, target first.
      if (state.path !== null) return ArrayPrototypeSlice(state.path, 0);
      return [state.currentTarget];
    }

    initEvent(type) {
      var state = eventState(this);
      if (arguments.length < 1) throw typeError('Event', 'initEvent', argumentsRequired(1, 0));
      type = toDOMString(type, 'Event', 'initEvent');
      var bubbles = !!arguments[1];
      var cancelable = !!arguments[2];
      if (!state.dispatching) initialize(state, type, bubbles, cancelable);
    }

    preventDefault() {
      cancel(eventState(this));
    }

    stopImmediatePropagation() {
      var state = eventState(this);
      state.stopPropagation = true;
      state.stopImmediatePropagation = true;
    }

    stopPropagation() {
      eventState(this).stopPropagation = true;
    }

    static {
      eventState = function (o) {
        if (typeof o !== 'object' || o === null || !(#s in o)) throw illegalInvocation();
        return o.#s;
      };
      isEvent = function (o) {
        return typeof o === 'object' && o !== null && #s in o;
      };
    }
  }

  // Chrome's isTrusted: an own accessor on every Event, enumerable, not configurable,
  // one getter shared by all of them.
  var IS_TRUSTED_DESC = {
    __proto__: null,
    get: nativeShape.wrapGetter('isTrusted', function () {
      return eventState(this).trusted;
    }),
    set: undefined,
    enumerable: true,
    configurable: false,
  };

  function newState(type) {
    return {
      __proto__: null,
      type: type,
      bubbles: false,
      cancelable: false,
      composed: false,
      target: null,
      currentTarget: null,
      phase: NONE,
      canceled: false,
      stopPropagation: false,
      stopImmediatePropagation: false,
      dispatching: false,
      inPassiveListener: false,
      trusted: false,
      timeStamp: DateNow() - TIME_ORIGIN,
      detail: null,
      // The propagation path of a host target's dispatch, while it runs; null otherwise.
      path: null,
    };
  }

  // WebIDL's EventInit (or CustomEventInit, `custom`) conversion into `state`.
  function readEventInit(state, init, iface, dictName, custom) {
    if (init === undefined || init === null) return;
    if (typeof init !== 'object' && typeof init !== 'function') {
      throw typeError(iface, undefined, "The provided value is not of type '" + dictName + "'.");
    }

    state.bubbles = !!init.bubbles;
    state.cancelable = !!init.cancelable;
    state.composed = !!init.composed;
    if (custom) {
      var detail = init.detail;
      state.detail = detail === undefined ? null : detail;
    }
  }

  function initialize(state, type, bubbles, cancelable) {
    state.type = type;
    state.bubbles = bubbles;
    state.cancelable = cancelable;
    state.stopPropagation = false;
    state.stopImmediatePropagation = false;
    state.canceled = false;
    state.trusted = false;
    state.target = null;
  }

  function cancel(state) {
    if (state.cancelable && !state.inPassiveListener) state.canceled = true;
  }

  /**
   * new CustomEvent(type, eventInitDict)
   * @param {*} type DOMString.
   * @param {{bubbles?: boolean, cancelable?: boolean, composed?: boolean, detail?: *}} [eventInitDict]
   * @throws {TypeError} as Event's, with `CustomEvent` in the context and
   *   `CustomEventInit` as the dictionary.
   * @node n/a — Chrome 158, tests/web/cases/events-target.expected.
   * @deviates none
   */
  class CustomEvent extends Event {
    #detail;

    constructor(type, eventInitDict) {
      if (arguments.length < 1) throw typeError('CustomEvent', undefined, argumentsRequired(1, 0));
      var state = newState(toDOMString(type, 'CustomEvent'));
      readEventInit(state, eventInitDict, 'CustomEvent', 'CustomEventInit', true);
      super(INTERNAL, state);
      this.#detail = state.detail;
    }

    get detail() {
      return detailOf(this);
    }

    initCustomEvent(type) {
      var state = eventState(this);
      detailOf(this);
      if (arguments.length < 1) {
        throw typeError('CustomEvent', 'initCustomEvent', argumentsRequired(1, 0));
      }

      type = toDOMString(type, 'CustomEvent', 'initCustomEvent');
      var bubbles = !!arguments[1];
      var cancelable = !!arguments[2];
      var detail = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : null;
      if (state.dispatching) return;
      initialize(state, type, bubbles, cancelable);
      this.#detail = detail;
    }

    static {
      detailOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#detail in o)) throw illegalInvocation();
        return o.#detail;
      };
    }
  }

  // One registered listener: what the DOM Standard calls an event listener. `removed`
  // keeps a dispatch already holding a snapshot of the list from running it.
  function newEntry(callback, capture, once, passive) {
    return {
      __proto__: null,
      callback: callback,
      capture: capture,
      once: once,
      passive: passive,
      removed: false,
    };
  }

  function removeEntry(listeners, type, entry) {
    entry.removed = true;
    var list = listeners[type];
    if (list === undefined) return;
    var at = ArrayPrototypeIndexOf(list, entry);
    if (at !== -1) ArrayPrototypeSplice(list, at, 1);
  }

  // WebIDL's `EventListener?`: null and undefined are null; any object (a function or
  // a handleEvent holder) is kept; anything else is refused.
  function toListener(callback, op) {
    if (callback === undefined || callback === null) return null;
    if (typeof callback !== 'object' && typeof callback !== 'function') {
      throw typeError('EventTarget', op, notOfType(2, 'Object'));
    }

    return callback;
  }

  /**
   * new EventTarget()
   * @node n/a — Chrome 158, tests/web/cases/events-target.expected and shape-events.
   * @deviates EventTarget.prototype.when (Chrome's Observable API) is absent: there
   *   is no Observable. A known gap, shape-events.
   */
  class EventTarget {
    // type -> listener entries, in registration order.
    #listeners = { __proto__: null };

    /**
     * @param {*} type DOMString.
     * @param {Function|Object|null} callback
     * @param {boolean|{capture?: boolean, once?: boolean, passive?: boolean, signal?: AbortSignal}} [options]
     * @throws {TypeError} `Illegal invocation` for a foreign receiver; `2 arguments
     *   required…`; `parameter 2 is not of type 'Object'.`; the `signal` member's
     *   conversion failure.
     * @node n/a — Chrome 158: the options are read capture, once, passive, signal; a
     *   duplicate (same type, callback and capture) and an already-aborted signal add
     *   nothing.
     */
    addEventListener(type, callback, options) {
      var listeners = listenersOf(this);
      if (arguments.length < 2) {
        throw typeError('EventTarget', 'addEventListener', argumentsRequired(2, arguments.length));
      }

      type = toDOMString(type, 'EventTarget', 'addEventListener');
      callback = toListener(callback, 'addEventListener');
      var capture = false;
      var once = false;
      var passive = false;
      var signal = null;
      if (typeof options === 'object' || typeof options === 'function') {
        if (options !== null) {
          capture = !!options.capture;
          once = !!options.once;
          passive = !!options.passive;
          var value = options.signal;
          if (value !== undefined) {
            if (!abortModule().isSignal(value)) {
              throw typeError('EventTarget', 'addEventListener', SIGNAL_TEXT);
            }

            signal = value;
          }
        }
      } else if (options !== undefined) {
        capture = !!options;
      }

      if (signal !== null && abortModule().signalAborted(signal)) return;
      if (callback === null) return;
      var list = listeners[type];
      if (list === undefined) {
        list = [];
        listeners[type] = list;
      }

      for (var i = 0; i < list.length; i++) {
        if (list[i].callback === callback && list[i].capture === capture) return;
      }

      var entry = newEntry(callback, capture, once, passive);
      ArrayPrototypePush1(list, entry);
      if (signal !== null) {
        abortModule().addAbortAlgorithm(signal, function () {
          removeEntry(listeners, type, entry);
        });
      }
    }

    /**
     * @param {*} type DOMString.
     * @param {Function|Object|null} callback
     * @param {boolean|{capture?: boolean}} [options] Only `capture` is read.
     * @throws {TypeError} as addEventListener's.
     * @node n/a — Chrome 158, tests/web/cases/events-target.expected.
     */
    removeEventListener(type, callback, options) {
      var listeners = listenersOf(this);
      if (arguments.length < 2) {
        throw typeError(
          'EventTarget',
          'removeEventListener',
          argumentsRequired(2, arguments.length),
        );
      }

      type = toDOMString(type, 'EventTarget', 'removeEventListener');
      callback = toListener(callback, 'removeEventListener');
      var capture = false;
      if (typeof options === 'object' || typeof options === 'function') {
        if (options !== null) capture = !!options.capture;
      } else if (options !== undefined) {
        capture = !!options;
      }

      var list = listeners[type];
      if (callback === null || list === undefined) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].callback === callback && list[i].capture === capture) {
          removeEntry(listeners, type, list[i]);
          return;
        }
      }
    }

    /**
     * @param {Event} event
     * @returns {boolean} false when a listener canceled a cancelable event.
     * @throws {TypeError} `parameter 1 is not of type 'Event'.`
     * @throws {DOMException} InvalidStateError `The event is already being
     *   dispatched.`, on this target or any other.
     * @node n/a — Chrome 158, tests/web/cases/events-target.expected. The event's
     *   isTrusted becomes false, as for any event a page dispatches.
     */
    dispatchEvent(event) {
      listenersOf(this);
      if (arguments.length < 1) {
        throw typeError('EventTarget', 'dispatchEvent', argumentsRequired(1, 0));
      }

      if (!isEvent(event)) throw typeError('EventTarget', 'dispatchEvent', notOfType(1, 'Event'));
      var state = eventState(event);
      if (state.dispatching) {
        throw pageError(
          new DOMException(
            context('EventTarget', 'dispatchEvent') + 'The event is already being dispatched.',
            'InvalidStateError',
          ),
        );
      }

      state.trusted = false;
      return dispatchAny(this, event, state);
    }

    static {
      listenersOf = function (o) {
        if (typeof o !== 'object' || o === null) throw illegalInvocation();
        if (#listeners in o) return o.#listeners;
        if (hostBrand === null || !hostBrand(o)) throw illegalInvocation();
        var listeners = WeakMapPrototypeGet(hostListeners, o);
        if (listeners === undefined) {
          listeners = { __proto__: null };
          WeakMapPrototypeSet(hostListeners, o, listeners);
        }

        return listeners;
      };
    }
  }

  // The dispatch of a target with no parent, as Blink runs it: AT_TARGET throughout,
  // the listeners registered when it starts (one added meanwhile waits for the next
  // dispatch; one removed meanwhile does not run), stopped by stopImmediatePropagation
  // alone.
  function dispatch(target, event, state) {
    state.dispatching = true;
    state.target = target;
    state.currentTarget = target;
    state.phase = AT_TARGET;
    var listeners = listenersOf(target);
    var list = listeners[state.type];
    if (list !== undefined && list.length > 0) {
      var snapshot = ArrayPrototypeSlice(list, 0);
      for (var i = 0; i < snapshot.length; i++) {
        if (state.stopImmediatePropagation) break;
        var entry = snapshot[i];
        if (entry.removed) continue;
        if (entry.once) removeEntry(listeners, state.type, entry);
        invoke(entry, target, event, state);
      }
    }

    state.phase = NONE;
    state.currentTarget = null;
    state.dispatching = false;
    return !state.canceled;
  }

  // A node propagates; every other target runs as above.
  function dispatchAny(target, event, state) {
    if (hostBrand !== null && hostBrand(target)) return dispatchPath(target, event, state);
    return dispatch(target, event, state);
  }

  // The DOM Standard's dispatch over a node's path (target, then each parent up to the
  // document): a capturing pass from the top down to the target, then a bubbling pass
  // back up, the latter only for an event that bubbles. At the target both passes run
  // with eventPhase AT_TARGET, capture listeners first — what Chrome does since 89.
  // The stop-propagation flag ends the dispatch between two targets;
  // stopImmediatePropagation also ends the target's own list (invokePhase).
  //
  // Deviates: the path ends at the document. Chrome's goes on to the window, which is not
  // an EventTarget in Larva yet (stage 4b); a listener on `window` sees nothing of a
  // node's event.
  function dispatchPath(target, event, state) {
    state.dispatching = true;
    state.target = target;
    var path = [target];
    for (var p = hostParent(target); p !== null; p = hostParent(p)) ArrayPrototypePush1(path, p);
    state.path = path;
    for (var i = path.length - 1; i >= 0; i--) {
      if (state.stopPropagation) break;
      state.phase = i === 0 ? AT_TARGET : CAPTURING_PHASE;
      invokePhase(path[i], event, state, true);
    }

    for (var j = 0; j < path.length; j++) {
      if (state.stopPropagation) break;
      if (j > 0 && !state.bubbles) break;
      state.phase = j === 0 ? AT_TARGET : BUBBLING_PHASE;
      invokePhase(path[j], event, state, false);
    }

    state.phase = NONE;
    state.currentTarget = null;
    state.path = null;
    state.dispatching = false;
    return !state.canceled;
  }

  // One target's listeners for one pass: those registered with `capture` equal to
  // `capture`, from a snapshot of the list taken now.
  function invokePhase(target, event, state, capture) {
    state.currentTarget = target;
    var listeners = listenersOf(target);
    var list = listeners[state.type];
    if (list === undefined || list.length === 0) return;
    var snapshot = ArrayPrototypeSlice(list, 0);
    for (var i = 0; i < snapshot.length; i++) {
      if (state.stopImmediatePropagation) break;
      var entry = snapshot[i];
      if (entry.removed || entry.capture !== capture) continue;
      if (entry.once) removeEntry(listeners, state.type, entry);
      invoke(entry, target, event, state);
    }
  }

  function invoke(entry, target, event, state) {
    var callback = entry.callback;
    state.inPassiveListener = entry.passive;
    try {
      if (typeof callback === 'function') {
        ReflectApply(callback, target, [event]);
      } else {
        // Read at each dispatch, not when the listener was added.
        var handleEvent = callback.handleEvent;
        if (typeof handleEvent !== 'function') {
          throw pageError(
            new TypeErrorP(
              "The provided callback is not a function or has no 'handleEvent' method.",
            ),
          );
        }

        ReflectApply(handleEvent, callback, [event]);
      }
    } catch (e) {
      reportException(e);
    }

    state.inPassiveListener = false;
  }

  /**
   * Fires a trusted event of `type` at `target` — the platform's own `abort`.
   * @param {EventTarget} target An instance of the implementation class, or a node.
   * @param {string} type
   * @param {boolean} [bubbles] The event's `bubbles` (DOMContentLoaded's is true).
   * @returns {boolean} false when a listener canceled it.
   */
  function fireEvent(target, type, bubbles) {
    var state = newState(type);
    state.trusted = true;
    state.bubbles = bubbles === true;
    var event = new Event(INTERNAL, state);
    return dispatchAny(target, event, state);
  }

  /**
   * Makes the DOM's node wrappers EventTargets (see hostBrand). Once per page: the
   * module instance is the page's, and internal/dom calls this from its install.
   * @param {function(*): boolean} brand True for a node wrapper; never throws.
   * @param {function(Object): ?Object} parent The next node of a dispatch's path.
   */
  function setHostTargets(brand, parent) {
    if (hostBrand !== null) throw new TypeErrorP('event_target: host targets are set once');
    hostBrand = brand;
    hostParent = parent;
  }

  /**
   * HTML's event handler IDL attribute (`onabort`): its listener goes into the list
   * when the handler is first set, and keeps that place while the handler changes.
   * @param {EventTarget} target
   * @param {string} type
   * @param {function(EventTarget): ?Function} read Reads the current handler.
   * @returns {Object} The entry, for detachHandler once the handler is set to null.
   */
  function attachHandler(target, type, read) {
    var entry = newEntry(
      function (event) {
        var handler = read(this);
        if (handler === null) return;
        if (ReflectApply(handler, this, [event]) === false) cancel(eventState(event));
      },
      false,
      false,
      false,
    );
    var listeners = listenersOf(target);
    var list = listeners[type];
    if (list === undefined) {
      list = [];
      listeners[type] = list;
    }

    ArrayPrototypePush1(list, entry);
    return entry;
  }

  function detachHandler(target, type, entry) {
    removeEntry(listenersOf(target), type, entry);
  }

  /**
   * Fires `event`, made by an Event subclass outside this module (internal/xhr's
   * ProgressEvent), at `target` as the platform's own: trusted, as fireEvent's.
   * @param {EventTarget} target
   * @param {Event} event Built with EVENT_INTERNAL and a newEventState record.
   * @returns {boolean} false when a listener canceled it.
   */
  function dispatchTrusted(target, event) {
    var state = eventState(event);
    state.trusted = true;
    return dispatchAny(target, event, state);
  }

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-events.expected).
  var PublicEventTarget = nativeShape.defineInterface({
    name: 'EventTarget',
    impl: EventTarget,
    length: 0,
    members: [
      'addEventListener:2',
      'dispatchEvent:1',
      'removeEventListener:2',
      'constructor',
      '@@toStringTag',
    ],
  });
  var PublicEvent = nativeShape.defineInterface({
    name: 'Event',
    impl: Event,
    length: 1,
    constants: PHASES,
    statics: PHASE_NAMES,
    members: P.ArrayPrototypeConcat(
      [
        'type',
        'target',
        'currentTarget',
        'eventPhase',
        'bubbles',
        'cancelable',
        'defaultPrevented',
        'composed',
        'timeStamp',
        'srcElement',
        'returnValue',
        'cancelBubble',
      ],
      PHASE_NAMES,
      [
        'composedPath:0',
        'initEvent:1',
        'preventDefault:0',
        'stopImmediatePropagation:0',
        'stopPropagation:0',
        'constructor',
        '@@toStringTag',
      ],
    ),
  });
  var PublicCustomEvent = nativeShape.defineInterface({
    name: 'CustomEvent',
    impl: CustomEvent,
    length: 1,
    parent: PublicEvent,
    members: ['detail', 'initCustomEvent:1', 'constructor', '@@toStringTag'],
  });

  module.exports = P.ObjectFreeze({
    __proto__: null,
    EventTarget: PublicEventTarget,
    Event: PublicEvent,
    CustomEvent: PublicCustomEvent,
    EventTargetImpl: EventTarget,
    fireEvent: fireEvent,
    setHostTargets: setHostTargets,
    attachHandler: attachHandler,
    detachHandler: detachHandler,
    // For an Event subclass defined in another module (internal/xhr's ProgressEvent):
    // the implementation class to extend, the token its constructor passes to Event's
    // with a state record, and the EventInit conversion.
    EventImpl: Event,
    EVENT_INTERNAL: INTERNAL,
    newEventState: newState,
    readEventInit: readEventInit,
    dispatchTrusted: dispatchTrusted,
  });
});
