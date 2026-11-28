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
  var mutationObserver = require('internal/mutation_observer');
  var reflect = require('internal/dom_reflect');
  var DOMException = require('internal/domexception').DOMException;
  var cookieJar = require('internal/cookie');
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var ProxyP = P.Proxy;
  var ReflectApply = P.ReflectApply;
  var ReflectDefineProperty = P.ReflectDefineProperty;
  var ReflectDeleteProperty = P.ReflectDeleteProperty;
  var ReflectGet = P.ReflectGet;
  var ReflectGetOwnPropertyDescriptor = P.ReflectGetOwnPropertyDescriptor;
  var ReflectHas = P.ReflectHas;
  var ReflectOwnKeys = P.ReflectOwnKeys;
  var ReflectSet = P.ReflectSet;
  var GeneratorPrototypeNext = P.GeneratorPrototypeNext;
  var WeakMapP = P.WeakMap;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
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

  // Hands a list to its constructor; no page argument is it.
  var INTERNAL = { __proto__: null };

  // The document's readiness (Document.readyState); advance() moves it on.
  var readyState = 'loading';

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
  var nCurrentScript = null;
  var nWrite = null;

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

    return all ? staticList(found) : found;
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
   * @deviates none: childNodes is live and the same object on every read, as in
   *   Chrome (tests/dom/cases/dom-live-collections.page).
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
      nNodeType(this);
      var lists = listsOf(this);
      if (lists.childNodes === null) lists.childNodes = liveList(NodeList, nChildNodes, this, null);
      return lists.childNodes;
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
   * @deviates attributes, namespaceURI, closest and matches are absent (stage 4b).
   *   children and getElementsBy* are live and cached per node (and per name), as in
   *   Chrome (tests/dom/cases/dom-live-collections.page); a named property of an
   *   HTMLCollection (`coll.someId`) is absent, namedItem() answers it.
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
      reflect.attributeChanged(this, name);
    }

    removeAttribute(name) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'removeAttribute');
      name = toDOMString(name, 'Element', 'removeAttribute');
      reflect.attributeRemoving(this, name);
      nRemoveAttribute(this, name);
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
      return byName(this, 'byTag', nByTagName, name);
    }

    getElementsByClassName(classNames) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Element', 'getElementsByClassName');
      var names = toDOMString(classNames, 'Element', 'getElementsByClassName');
      return byName(this, 'byClass', nByClassName, names);
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
      return childrenOf(this);
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
   * @node n/a — Chrome 158: the interface a tag maps to is the HTML standard's; the
   *   reflected members are internal/dom_reflect's (tests/dom/cases/dom-reflect-*.page).
   * @deviates Only the reflected attributes internal/dom_reflect's table lists exist;
   *   event handler attributes, layout and form state are absent (stage 4b).
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
      return childrenOf(this);
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
   * @deviates No URL or createElementNS yet (stage 4b).
   */
  class Document extends Node {
    get documentElement() {
      return firstElement(this, true);
    }

    /**
     * The cookies of the document's URL that a script may see (no HttpOnly), and one
     * set-cookie-string stored per assignment (internal/cookie).
     * @node Chrome 158, tests/dom/cases/cookie-document-{basic,attributes,limits}.page.
     * @deviates In memory, per page (no persistence); '' and a write ignored for an
     *   opaque-origin document, where Chrome throws for a sandboxed or data: one.
     */
    get cookie() {
      nNodeType(this);
      return cookieJar.documentGet();
    }

    set cookie(value) {
      nNodeType(this);
      cookieJar.documentSet(toDOMString(value, 'Document', 'cookie'));
    }

    /**
     * HTML's document readiness: `loading` while the parser runs, `interactive` from
     * just before DOMContentLoaded, `complete` from just before the window's `load`.
     * @node Chrome 158, tests/dom/cases/dom-load.page.
     * @deviates `complete` (and `load`) wait for the page's event loop to idle, since a
     *   Larva page has no subresources to wait for: a timer a script set before then
     *   runs before `load`, where Chrome's order with it is a race.
     */
    get readyState() {
      nNodeType(this);
      return readyState;
    }

    get head() {
      return htmlChild(this, 'head', null);
    }

    /**
     * The script element whose classic script is running, or null: set around each one
     * a page runs (pkg/runtime/page_script.odin script_execute), parser-inserted,
     * deferred, async and inserted alike, and restored after it, so a listener or a
     * callback that runs later sees null.
     * @node Chrome 158, tests/dom/cases/dom-script-{external,defer,async,dynamic}.page.
     * @deviates none for classic scripts; a module script never runs (Lava has no
     *   module loader), so the null Chrome answers inside one is not observable here.
     */
    get currentScript() {
      return nCurrentScript(this);
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
      return childrenOf(this);
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

      var el = nCreateElement(this, name);
      if (nLocalName(el) === 'script') reflect.scriptCreated(el);
      return el;
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
      return byName(this, 'byTag', nByTagName, name);
    }

    getElementsByClassName(classNames) {
      nNodeType(this);
      needArgs(arguments.length, 1, 'Document', 'getElementsByClassName');
      var names = toDOMString(classNames, 'Document', 'getElementsByClassName');
      return byName(this, 'byClass', nByClassName, names);
    }

    querySelector(selectors) {
      nNodeType(this);
      return query(this, selectors, false, 'Document', 'querySelector', arguments.length);
    }

    querySelectorAll(selectors) {
      nNodeType(this);
      return query(this, selectors, true, 'Document', 'querySelectorAll', arguments.length);
    }

    /**
     * Writes markup at the parser's insertion point (HTML's document.write), parsed
     * before write returns: what it builds is in the tree at once, and a written inline
     * script runs inside the call; a written external script blocks the parser until
     * the writing script has returned.
     * @param {...*} text Each converted to a DOMString, in order, and joined.
     * @node Chrome 158, tests/dom/cases/dom-script-write.page: `write.length` is 0.
     * @deviates Only while a parser-inserted script runs: once the document has parsed
     *   (a deferred or async script, a listener, a timer) the call does nothing, where
     *   Chrome ignores it from an async or deferred script but runs document.open (the
     *   page is replaced) from a listener or a timer — that reopening is not modeled.
     *   TrustedHTML is not modeled either: every argument is a string.
     */
    write() {
      nNodeType(this);
      nWrite(this, joinText(arguments, 'write', ''));
    }

    /**
     * document.write, then a line feed.
     * @node Chrome 158, tests/dom/cases/dom-script-write.page.
     * @deviates As write.
     */
    writeln() {
      nNodeType(this);
      nWrite(this, joinText(arguments, 'writeln', '\n'));
    }
  }

  // document.write's arguments as one string, each converted in order, then `end`.
  function joinText(args, op, end) {
    var out = '';
    for (var i = 0; i < args.length; i++) out += toDOMString(args[i], 'Document', op);
    return out + end;
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

  // A list's state, keyed by what a page holds of it (the list itself, or the proxy in
  // front of a live one, and that proxy's target): `items` for a static list
  // (querySelectorAll's), `compute` for a live one, which recomputes its items from the
  // tree at every access — the MVP of a live collection (stage 4b), with no cache to
  // invalidate. A private field cannot be the brand here: a member called through the
  // proxy gets the proxy as `this`.
  var listState = new WeakMapP();

  // A node's live lists, made on first use and the same object on every read after, as
  // Blink caches them: childNodes, children, and one per name for getElementsBy*.
  var nodeLists = new WeakMapP();

  function listsOf(node) {
    var lists = WeakMapPrototypeGet(nodeLists, node);
    if (lists === undefined) {
      lists = { __proto__: null, childNodes: null, children: null, byTag: null, byClass: null };
      WeakMapPrototypeSet(nodeLists, node, lists);
    }

    return lists;
  }

  function childrenOf(node) {
    nNodeType(node);
    var lists = listsOf(node);
    if (lists.children === null) {
      lists.children = liveList(HTMLCollection, elementChildren, node, null);
    }

    return lists.children;
  }

  // A getElementsBy* collection: one per node, kind and name.
  function byName(node, kind, compute, name) {
    var lists = listsOf(node);
    var table = lists[kind];
    if (table === null) {
      table = { __proto__: null };
      lists[kind] = table;
    }

    var list = table[name];
    if (list === undefined) {
      list = liveList(HTMLCollection, compute, node, name);
      table[name] = list;
    }

    return list;
  }

  function itemsOfState(rec) {
    if (rec.compute === null) return rec.items;
    return rec.arg === null ? rec.compute(rec.node) : rec.compute(rec.node, rec.arg);
  }

  // A live list's record ({compute, node, arg}): the brand check of internal/dom_reflect's
  // DOMTokenList, which shares this machinery and checks `compute` itself.
  function listRecord(o) {
    var rec = WeakMapPrototypeGet(listState, o);
    if (rec === undefined) throw illegalInvocation();
    return rec;
  }

  // Any list's items now: the proxy traps', for every kind of list.
  function anyListItems(o) {
    return itemsOfState(listRecord(o));
  }

  // The brand check of every NodeList and HTMLCollection member, and its items now. A
  // DOMTokenList's record is refused: its items are strings, not nodes.
  function listItems(o) {
    var rec = listRecord(o);
    if (rec.tokens) throw illegalInvocation();
    return itemsOfState(rec);
  }

  // `key` as an array index (a canonical numeric string below 2^32 - 1), or -1: the
  // property names a list answers from its items (WebIDL's indexed properties).
  function arrayIndex(key) {
    if (typeof key !== 'string') return -1;
    var n = key.length;
    if (n === 0 || n > 10) return -1;
    var c = StringPrototypeCharCodeAt(key, 0);
    if (c === 0x30) return n === 1 ? 0 : -1;
    var v = 0;
    for (var i = 0; i < n; i++) {
      c = StringPrototypeCharCodeAt(key, i);
      if (c < 0x30 || c > 0x39) return -1;
      v = v * 10 + (c - 0x30);
    }

    return v < 4294967295 ? v : -1;
  }

  // The legacy platform object's indexed properties, as a proxy's traps over the list
  // object (its target): read-only, enumerable, configurable, recomputed per access.
  // Null-prototype, so a page's Object.prototype cannot add a trap.
  var LIVE_HANDLER = {
    __proto__: null,
    get: function (target, key, receiver) {
      var at = arrayIndex(key);
      if (at !== -1) {
        var items = anyListItems(target);
        if (at < items.length) return items[at];
      }

      return ReflectGet(target, key, receiver);
    },
    has: function (target, key) {
      var at = arrayIndex(key);
      if (at !== -1) return at < anyListItems(target).length;
      return ReflectHas(target, key);
    },
    getOwnPropertyDescriptor: function (target, key) {
      var at = arrayIndex(key);
      if (at !== -1) {
        var items = anyListItems(target);
        if (at >= items.length) return undefined;
        return {
          __proto__: null,
          value: items[at],
          writable: false,
          enumerable: true,
          configurable: true,
        };
      }

      return ReflectGetOwnPropertyDescriptor(target, key);
    },
    ownKeys: function (target) {
      var items = anyListItems(target);
      var keys = [];
      var n = 0;
      for (var i = 0; i < items.length; i++) keys[n++] = '' + i;
      var own = ReflectOwnKeys(target);
      for (var j = 0; j < own.length; j++) keys[n++] = own[j];
      return keys;
    },
    defineProperty: function (target, key, desc) {
      if (arrayIndex(key) !== -1) return false;
      return ReflectDefineProperty(target, key, desc);
    },
    set: function (target, key, value, receiver) {
      if (arrayIndex(key) !== -1) return false;
      return ReflectSet(target, key, value, receiver);
    },
    deleteProperty: function (target, key) {
      var at = arrayIndex(key);
      if (at !== -1) return at >= anyListItems(target).length;
      return ReflectDeleteProperty(target, key);
    },
  };

  // A live list of `Impl` over `node`: `compute(node[, arg])` answers its items.
  function liveList(Impl, compute, node, arg) {
    var target = new Impl(INTERNAL);
    var rec = {
      __proto__: null,
      items: null,
      compute: compute,
      node: node,
      arg: arg,
      tokens: Impl !== NodeList && Impl !== HTMLCollection,
    };
    var proxy = new ProxyP(target, LIVE_HANDLER);
    WeakMapPrototypeSet(listState, target, rec);
    WeakMapPrototypeSet(listState, proxy, rec);
    return proxy;
  }

  // The indexed own properties of a static list: what Blink reports for an index of a
  // NodeList, enumerable and configurable but not writable.
  var INDEX_DESC = {
    __proto__: null,
    value: null,
    writable: false,
    enumerable: true,
    configurable: true,
  };

  // A static NodeList of `items` (querySelectorAll's).
  function staticList(items) {
    var list = new NodeList(INTERNAL);
    var rec = {
      __proto__: null,
      items: items,
      compute: null,
      node: null,
      arg: null,
      tokens: false,
    };
    WeakMapPrototypeSet(listState, list, rec);
    for (var i = 0; i < items.length; i++) {
      INDEX_DESC.value = items[i];
      ObjectDefineProperty(list, i, INDEX_DESC);
    }

    INDEX_DESC.value = null;
    return list;
  }

  /**
   * NodeList: live for childNodes, static for querySelectorAll, as in Chrome.
   * @node n/a — Chrome 158, tests/dom/cases/dom-live-collections.page.
   * @deviates A live list is a Proxy over the list object (its indexed properties are
   *   traps), so `this` is checked against a WeakMap instead of a private field; nothing
   *   a page reads tells the two apart.
   */
  class NodeList {
    constructor(token) {
      if (token !== INTERNAL) throw illegalInvocation();
    }

    get length() {
      return listItems(this).length;
    }

    item(index) {
      var items = listItems(this);
      needArgs(arguments.length, 1, 'NodeList', 'item');
      var v = items[index >>> 0];
      return v === undefined ? null : v;
    }

    forEach(callback) {
      listItems(this);
      needArgs(arguments.length, 1, 'NodeList', 'forEach');
      if (typeof callback !== 'function') {
        throw typeError(
          'NodeList',
          'forEach',
          'The callback provided as parameter 1 is not a function.',
        );
      }

      var thisArg = arguments[1];
      for (var i = 0; ; i++) {
        var items = listItems(this);
        if (i >= items.length) break;
        ReflectApply(callback, thisArg, [items[i], i, this]);
      }
    }

    *entries() {
      listItems(this);
      for (var i = 0; ; i++) {
        var items = listItems(this);
        if (i >= items.length) return;
        yield [i, items[i]];
      }
    }

    *keys() {
      listItems(this);
      for (var i = 0; ; i++) {
        if (i >= listItems(this).length) return;
        yield i;
      }
    }

    *values() {
      listItems(this);
      for (var i = 0; ; i++) {
        var items = listItems(this);
        if (i >= items.length) return;
        yield items[i];
      }
    }
  }

  /**
   * HTMLCollection: always live (children, getElementsByTagName/ClassName).
   * @node n/a — Chrome 158, tests/dom/cases/dom-live-collections.page.
   * @deviates As NodeList's; no named properties (namedItem answers them).
   */
  class HTMLCollection {
    constructor(token) {
      if (token !== INTERNAL) throw illegalInvocation();
    }

    get length() {
      return listItems(this).length;
    }

    item(index) {
      var items = listItems(this);
      needArgs(arguments.length, 1, 'HTMLCollection', 'item');
      var v = items[index >>> 0];
      return v === undefined ? null : v;
    }

    namedItem(name) {
      var items = listItems(this);
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
      listItems(this);
      for (var i = 0; ; i++) {
        var items = listItems(this);
        if (i >= items.length) return;
        yield items[i];
      }
    }
  }

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
  var PublicElement = define(
    'Element',
    Element,
    PublicNode,
    P.ArrayPrototypeConcat(
      ['localName', 'tagName', 'id', 'className'],
      reflect.members('Element', Element.prototype),
      [
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
      ],
    ),
  );
  var PublicHTMLElement = define(
    'HTMLElement',
    HTMLElement,
    PublicElement,
    reflect.members('HTMLElement', HTMLElement.prototype),
  );
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
    'cookie',
    'readyState',
    'title',
    'body',
    'head',
    'currentScript',
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
    'write:0',
    'writeln:0',
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
    define(name, impl, PublicHTMLElement, reflect.members(name, impl.prototype));
  }

  /**
   * Binds the natives, makes node wrappers EventTargets, and defines the page's
   * `window` and `document`.
   * @param {Object} native pkg/runtime/dom.odin's bindings.
   * @param {string[]} names The interfaces Odin makes wrappers of, in its order.
   * @returns {{protos: Object[], advance: Function, fireAt: Function, parsed: Function}}
   *   The prototypes for `names`, in order; the readiness step the page loader fires
   *   DOMContentLoaded and `load` with; the one it fires a script element's
   *   `load`/`error` with; and the step it hands parser-inserted nodes to for
   *   MutationObserver.
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
    nCurrentScript = native.currentScript;
    nWrite = native.write;

    // The natives that change the tree, wrapped with the records MutationObserver
    // queues for them (internal/mutation_observer); every mutation below goes through
    // these.
    var observed = mutationObserver.attach(native, staticList);
    nInsertBefore = observed.insertBefore;
    nRemoveChild = observed.removeChild;
    nReplaceChild = observed.replaceChild;
    nRemove = observed.remove;
    nSetTextContent = observed.setTextContent;
    nSetData = observed.setData;
    nSetInnerHTML = observed.setInnerHTML;
    nSetAttribute = observed.setAttribute;
    nRemoveAttribute = observed.removeAttribute;

    var global = globalThis;
    events.setHostTargets(nIsNode, nParent, isDocument);
    nativeShape.defineGlobalAttribute('window', function () {
      return global;
    });
    nativeShape.defineGlobalAttribute('document', function () {
      return nDocument();
    });
    windowTarget = global;

    var protos = [];
    for (var j = 0; j < names.length; j++) {
      var impl = IMPLS[names[j]];
      if (impl === undefined) throw new TypeErrorP('internal/dom: no interface ' + names[j]);
      protos[j] = impl.prototype;
    }

    reflect.install(
      {
        __proto__: null,
        interface: native.interface,
        document: nDocument,
        nodeType: nNodeType,
        parent: nParent,
        firstChild: nFirstChild,
        nextSibling: nNextSibling,
        data: nData,
        localName: nLocalName,
        textContent: nTextContent,
        setTextContent: nSetTextContent,
        getAttribute: nGetAttribute,
        setAttribute: nSetAttribute,
        removeAttribute: nRemoveAttribute,
        query: nQuery,
        liveList: liveList,
        listRecord: listRecord,
        listToken: INTERNAL,
      },
      names,
      protos,
    );

    return {
      __proto__: null,
      protos: protos,
      advance: advance,
      fireAt: fireAt,
      parsed: observed.parsed,
    };
  }

  function isDocument(o) {
    return nNodeType(o) === DOCUMENT_NODE;
  }

  // The page's window, which `load` is fired at (internal/event_target made it an
  // EventTarget, with its `onload`, at that module's eval).
  var windowTarget = null;

  // The steps of one readiness change, one listener a step (event_target dispatch):
  // `interactive` is readystatechange at the document; `contentloaded` is
  // DOMContentLoaded at it, with the deferred scripts run in between (HTML's "the end"
  // steps 3-5, Chrome 158 tests/dom/cases/dom-script-defer.page); `complete` is
  // readystatechange at the document then `load` at the window, targeted at the
  // document (HTML's legacy target override).
  function* lifecycle(stage) {
    var doc = nDocument();
    var steps;
    if (stage === 'contentloaded') {
      steps = events.fireSteps(doc, 'DOMContentLoaded', true);
    } else {
      readyState = stage;
      steps = events.fireSteps(doc, 'readystatechange', false);
      while (!ReflectApply(GeneratorPrototypeNext, steps, []).done) yield;
      if (stage === 'interactive') return;
      steps = events.fireSteps(windowTarget, 'load', false, doc);
    }

    while (!ReflectApply(GeneratorPrototypeNext, steps, []).done) yield;
  }

  // An element's `load` or `error` (HTML's "fire an event" at a script element: not
  // bubbling, not cancelable), one listener a step, as advance's.
  function* elementEvent(node, type) {
    var steps = events.fireSteps(node, type, false);
    while (!ReflectApply(GeneratorPrototypeNext, steps, []).done) yield;
  }

  /**
   * advance's step function for an event at a script element (pkg/runtime/page_script.odin
   * script_fire): its `load` once its external script ran, its `error` when that script
   * could not be fetched.
   * @param {Node} node The script element.
   * @param {string} type `load` or `error`.
   * @returns {function(): boolean}
   */
  function fireAt(node, type) {
    var steps = elementEvent(node, type);
    return function () {
      return !ReflectApply(GeneratorPrototypeNext, steps, []).done;
    };
  }

  /**
   * Moves the document to `stage` and hands the page loader the step function that
   * fires its events: each call runs at most one listener and answers whether more
   * remain, so the loader's own call boundary is the microtask checkpoint between two
   * listeners (Chrome 158, tests/dom/cases/dom-load.page: a microtask queued by one
   * `load` listener runs before the next listener).
   * @param {string} stage `interactive` (parse done), `contentloaded` (the deferred
   *   scripts ran) or `complete` (the loop idled).
   * @returns {function(): boolean}
   */
  function advance(stage) {
    var steps = lifecycle(stage);
    return function () {
      return !ReflectApply(GeneratorPrototypeNext, steps, []).done;
    };
  }

  module.exports = ObjectFreeze({ __proto__: null, install: install });
});
