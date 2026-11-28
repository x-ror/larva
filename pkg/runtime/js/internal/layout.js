/**
 * @fileoverview Fake geometry for a page with no layout engine (#14): DOMRectReadOnly,
 * DOMRect and DOMRectList; the viewport's scroll position and the window's scroll
 * operations; Element's geometry and scrolling members (getBoundingClientRect, offset*,
 * client*, scroll*, scrollIntoView); and the inline and computed CSSStyleDeclaration
 * (`element.style`, getComputedStyle).
 *
 * Larva lays nothing out (docs/LARVA.md), yet real pages measure before they act: lazy
 * loaders skip an element whose offsetWidth is 0, infinite-scroll loops read
 * scrollHeight until it stops growing, "is visible" checks read getComputedStyle. So the
 * numbers here are a deliberately simple, deterministic block-flow ESTIMATE, consistent
 * with each other rather than with Chrome's pixels:
 *   - the root is the profile's viewport wide (pkg/profile, innerWidth); body has the
 *     UA's 8px margin; every block-level box is its container's width, stacked;
 *   - a run of inline content is one line box per `width / CHAR_WIDTH` characters of
 *     collapsed text, LINE_HEIGHT tall; a replaced element (img, video, input, …) is
 *     its width/height attribute or inline px size, else a fixed default;
 *   - an inline `height`/`width` in px or vh is honoured; `display: none` (inline
 *     style, the `hidden` attribute or the UA default for head, script, …) is no box at
 *     all, so every geometry member reads 0 and getClientRects() is empty.
 * The estimate is computed for the whole document at once and kept until the tree
 * changes (internal/dom routes every mutation through `dirtying`) or the current
 * microtask checkpoint passes (which covers the parser's own insertions).
 *
 * The viewport scrolls: window.scrollTo/scrollBy/scroll, scrollIntoView and
 * documentElement.scrollTop move scrollX/scrollY (clamped to the estimated document),
 * and a `scroll` event is fired at the document (bubbling to the window) as a task, as
 * Chrome fires it in its next frame. An element whose inline overflow makes it a scroll
 * container keeps its own scrollTop and gets its own, non-bubbling `scroll`.
 *
 * Instantiated eagerly (internal/navigator requires it, which the loader names), so
 * every capture below is pristine.
 *
 * @module lava/internal/layout
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var eventTarget = require('internal/event_target');
  var DOMException = require('internal/domexception').DOMException;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ReflectOwnKeys = P.ReflectOwnKeys;
  var TypeErrorP = P.TypeError;
  var MathFloor = P.MathFloor;
  var MathMax = P.MathMax;
  var MathMin = P.MathMin;
  var NumberIsFinite = P.NumberIsFinite;
  var NumberP = P.Number;
  var ObjectCreate = P.ObjectCreate;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var PromiseResolve = P.PromiseResolve;
  var PromiseThen = P.Promise.prototype.then;
  var ProxyP = P.Proxy;
  var ReflectApply = P.ReflectApply;
  var ReflectGet = P.ReflectGet;
  var ReflectHas = P.ReflectHas;
  var ReflectSet = P.ReflectSet;
  var StringP = P.String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeTrim = P.StringPrototypeTrim;
  var SymbolIterator = P.Symbol.iterator;
  var ArrayPrototypeValues = P.Array.prototype.values;
  var WeakMapP = P.WeakMap;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var toNumber = webErrors.toNumber;
  var typeError = webErrors.typeError;
  var fireEvent = eventTarget.fireEvent;
  // Captured at this eager eval: the timer a scroll event is queued on.
  var setTimeoutP = setTimeout;

  var INTERNAL = { __proto__: null };

  // --- the estimate's constants ----------------------------------------------------

  // Chrome's `normal` line height for its 16px default font, rounded, and an average
  // glyph advance of that font: what a line box and a character cost.
  var LINE_HEIGHT = 18;
  var CHAR_WIDTH = 8;
  var BODY_MARGIN = 8;
  var BLOCK_MARGIN = 16;
  var LIST_INDENT = 40;

  var DISPLAY_NONE = {
    __proto__: null,
    area: 1,
    base: 1,
    basefont: 1,
    datalist: 1,
    head: 1,
    link: 1,
    meta: 1,
    noembed: 1,
    noframes: 1,
    param: 1,
    rp: 1,
    script: 1,
    style: 1,
    template: 1,
    title: 1,
    // Scripting is on in a page, so <noscript> is not rendered.
    noscript: 1,
    source: 1,
    track: 1,
    dialog: 1,
  };
  // The UA stylesheet's `display` per element (HTML §15.3), for the values that are not
  // `inline` or `none`.
  var DISPLAY = {
    __proto__: null,
    html: 'block',
    body: 'block',
    address: 'block',
    article: 'block',
    aside: 'block',
    blockquote: 'block',
    center: 'block',
    details: 'block',
    dd: 'block',
    dir: 'block',
    div: 'block',
    dl: 'block',
    dt: 'block',
    fieldset: 'block',
    figcaption: 'block',
    figure: 'block',
    footer: 'block',
    form: 'block',
    h1: 'block',
    h2: 'block',
    h3: 'block',
    h4: 'block',
    h5: 'block',
    h6: 'block',
    header: 'block',
    hgroup: 'block',
    hr: 'block',
    legend: 'block',
    listing: 'block',
    main: 'block',
    menu: 'block',
    nav: 'block',
    ol: 'block',
    optgroup: 'block',
    option: 'block',
    p: 'block',
    plaintext: 'block',
    pre: 'block',
    search: 'block',
    section: 'block',
    summary: 'block',
    ul: 'block',
    xmp: 'block',
    li: 'list-item',
    table: 'table',
    caption: 'table-caption',
    colgroup: 'table-column-group',
    col: 'table-column',
    thead: 'table-header-group',
    tbody: 'table-row-group',
    tfoot: 'table-footer-group',
    tr: 'table-row',
    td: 'table-cell',
    th: 'table-cell',
    button: 'inline-block',
    input: 'inline-block',
    meter: 'inline-block',
    progress: 'inline-block',
    select: 'inline-block',
    textarea: 'inline-block',
    marquee: 'inline-block',
  };
  // Replaced elements and their size when neither attribute nor inline style gives one
  // (Chrome's 300x150 for the embedded ones; a fixed placeholder for an image whose
  // natural size Larva never learns, as it decodes none).
  var REPLACED = {
    __proto__: null,
    img: [100, 100],
    video: [300, 150],
    canvas: [300, 150],
    iframe: [300, 150],
    embed: [300, 150],
    object: [300, 150],
    svg: [300, 150],
    audio: [300, 54],
    input: [150, 21],
    button: [64, 21],
    select: [150, 21],
    textarea: [180, 36],
    meter: [80, 16],
    progress: [160, 16],
  };
  var HEADING_LINE = { __proto__: null, h1: 37, h2: 28, h3: 22 };
  var MARGINED = {
    __proto__: null,
    p: 1,
    h1: 1,
    h2: 1,
    h3: 1,
    h4: 1,
    h5: 1,
    h6: 1,
    ul: 1,
    ol: 1,
    dl: 1,
    blockquote: 1,
    figure: 1,
    pre: 1,
    hr: 1,
  };

  // --- natives (internal/dom's, bound by attach) -----------------------------------

  var attached = false;
  var nIsNode = null;
  var nNodeType = null;
  var nLocalName = null;
  var nParent = null;
  var nFirstChild = null;
  var nNextSibling = null;
  var nData = null;
  var nGetAttribute = null;
  var nSetAttribute = null;
  var nDocument = null;

  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
  var DOCUMENT_NODE = 9;

  // The profile's viewport (internal/navigator's setViewport, at its eval).
  var viewport = {
    __proto__: null,
    width: 1920,
    height: 1080,
    screenWidth: 1920,
    screenHeight: 1080,
    dpr: 1,
  };

  /**
   * True for a node wrapper that is an Element: the brand observe() and
   * getComputedStyle() check their argument with. Never throws.
   * @param {*} v
   * @returns {boolean}
   */
  function isElement(v) {
    return attached && nIsNode(v) && nNodeType(v) === ELEMENT_NODE;
  }

  function isDocumentNode(v) {
    return attached && nIsNode(v) && nNodeType(v) === DOCUMENT_NODE;
  }

  function checkElement(o) {
    if (!isElement(o)) throw illegalInvocation();
  }

  // --- inline style -----------------------------------------------------------------

  // A `style` attribute's declarations, parsed: [name, value, important] triples in
  // source order, a later duplicate replacing the earlier in place. Shorthands are not
  // expanded (a deviation: `margin: 0` stays one declaration, Chrome makes it four).
  var parsedText = null;
  var parsedDecls = null;

  function isSpace(c) {
    return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  }

  function trim(s) {
    return StringPrototypeTrim(s);
  }

  function lower(s) {
    return StringPrototypeToLowerCase(s);
  }

  function findDecl(decls, name) {
    for (var i = 0; i < decls.length; i++) {
      if (decls[i][0] === name) return i;
    }

    return -1;
  }

  function parseDeclarations(text) {
    if (text === parsedText) return parsedDecls;
    var decls = [];
    var start = 0;
    var depth = 0;
    var quote = 0;
    for (var i = 0; i <= text.length; i++) {
      var c = i < text.length ? StringPrototypeCharCodeAt(text, i) : 59;
      if (quote !== 0) {
        if (c === quote) quote = 0;
        continue;
      }

      if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 40) {
        depth++;
      } else if (c === 41 && depth > 0) {
        depth--;
      } else if (c === 59 && depth === 0) {
        addDecl(decls, StringPrototypeSlice(text, start, i));
        start = i + 1;
      }
    }

    parsedText = text;
    parsedDecls = decls;
    return decls;
  }

  function addDecl(decls, part) {
    var colon = -1;
    for (var i = 0; i < part.length; i++) {
      if (StringPrototypeCharCodeAt(part, i) === 58) {
        colon = i;
        break;
      }
    }

    if (colon === -1) return;
    var name = trim(StringPrototypeSlice(part, 0, colon));
    if (name === '') return;
    if (!isCustom(name)) name = lower(name);
    var value = trim(StringPrototypeSlice(part, colon + 1, part.length));
    var important = false;
    var bang = importantAt(value);
    if (bang !== -1) {
      important = true;
      value = trim(StringPrototypeSlice(value, 0, bang));
    }

    if (value === '') return;
    var decl = [name, value, important];
    var at = findDecl(decls, name);
    if (at === -1) decls[decls.length] = decl;
    else decls[at] = decl;
  }

  // Where a trailing `!important` (any case, any space after the `!`) starts; -1 when
  // there is none.
  function importantAt(value) {
    var word = 'important';
    var end = value.length;
    if (end < word.length + 1) return -1;
    if (lower(StringPrototypeSlice(value, end - word.length, end)) !== word) return -1;
    var i = end - word.length - 1;
    while (i >= 0 && isSpace(StringPrototypeCharCodeAt(value, i))) i--;
    return i >= 0 && StringPrototypeCharCodeAt(value, i) === 33 ? i : -1;
  }

  function isCustom(name) {
    return (
      name.length > 2 &&
      StringPrototypeCharCodeAt(name, 0) === 45 &&
      StringPrototypeCharCodeAt(name, 1) === 45
    );
  }

  function serializeDecls(decls) {
    var out = '';
    for (var i = 0; i < decls.length; i++) {
      var d = decls[i];
      out += (i === 0 ? '' : ' ') + d[0] + ': ' + d[1] + (d[2] ? ' !important' : '') + ';';
    }

    return out;
  }

  function inlineDecls(el) {
    var text = nGetAttribute(el, 'style');
    return text === null || text === '' ? EMPTY_DECLS : parseDeclarations(text);
  }

  var EMPTY_DECLS = [];

  function inlineValue(el, name) {
    var decls = inlineDecls(el);
    var at = findDecl(decls, name);
    return at === -1 ? '' : lower(decls[at][1]);
  }

  // `display` as the cascade of the UA sheet, the `hidden` attribute and the inline
  // style gives it (no page stylesheet is applied: a deviation, #14).
  function computedDisplay(el) {
    var d = inlineValue(el, 'display');
    if (d !== '' && d !== 'inherit' && d !== 'initial' && d !== 'unset' && d !== 'revert') return d;
    var name = nLocalName(el);
    if (DISPLAY_NONE[name] === 1) {
      if (name === 'dialog' && nGetAttribute(el, 'open') !== null) return 'block';
      return 'none';
    }

    if (nGetAttribute(el, 'hidden') !== null) return 'none';
    if (name === 'input' && lower(attr(el, 'type')) === 'hidden') return 'none';
    if (name === 'audio' && nGetAttribute(el, 'controls') === null) return 'none';
    var ua = DISPLAY[name];
    return ua === undefined ? 'inline' : ua;
  }

  function attr(el, name) {
    var v = nGetAttribute(el, name);
    return v === null ? '' : v;
  }

  // `visibility`, which inherits: the nearest inline value up the tree.
  function computedVisibility(el) {
    for (var n = el; n !== null && nNodeType(n) === ELEMENT_NODE; n = nParent(n)) {
      var v = inlineValue(n, 'visibility');
      if (v === 'hidden' || v === 'collapse' || v === 'visible') return v;
    }

    return 'visible';
  }

  function isBlockLevel(display) {
    return (
      display !== 'inline' &&
      display !== 'inline-block' &&
      display !== 'inline-flex' &&
      display !== 'inline-grid' &&
      display !== 'inline-table' &&
      display !== 'contents'
    );
  }

  // A px (or vh/vw/em/rem) length off the inline style; -1 when absent or relative to
  // something the estimate does not track.
  function inlineLength(el, name) {
    return parseLength(inlineValue(el, name));
  }

  function parseLength(v) {
    if (v === '') return -1;
    var end = v.length;
    var unit = '';
    while (end > 0) {
      var c = StringPrototypeCharCodeAt(v, end - 1);
      if ((c >= 97 && c <= 122) || c === 37) end--;
      else break;
    }

    unit = StringPrototypeSlice(v, end, v.length);
    var n = NumberP(StringPrototypeSlice(v, 0, end));
    if (end === 0 || !NumberIsFinite(n) || n < 0) return -1;
    if (unit === 'px' || (unit === '' && n === 0)) return n;
    if (unit === 'vh') return (n * viewport.height) / 100;
    if (unit === 'vw') return (n * viewport.width) / 100;
    if (unit === 'em' || unit === 'rem') return n * 16;
    return -1;
  }

  function attrLength(el, name) {
    var v = nGetAttribute(el, name);
    if (v === null) return -1;
    var n = NumberP(trim(v));
    return NumberIsFinite(n) && n >= 0 ? n : -1;
  }

  // --- the estimate -----------------------------------------------------------------

  // element -> [x, y, width, height, contentHeight, kind]; kind is 0 for a block box, 1
  // for an inline box (no client size, as Chrome's), 2 for a replaced inline one; absent
  // for an element with no box (not connected, or under display:none).
  var boxes = null;
  var docHeight = 0;
  var docWidth = 0;
  // Bumped by every tree mutation (dirtying) and by a dropped estimate: what an
  // IntersectionObserver re-evaluates against.
  var generation = 0;
  var invalidated = [];

  function dropLayout() {
    if (boxes === null) return;
    boxes = null;
  }

  function invalidate() {
    generation++;
    boxes = null;
    for (var i = 0; i < invalidated.length; i++) invalidated[i]();
  }

  /**
   * Wraps one of internal/dom's mutating natives so the estimate is dropped after it.
   * @param {Function} fn
   * @returns {Function}
   */
  function dirtying(fn) {
    return function (a, b, c) {
      var r = fn(a, b, c);
      invalidate();
      return r;
    };
  }

  function ensureLayout() {
    if (boxes !== null) return;
    boxes = new WeakMapP();
    docHeight = 0;
    docWidth = viewport.width;
    if (!attached) return;
    var root = firstElementChild(nDocument());
    if (root !== null && computedDisplay(root) !== 'none') {
      docHeight = blockBox(root, 0, 0, viewport.width, false);
    }

    // The estimate also ends at the next microtask checkpoint: the parser inserts nodes
    // between scripts without going through `dirtying`.
    ReflectApply(PromiseThen, PromiseResolve(), [dropLayout]);
  }

  function firstElementChild(node) {
    for (var c = nFirstChild(node); c !== null; c = nNextSibling(c)) {
      if (nNodeType(c) === ELEMENT_NODE) return c;
    }

    return null;
  }

  // The collapsed length of a text node's data: each run of white space is one space.
  // White space alone at the start of a line box is nothing.
  function textLength(data, atLineStart) {
    var n = 0;
    var space = atLineStart;
    for (var i = 0; i < data.length; i++) {
      if (isSpace(StringPrototypeCharCodeAt(data, i))) {
        if (!space) n++;
        space = true;
      } else {
        n++;
        space = false;
      }
    }

    return n;
  }

  function lineHeightOf(name) {
    var h = HEADING_LINE[name];
    return h === undefined ? LINE_HEIGHT : h;
  }

  function marginOf(name, display) {
    if (name === 'body') return BODY_MARGIN;
    if (MARGINED[name] === 1) return BLOCK_MARGIN / 2;
    return display === 'table-cell' ? 1 : 0;
  }

  // Lays out `el` as a block box at (x, y), `width` wide; answers its height.
  function blockBox(el, x, y, width, inlineLevel) {
    var name = nLocalName(el);
    var w = inlineLength(el, 'width');
    if (w >= 0) width = w;
    var indent = name === 'ul' || name === 'ol' ? LIST_INDENT : 0;
    var run = newRun(y + 0, x + indent, width - indent, lineHeightOf(name));
    var cy = flow(el, run);
    var content = cy - y;
    var h = inlineLength(el, 'height');
    var height = h >= 0 ? h : content;
    WeakMapPrototypeSet(boxes, el, [x, y, width, height, MathMax(content, height), 0]);
    return height;
  }

  function newRun(y, x, width, lineHeight) {
    return {
      __proto__: null,
      x: x,
      top: y,
      width: width > 1 ? width : 1,
      used: 0,
      tallest: lineHeight,
      lineHeight: lineHeight,
      charWidth: lineHeight === LINE_HEIGHT ? CHAR_WIDTH : MathFloor(lineHeight * 0.45),
    };
  }

  // The height the run's line boxes take so far.
  function runHeight(run) {
    if (run.used === 0) return 0;
    return lines(run) * run.tallest;
  }

  function lines(run) {
    var n = run.used / run.width;
    var whole = MathFloor(n);
    return whole === n ? whole : whole + 1;
  }

  // Ends the current run: answers where the next block starts.
  function flush(run) {
    var y = run.top + runHeight(run);
    run.top = y;
    run.used = 0;
    run.tallest = run.lineHeight;
    return y;
  }

  // Lays out the children of `parent` into `run`'s container; answers the y below them.
  function flow(parent, run) {
    for (var c = nFirstChild(parent); c !== null; c = nNextSibling(c)) {
      var type = nNodeType(c);
      if (type === TEXT_NODE) {
        run.used += textLength(nData(c), run.used === 0) * run.charWidth;
        continue;
      }

      if (type !== ELEMENT_NODE) continue;
      var display = computedDisplay(c);
      if (display === 'none') continue;
      if (display === 'contents') {
        flow(c, run);
        continue;
      }

      var name = nLocalName(c);
      if (name === 'br') {
        run.used = run.used === 0 ? run.width : lines(run) * run.width;
        continue;
      }

      if (isBlockLevel(display) || hasBlock(c)) {
        var y = flush(run);
        var m = marginOf(name, display);
        var h = blockBox(
          c,
          run.x + (name === 'body' ? m : 0),
          y + m,
          run.width - (name === 'body' ? 2 * m : 0),
          false,
        );
        run.top = y + m + h + m;
        continue;
      }

      inlineBox(c, name, run);
    }

    return flush(run);
  }

  // An inline-level element: its glyphs (or its replaced size) join the run, and its box
  // is where they landed.
  function inlineBox(el, name, run) {
    var line = MathFloor(run.used / run.width);
    var x = run.x + (run.used - line * run.width);
    var y = run.top + line * run.tallest;
    var size = REPLACED[name];
    var w;
    var h;
    if (size !== undefined) {
      w = inlineLength(el, 'width');
      if (w < 0) w = attrLength(el, 'width');
      h = inlineLength(el, 'height');
      if (h < 0) h = attrLength(el, 'height');
      if (w < 0) w = size[0];
      if (h < 0) h = size[1];
      run.used += w;
      if (h > run.tallest) run.tallest = h;
    } else {
      var before = run.used;
      inlineFlow(el, run);
      w = run.used - before;
      h = run.lineHeight;
      if (w > run.width) {
        x = run.x;
        h = (lines(run) - line) * run.lineHeight;
        w = run.width;
      }
    }

    WeakMapPrototypeSet(boxes, el, [x, y, w, h, h, size === undefined ? 1 : 2]);
  }

  function inlineFlow(el, run) {
    for (var c = nFirstChild(el); c !== null; c = nNextSibling(c)) {
      var type = nNodeType(c);
      if (type === TEXT_NODE) {
        run.used += textLength(nData(c), run.used === 0) * run.charWidth;
      } else if (type === ELEMENT_NODE && computedDisplay(c) !== 'none') {
        var name = nLocalName(c);
        if (name === 'br') run.used = lines(run) * run.width;
        else inlineBox(c, name, run);
      }
    }
  }

  // An inline element holding a block (a card wrapped in <a>) is laid out as a block.
  function hasBlock(el) {
    if (REPLACED[nLocalName(el)] !== undefined) return false;
    for (var c = nFirstChild(el); c !== null; c = nNextSibling(c)) {
      if (nNodeType(c) !== ELEMENT_NODE) continue;
      var d = computedDisplay(c);
      if (d === 'none') continue;
      if (isBlockLevel(d) || hasBlock(c)) return true;
    }

    return false;
  }

  // The element's box, or null when it has none.
  function boxOf(el) {
    ensureLayout();
    var b = WeakMapPrototypeGet(boxes, el);
    return b === undefined ? null : b;
  }

  // --- scrolling --------------------------------------------------------------------

  var scrollX = 0;
  var scrollY = 0;
  // element -> [left, top] for an element scroll container scrolled from 0.
  var elementScroll = new WeakMapP();
  var pendingScroll = [];
  var scrollQueued = false;
  var scrolled = [];

  function documentScrollHeight() {
    ensureLayout();
    return MathMax(docHeight, viewport.height);
  }

  function maxScrollY() {
    return MathMax(0, documentScrollHeight() - viewport.height);
  }

  function maxScrollX() {
    ensureLayout();
    return MathMax(0, docWidth - viewport.width);
  }

  function clamp(v, max) {
    if (!NumberIsFinite(v)) v = 0;
    v = MathFloor(v);
    return v < 0 ? 0 : v > max ? max : v;
  }

  function scrollViewportTo(x, y) {
    x = clamp(x, maxScrollX());
    y = clamp(y, maxScrollY());
    if (x === scrollX && y === scrollY) return;
    scrollX = x;
    scrollY = y;
    if (attached) queueScroll(nDocument());
  }

  function queueScroll(target) {
    if (ArrayPrototypeIndexOf(pendingScroll, target) === -1)
      pendingScroll[pendingScroll.length] = target;
    if (scrollQueued) return;
    scrollQueued = true;
    setTimeoutP(fireScrolls, 0);
  }

  // The `scroll` events of the scrolls since the last: one per target, the document's
  // bubbling to the window (CSSOM View's "run the scroll steps"), an element's not.
  function fireScrolls() {
    scrollQueued = false;
    var targets = pendingScroll;
    pendingScroll = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      fireEvent(t, 'scroll', isDocumentNode(t));
    }

    for (var j = 0; j < scrolled.length; j++) scrolled[j]();
  }

  function isScrollContainer(el) {
    var o = inlineValue(el, 'overflow');
    var oy = inlineValue(el, 'overflow-y');
    return (
      o === 'auto' ||
      o === 'scroll' ||
      o === 'hidden' ||
      oy === 'auto' ||
      oy === 'scroll' ||
      oy === 'hidden'
    );
  }

  function scrollOf(el) {
    var s = WeakMapPrototypeGet(elementScroll, el);
    return s === undefined ? null : s;
  }

  function elementScrollAt(el, axis) {
    var s = scrollOf(el);
    return s === null ? 0 : s[axis];
  }

  function isRoot(el) {
    return nParent(el) !== null && nNodeType(nParent(el)) === DOCUMENT_NODE;
  }

  function scrollElementTo(el, left, top) {
    if (isRoot(el)) {
      scrollViewportTo(left, top);
      return;
    }

    var b = boxOf(el);
    if (b === null || b[5] === 1 || !isScrollContainer(el)) return;
    var s = scrollOf(el);
    var cur = s === null ? [0, 0] : s;
    var nl = clamp(left, 0);
    var nt = clamp(top, MathMax(0, b[4] - b[3]));
    if (nl === cur[0] && nt === cur[1]) return;
    WeakMapPrototypeSet(elementScroll, el, [nl, nt]);
    queueScroll(el);
  }

  // A scroll operation's coordinate; null for a Symbol, which WebIDL's unrestricted double
  // would throw on and Chrome 158 answers by not scrolling at all (tests/dom/cases/
  // dom-layout.page). A non-finite value is 0.
  function coordinate(v) {
    return typeof v === 'symbol' ? null : NumberP(v);
  }

  // ScrollToOptions, as `scroll(options)` reads it: behavior, left, top in that order —
  // WebIDL's lexicographic member order. An unknown behavior is not refused (Chrome 158,
  // tests/dom/cases/dom-layout.page); every behavior scrolls at once. Absent members are
  // undefined.
  function readScrollOptions(options) {
    var out = { __proto__: null, left: undefined, top: undefined };
    if (options === undefined || options === null) return out;
    if (typeof options !== 'object' && typeof options !== 'function') return null;
    // Read for its side effects (a getter), then ignored.
    options.behavior; // eslint-disable-line no-unused-expressions
    var left = options.left;
    if (left !== undefined) out.left = coordinate(left);
    var top = options.top;
    if (top !== undefined) out.top = coordinate(top);
    return out.left === null || out.top === null ? null : out;
  }

  // The (x, y) a scroll/scrollTo/scrollBy call asks for, absolute; null for a call
  // that asks nothing (no arguments, or a lone primitive).
  function scrollTarget(args, relative, curX, curY, iface, op) {
    var x;
    var y;
    if (args.length >= 2) {
      x = coordinate(args[0]);
      y = coordinate(args[1]);
      if (x === null || y === null) return null;
    } else if (args.length === 1) {
      var o = readScrollOptions(args[0]);
      if (o === null) return null;
      x = o.left === undefined ? (relative ? 0 : curX) : o.left;
      y = o.top === undefined ? (relative ? 0 : curY) : o.top;
    } else {
      return null;
    }

    if (!NumberIsFinite(x)) x = 0;
    if (!NumberIsFinite(y)) y = 0;
    return relative ? [curX + x, curY + y] : [x, y];
  }

  function windowScroll(args, relative, op) {
    var t = scrollTarget(args, relative, scrollX, scrollY, 'Window', op);
    if (t !== null) scrollViewportTo(t[0], t[1]);
  }

  // --- DOMRectReadOnly / DOMRect / DOMRectList --------------------------------------

  var rectState;
  var setRect;
  var isMutableRect;

  function unrestricted(value, iface, op) {
    return value === undefined ? 0 : toNumber(value, iface, op);
  }

  // DOMRectInit, read in WebIDL's lexicographic order: height, width, x, y.
  function readRectInit(other, iface) {
    if (other === undefined || other === null) return [0, 0, 0, 0];
    if (typeof other !== 'object' && typeof other !== 'function') {
      throw typeError(iface, 'fromRect', "The provided value is not of type 'DOMRectInit'.");
    }

    var h = unrestricted(other.height, iface, 'fromRect');
    var w = unrestricted(other.width, iface, 'fromRect');
    var x = unrestricted(other.x, iface, 'fromRect');
    var y = unrestricted(other.y, iface, 'fromRect');
    return [x, y, w, h];
  }

  /**
   * DOMRectReadOnly: a rectangle, as getBoundingClientRect and the observer entries
   * answer it.
   * @param {number} [x]
   * @param {number} [y]
   * @param {number} [width]
   * @param {number} [height]
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): top/left are the minima,
   *   right/bottom the maxima, so a negative width flips them; NaN propagates.
   * @deviates none
   */
  class DOMRectReadOnly {
    #r;

    constructor() {
      var iface = new.target === DOMRect ? 'DOMRect' : 'DOMRectReadOnly';
      this.#r = [
        unrestricted(arguments[0], iface),
        unrestricted(arguments[1], iface),
        unrestricted(arguments[2], iface),
        unrestricted(arguments[3], iface),
      ];
    }

    static {
      rectState = function (o) {
        if (o === null || typeof o !== 'object' || !(#r in o)) throw illegalInvocation();
        return o.#r;
      };
      setRect = function (o, i, v) {
        o.#r[i] = v;
      };
    }

    static fromRect(other) {
      var r = readRectInit(other, 'DOMRectReadOnly');
      return new DOMRectReadOnly(r[0], r[1], r[2], r[3]);
    }

    get x() {
      return rectState(this)[0];
    }

    get y() {
      return rectState(this)[1];
    }

    get width() {
      return rectState(this)[2];
    }

    get height() {
      return rectState(this)[3];
    }

    get top() {
      var r = rectState(this);
      return MathMin(r[1], r[1] + r[3]);
    }

    get right() {
      var r = rectState(this);
      return MathMax(r[0], r[0] + r[2]);
    }

    get bottom() {
      var r = rectState(this);
      return MathMax(r[1], r[1] + r[3]);
    }

    get left() {
      var r = rectState(this);
      return MathMin(r[0], r[0] + r[2]);
    }

    toJSON() {
      var r = rectState(this);
      return {
        x: r[0],
        y: r[1],
        width: r[2],
        height: r[3],
        top: MathMin(r[1], r[1] + r[3]),
        right: MathMax(r[0], r[0] + r[2]),
        bottom: MathMax(r[1], r[1] + r[3]),
        left: MathMin(r[0], r[0] + r[2]),
      };
    }
  }

  class DOMRect extends DOMRectReadOnly {
    #mutable = true;

    static {
      isMutableRect = function (o) {
        if (o === null || typeof o !== 'object' || !(#mutable in o)) throw illegalInvocation();
      };
    }

    static fromRect(other) {
      var r = readRectInit(other, 'DOMRect');
      return new DOMRect(r[0], r[1], r[2], r[3]);
    }

    get x() {
      isMutableRect(this);
      return rectState(this)[0];
    }

    set x(v) {
      isMutableRect(this);
      setRect(this, 0, toNumber(v, 'DOMRect', 'x'));
    }

    get y() {
      isMutableRect(this);
      return rectState(this)[1];
    }

    set y(v) {
      isMutableRect(this);
      setRect(this, 1, toNumber(v, 'DOMRect', 'y'));
    }

    get width() {
      isMutableRect(this);
      return rectState(this)[2];
    }

    set width(v) {
      isMutableRect(this);
      setRect(this, 2, toNumber(v, 'DOMRect', 'width'));
    }

    get height() {
      isMutableRect(this);
      return rectState(this)[3];
    }

    set height(v) {
      isMutableRect(this);
      setRect(this, 3, toNumber(v, 'DOMRect', 'height'));
    }
  }

  var isRectList;

  /**
   * DOMRectList: getClientRects()'s answer, a fixed list with indexed properties.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page).
   * @deviates An inline box that wraps is one rect here, not one per line box.
   */
  class DOMRectList {
    #items;

    constructor(token, items) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#items = items;
      for (var i = 0; i < items.length; i++) {
        ObjectDefineProperty(this, i, {
          __proto__: null,
          value: items[i],
          writable: false,
          enumerable: true,
          configurable: true,
        });
      }
    }

    static {
      isRectList = function (o) {
        if (o === null || typeof o !== 'object' || !(#items in o)) throw illegalInvocation();
        return o.#items;
      };
    }

    get length() {
      return isRectList(this).length;
    }

    item(index) {
      var items = isRectList(this);
      if (arguments.length < 1) throw typeError('DOMRectList', 'item', argumentsRequired(1, 0));
      var i = toNumber(index, 'DOMRectList', 'item');
      i = NumberIsFinite(i) ? MathFloor(i) % 4294967296 : 0;
      if (i < 0) i += 4294967296;
      return i < items.length ? items[i] : null;
    }
  }

  var PublicDOMRectReadOnly = nativeShape.defineInterface({
    name: 'DOMRectReadOnly',
    impl: DOMRectReadOnly,
    length: 0,
    statics: ['fromRect:0'],
    members: [
      'x',
      'y',
      'width',
      'height',
      'top',
      'right',
      'bottom',
      'left',
      'toJSON:0',
      'constructor',
      '@@toStringTag',
    ],
  });
  nativeShape.defineInterface({
    name: 'DOMRect',
    impl: DOMRect,
    length: 0,
    parent: PublicDOMRectReadOnly,
    statics: ['fromRect:0'],
    members: ['x', 'y', 'width', 'height', 'constructor', '@@toStringTag'],
  });
  nativeShape.defineInterface({
    name: 'DOMRectList',
    impl: DOMRectList,
    length: 0,
    illegal: true,
    members: ['length', 'item:1', 'constructor', '@@toStringTag'],
  });
  // WebIDL's iterator for an interface with an indexed getter and a length: the
  // intrinsic %Array.prototype.values% itself, after @@toStringTag as in Blink.
  ObjectDefineProperty(DOMRectList.prototype, SymbolIterator, {
    __proto__: null,
    value: ArrayPrototypeValues,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  function newRect(x, y, w, h) {
    return new DOMRect(x, y, w, h);
  }

  function newRectReadOnly(x, y, w, h) {
    return new DOMRectReadOnly(x, y, w, h);
  }

  // The element's border box relative to the viewport: its estimated position less the
  // viewport's scroll and its scroll-container ancestors' scrollTop.
  function clientRect(el) {
    var b = boxOf(el);
    if (b === null) return null;
    var dx = scrollX;
    var dy = scrollY;
    for (var p = nParent(el); p !== null && nNodeType(p) === ELEMENT_NODE; p = nParent(p)) {
      var s = scrollOf(p);
      if (s !== null) {
        dx += s[0];
        dy += s[1];
      }
    }

    return [b[0] - dx, b[1] - dy, b[2], b[3], b[5]];
  }

  /**
   * The element's rect for an observer entry: [x, y, width, height, kind] relative to
   * the viewport (kind as `boxes` holds it), or null when the element has no box.
   */
  function rectOf(el) {
    return clientRect(el);
  }

  // --- Element / HTMLElement / Document members ------------------------------------

  function offsetParentOf(el) {
    if (boxOf(el) === null) return null;
    var name = nLocalName(el);
    if (name === 'body' || name === 'html') return null;
    for (var p = nParent(el); p !== null && nNodeType(p) === ELEMENT_NODE; p = nParent(p)) {
      var pn = nLocalName(p);
      if (pn === 'body') return p;
      var pos = inlineValue(p, 'position');
      if (pos !== '' && pos !== 'static') return p;
      if (pn === 'td' || pn === 'th' || pn === 'table') return p;
    }

    return null;
  }

  function round(v) {
    return MathFloor(v + 0.5);
  }

  /**
   * Element's geometry and scrolling members (CSSOM View), defined on `proto` (the
   * Element implementation's prototype) before internal/dom lays the interface out.
   * @returns {string[]} The member entries, in Blink's relative order.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): every member exists on
   *   Element.prototype with these lengths; detached and display:none elements read 0;
   *   documentElement.scrollTop is the viewport's scrollY; scroll() on an element that
   *   is not a scroll container changes nothing.
   * @deviates The values are the estimate's (file comment), not Chrome's pixels.
   */
  function elementMembers(proto) {
    var members = {
      get scrollTop() {
        checkElement(this);
        if (isRoot(this)) return scrollY;
        var s = scrollOf(this);
        return s === null ? 0 : s[1];
      },
      set scrollTop(v) {
        checkElement(this);
        var top = toNumber(v, 'Element', 'scrollTop');
        if (isRoot(this)) scrollViewportTo(scrollX, top);
        else scrollElementTo(this, elementScrollAt(this, 0), top);
      },
      get scrollLeft() {
        checkElement(this);
        if (isRoot(this)) return scrollX;
        var s = scrollOf(this);
        return s === null ? 0 : s[0];
      },
      set scrollLeft(v) {
        checkElement(this);
        var left = toNumber(v, 'Element', 'scrollLeft');
        if (isRoot(this)) scrollViewportTo(left, scrollY);
        else scrollElementTo(this, left, elementScrollAt(this, 1));
      },
      get scrollWidth() {
        checkElement(this);
        if (isRoot(this)) return MathMax(docWidth, viewport.width);
        var b = boxOf(this);
        return b === null || b[5] === 1 ? 0 : round(b[2]);
      },
      get scrollHeight() {
        checkElement(this);
        if (isRoot(this)) return documentScrollHeight();
        var b = boxOf(this);
        return b === null || b[5] === 1 ? 0 : round(b[4]);
      },
      get clientTop() {
        checkElement(this);
        return 0;
      },
      get clientLeft() {
        checkElement(this);
        return 0;
      },
      get clientWidth() {
        checkElement(this);
        if (isRoot(this)) return viewport.width;
        var b = boxOf(this);
        return b === null || b[5] === 1 ? 0 : round(b[2]);
      },
      get clientHeight() {
        checkElement(this);
        if (isRoot(this)) return viewport.height;
        var b = boxOf(this);
        return b === null || b[5] === 1 ? 0 : round(b[3]);
      },
      getBoundingClientRect() {
        checkElement(this);
        var r = clientRect(this);
        return r === null ? newRect(0, 0, 0, 0) : newRect(r[0], r[1], r[2], r[3]);
      },
      getClientRects() {
        checkElement(this);
        var r = clientRect(this);
        var items = r === null ? [] : [newRect(r[0], r[1], r[2], r[3])];
        return new DOMRectList(INTERNAL, items);
      },
      scroll() {
        checkElement(this);
        elementScrollCall(this, arguments, false, 'scroll');
      },
      scrollBy() {
        checkElement(this);
        elementScrollCall(this, arguments, true, 'scrollBy');
      },
      scrollIntoView(arg) {
        checkElement(this);
        var block = 'start';
        if (arg === false) {
          block = 'end';
        } else if (arg !== undefined && arg !== null && typeof arg === 'object') {
          // Read in WebIDL's order; an unknown value is not refused (Chrome 158,
          // tests/dom/cases/dom-layout.page) and aligns to the start.
          arg.behavior; // eslint-disable-line no-unused-expressions
          var b = arg.block;
          if (typeof b === 'string' && LOGICAL[b] === 1) block = b;
        }

        scrollIntoView(this, block);
      },
      scrollIntoViewIfNeeded() {
        checkElement(this);
        var r = clientRect(this);
        if (r === null || (r[1] >= 0 && r[1] + r[3] <= viewport.height)) return;
        scrollIntoView(this, 'center');
      },
      scrollTo() {
        checkElement(this);
        elementScrollCall(this, arguments, false, 'scrollTo');
      },
    };
    copyMembers(proto, members);
    return [
      'scrollTop',
      'scrollLeft',
      'scrollWidth',
      'scrollHeight',
      'clientTop',
      'clientLeft',
      'clientWidth',
      'clientHeight',
      'getBoundingClientRect:0',
      'getClientRects:0',
      'scroll:0',
      'scrollBy:0',
      'scrollIntoView:0',
      'scrollIntoViewIfNeeded:0',
      'scrollTo:0',
    ];
  }

  var LOGICAL = { __proto__: null, start: 1, center: 1, end: 1, nearest: 1 };

  function elementScrollCall(el, args, relative, op) {
    var cur = isRoot(el) ? [scrollX, scrollY] : scrollOf(el);
    if (cur === null) cur = [0, 0];
    var t = scrollTarget(args, relative, cur[0], cur[1], 'Element', op);
    if (t !== null) scrollElementTo(el, t[0], t[1]);
  }

  function scrollIntoView(el, block) {
    var b = boxOf(el);
    if (b === null) return;
    var top = b[1];
    if (block === 'end') top = b[1] + b[3] - viewport.height;
    else if (block === 'center') top = b[1] + b[3] / 2 - viewport.height / 2;
    else if (block === 'nearest') {
      if (b[1] >= scrollY && b[1] + b[3] <= scrollY + viewport.height) return;
      if (b[1] > scrollY) top = b[1] + b[3] - viewport.height;
    }

    scrollViewportTo(scrollX, top);
  }

  function copyMembers(proto, members) {
    var keys = ReflectOwnKeys(members);
    for (var i = 0; i < keys.length; i++) {
      var d = ObjectGetOwnPropertyDescriptor(members, keys[i]);
      d.enumerable = false;
      ObjectDefineProperty(proto, keys[i], d);
    }
  }

  var styles = new WeakMapP();

  /**
   * HTMLElement's geometry members and `style`, defined on `proto` before internal/dom
   * lays the interface out.
   * @returns {string[]} The member entries, in Blink's relative order.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): offsetParent is the nearest
   *   positioned ancestor or body, null for body and for an element with no box;
   *   `style` is one CSSStyleDeclaration per element, [PutForwards=cssText].
   * @deviates The values are the estimate's (file comment).
   */
  function htmlElementMembers(proto) {
    var members = {
      get offsetParent() {
        checkElement(this);
        return offsetParentOf(this);
      },
      get offsetTop() {
        checkElement(this);
        return offsetPosition(this, 1);
      },
      get offsetLeft() {
        checkElement(this);
        return offsetPosition(this, 0);
      },
      get offsetWidth() {
        checkElement(this);
        var b = boxOf(this);
        return b === null ? 0 : round(b[2]);
      },
      get offsetHeight() {
        checkElement(this);
        var b = boxOf(this);
        return b === null ? 0 : round(b[3]);
      },
      get style() {
        checkElement(this);
        return inlineStyle(this);
      },
      set style(v) {
        checkElement(this);
        setCssText(this, toDOMString(v, 'HTMLElement', 'style'));
      },
    };
    copyMembers(proto, members);
    return ['offsetParent', 'offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'style'];
  }

  function offsetPosition(el, axis) {
    var b = boxOf(el);
    if (b === null) return 0;
    var p = offsetParentOf(el);
    if (p === null) return round(b[axis]);
    var pb = boxOf(p);
    return round(b[axis] - (pb === null || nLocalName(p) === 'body' ? 0 : pb[axis]));
  }

  /**
   * Document's `scrollingElement`: the root element (a standards-mode document's).
   * @returns {string[]}
   * @node Chrome 158 (tests/dom/cases/dom-layout.page).
   * @deviates A quirks-mode document answers the root too, where Chrome answers body.
   */
  function documentMembers(proto) {
    copyMembers(proto, {
      get scrollingElement() {
        if (!isDocumentNode(this)) throw illegalInvocation();
        return firstElementChild(this);
      },
    });
    return ['scrollingElement'];
  }

  // --- CSSStyleDeclaration ------------------------------------------------------------

  // The CSS properties a declaration answers as named properties (`style.display`,
  // `style['background-color']`), in kebab case: the common ones, not Chrome's full
  // list. A name outside it is an ordinary expando.
  var PROPERTY_LIST =
    'align-content align-items align-self animation animation-delay animation-direction ' +
    'animation-duration animation-name appearance aspect-ratio backface-visibility background ' +
    'background-attachment background-clip background-color background-image background-origin ' +
    'background-position background-repeat background-size border border-bottom border-bottom-color ' +
    'border-bottom-left-radius border-bottom-right-radius border-bottom-style border-bottom-width ' +
    'border-collapse border-color border-left border-left-color border-left-style border-left-width ' +
    'border-radius border-right border-right-color border-right-style border-right-width border-spacing ' +
    'border-style border-top border-top-color border-top-left-radius border-top-right-radius ' +
    'border-top-style border-top-width border-width bottom box-shadow box-sizing caret-color clear clip ' +
    'clip-path color column-gap columns content content-visibility cursor direction display fill filter ' +
    'flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float font font-family ' +
    'font-size font-style font-variant font-weight gap grid grid-area grid-column grid-row ' +
    'grid-template-areas grid-template-columns grid-template-rows height inset justify-content ' +
    'justify-items justify-self left letter-spacing line-height list-style list-style-type margin ' +
    'margin-bottom margin-left margin-right margin-top mask max-height max-width min-height min-width ' +
    'mix-blend-mode object-fit object-position opacity order outline outline-color outline-offset ' +
    'outline-style outline-width overflow overflow-wrap overflow-x overflow-y padding padding-bottom ' +
    'padding-left padding-right padding-top perspective place-content place-items pointer-events ' +
    'position resize right rotate row-gap scale scroll-behavior stroke stroke-width tab-size ' +
    'table-layout text-align text-decoration text-indent text-overflow text-shadow text-transform top ' +
    'touch-action transform transform-origin transition transition-delay transition-duration ' +
    'transition-property transition-timing-function translate user-select vertical-align visibility ' +
    'white-space width will-change word-break word-spacing word-wrap writing-mode z-index zoom';
  var PROPERTIES = { __proto__: null };
  var PROPERTY_NAMES = [];
  (function () {
    var start = 0;
    for (var i = 0; i <= PROPERTY_LIST.length; i++) {
      if (i === PROPERTY_LIST.length || StringPrototypeCharCodeAt(PROPERTY_LIST, i) === 32) {
        var name = StringPrototypeSlice(PROPERTY_LIST, start, i);
        PROPERTIES[name] = 1;
        PROPERTY_NAMES[PROPERTY_NAMES.length] = name;
        start = i + 1;
      }
    }
  })();

  // What getComputedStyle answers for a property no inline style sets: the initial
  // values pages test against.
  var COMPUTED_DEFAULTS = {
    __proto__: null,
    opacity: '1',
    position: 'static',
    float: 'none',
    overflow: 'visible',
    'overflow-x': 'visible',
    'overflow-y': 'visible',
    'z-index': 'auto',
    'pointer-events': 'auto',
    'content-visibility': 'visible',
    color: 'rgb(0, 0, 0)',
    'background-color': 'rgba(0, 0, 0, 0)',
    'background-image': 'none',
    'font-size': '16px',
    transform: 'none',
    top: 'auto',
    left: 'auto',
    right: 'auto',
    bottom: 'auto',
    'margin-top': '0px',
    'margin-right': '0px',
    'margin-bottom': '0px',
    'margin-left': '0px',
    'padding-top': '0px',
    'padding-right': '0px',
    'padding-bottom': '0px',
    'padding-left': '0px',
    'box-sizing': 'content-box',
    cursor: 'auto',
    clip: 'auto',
    'max-height': 'none',
    'max-width': 'none',
    filter: 'none',
  };

  // A named property's CSS name: `backgroundColor` -> `background-color`, `cssFloat` ->
  // `float`, `webkitTransform` -> `-webkit-transform`; a kebab name answers itself. null
  // for a key that is not a known property.
  function cssName(key) {
    if (typeof key !== 'string' || key === '') return null;
    if (PROPERTIES[key] === 1) return key;
    var out = '';
    var start = 0;
    if (
      StringPrototypeSlice(key, 0, 6) === 'webkit' ||
      StringPrototypeSlice(key, 0, 6) === 'Webkit'
    ) {
      out = '-webkit-';
      start = 6;
    }

    for (var i = start; i < key.length; i++) {
      var c = StringPrototypeCharCodeAt(key, i);
      if (c >= 65 && c <= 90) {
        if (i !== start) out += '-';
        out += lower(StringPrototypeSlice(key, i, i + 1));
      } else if (c === 45) {
        return null;
      } else {
        out += StringPrototypeSlice(key, i, i + 1);
      }
    }

    if (start !== 0) return PROPERTIES[StringPrototypeSlice(out, 8, out.length)] === 1 ? out : null;
    return PROPERTIES[out] === 1 ? out : null;
  }

  // Proxy -> { el, computed }: the brand every member checks (a private field is
  // never found through a Proxy).
  var declarations = new WeakMapP();

  function declOf(o) {
    var s = WeakMapPrototypeGet(declarations, o);
    if (s === undefined) throw illegalInvocation();
    return s;
  }

  function readOnly(prefix, what) {
    return pageError(
      new DOMException(
        prefix + 'These styles are computed, and therefore ' + what,
        'NoModificationAllowedError',
      ),
    );
  }

  function readOnlyProperty(op, name) {
    return readOnly(
      context('CSSStyleDeclaration', op),
      "the '" + name + "' property is read-only.",
    );
  }

  function getValue(s, name) {
    if (!s.computed) {
      var decls = inlineDecls(s.el);
      var at = findDecl(decls, name);
      return at === -1 ? '' : decls[at][1];
    }

    return computedValue(s.el, name);
  }

  function computedValue(el, name) {
    if (name === 'display') return computedDisplay(el);
    if (name === 'visibility') return computedVisibility(el);
    if (name === 'width' || name === 'height') {
      var b = boxOf(el);
      if (b === null || b[5] === 1) return 'auto';
      return b[name === 'width' ? 2 : 3] + 'px';
    }

    var v = inlineValue(el, name);
    if (v !== '') return v;
    var d = COMPUTED_DEFAULTS[name];
    return d === undefined ? '' : d;
  }

  function setValue(s, name, value, important) {
    var decls = ArrayPrototypeSliceAll(inlineDecls(s.el));
    var at = findDecl(decls, name);
    if (value === '') {
      if (at === -1) return;
      ArrayPrototypeSplice(decls, at, 1);
    } else if (at === -1) {
      decls[decls.length] = [name, value, important];
    } else {
      decls[at] = [name, value, important];
    }

    nSetAttribute(s.el, 'style', serializeDecls(decls));
  }

  function ArrayPrototypeSliceAll(a) {
    return ArrayPrototypeSlice(a, 0);
  }

  function setCssText(el, text) {
    var decls = parseDeclarations(text);
    nSetAttribute(el, 'style', serializeDecls(decls));
  }

  function propertyName(property, op) {
    var name = trim(toDOMString(property, 'CSSStyleDeclaration', op));
    return isCustom(name) ? name : lower(name);
  }

  var CSSStyleDeclarationProto;

  /**
   * CSSStyleDeclaration: an element's inline style (`element.style`, backed by its
   * `style` attribute) or its computed style (getComputedStyle).
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): serialization is
   *   `name: value;` joined by a space; a computed declaration refuses every write
   *   with NoModificationAllowedError.
   * @deviates Shorthands are not expanded and unknown properties are kept; named
   *   properties are a Proxy over a fixed list of common properties (PROPERTY_LIST), not
   *   every property Chrome knows; a computed value is the inline value, the UA
   *   default `display`, the estimate's width/height or a fixed initial value — no page
   *   stylesheet is applied.
   */
  class CSSStyleDeclaration {
    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
    }

    get cssText() {
      var s = declOf(this);
      return s.computed ? '' : serializeDecls(inlineDecls(s.el));
    }

    set cssText(v) {
      var s = declOf(this);
      if (s.computed) {
        throw readOnly(
          "Failed to set the 'cssText' property on 'CSSStyleDeclaration': ",
          'read-only.',
        );
      }

      setCssText(s.el, toDOMString(v, 'CSSStyleDeclaration', 'cssText'));
    }

    get length() {
      var s = declOf(this);
      return s.computed ? PROPERTY_NAMES.length : inlineDecls(s.el).length;
    }

    get parentRule() {
      declOf(this);
      return null;
    }

    get cssFloat() {
      return getValue(declOf(this), 'float');
    }

    set cssFloat(v) {
      var s = declOf(this);
      if (s.computed) throw readOnlyProperty('cssFloat', 'float');
      setValue(s, 'float', trim(toDOMString(v, 'CSSStyleDeclaration', 'cssFloat')), false);
    }

    getPropertyPriority(property) {
      var s = declOf(this);
      if (arguments.length < 1) {
        throw typeError('CSSStyleDeclaration', 'getPropertyPriority', argumentsRequired(1, 0));
      }

      var name = propertyName(property, 'getPropertyPriority');
      if (s.computed) return '';
      var decls = inlineDecls(s.el);
      var at = findDecl(decls, name);
      return at !== -1 && decls[at][2] ? 'important' : '';
    }

    getPropertyValue(property) {
      var s = declOf(this);
      if (arguments.length < 1) {
        throw typeError('CSSStyleDeclaration', 'getPropertyValue', argumentsRequired(1, 0));
      }

      return getValue(s, propertyName(property, 'getPropertyValue'));
    }

    item(index) {
      var s = declOf(this);
      if (arguments.length < 1)
        throw typeError('CSSStyleDeclaration', 'item', argumentsRequired(1, 0));
      var i = toNumber(index, 'CSSStyleDeclaration', 'item');
      i = NumberIsFinite(i) ? MathFloor(i) : 0;
      if (s.computed) return i >= 0 && i < PROPERTY_NAMES.length ? PROPERTY_NAMES[i] : '';
      var decls = inlineDecls(s.el);
      return i >= 0 && i < decls.length ? decls[i][0] : '';
    }

    removeProperty(property) {
      var s = declOf(this);
      if (arguments.length < 1) {
        throw typeError('CSSStyleDeclaration', 'removeProperty', argumentsRequired(1, 0));
      }

      var name = propertyName(property, 'removeProperty');
      if (s.computed) throw readOnlyProperty('removeProperty', name);
      var old = getValue(s, name);
      setValue(s, name, '', false);
      return old;
    }

    setProperty(property, value, priority) {
      var s = declOf(this);
      if (arguments.length < 2) {
        throw typeError(
          'CSSStyleDeclaration',
          'setProperty',
          argumentsRequired(2, arguments.length),
        );
      }

      var name = propertyName(property, 'setProperty');
      // [LegacyNullToEmptyString] value.
      var v = value === null ? '' : trim(toDOMString(value, 'CSSStyleDeclaration', 'setProperty'));
      var p =
        priority === undefined ? '' : toDOMString(priority, 'CSSStyleDeclaration', 'setProperty');
      if (s.computed) throw readOnlyProperty('setProperty', name);
      var important = lower(p) === 'important';
      if (!important && p !== '') return;
      setValue(s, name, v, important);
    }
  }

  CSSStyleDeclarationProto = CSSStyleDeclaration.prototype;
  nativeShape.defineInterface({
    name: 'CSSStyleDeclaration',
    impl: CSSStyleDeclaration,
    length: 0,
    illegal: true,
    members: [
      'cssText',
      'length',
      'parentRule',
      'cssFloat',
      'getPropertyPriority:1',
      'getPropertyValue:1',
      'item:1',
      'removeProperty:1',
      'setProperty:2',
      'constructor',
      '@@toStringTag',
    ],
  });
  ObjectDefineProperty(CSSStyleDeclarationProto, SymbolIterator, {
    __proto__: null,
    value: ArrayPrototypeValues,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // An array index key (`style[0]`): the declaration's item.
  function indexOf(key) {
    if (typeof key !== 'string' || key === '') return -1;
    var n = 0;
    for (var i = 0; i < key.length; i++) {
      var c = StringPrototypeCharCodeAt(key, i);
      if (c < 48 || c > 57 || (i === 0 && c === 48 && key.length > 1)) return -1;
      n = n * 10 + (c - 48);
    }

    return n;
  }

  var STYLE_HANDLER = {
    __proto__: null,
    get: function (target, key, receiver) {
      var s = WeakMapPrototypeGet(declarations, receiver);
      if (s !== undefined && typeof key === 'string') {
        var name = cssName(key);
        if (name !== null && !ReflectHas(CSSStyleDeclarationProto, key)) return getValue(s, name);
        var i = indexOf(key);
        if (i !== -1) {
          if (s.computed) return i < PROPERTY_NAMES.length ? PROPERTY_NAMES[i] : undefined;
          var decls = inlineDecls(s.el);
          return i < decls.length ? decls[i][0] : undefined;
        }
      }

      return ReflectGet(target, key, receiver);
    },
    set: function (target, key, value, receiver) {
      var s = WeakMapPrototypeGet(declarations, receiver);
      if (s !== undefined && typeof key === 'string') {
        var name = cssName(key);
        if (name !== null && !ReflectHas(CSSStyleDeclarationProto, key)) {
          if (s.computed) {
            throw readOnly(
              "Failed to set a named property '" + key + "' on 'CSSStyleDeclaration': ",
              "the '" + name + "' property is read-only.",
            );
          }

          // [LegacyNullToEmptyString]
          var v = value === null ? '' : trim(toDOMString(value, 'CSSStyleDeclaration', key));
          setValue(s, name, v, false);
          return true;
        }
      }

      return ReflectSet(target, key, value, receiver);
    },
    has: function (target, key) {
      if (typeof key === 'string' && cssName(key) !== null) return true;
      return ReflectHas(target, key);
    },
  };

  function newDeclaration(el, computed) {
    var proxy = new ProxyP(ObjectCreate(CSSStyleDeclarationProto), STYLE_HANDLER);
    WeakMapPrototypeSet(declarations, proxy, { __proto__: null, el: el, computed: computed });
    return proxy;
  }

  function inlineStyle(el) {
    var s = WeakMapPrototypeGet(styles, el);
    if (s === undefined) {
      s = newDeclaration(el, false);
      WeakMapPrototypeSet(styles, el, s);
    }

    return s;
  }

  /**
   * window.getComputedStyle(elt, pseudoElt): a read-only CSSStyleDeclaration over the
   * element's estimated computed style.
   * @param {Element} elt
   * @param {?string} [pseudoElt]
   * @returns {CSSStyleDeclaration}
   * @throws {TypeError} `Failed to execute 'getComputedStyle' on 'Window': parameter 1
   *   is not of type 'Element'.`
   * @node Chrome 158 (tests/dom/cases/dom-layout.page).
   * @deviates The values: see CSSStyleDeclaration. pseudoElt is converted and ignored.
   */
  function getComputedStyle(elt, pseudoElt) {
    if (arguments.length < 1) {
      throw typeError('Window', 'getComputedStyle', argumentsRequired(1, 0));
    }

    if (!isElement(elt)) throw typeError('Window', 'getComputedStyle', notOfType(1, 'Element'));
    if (pseudoElt !== undefined && pseudoElt !== null)
      toDOMString(pseudoElt, 'Window', 'getComputedStyle');
    return newDeclaration(elt, true);
  }

  nativeShape.defineOperation('getComputedStyle', getComputedStyle, 1);

  /**
   * window.scroll / scrollTo / scrollBy: `(x, y)` or `(ScrollToOptions)`.
   * @node Chrome 158 (tests/dom/cases/dom-layout.page): the offset is clamped to the
   *   document; a lone primitive argument is accepted and changes nothing; the
   *   viewport's `scroll` event is fired at the document and bubbles.
   * @deviates The bound is the estimated document height; the event is a task, not a
   *   rendering-step event, and `behavior: 'smooth'` scrolls at once.
   */
  nativeShape.defineOperation(
    'scroll',
    function scroll() {
      windowScroll(arguments, false, 'scroll');
    },
    0,
  );
  nativeShape.defineOperation(
    'scrollTo',
    function scrollTo() {
      windowScroll(arguments, false, 'scrollTo');
    },
    0,
  );
  nativeShape.defineOperation(
    'scrollBy',
    function scrollBy() {
      windowScroll(arguments, true, 'scrollBy');
    },
    0,
  );

  /**
   * Binds internal/dom's natives: from here on elements have boxes.
   * @param {Object} native The DOM natives, `setAttribute` the observed one.
   */
  function attach(native) {
    nIsNode = native.isNode;
    nNodeType = native.nodeType;
    nLocalName = native.localName;
    nParent = native.parent;
    nFirstChild = native.firstChild;
    nNextSibling = native.nextSibling;
    nData = native.data;
    nGetAttribute = native.getAttribute;
    nSetAttribute = native.setAttribute;
    nDocument = native.document;
    attached = true;
    boxes = null;
  }

  /**
   * The profile's viewport (internal/navigator's natives).
   * @param {Object} native
   */
  function setViewport(native) {
    viewport.width = native.innerWidth;
    viewport.height = native.innerHeight;
    viewport.screenWidth = native.screenWidth;
    viewport.screenHeight = native.screenHeight;
    viewport.dpr = native.devicePixelRatio;
  }

  module.exports = ObjectFreeze({
    __proto__: null,
    attach: attach,
    setViewport: setViewport,
    viewport: viewport,
    dirtying: dirtying,
    elementMembers: elementMembers,
    htmlElementMembers: htmlElementMembers,
    documentMembers: documentMembers,
    isElement: isElement,
    isDocument: isDocumentNode,
    rectOf: rectOf,
    newRectReadOnly: newRectReadOnly,
    generation: function () {
      return generation;
    },
    // Callbacks run after every tree mutation and after every batch of scroll events:
    // what the observers re-evaluate on.
    onInvalidate: function (fn) {
      invalidated[invalidated.length] = fn;
    },
    onScroll: function (fn) {
      scrolled[scrolled.length] = fn;
    },
    scrollX: function () {
      return scrollX;
    },
    scrollY: function () {
      return scrollY;
    },
  });
});
