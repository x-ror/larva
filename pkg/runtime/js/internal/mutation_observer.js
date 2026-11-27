/**
 * @fileoverview MutationObserver and MutationRecord (DOM Standard §4.3) for a page's
 * document: the registered-observer lists, the records, and the "queue a mutation
 * observer microtask" / "notify mutation observers" pair that delivers them.
 *
 * The DOM's mutation natives (pkg/runtime/dom.odin) know nothing of observers. `attach`
 * wraps the ones that change the tree — insertBefore, replaceChild, removeChild, remove,
 * setTextContent, setData, setInnerHTML, setAttribute, removeAttribute — and
 * internal/dom calls the wrappers in their place, so every mutation path a page has
 * goes through one of them. While no observer is registered anywhere (`live` is 0) a
 * wrapper is the native plus one comparison; only then does it read the state a record
 * needs (the siblings, the removed children, the old value) before calling the native.
 * Nodes the parser inserts never pass through a native: pkg/html records them while
 * an observer is registered (observeParser), and the page loader hands them to
 * `parsed` at each microtask checkpoint (dom.odin dom_parser_checkpoint).
 *
 * Required by internal/dom, so it loads with a page's DOM and never for `lava run`;
 * internal/dom is loaded before a page's first script, so the captures below are still
 * pristine.
 *
 * @module lava/internal/mutation_observer
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var nativeShape = require('internal/native_shape');
  var reportException = require('internal/deferred').reportException;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var PromiseResolve = P.PromiseResolve;
  var PromiseThen = P.Promise.prototype.then;
  var ReflectApply = P.ReflectApply;
  var SymbolIterator = P.Symbol.iterator;
  var WeakMapP = P.WeakMap;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var argumentsRequired = webErrors.argumentsRequired;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;

  var ELEMENT_NODE = 1;
  var DOCUMENT_FRAGMENT_NODE = 11;

  // Hands a record its state; no page argument is it.
  var INTERNAL = { __proto__: null };

  // The natives (internal/dom's, from pkg/runtime/dom.odin), bound by attach.
  var nIsNode = null;
  var nNodeType = null;
  var nNodeName = null;
  var nLocalName = null;
  var nParent = null;
  var nFirstChild = null;
  var nNextSibling = null;
  var nPreviousSibling = null;
  var nData = null;
  var nGetAttribute = null;
  var nObserveParser = null;
  // internal/dom's static NodeList maker, for addedNodes and removedNodes.
  var staticList = null;

  // node -> its registered observer list: { observer, options, source } entries, a
  // transient one (DOM §4.3's "transient registered observer") with its `source`.
  var registry = new WeakMapP();
  // Entries in every list, transient ones included: 0 is the fast path of every hook.
  var live = 0;
  // Observers the next notification visits — those with records, and those holding
  // transient registrations to drop — in the order they joined; notify sorts them.
  var pending = [];
  var pendingCount = 0;
  var notifyQueued = false;
  var created = 0;

  // The promise each notification is a reaction of. Its own `constructor` is
  // undefined, so `then` takes the intrinsic Promise as the species without reading
  // Promise.prototype.constructor or Promise[Symbol.species], both of which a page can
  // replace.
  var resolved = PromiseResolve(undefined);
  ObjectDefineProperty(resolved, 'constructor', { __proto__: null, value: undefined });

  function setLive(delta) {
    var before = live;
    live += delta;
    if ((before === 0) !== (live === 0)) nObserveParser(live !== 0);
  }

  // DOM's "queue a mutation observer microtask".
  function queueNotify() {
    if (notifyQueued) return;
    notifyQueued = true;
    ReflectApply(PromiseThen, resolved, [notify]);
  }

  function addPending(state) {
    if (state.pending) return;
    state.pending = true;
    pending[pendingCount++] = state;
  }

  // DOM's "notify mutation observers": every observer with work, in creation order
  // (an insertion sort: the list is short), its transient registrations dropped and
  // its callback called with what it had queued. Records a callback queues go to the
  // observers still to come in this round, or to the next notification.
  function notify() {
    notifyQueued = false;
    var list = pending;
    var n = pendingCount;
    pending = [];
    pendingCount = 0;
    for (var i = 1; i < n; i++) {
      var s = list[i];
      var j = i - 1;
      while (j >= 0 && list[j].id > s.id) {
        list[j + 1] = list[j];
        j--;
      }

      list[j + 1] = s;
    }

    for (var k = 0; k < n; k++) {
      var state = list[k];
      state.pending = false;
      var records = state.records;
      state.records = [];
      state.recordCount = 0;
      dropTransients(state);
      if (records.length === 0) continue;
      try {
        ReflectApply(state.callback, state.observer, [records, state.observer]);
      } catch (e) {
        reportException(e);
      }
    }
  }

  function dropTransients(state) {
    var nodes = state.transientNodes;
    if (nodes.length === 0) return;
    state.transientNodes = [];
    for (var i = 0; i < nodes.length; i++) {
      removeEntries(nodes[i], state.observer, true);
    }
  }

  // Removes `observer`'s entries from `node`'s list: only the transient ones, or all.
  function removeEntries(node, observer, transientOnly) {
    var regs = WeakMapPrototypeGet(registry, node);
    if (regs === undefined) return;
    var kept = [];
    var n = 0;
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      if (r.observer === observer && (!transientOnly || r.source !== null)) continue;
      kept[n++] = r;
    }

    if (n !== regs.length) {
      WeakMapPrototypeSet(registry, node, kept);
      setLive(n - regs.length);
    }
  }

  function entriesOf(node) {
    var regs = WeakMapPrototypeGet(registry, node);
    if (regs === undefined) {
      regs = [];
      WeakMapPrototypeSet(registry, node, regs);
    }

    return regs;
  }

  // DOM's "queue a mutation record": one record per interested observer, with the old
  // value only for an observer that asked for it.
  function queueRecord(type, target, name, oldValue, added, removed, prev, next) {
    var observers = null;
    var olds = null;
    var count = 0;
    for (var node = target; node !== null; node = nParent(node)) {
      var regs = WeakMapPrototypeGet(registry, node);
      if (regs === undefined) continue;
      for (var i = 0; i < regs.length; i++) {
        var o = regs[i].options;
        if (node !== target && !o.subtree) continue;
        var wantsOld = false;
        if (type === 'attributes') {
          if (!o.attributes) continue;
          if (o.attributeFilter !== null && !ArrayPrototypeIncludes(o.attributeFilter, name)) {
            continue;
          }

          wantsOld = o.attributeOldValue;
        } else if (type === 'characterData') {
          if (!o.characterData) continue;
          wantsOld = o.characterDataOldValue;
        } else if (!o.childList) {
          continue;
        }

        if (observers === null) {
          observers = [];
          olds = [];
        }

        var at = ArrayPrototypeIndexOf(observers, regs[i].observer);
        if (at === -1) {
          at = count++;
          observers[at] = regs[i].observer;
          olds[at] = null;
        }

        if (wantsOld) olds[at] = oldValue;
      }
    }

    if (count === 0) return;
    for (var k = 0; k < count; k++) {
      var state = stateOf(observers[k]);
      state.records[state.recordCount++] = new MutationRecord(
        INTERNAL,
        type,
        target,
        name,
        olds[k],
        added,
        removed,
        prev,
        next,
      );
      addPending(state);
    }

    queueNotify();
  }

  function queueTree(target, added, removed, prev, next) {
    queueRecord('childList', target, null, null, added, removed, prev, next);
  }

  // The "remove" steps' transient registrations: `node`, just removed from `parent`,
  // stays observed by every subtree registration on `parent` and its ancestors until
  // the next notification.
  function addTransients(parent, node) {
    for (var a = parent; a !== null; a = nParent(a)) {
      var regs = WeakMapPrototypeGet(registry, a);
      if (regs === undefined) continue;
      for (var i = 0; i < regs.length; i++) {
        var r = regs[i];
        if (!r.options.subtree) continue;
        var list = entriesOf(node);
        list[list.length] = {
          __proto__: null,
          observer: r.observer,
          options: r.options,
          source: r,
        };
        setLive(1);
        var state = stateOf(r.observer);
        state.transientNodes[state.transientNodes.length] = node;
        addPending(state);
      }
    }
  }

  function childrenOf(node) {
    var out = [];
    var n = 0;
    for (var c = nFirstChild(node); c !== null; c = nNextSibling(c)) out[n++] = c;
    return out;
  }

  function removedAll(parent, nodes) {
    for (var i = 0; i < nodes.length; i++) addTransients(parent, nodes[i]);
  }

  // The attribute name a record carries: what setAttribute stores, lowercased on an
  // HTML element. A foreign element (SVG, MathML — only the parser makes one) keeps a
  // tag name equal to its local name, which has letters; an HTML element's tag name is
  // its local name uppercased, so the two differ unless the name has no letters at all.
  function attributeName(element, name) {
    var local = nLocalName(element);
    if (nNodeName(element) === local && local !== toAsciiUpper(local)) return name;
    return toAsciiLower(name);
  }

  function toAsciiLower(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      out += c >= 'A' && c <= 'Z' ? LOWER[c] : c;
    }

    return out;
  }

  function toAsciiUpper(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      out += c >= 'a' && c <= 'z' ? UPPER[c] : c;
    }

    return out;
  }

  var LOWER = { __proto__: null };
  var UPPER = { __proto__: null };
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var letters = 'abcdefghijklmnopqrstuvwxyz';
  for (var li = 0; li < 26; li++) {
    LOWER[LETTERS[li]] = letters[li];
    UPPER[letters[li]] = LETTERS[li];
  }

  /**
   * Wraps internal/dom's mutation natives with the records they queue.
   * @param {Object} native pkg/runtime/dom.odin's bindings.
   * @param {function(Array): Object} makeStaticList internal/dom's static NodeList.
   * @returns {Object} The wrapped natives, under the names internal/dom binds, and
   *   `parsed`, the page loader's step for parser-inserted nodes.
   */
  function attach(native, makeStaticList) {
    nIsNode = native.isNode;
    nNodeType = native.nodeType;
    nNodeName = native.nodeName;
    nLocalName = native.localName;
    nParent = native.parent;
    nFirstChild = native.firstChild;
    nNextSibling = native.nextSibling;
    nPreviousSibling = native.previousSibling;
    nData = native.data;
    nGetAttribute = native.getAttribute;
    nObserveParser = native.observeParser;
    staticList = makeStaticList;
    var nInsertBefore = native.insertBefore;
    var nReplaceChild = native.replaceChild;
    var nRemoveChild = native.removeChild;
    var nRemove = native.remove;
    var nSetTextContent = native.setTextContent;
    var nSetData = native.setData;
    var nSetInnerHTML = native.setInnerHTML;
    var nSetAttribute = native.setAttribute;
    var nRemoveAttribute = native.removeAttribute;

    // A node leaving its parent to be inserted elsewhere: the removal record on the
    // old parent ("adopt" removes it first, observers not suppressed).
    function insertBefore(parent, node, child) {
      if (live === 0) return nInsertBefore(parent, node, child);
      var fragment = nNodeType(node) === DOCUMENT_FRAGMENT_NODE;
      var nodes = fragment ? childrenOf(node) : null;
      var from = fragment ? null : nParent(node);
      var fromPrev = from === null ? null : nPreviousSibling(node);
      var fromNext = from === null ? null : nNextSibling(node);
      var code = nInsertBefore(parent, node, child);
      if (code !== 0) return code;
      if (fragment) {
        if (nodes.length === 0) return 0;
        removedAll(node, nodes);
        queueTree(node, [], nodes, null, null);
      } else {
        nodes = [node];
        if (from !== null) {
          addTransients(from, node);
          queueTree(from, [], nodes, fromPrev, fromNext);
        }
      }

      var prev = nPreviousSibling(nodes[0]);
      queueTree(parent, nodes, [], prev, nNextSibling(nodes[nodes.length - 1]));
      return 0;
    }

    // DOM's "replace": child leaves with observers suppressed, node leaves its old
    // parent with them not, and one record carries both sides.
    function replaceChild(parent, node, child) {
      if (live === 0) return nReplaceChild(parent, node, child);
      var fragment = nNodeType(node) === DOCUMENT_FRAGMENT_NODE;
      var nodes = fragment ? childrenOf(node) : [node];
      var next = nNextSibling(child);
      if (next === node) next = nNextSibling(node);
      var prev = nPreviousSibling(child);
      if (prev === node) prev = nPreviousSibling(node);
      var from = fragment || node === child ? null : nParent(node);
      var fromPrev = null;
      var fromNext = null;
      if (from !== null) {
        // As the siblings are once child is gone.
        fromPrev = nPreviousSibling(node);
        if (fromPrev === child) fromPrev = nPreviousSibling(child);
        fromNext = nNextSibling(node);
        if (fromNext === child) fromNext = nNextSibling(child);
      }

      var code = nReplaceChild(parent, node, child);
      if (code !== 0) return code;
      addTransients(parent, child);
      if (fragment) {
        if (nodes.length !== 0) {
          removedAll(node, nodes);
          queueTree(node, [], nodes, null, null);
        }
      } else if (from !== null) {
        addTransients(from, node);
        queueTree(from, [], [node], fromPrev, fromNext);
      }

      queueTree(parent, nodes, [child], prev, next);
      return 0;
    }

    function removeChild(parent, child) {
      if (live === 0) return nRemoveChild(parent, child);
      var prev = nPreviousSibling(child);
      var next = nNextSibling(child);
      var code = nRemoveChild(parent, child);
      if (code !== 0) return code;
      addTransients(parent, child);
      queueTree(parent, [], [child], prev, next);
      return 0;
    }

    function remove(node) {
      if (live === 0) return nRemove(node);
      var parent = nParent(node);
      var prev = parent === null ? null : nPreviousSibling(node);
      var next = parent === null ? null : nNextSibling(node);
      var result = nRemove(node);
      if (parent === null) return result;
      addTransients(parent, node);
      queueTree(parent, [], [node], prev, next);
      return result;
    }

    // DOM's "replace all": one record with every child that left and the one that
    // came, none when nothing changed.
    function replaceAll(node, set, value) {
      var removed = childrenOf(node);
      var result = set(node, value);
      var added = childrenOf(node);
      if (removed.length === 0 && added.length === 0) return result;
      removedAll(node, removed);
      queueTree(node, added, removed, null, null);
      return result;
    }

    // DOM's "replace data": a characterData record, the old value whatever the new.
    function replaceData(node, value) {
      var old = nData(node);
      var result = nSetData(node, value);
      queueRecord('characterData', node, null, old, [], [], null, null);
      return result;
    }

    function setTextContent(node, value) {
      if (live === 0) return nSetTextContent(node, value);
      var type = nNodeType(node);
      if (type === ELEMENT_NODE || type === DOCUMENT_FRAGMENT_NODE) {
        return replaceAll(node, nSetTextContent, value);
      }

      if (type === 3 || type === 4 || type === 7 || type === 8) {
        var old = nData(node);
        var result = nSetTextContent(node, value);
        queueRecord('characterData', node, null, old, [], [], null, null);
        return result;
      }

      return nSetTextContent(node, value);
    }

    function setData(node, value) {
      if (live === 0) return nSetData(node, value);
      return replaceData(node, value);
    }

    function setInnerHTML(node, value) {
      if (live === 0) return nSetInnerHTML(node, value);
      return replaceAll(node, nSetInnerHTML, value);
    }

    function setAttribute(element, name, value) {
      if (live === 0) return nSetAttribute(element, name, value);
      var old = nGetAttribute(element, name);
      var result = nSetAttribute(element, name, value);
      queueRecord('attributes', element, attributeName(element, name), old, [], [], null, null);
      return result;
    }

    function removeAttribute(element, name) {
      if (live === 0) return nRemoveAttribute(element, name);
      var old = nGetAttribute(element, name);
      var result = nRemoveAttribute(element, name);
      if (old !== null) {
        queueRecord('attributes', element, attributeName(element, name), old, [], [], null, null);
      }

      return result;
    }

    return {
      __proto__: null,
      insertBefore: insertBefore,
      replaceChild: replaceChild,
      removeChild: removeChild,
      remove: remove,
      setTextContent: setTextContent,
      setData: setData,
      setInnerHTML: setInnerHTML,
      setAttribute: setAttribute,
      removeAttribute: removeAttribute,
      parsed: parsed,
    };
  }

  /**
   * The page loader's step for the nodes the parser inserted since the last
   * checkpoint (pkg/runtime/dom.odin dom_parser_checkpoint): a childList record each,
   * as the parser's append made it — the node after its previous sibling, at the end.
   * @param {Array} nodes In insertion order.
   */
  function parsed(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var parent = nParent(node);
      if (parent === null) continue;
      queueTree(parent, [node], [], nPreviousSibling(node), null);
    }
  }

  // Bound in MutationObserver's static block: the only code that reads its state.
  var stateOf;

  // MutationObserverInit, converted in WebIDL's order: the members by name, each
  // read once, then the observe() steps' defaults and checks.
  function readOptions(options) {
    var o = {
      __proto__: null,
      childList: false,
      attributes: false,
      characterData: false,
      subtree: false,
      attributeOldValue: false,
      characterDataOldValue: false,
      attributeFilter: null,
    };
    var attributes;
    var attributeOldValue;
    var characterData;
    var characterDataOldValue;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' && typeof options !== 'function') {
        throw typeError(
          'MutationObserver',
          'observe',
          "The provided value is not of type 'MutationObserverInit'.",
        );
      }

      var filter = options.attributeFilter;
      if (filter !== undefined) o.attributeFilter = stringSequence(filter);
      attributeOldValue = options.attributeOldValue;
      attributes = options.attributes;
      characterData = options.characterData;
      characterDataOldValue = options.characterDataOldValue;
      o.childList = !!options.childList;
      o.subtree = !!options.subtree;
    }

    if (attributes === undefined) {
      o.attributes = attributeOldValue !== undefined || o.attributeFilter !== null;
    } else {
      o.attributes = !!attributes;
    }

    if (characterData === undefined) {
      o.characterData = characterDataOldValue !== undefined;
    } else {
      o.characterData = !!characterData;
    }

    o.attributeOldValue = !!attributeOldValue;
    o.characterDataOldValue = !!characterDataOldValue;
    if (o.attributeOldValue && !o.attributes) {
      throw typeError(
        'MutationObserver',
        'observe',
        "The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.",
      );
    }

    if (o.attributeFilter !== null && !o.attributes) {
      throw typeError(
        'MutationObserver',
        'observe',
        "The options object may only set 'attributeFilter' when 'attributes' is true or not present.",
      );
    }

    if (o.characterDataOldValue && !o.characterData) {
      throw typeError(
        'MutationObserver',
        'observe',
        "The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.",
      );
    }

    // Blink checks the combinations before the emptiness (Chrome 158: `{attributes:
    // false, attributeOldValue: true}` reports attributeOldValue).
    if (!o.childList && !o.attributes && !o.characterData) {
      throw typeError(
        'MutationObserver',
        'observe',
        "The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.",
      );
    }

    return o;
  }

  // WebIDL's sequence<DOMString>, through the value's own iterator.
  function stringSequence(value) {
    var method =
      typeof value === 'object' || typeof value === 'function' ? value[SymbolIterator] : undefined;
    if (value === null || typeof method !== 'function') {
      throw typeError(
        'MutationObserver',
        'observe',
        "Failed to read the 'attributeFilter' property from 'MutationObserverInit': " +
          'The provided value cannot be converted to a sequence.',
      );
    }

    var iterator = ReflectApply(method, value, []);
    var next = iterator.next;
    var out = [];
    var n = 0;
    for (;;) {
      var step = ReflectApply(next, iterator, []);
      if (step.done) return out;
      out[n++] = toDOMString(step.value, 'MutationObserver', 'observe');
    }
  }

  /**
   * MutationObserver (DOM Standard §4.3.1).
   * @param {Function} callback Called with (records, observer), `this` the observer.
   * @throws {TypeError} `Failed to construct 'MutationObserver': parameter 1 is not of
   *   type 'Function'.` — callback is not callable.
   * @node Chrome 158, tests/dom/cases/dom-mutation-observer.page: the WebIDL errors,
   *   the dictionary members read in name order, records batched per observer and
   *   delivered in observer creation order in one microtask, transient registrations.
   * @deviates none
   */
  class MutationObserver {
    #state;

    constructor(callback) {
      if (arguments.length < 1) {
        throw typeError('MutationObserver', undefined, argumentsRequired(1, arguments.length));
      }

      if (typeof callback !== 'function') {
        throw typeError('MutationObserver', undefined, notOfType(1, 'Function'));
      }

      this.#state = {
        __proto__: null,
        observer: this,
        callback: callback,
        id: ++created,
        records: [],
        recordCount: 0,
        nodes: [],
        transientNodes: [],
        pending: false,
      };
    }

    static {
      stateOf = function (o) {
        if (o === null || (typeof o !== 'object' && typeof o !== 'function') || !(#state in o)) {
          throw illegalInvocation();
        }

        return o.#state;
      };
    }

    observe(target, options) {
      var state = stateOf(this);
      if (arguments.length < 1) {
        throw typeError('MutationObserver', 'observe', argumentsRequired(1, arguments.length));
      }

      if (!nIsNode(target)) throw typeError('MutationObserver', 'observe', notOfType(1, 'Node'));
      var o = readOptions(options);
      var regs = entriesOf(target);
      for (var i = 0; i < regs.length; i++) {
        var reg = regs[i];
        if (reg.observer !== this || reg.source !== null) continue;
        // Re-observing replaces the options, and ends the transient registrations
        // this one left on removed nodes.
        for (var j = 0; j < state.nodes.length; j++) dropSourced(state.nodes[j], reg);
        for (var k = 0; k < state.transientNodes.length; k++) {
          dropSourced(state.transientNodes[k], reg);
        }

        reg.options = o;
        return;
      }

      regs[regs.length] = { __proto__: null, observer: this, options: o, source: null };
      state.nodes[state.nodes.length] = target;
      setLive(1);
    }

    disconnect() {
      var state = stateOf(this);
      var nodes = state.nodes;
      var transients = state.transientNodes;
      state.nodes = [];
      state.transientNodes = [];
      for (var i = 0; i < nodes.length; i++) removeEntries(nodes[i], this, false);
      for (var j = 0; j < transients.length; j++) removeEntries(transients[j], this, false);
      state.records = [];
      state.recordCount = 0;
    }

    takeRecords() {
      var state = stateOf(this);
      var records = state.records;
      state.records = [];
      state.recordCount = 0;
      return records;
    }
  }

  function dropSourced(node, source) {
    var regs = WeakMapPrototypeGet(registry, node);
    if (regs === undefined) return;
    var kept = [];
    var n = 0;
    for (var i = 0; i < regs.length; i++) {
      if (regs[i].source !== source) kept[n++] = regs[i];
    }

    if (n !== regs.length) {
      WeakMapPrototypeSet(registry, node, kept);
      setLive(n - regs.length);
    }
  }

  /**
   * MutationRecord (DOM Standard §4.3.2): read-only, made only by the observers.
   * @node Chrome 158, tests/dom/cases/dom-mutation-observer.page: Illegal constructor;
   *   addedNodes/removedNodes are static NodeLists, the same object on every read.
   * @deviates none
   */
  class MutationRecord {
    #type;
    #target;
    #addedNodes;
    #removedNodes;
    #previousSibling;
    #nextSibling;
    #attributeName;
    #oldValue;

    constructor(token, type, target, name, oldValue, added, removed, prev, next) {
      if (token !== INTERNAL) throw illegalInvocation();
      this.#type = type;
      this.#target = target;
      this.#attributeName = name;
      this.#oldValue = oldValue;
      this.#addedNodes = staticList(added);
      this.#removedNodes = staticList(removed);
      this.#previousSibling = prev;
      this.#nextSibling = next;
    }

    static {
      recordOf = function (o) {
        if (o === null || (typeof o !== 'object' && typeof o !== 'function') || !(#type in o)) {
          throw illegalInvocation();
        }

        return o;
      };
    }

    get type() {
      return recordOf(this).#type;
    }

    get target() {
      return recordOf(this).#target;
    }

    get addedNodes() {
      return recordOf(this).#addedNodes;
    }

    get removedNodes() {
      return recordOf(this).#removedNodes;
    }

    get previousSibling() {
      return recordOf(this).#previousSibling;
    }

    get nextSibling() {
      return recordOf(this).#nextSibling;
    }

    get attributeName() {
      return recordOf(this).#attributeName;
    }

    get attributeNamespace() {
      recordOf(this);
      // Every attribute a page can set here is in no namespace (no setAttributeNS).
      return null;
    }

    get oldValue() {
      return recordOf(this).#oldValue;
    }
  }

  var recordOf;

  // The interface objects a page sees, in Blink's member order (Chrome 158,
  // tests/dom/cases/dom-mutation-observer.page).
  var PublicMutationObserver = nativeShape.defineInterface({
    __proto__: null,
    name: 'MutationObserver',
    impl: MutationObserver,
    length: 1,
    members: ['disconnect:0', 'observe:1', 'takeRecords:0', 'constructor', '@@toStringTag'],
  });
  var PublicMutationRecord = nativeShape.defineInterface({
    __proto__: null,
    name: 'MutationRecord',
    impl: MutationRecord,
    length: 0,
    illegal: true,
    members: [
      'type',
      'target',
      'addedNodes',
      'removedNodes',
      'previousSibling',
      'nextSibling',
      'attributeName',
      'attributeNamespace',
      'oldValue',
      'constructor',
      '@@toStringTag',
    ],
  });

  module.exports = ObjectFreeze({
    __proto__: null,
    MutationObserver: PublicMutationObserver,
    MutationRecord: PublicMutationRecord,
    attach: attach,
  });
});
