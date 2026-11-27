/**
 * @fileoverview The DOM a page's scripts see (docs/LARVA.md decision 4, roadmap stage
 * 4a): `document`, `window`, and the interfaces of the nodes in a page's tree — Node,
 * Element, HTMLElement and its per-tag subclasses, Document, CharacterData, Text,
 * Comment, DocumentType, DocumentFragment, NodeList, HTMLCollection — as interface
 * objects with Chrome's prototype chain (HTMLDivElement → HTMLElement → Element → Node
 * → EventTarget).
 *
 * The tree is lexbor's, in Odin (pkg/html); this file holds no node state at all. A
 * node's wrapper is made natively (pkg/runtime/dom.odin dom_wrap): one JSClass gives
 * it the private slot that points at the node, and its [[Prototype]] is set to the
 * prototype of the interface this file defines for it — the array `install` returns,
 * in the order Odin names them. The wrapper is recorded in the page's node → wrapper
 * map and protected until the page closes, so `a.firstChild === a.firstChild` holds and
 * expandos stay. Every member below calls a native that brand-checks its receiver
 * (class and a live private pointer) and throws `Illegal invocation` otherwise —
 * including for a wrapper whose page is gone, whose private pointer teardown set to nil.
 *
 * Hand-written, not generated from WebIDL: stage 4a is the smallest slice that runs a
 * page end to end, and a dozen interfaces with a few members each do not pay for a
 * generator yet. The members follow WebIDL's conversions (DOMString, `Node`
 * arguments, nullable) for what they take; each interface lists its members in the
 * order Blink lays them out only for what exists here.
 *
 * Loaded lazily, by the page loader through the module loader's `installDom`
 * (bootstrap/loader.js), before the page's first script: a `lava run` page never pays
 * for it, and an HTML page has it before any page code runs, so the captures below are
 * still pristine.
 *
 * @module lava/internal/dom
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var nativeShape = require('internal/native_shape');
  var events = require('internal/event_target');
  var DOMException = require('internal/domexception').DOMException;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var ReflectApply = P.ReflectApply;
  var SymbolIterator = P.Symbol.iterator;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var TypeErrorP = P.TypeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;

  // Hands a list's items to its constructor; no page argument is it.
  var INTERNAL = { __proto__: null };

  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
  var COMMENT_NODE = 8;
  var DOCUMENT_NODE = 9;
  var NODE_TYPES = {
    __proto__: null,
    ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    NOTATION_NODE: 12,
  };
  var NODE_TYPE_NAMES = [
    'ELEMENT_NODE',
    'ATTRIBUTE_NODE',
    'TEXT_NODE',
    'CDATA_SECTION_NODE',
    'ENTITY_REFERENCE_NODE',
    'ENTITY_NODE',
    'PROCESSING_INSTRUCTION_NODE',
    'COMMENT_NODE',
    'DOCUMENT_NODE',
    'DOCUMENT_TYPE_NODE',
    'DOCUMENT_FRAGMENT_NODE',
    'NOTATION_NODE',
  ];

  // The natives (pkg/runtime/dom.odin make_dom_bindings), bound once by install. Each
  // takes the receiver node first and throws `Illegal invocation` for anything else.
  var nIsNode = null;
  var nDocument = null;
  var nNodeType = null;
  var nNodeName = null;
  var nParent = null;
  var nFirstChild = null;
  var nLastChild = null;
  var nNextSibling = null;
  var nPreviousSibling = null;
  var nChildNodes = null;
  var nTextContent = null;
  var nSetTextContent = null;
  var nData = null;
  var nSetData = null;
  var nInsertBefore = null;
  var nRemoveChild = null;
  var nReplaceChild = null;
  var nRemove = null;
  var nContains = null;
  var nClone = null;
  var nLocalName = null;
  var nGetAttribute = null;
  var nSetAttribute = null;
  var nRemoveAttribute = null;
  var nHasAttribute = null;
  var nInnerHTML = null;
  var nSetInnerHTML = null;
  var nOuterHTML = null;
  var nQuery = null;
  var nByTagName = null;
  var nByClassName = null;
  var nById = null;
  var nCreateElement = null;
  var nCreateText = null;
  var nCreateComment = null;
  var nCreateFragment = null;

  // What a mutation native answered (pkg/html Mutation_Error) as the DOMException a
  // page sees. The messages are Chrome's for the common case of each name.
  function mutated(code, iface, op) {
    if (code === 0) return;
    var name;
    var detail;
    if (code === 1) {
      name = 'HierarchyRequestError';
      detail = 'The new child element contains the parent.';
    } else if (code === 2) {
      name = 'NotFoundError';
      detail =
        op === 'removeChild'
          ? 'The node to be removed is not a child of this node.'
          : op === 'replaceChild'
            ? 'The node to be replaced is not a child of this node.'
            : 'The node before which the new node is to be inserted is not a child of this node.';
    } else if (code === 3) {
      name = 'NotSupportedError';
      detail = 'This operation is not supported.';
    } else {
      throw pageError(new TypeErrorP(context(iface, op) + 'The operation failed.'));
    }

    throw pageError(new DOMException(context(iface, op) + detail, name));
  }

  function checkNode(value, iface, op, index) {
    if (!nIsNode(value)) throw typeError(iface, op, notOfType(index, 'Node'));
  }

  function needArgs(present, required, iface, op) {
    if (present < required) throw typeError(iface, op, argumentsRequired(required, present));
  }

  // [LegacyNullToEmptyString] DOMString, as textContent and innerHTML take.
  function nullableString(value, iface, op) {
    return value === null ? '' : toDOMString(value, iface, op);
  }

  // The element children of `node`, in order.
  function elementChildren(node) {
    var out = [];
    var n = 0;
    for (var c = nFirstChild(node); c !== null; c = nNextSibling(c)) {
      if (nNodeType(c) === ELEMENT_NODE) out[n++] = c;
    }

    return out;
  }

  function firstElement(node, forward) {
    for (var c = forward ? nFirstChild(node) : nLastChild(node); c !== null;) {
      if (nNodeType(c) === ELEMENT_NODE) return c;
      c = forward ? nNextSibling(c) : nPreviousSibling(c);
    }

    return null;
  }

  function siblingElement(node, forward) {
    for (var c = forward ? nNextSibling(node) : nPreviousSibling(node); c !== null;) {
      if (nNodeType(c) === ELEMENT_NODE) return c;
      c = forward ? nNextSibling(c) : nPreviousSibling(c);
    }

    return null;
  }

  function query(node, selectors, all, iface, op, argc) {
    needArgs(argc, 1, iface, op);
    var css = toDOMString(selectors, iface, op);
    var found = nQuery(node, css, all);
    if (found === false) {
      throw pageError(
        new DOMException(
          context(iface, op) + "'" + css + "' is not a valid selector.",
          'SyntaxError',
        ),
      );
    }

    return all ? new NodeList(INTERNAL, found) : found;
  }

  // HTML's "strip and collapse ASCII whitespace", for document.title.
  function stripAndCollapse(s) {
    var out = '';
    var pending = false;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
        pending = out !== '';
        continue;
      }

      if (pending) out += ' ';
      pending = false;
      out += StringPrototypeSlice(s, i, i + 1);
    }

    return out;
  }

  /**
   * Node (DOM Standard §4.4). Illegal to construct, as in Chrome.
   * @node n/a — Chrome 158, tests/dom/cases/*.page.html.
   * @deviates childNodes is a static NodeList, a new one per read, where Chrome's is
   *   live and the same object each time; a page that holds one across a mutation sees
   *   the old children.
   */
  class Node extends events.EventTargetImpl {
    get nodeType() {
      return nNodeType(this);
    }

    get nodeName() {
      return nNodeName(this);
    }

    get isConnected() {
      var n = this;
      for (var p = nParent(n); p !== null; p = nParent(p)) n = p;
      return nNodeType(n) === DOCUMENT_NODE;
    }

    get ownerDocument() {
      return nNodeType(this) === DOCUMENT_NODE ? null : nDocument();
    }

    get parentNode() {
      return nParent(this);
    }

    get parentElement() {
      var p = nParent(this);
      return p !== null && nNodeType(p) === ELEMENT_NODE ? p : null;
    }

    get childNodes() {
      return new NodeList(INTERNAL, nChildNodes(this));
    }

    get firstChild() {
      return nFirstChild(this);
    }

    get lastChild() {
      return nLastChild(this);
    }

    get previousSibling() {
      return nPreviousSibling(this);
    }

    get nextSibling() {
      return nNextSibling(this);
    }

    get nodeValue() {
      var t = nNodeType(this);
      return t === TEXT_NODE || t === COMMENT_NODE || t === 4 || t === 7 ? nData(this) : null;
    }

    set nodeValue(value) {
      var t = nNodeType(this);
      if (t === TEXT_NODE || t === COMMENT_NODE || t === 4 || t === 7) {
        nSetData(this, nullableString(value, 'Node', 'nodeValue'));
      }
    }

    get textContent() {
      return nTextContent(this);
    }

    set textContent(value) {
      nSetTextContent(this, nullableString(value, 'Node', 'textContent'));
    }

    hasChildNodes() {
      return nFirstChild(this) !== null;
    }

    contains(other) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Node', 'contains');
      if (other === null) return false;
      checkNode(other, 'Node', 'contains', 1);
      return nContains(this, other);
    }

    cloneNode(deep) {
      if (nNodeType(this) === DOCUMENT_NODE) {
        throw pageError(
          new DOMException(
            context('Node', 'cloneNode') + 'Cloning a document is not supported yet.',
            'NotSupportedError',
          ),
        );
      }

      return nClone(this, !!deep);
    }

    appendChild(node) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Node', 'appendChild');
      checkNode(node, 'Node', 'appendChild', 1);
      mutated(nInsertBefore(this, node, null), 'Node', 'appendChild');
      return node;
    }

    insertBefore(node, child) {
      nNodeType(this);
      needArgs(arguments.length, 2, 'Node', 'insertBefore');
      checkNode(node, 'Node', 'insertBefore', 1);
      if (child !== null) checkNode(child, 'Node', 'insertBefore', 2);
      mutated(nInsertBefore(this, node, child), 'Node', 'insertBefore');
      return node;
    }

    replaceChild(node, child) {
      nNodeType(this);
      needArgs(arguments.length, 2, 'Node', 'replaceChild');
      checkNode(node, 'Node', 'replaceChild', 1);
      checkNode(child, 'Node', 'replaceChild', 2);
      mutated(nReplaceChild(this, node, child), 'Node', 'replaceChild');
      return child;
    }

    removeChild(child) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Node', 'removeChild');
      checkNode(child, 'Node', 'removeChild', 1);
      mutated(nRemoveChild(this, child), 'Node', 'removeChild');
      return child;
    }
  }

  /**
   * Element (DOM Standard §4.9), with the ParentNode and ChildNode members Blink puts
   * on its prototype.
   * @node n/a — Chrome 158, tests/dom/cases/*.page.html.
   * @deviates children and getElementsBy* are static HTMLCollections (Chrome's are
   *   live); attributes, namespaceURI, closest and matches are absent (stage 4b).
   */
  class Element extends Node {
    get localName() {
      return nLocalName(this);
    }

    get tagName() {
      return nNodeName(this);
    }

    get id() {
      var v = nGetAttribute(this, 'id');
      return v === null ? '' : v;
    }

    set id(value) {
      nSetAttribute(this, 'id', toDOMString(value, 'Element', 'id'));
    }

    get className() {
      var v = nGetAttribute(this, 'class');
      return v === null ? '' : v;
    }

    set className(value) {
      nSetAttribute(this, 'class', toDOMString(value, 'Element', 'className'));
    }

    getAttribute(name) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'getAttribute');
      return nGetAttribute(this, toDOMString(name, 'Element', 'getAttribute'));
    }

    setAttribute(name, value) {
      nNodeType(this);
      needArgs(arguments.length, 2, 'Element', 'setAttribute');
      name = toDOMString(name, 'Element', 'setAttribute');
      value = toDOMString(value, 'Element', 'setAttribute');
      if (!validName(name)) {
        throw pageError(
          new DOMException(
            context('Element', 'setAttribute') + "'" + name + "' is not a valid attribute name.",
            'InvalidCharacterError',
          ),
        );
      }

      nSetAttribute(this, name, value);
    }

    removeAttribute(name) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'removeAttribute');
      nRemoveAttribute(this, toDOMString(name, 'Element', 'removeAttribute'));
    }

    hasAttribute(name) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'hasAttribute');
      return nHasAttribute(this, toDOMString(name, 'Element', 'hasAttribute'));
    }

    getElementsByTagName(qualifiedName) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'getElementsByTagName');
      var name = toDOMString(qualifiedName, 'Element', 'getElementsByTagName');
      return new HTMLCollection(INTERNAL, nByTagName(this, name));
    }

    getElementsByClassName(classNames) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'getElementsByClassName');
      var names = toDOMString(classNames, 'Element', 'getElementsByClassName');
      return new HTMLCollection(INTERNAL, nByClassName(this, names));
    }

    get innerHTML() {
      return nInnerHTML(this);
    }

    set innerHTML(value) {
      nSetInnerHTML(this, nullableString(value, 'Element', 'innerHTML'));
    }

    get outerHTML() {
      return nOuterHTML(this);
    }

    get children() {
      return new HTMLCollection(INTERNAL, elementChildren(this));
    }

    get firstElementChild() {
      return firstElement(this, true);
    }

    get lastElementChild() {
      return firstElement(this, false);
    }

    get childElementCount() {
      return elementChildren(this).length;
    }

    get previousElementSibling() {
      return siblingElement(this, false);
    }

    get nextElementSibling() {
      return siblingElement(this, true);
    }

    querySelector(selectors) {
      nNodeType(this);
      return query(this, selectors, false, 'Element', 'querySelector', arguments.length);
    }

    querySelectorAll(selectors) {
      nNodeType(this);
      return query(this, selectors, true, 'Element', 'querySelectorAll', arguments.length);
    }

    remove() {
      nRemove(this);
    }
  }

  // An attribute or element name createElement/setAttribute accept: non-empty, with no
  // ASCII whitespace, NUL, `/`, `>` or `<` — the DOM Standard's relaxed "valid
  // attribute local name", which Chrome 158 applies.
  function validName(name) {
    if (name === '') return false;
    for (var i = 0; i < name.length; i++) {
      var c = StringPrototypeCharCodeAt(name, i);
      if (
        c === 0 ||
        c === 0x20 ||
        c === 0x09 ||
        c === 0x0a ||
        c === 0x0c ||
        c === 0x0d ||
        c === 0x2f ||
        c === 0x3e ||
        c === 0x3c
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * HTMLElement and every per-tag subclass Larva names (ELEMENT_INTERFACES).
   * @node n/a — Chrome 158: the interface a tag maps to is the HTML standard's.
   * @deviates The subclasses carry no members of their own yet (no reflected
   *   attributes such as HTMLAnchorElement.href); stage 4b.
   */
  class HTMLElement extends Element {}

  /**
   * CharacterData, Text, Comment.
   * @node n/a — Chrome 158, tests/dom/cases/*.page.html.
   * @deviates Text and Comment are not constructible (`new Text()`); stage 4b.
   */
  class CharacterData extends Node {
    get data() {
      return nData(this);
    }

    set data(value) {
      nSetData(this, nullableString(value, 'CharacterData', 'data'));
    }

    get length() {
      return nData(this).length;
    }

    remove() {
      nRemove(this);
    }
  }

  class Text extends CharacterData {}

  class Comment extends CharacterData {}

  class ProcessingInstruction extends CharacterData {
    get target() {
      return nNodeName(this);
    }
  }

  class DocumentType extends Node {
    get name() {
      return nNodeName(this);
    }

    remove() {
      nRemove(this);
    }
  }

  class DocumentFragment extends Node {
    get children() {
      return new HTMLCollection(INTERNAL, elementChildren(this));
    }

    get firstElementChild() {
      return firstElement(this, true);
    }

    get lastElementChild() {
      return firstElement(this, false);
    }

    get childElementCount() {
      return elementChildren(this).length;
    }

    getElementById(elementId) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'DocumentFragment', 'getElementById');
      return nById(this, toDOMString(elementId, 'DocumentFragment', 'getElementById'));
    }

    querySelector(selectors) {
      nNodeType(this);
      return query(this, selectors, false, 'DocumentFragment', 'querySelector', arguments.length);
    }

    querySelectorAll(selectors) {
      nNodeType(this);
      return query(this, selectors, true, 'DocumentFragment', 'querySelectorAll', arguments.length);
    }
  }

  /**
   * Document (DOM Standard §4.5) with HTML's document members.
   * @node n/a — Chrome 158, tests/dom/cases/*.page.html.
   * @deviates No readyState, URL, cookie, write or createElementNS yet (stage 4b).
   */
  class Document extends Node {
    get documentElement() {
      return firstElement(this, true);
    }

    get head() {
      return htmlChild(this, 'head', null);
    }

    get body() {
      return htmlChild(this, 'body', 'frameset');
    }

    get title() {
      nNodeType(this);
      var el = nQuery(this, 'title', false);
      return el === null ? '' : stripAndCollapse(nTextContent(el));
    }

    set title(value) {
      value = toDOMString(value, 'Document', 'title');
      var el = nQuery(this, 'title', false);
      if (el === null) {
        var head = htmlChild(this, 'head', null);
        if (head === null) return;
        el = nCreateElement(this, 'title');
        nInsertBefore(head, el, null);
      }

      nSetTextContent(el, value);
    }

    get children() {
      return new HTMLCollection(INTERNAL, elementChildren(this));
    }

    get firstElementChild() {
      return firstElement(this, true);
    }

    get lastElementChild() {
      return firstElement(this, false);
    }

    get childElementCount() {
      return elementChildren(this).length;
    }

    createElement(localName) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'createElement');
      var name = toDOMString(localName, 'Document', 'createElement');
      if (!validName(name)) {
        throw pageError(
          new DOMException(
            context('Document', 'createElement') +
              "The tag name provided ('" +
              name +
              "') is not a valid name.",
            'InvalidCharacterError',
          ),
        );
      }

      return nCreateElement(this, name);
    }

    createTextNode(data) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'createTextNode');
      return nCreateText(this, toDOMString(data, 'Document', 'createTextNode'));
    }

    createComment(data) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'createComment');
      return nCreateComment(this, toDOMString(data, 'Document', 'createComment'));
    }

    createDocumentFragment() {
      return nCreateFragment(this);
    }

    getElementById(elementId) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'getElementById');
      return nById(this, toDOMString(elementId, 'Document', 'getElementById'));
    }

    getElementsByTagName(qualifiedName) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'getElementsByTagName');
      var name = toDOMString(qualifiedName, 'Document', 'getElementsByTagName');
      return new HTMLCollection(INTERNAL, nByTagName(this, name));
    }

    getElementsByClassName(classNames) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'getElementsByClassName');
      var names = toDOMString(classNames, 'Document', 'getElementsByClassName');
      return new HTMLCollection(INTERNAL, nByClassName(this, names));
    }

    querySelector(selectors) {
      nNodeType(this);
      return query(this, selectors, false, 'Document', 'querySelector', arguments.length);
    }

    querySelectorAll(selectors) {
      nNodeType(this);
      return query(this, selectors, true, 'Document', 'querySelectorAll', arguments.length);
    }
  }

  class HTMLDocument extends Document {}

  // The first child of the document element that is a `name` (or `alt`) element: the
  // head and body getters. null when the document element is missing.
  function htmlChild(doc, name, alt) {
    var root = firstElement(doc, true);
    if (root === null) return null;
    for (var c = nFirstChild(root); c !== null; c = nNextSibling(c)) {
      if (nNodeType(c) !== ELEMENT_NODE) continue;
      var local = nLocalName(c);
      if (local === name || local === alt) return c;
    }

    return null;
  }

  // The indexed own properties of a static list: what Blink reports for an index of a
  // NodeList or HTMLCollection, enumerable and configurable but not writable.
  var INDEX_DESC = {
    __proto__: null,
    value: null,
    writable: false,
    enumerable: true,
    configurable: true,
  };
  function stampItems(list, items) {
    for (var i = 0; i < items.length; i++) {
      INDEX_DESC.value = items[i];
      ObjectDefineProperty(list, i, INDEX_DESC);
    }

    INDEX_DESC.value = null;
  }

  /**
   * NodeList: a static list in Larva (see Node's @deviates).
   * @node n/a — Chrome 158, tests/dom/cases/*.page.html.
   */
  class NodeList {
    #items;

    constructor(token, items) {
      if (token !== INTERNAL) throw illegalInvocation();
      this.#items = items;
      stampItems(this, items);
    }

    get length() {
      return itemsOf(this).length;
    }

    item(index) {
      var items = itemsOf(this);
      needArgs(arguments.length, 1, 'NodeList', 'item');
      var v = items[index >>> 0];
      return v === undefined ? null : v;
    }

    forEach(callback) {
      var items = itemsOf(this);
      needArgs(arguments.length, 1, 'NodeList', 'forEach');
      if (typeof callback !== 'function') {
        throw typeError(
          'NodeList',
          'forEach',
          'The callback provided as parameter 1 is not a function.',
        );
      }

      var thisArg = arguments[1];
      for (var i = 0; i < items.length; i++) ReflectApply(callback, thisArg, [items[i], i, this]);
    }

    *entries() {
      var items = itemsOf(this);
      for (var i = 0; i < items.length; i++) yield [i, items[i]];
    }

    *keys() {
      var items = itemsOf(this);
      for (var i = 0; i < items.length; i++) yield i;
    }

    *values() {
      var items = itemsOf(this);
      for (var i = 0; i < items.length; i++) yield items[i];
    }

    static {
      itemsOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#items in o)) throw illegalInvocation();
        return o.#items;
      };
    }
  }

  var itemsOf;

  /**
   * HTMLCollection: a static list of elements in Larva (see Element's @deviates).
   * @node n/a — Chrome 158, tests/dom/cases/*.page.html.
   */
  class HTMLCollection {
    #items;

    constructor(token, items) {
      if (token !== INTERNAL) throw illegalInvocation();
      this.#items = items;
      stampItems(this, items);
    }

    get length() {
      return collectionOf(this).length;
    }

    item(index) {
      var items = collectionOf(this);
      needArgs(arguments.length, 1, 'HTMLCollection', 'item');
      var v = items[index >>> 0];
      return v === undefined ? null : v;
    }

    namedItem(name) {
      var items = collectionOf(this);
      needArgs(arguments.length, 1, 'HTMLCollection', 'namedItem');
      name = toDOMString(name, 'HTMLCollection', 'namedItem');
      if (name === '') return null;
      for (var i = 0; i < items.length; i++) {
        if (nGetAttribute(items[i], 'id') === name || nGetAttribute(items[i], 'name') === name) {
          return items[i];
        }
      }

      return null;
    }

    *[SymbolIterator]() {
      var items = collectionOf(this);
      for (var i = 0; i < items.length; i++) yield items[i];
    }

    static {
      collectionOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#items in o)) throw illegalInvocation();
        return o.#items;
      };
    }
  }

  var collectionOf;

  // The per-tag subclasses of HTMLElement Larva maps elements to
  // (pkg/runtime/dom.odin element_interface names the same set); every other HTML
  // element is an HTMLElement or an HTMLUnknownElement.
  var ELEMENT_INTERFACES = [
    'HTMLUnknownElement',
    'HTMLHtmlElement',
    'HTMLHeadElement',
    'HTMLBodyElement',
    'HTMLTitleElement',
    'HTMLMetaElement',
    'HTMLLinkElement',
    'HTMLStyleElement',
    'HTMLScriptElement',
    'HTMLDivElement',
    'HTMLSpanElement',
    'HTMLParagraphElement',
    'HTMLHeadingElement',
    'HTMLAnchorElement',
    'HTMLUListElement',
    'HTMLOListElement',
    'HTMLLIElement',
    'HTMLDListElement',
    'HTMLPreElement',
    'HTMLQuoteElement',
    'HTMLBRElement',
    'HTMLHRElement',
    'HTMLImageElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLLabelElement',
    'HTMLSelectElement',
    'HTMLOptionElement',
    'HTMLTextAreaElement',
    'HTMLTableElement',
    'HTMLTableSectionElement',
    'HTMLTableRowElement',
    'HTMLTableCellElement',
    'HTMLTemplateElement',
    'HTMLIFrameElement',
  ];

  // Interface name -> implementation class: what install hands Odin the prototypes of.
  var IMPLS = { __proto__: null };
  var SHAPE_END = ['constructor', '@@toStringTag'];

  function define(name, impl, parent, members, constants, statics) {
    var spec = {
      __proto__: null,
      name: name,
      impl: impl,
      length: 0,
      illegal: true,
      members: P.ArrayPrototypeConcat(members, SHAPE_END),
    };
    if (parent !== null) spec.parent = parent;
    if (constants !== undefined) spec.constants = constants;
    if (statics !== undefined) spec.statics = statics;
    IMPLS[name] = impl;
    return nativeShape.defineInterface(spec);
  }

  var PublicNode = define(
    'Node',
    Node,
    events.EventTarget,
    P.ArrayPrototypeConcat(NODE_TYPE_NAMES, [
      'nodeType',
      'nodeName',
      'isConnected',
      'ownerDocument',
      'parentNode',
      'parentElement',
      'childNodes',
      'firstChild',
      'lastChild',
      'previousSibling',
      'nextSibling',
      'nodeValue',
      'textContent',
      'hasChildNodes:0',
      'contains:1',
      'cloneNode:0',
      'insertBefore:2',
      'appendChild:1',
      'replaceChild:2',
      'removeChild:1',
    ]),
    NODE_TYPES,
    NODE_TYPE_NAMES,
  );
  var PublicElement = define('Element', Element, PublicNode, [
    'localName',
    'tagName',
    'id',
    'className',
    'innerHTML',
    'outerHTML',
    'children',
    'firstElementChild',
    'lastElementChild',
    'childElementCount',
    'previousElementSibling',
    'nextElementSibling',
    'getAttribute:1',
    'getElementsByClassName:1',
    'getElementsByTagName:1',
    'hasAttribute:1',
    'removeAttribute:1',
    'setAttribute:2',
    'querySelector:1',
    'querySelectorAll:1',
    'remove:0',
  ]);
  var PublicHTMLElement = define('HTMLElement', HTMLElement, PublicElement, []);
  var PublicCharacterData = define('CharacterData', CharacterData, PublicNode, [
    'data',
    'length',
    'remove:0',
  ]);
  define('Text', Text, PublicCharacterData, []);
  define('Comment', Comment, PublicCharacterData, []);
  define('ProcessingInstruction', ProcessingInstruction, PublicCharacterData, ['target']);
  define('DocumentType', DocumentType, PublicNode, ['name', 'remove:0']);
  define('DocumentFragment', DocumentFragment, PublicNode, [
    'children',
    'firstElementChild',
    'lastElementChild',
    'childElementCount',
    'getElementById:1',
    'querySelector:1',
    'querySelectorAll:1',
  ]);
  var PublicDocument = define('Document', Document, PublicNode, [
    'documentElement',
    'title',
    'body',
    'head',
    'children',
    'firstElementChild',
    'lastElementChild',
    'childElementCount',
    'getElementsByTagName:1',
    'getElementsByClassName:1',
    'createDocumentFragment:0',
    'createTextNode:1',
    'createComment:1',
    'createElement:1',
    'getElementById:1',
    'querySelector:1',
    'querySelectorAll:1',
  ]);
  define('HTMLDocument', HTMLDocument, PublicDocument, []);
  define('NodeList', NodeList, null, [
    'entries:0',
    'keys:0',
    'values:0',
    'forEach:1',
    'length',
    'item:1',
    '@@iterator=values',
  ]);
  define('HTMLCollection', HTMLCollection, null, ['length', 'item:1', 'namedItem:1', '@@iterator']);
  for (var i = 0; i < ELEMENT_INTERFACES.length; i++) {
    var name = ELEMENT_INTERFACES[i];
    var impl = { [name]: class extends HTMLElement {} }[name];
    define(name, impl, PublicHTMLElement, []);
  }

  /**
   * Binds the natives, makes node wrappers EventTargets, and defines the page's
   * `window` and `document`.
   * @param {Object} native pkg/runtime/dom.odin's bindings.
   * @param {string[]} names The interfaces Odin makes wrappers of, in its order.
   * @returns {{protos: Object[], fire: Function}} The prototypes for `names`, in order,
   *   and the trusted-event dispatcher the page loader fires DOMContentLoaded with.
   * @throws {TypeError} for a name this file does not define: Odin and this file
   *   disagree, and no page may run on a half-built DOM.
   */
  function install(native, names) {
    nIsNode = native.isNode;
    nDocument = native.document;
    nNodeType = native.nodeType;
    nNodeName = native.nodeName;
    nParent = native.parent;
    nFirstChild = native.firstChild;
    nLastChild = native.lastChild;
    nNextSibling = native.nextSibling;
    nPreviousSibling = native.previousSibling;
    nChildNodes = native.childNodes;
    nTextContent = native.textContent;
    nSetTextContent = native.setTextContent;
    nData = native.data;
    nSetData = native.setData;
    nInsertBefore = native.insertBefore;
    nRemoveChild = native.removeChild;
    nReplaceChild = native.replaceChild;
    nRemove = native.remove;
    nContains = native.contains;
    nClone = native.clone;
    nLocalName = native.localName;
    nGetAttribute = native.getAttribute;
    nSetAttribute = native.setAttribute;
    nRemoveAttribute = native.removeAttribute;
    nHasAttribute = native.hasAttribute;
    nInnerHTML = native.innerHTML;
    nSetInnerHTML = native.setInnerHTML;
    nOuterHTML = native.outerHTML;
    nQuery = native.query;
    nByTagName = native.byTagName;
    nByClassName = native.byClassName;
    nById = native.byId;
    nCreateElement = native.createElement;
    nCreateText = native.createText;
    nCreateComment = native.createComment;
    nCreateFragment = native.createFragment;

    events.setHostTargets(nIsNode, nParent);
    var global = globalThis;
    nativeShape.defineGlobalAttribute('window', function () {
      return global;
    });
    nativeShape.defineGlobalAttribute('document', function () {
      return nDocument();
    });

    var protos = [];
    for (var j = 0; j < names.length; j++) {
      var impl = IMPLS[names[j]];
      if (impl === undefined) throw new TypeErrorP('internal/dom: no interface ' + names[j]);
      protos[j] = impl.prototype;
    }

    return { __proto__: null, protos: protos, fire: events.fireEvent };
  }

  module.exports = ObjectFreeze({ __proto__: null, install: install });
});
