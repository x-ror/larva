/**
 * @fileoverview XPath 1.0 for pages (issue #11): `document.evaluate`,
 * `document.createExpression`, `document.createNSResolver`, and the XPathResult,
 * XPathExpression, XPathEvaluator and Attr interfaces. The actions DSL (#15) locates
 * elements through it.
 *
 * Reuse verdict (CLAUDE.md §2): lexbor, the tree's owner, ships no XPath module (the
 * vendored build at .deps/lexbor/include/lexbor has html, dom, css, selectors, style,
 * url, encoding, ns, tag, unicode, punycode, engine, core, utils — no xpath), the Odin
 * SDK has none, and no linked C library has one over lexbor nodes. So the engine is
 * here, hand-rolled over internal/dom's natives: a tokenizer with XPath 1.0's lexical
 * disambiguation rules (§3.7), a recursive-descent parser that rejects unknown
 * functions and wrong arities up front as Blink does, and an evaluator over the 13 axes.
 * JS rather than Odin because a result must hand the page the same wrappers and Attr
 * objects the DOM does, and the predicates call back into the expression language.
 *
 * Where Blink departs from the XPath 1.0 text, this follows Blink, because Chrome's
 * recording is the oracle (tests/dom/cases/xpath-{axes,functions,result}.page):
 *  - an unprefixed name test matches an HTML element ignoring ASCII case, and a
 *    non-HTML element (SVG, MathML) only in no namespace — so never, in an HTML page;
 *    an unprefixed attribute test ignores case on an HTML element only;
 *  - a number prints to 6 significant digits (WTF::String::Number): `0.1 + 0.2` is
 *    "0.3", 1e20 is "1e+20" shaped, `1.00000e-7` keeps its zeros;
 *  - lang() reads only `xml:lang`, so an HTML `lang` attribute never matches;
 *  - `$x` evaluates to "" (no variable bindings exist), and a value that must be a
 *    node-set but is not throws "Type conversion failed" as a SyntaxError.
 *
 * Every node-set is kept in document order without duplicates, the unordered result
 * types included (the spec lets those be in any order; Chrome's is document order for
 * every recorded case).
 *
 * @module lava/internal/xpath
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var nativeShape = require('internal/native_shape');
  var DOMException = require('internal/domexception').DOMException;
  var ArrayIsArray = P.ArrayIsArray;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var MathFloor = P.MathFloor;
  var NumberP = P.Number;
  var NumberPrototypeToPrecision = P.NumberPrototypeToPrecision;
  var ObjectFreeze = P.ObjectFreeze;
  var ObjectSetPrototypeOf = P.ObjectSetPrototypeOf;
  var ReflectApply = P.ReflectApply;
  var ReflectGet = P.ReflectGet;
  var StringP = P.String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeStartsWith = P.StringPrototypeStartsWith;
  var TypeErrorP = P.TypeError;
  var WeakMapP = P.WeakMap;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var argumentsRequired = webErrors.argumentsRequired;
  var attributeContext = webErrors.attributeContext;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var toNumberArg = webErrors.toNumber;
  var typeError = webErrors.typeError;

  // html.Namespace's ordinals (pkg/html/node.odin), as the namespace and attributes
  // natives report them, and the URI of each.
  var NS_NONE = 0;
  var NS_HTML = 1;
  var NS_XML = 5;
  var NS_XMLNS = 6;
  var NS_URIS = [
    '',
    'http://www.w3.org/1999/xhtml',
    'http://www.w3.org/1998/Math/MathML',
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/XML/1998/namespace',
    'http://www.w3.org/2000/xmlns/',
    '',
  ];

  var RESULT_TYPES = {
    __proto__: null,
    ANY_TYPE: 0,
    NUMBER_TYPE: 1,
    STRING_TYPE: 2,
    BOOLEAN_TYPE: 3,
    UNORDERED_NODE_ITERATOR_TYPE: 4,
    ORDERED_NODE_ITERATOR_TYPE: 5,
    UNORDERED_NODE_SNAPSHOT_TYPE: 6,
    ORDERED_NODE_SNAPSHOT_TYPE: 7,
    ANY_UNORDERED_NODE_TYPE: 8,
    FIRST_ORDERED_NODE_TYPE: 9,
  };
  var RESULT_TYPE_NAMES = [
    'ANY_TYPE',
    'NUMBER_TYPE',
    'STRING_TYPE',
    'BOOLEAN_TYPE',
    'UNORDERED_NODE_ITERATOR_TYPE',
    'ORDERED_NODE_ITERATOR_TYPE',
    'UNORDERED_NODE_SNAPSHOT_TYPE',
    'ORDERED_NODE_SNAPSHOT_TYPE',
    'ANY_UNORDERED_NODE_TYPE',
    'FIRST_ORDERED_NODE_TYPE',
  ];

  // Token kinds.
  var T_END = 0;
  var T_LPAREN = 1;
  var T_RPAREN = 2;
  var T_LBRACK = 3;
  var T_RBRACK = 4;
  var T_DOT = 5;
  var T_DOTDOT = 6;
  var T_AT = 7;
  var T_COMMA = 8;
  var T_AXIS = 9;
  var T_NAME = 10;
  var T_NODETYPE = 11;
  var T_FUNC = 12;
  var T_LITERAL = 13;
  var T_NUMBER = 14;
  var T_OP = 15;
  var T_VAR = 16;

  // Axes; the reverse ones are the first four.
  var AX_ANCESTOR = 0;
  var AX_ANCESTOR_OR_SELF = 1;
  var AX_PRECEDING = 2;
  var AX_PRECEDING_SIBLING = 3;
  var AX_PARENT = 4;
  var AX_ATTRIBUTE = 5;
  var AX_CHILD = 6;
  var AX_DESCENDANT = 7;
  var AX_DESCENDANT_OR_SELF = 8;
  var AX_FOLLOWING = 9;
  var AX_FOLLOWING_SIBLING = 10;
  var AX_NAMESPACE = 11;
  var AX_SELF = 12;
  var AXES = {
    __proto__: null,
    ancestor: AX_ANCESTOR,
    'ancestor-or-self': AX_ANCESTOR_OR_SELF,
    attribute: AX_ATTRIBUTE,
    child: AX_CHILD,
    descendant: AX_DESCENDANT,
    'descendant-or-self': AX_DESCENDANT_OR_SELF,
    following: AX_FOLLOWING,
    'following-sibling': AX_FOLLOWING_SIBLING,
    namespace: AX_NAMESPACE,
    parent: AX_PARENT,
    preceding: AX_PRECEDING,
    'preceding-sibling': AX_PRECEDING_SIBLING,
    self: AX_SELF,
  };

  // Node tests.
  var TEST_NAME = 0;
  var TEST_NODE = 1;
  var TEST_TEXT = 2;
  var TEST_COMMENT = 3;
  var TEST_PI = 4;
  var NODE_TYPES = {
    __proto__: null,
    node: TEST_NODE,
    text: TEST_TEXT,
    comment: TEST_COMMENT,
    'processing-instruction': TEST_PI,
  };

  // Expression kinds.
  var K_NUM = 0;
  var K_STR = 1;
  var K_VAR = 2;
  var K_OR = 3;
  var K_AND = 4;
  var K_CMP = 5;
  var K_ARITH = 6;
  var K_NEG = 7;
  var K_UNION = 8;
  var K_FN = 9;
  var K_FILTER = 10;
  var K_PATH = 11;

  // The core function library: name -> [min, max] argument count (-1: unbounded).
  // Blink checks both while parsing, so `nonexistent()` and `count()` are syntax
  // errors even where evaluation would never reach them.
  var FUNCTIONS = {
    __proto__: null,
    last: [0, 0],
    position: [0, 0],
    count: [1, 1],
    id: [1, 1],
    'local-name': [0, 1],
    'namespace-uri': [0, 1],
    name: [0, 1],
    string: [0, 1],
    concat: [2, -1],
    'starts-with': [2, 2],
    contains: [2, 2],
    'substring-before': [2, 2],
    'substring-after': [2, 2],
    substring: [2, 3],
    'string-length': [0, 1],
    'normalize-space': [0, 1],
    translate: [3, 3],
    boolean: [1, 1],
    not: [1, 1],
    true: [0, 0],
    false: [0, 0],
    lang: [1, 1],
    number: [0, 1],
    sum: [1, 1],
    floor: [1, 1],
    ceiling: [1, 1],
    round: [1, 1],
  };

  // What the parser and evaluator throw; evaluate() turns each into Chrome's error.
  var SYNTAX = { __proto__: null };
  var NAMESPACE = { __proto__: null };
  var CONVERSION = { __proto__: null };

  // The natives (pkg/runtime/dom.odin through internal/dom), bound by install.
  var nIsNode = null;
  var nDocument = null;
  var nNodeType = null;
  var nNodeName = null;
  var nLocalName = null;
  var nNamespace = null;
  var nAttributes = null;
  var nParent = null;
  var nFirstChild = null;
  var nLastChild = null;
  var nNextSibling = null;
  var nPreviousSibling = null;
  var nData = null;
  var nTextContent = null;
  var nGetAttribute = null;
  var nSetAttribute = null;
  var nById = null;
  var nVersion = null;

  // --- Lexer -------------------------------------------------------------------

  function token(k, v, prefix) {
    return { __proto__: null, k: k, v: v, prefix: prefix };
  }

  function isSpace(c) {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  }

  function isDigit(c) {
    return c >= 0x30 && c <= 0x39;
  }

  // XML's NameStartChar, with every non-ASCII code unit let in: the ranges it leaves
  // out are punctuation no page writes in a name.
  function isNameStart(c) {
    return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 0x80;
  }

  function isNameChar(c) {
    return isNameStart(c) || isDigit(c) || c === 0x2d || c === 0x2e;
  }

  function skipSpace(s, i) {
    while (i < s.length && isSpace(StringPrototypeCharCodeAt(s, i))) i++;
    return i;
  }

  function nameEnd(s, i) {
    while (i < s.length && isNameChar(StringPrototypeCharCodeAt(s, i))) i++;
    return i;
  }

  // XPath 1.0 §3.7: after a token that can end an operand, `*` multiplies and a name
  // is an operator name; a name followed by `(` is a function or node type, by `::`
  // an axis.
  function tokenize(s) {
    var toks = [];
    var n = 0;
    var i = 0;
    var len = s.length;
    for (;;) {
      i = skipSpace(s, i);
      if (i >= len) break;
      var c = StringPrototypeCharCodeAt(s, i);
      var prev = n === 0 ? null : toks[n - 1].k;
      var operand =
        prev !== null &&
        prev !== T_AT &&
        prev !== T_AXIS &&
        prev !== T_LPAREN &&
        prev !== T_LBRACK &&
        prev !== T_COMMA &&
        prev !== T_OP;
      var next = i + 1 < len ? StringPrototypeCharCodeAt(s, i + 1) : -1;
      if (c === 0x28) {
        toks[n++] = token(T_LPAREN, null, null);
        i++;
      } else if (c === 0x29) {
        toks[n++] = token(T_RPAREN, null, null);
        i++;
      } else if (c === 0x5b) {
        toks[n++] = token(T_LBRACK, null, null);
        i++;
      } else if (c === 0x5d) {
        toks[n++] = token(T_RBRACK, null, null);
        i++;
      } else if (c === 0x2c) {
        toks[n++] = token(T_COMMA, null, null);
        i++;
      } else if (c === 0x40) {
        toks[n++] = token(T_AT, null, null);
        i++;
      } else if (c === 0x7c || c === 0x2b || c === 0x2d || c === 0x3d) {
        toks[n++] = token(T_OP, StringPrototypeSlice(s, i, i + 1), null);
        i++;
      } else if (c === 0x2f) {
        var dbl = next === 0x2f;
        toks[n++] = token(T_OP, dbl ? '//' : '/', null);
        i += dbl ? 2 : 1;
      } else if (c === 0x21) {
        if (next !== 0x3d) throw SYNTAX;
        toks[n++] = token(T_OP, '!=', null);
        i += 2;
      } else if (c === 0x3c || c === 0x3e) {
        var eq = next === 0x3d;
        toks[n++] = token(T_OP, (c === 0x3c ? '<' : '>') + (eq ? '=' : ''), null);
        i += eq ? 2 : 1;
      } else if (c === 0x2a) {
        toks[n++] = operand ? token(T_OP, '*', null) : token(T_NAME, '*', null);
        i++;
      } else if (c === 0x2e && next === 0x2e) {
        toks[n++] = token(T_DOTDOT, null, null);
        i += 2;
      } else if (isDigit(c) || (c === 0x2e && isDigit(next))) {
        var start = i;
        while (i < len && isDigit(StringPrototypeCharCodeAt(s, i))) i++;
        if (i < len && StringPrototypeCharCodeAt(s, i) === 0x2e) {
          i++;
          while (i < len && isDigit(StringPrototypeCharCodeAt(s, i))) i++;
        }
        toks[n++] = token(T_NUMBER, NumberP(StringPrototypeSlice(s, start, i)), null);
      } else if (c === 0x2e) {
        toks[n++] = token(T_DOT, null, null);
        i++;
      } else if (c === 0x22 || c === 0x27) {
        var close = StringPrototypeIndexOf(s, c === 0x22 ? '"' : "'", i + 1);
        if (close === -1) throw SYNTAX;
        toks[n++] = token(T_LITERAL, StringPrototypeSlice(s, i + 1, close), null);
        i = close + 1;
      } else if (c === 0x24) {
        var q = qname(s, i + 1);
        if (q === null || q.local === '*') throw SYNTAX;
        toks[n++] = token(T_VAR, q.local, q.prefix);
        i = q.end;
      } else if (isNameStart(c)) {
        if (operand) {
          var end = nameEnd(s, i);
          var op = StringPrototypeSlice(s, i, end);
          if (op !== 'and' && op !== 'or' && op !== 'mod' && op !== 'div') throw SYNTAX;
          toks[n++] = token(T_OP, op, null);
          i = end;
          continue;
        }

        var name = qname(s, i);
        i = name.end;
        var after = skipSpace(s, i);
        var ac = after < len ? StringPrototypeCharCodeAt(s, after) : -1;
        if (name.local !== '*' && ac === 0x28) {
          var isType = name.prefix === null && NODE_TYPES[name.local] !== undefined;
          toks[n++] = token(isType ? T_NODETYPE : T_FUNC, name.local, name.prefix);
        } else if (
          name.prefix === null &&
          ac === 0x3a &&
          after + 1 < len &&
          StringPrototypeCharCodeAt(s, after + 1) === 0x3a
        ) {
          if (AXES[name.local] === undefined) throw SYNTAX;
          toks[n++] = token(T_AXIS, AXES[name.local], null);
          i = after + 2;
        } else {
          toks[n++] = token(T_NAME, name.local, name.prefix);
        }
      } else {
        throw SYNTAX;
      }
    }

    toks[n] = token(T_END, null, null);
    return toks;
  }

  // A QName or `prefix:*` at i; null when no name starts there.
  function qname(s, i) {
    if (i >= s.length || !isNameStart(StringPrototypeCharCodeAt(s, i))) return null;
    var end = nameEnd(s, i);
    var first = StringPrototypeSlice(s, i, end);
    if (
      end + 1 < s.length &&
      StringPrototypeCharCodeAt(s, end) === 0x3a &&
      StringPrototypeCharCodeAt(s, end + 1) !== 0x3a
    ) {
      var c = StringPrototypeCharCodeAt(s, end + 1);
      if (c === 0x2a) return { __proto__: null, prefix: first, local: '*', end: end + 2 };
      if (!isNameStart(c)) throw SYNTAX;
      var localEnd = nameEnd(s, end + 1);
      return {
        __proto__: null,
        prefix: first,
        local: StringPrototypeSlice(s, end + 1, localEnd),
        end: localEnd,
      };
    }

    return { __proto__: null, prefix: null, local: first, end: end };
  }

  // --- Parser ------------------------------------------------------------------

  function node(k, a, b, op) {
    return { __proto__: null, k: k, a: a, b: b, op: op };
  }

  function parse(source, resolver) {
    var toks = tokenize(source);
    var st = { __proto__: null, toks: toks, i: 0, resolver: resolver };
    if (toks[0].k === T_END) throw SYNTAX;
    var e = parseOr(st);
    if (toks[st.i].k !== T_END) throw SYNTAX;
    return e;
  }

  function peek(st) {
    return st.toks[st.i];
  }

  function isOp(t, v) {
    return t.k === T_OP && t.v === v;
  }

  function expect(st, k) {
    if (st.toks[st.i].k !== k) throw SYNTAX;
    st.i++;
  }

  function parseOr(st) {
    var e = parseAnd(st);
    while (isOp(peek(st), 'or')) {
      st.i++;
      e = node(K_OR, e, parseAnd(st), null);
    }

    return e;
  }

  function parseAnd(st) {
    var e = parseEquality(st);
    while (isOp(peek(st), 'and')) {
      st.i++;
      e = node(K_AND, e, parseEquality(st), null);
    }

    return e;
  }

  function parseEquality(st) {
    var e = parseRelational(st);
    for (var t = peek(st); isOp(t, '=') || isOp(t, '!='); t = peek(st)) {
      st.i++;
      e = node(K_CMP, e, parseRelational(st), t.v);
    }

    return e;
  }

  function parseRelational(st) {
    var e = parseAdditive(st);
    for (
      var t = peek(st);
      isOp(t, '<') || isOp(t, '>') || isOp(t, '<=') || isOp(t, '>=');
      t = peek(st)
    ) {
      st.i++;
      e = node(K_CMP, e, parseAdditive(st), t.v);
    }

    return e;
  }

  function parseAdditive(st) {
    var e = parseMultiplicative(st);
    for (var t = peek(st); isOp(t, '+') || isOp(t, '-'); t = peek(st)) {
      st.i++;
      e = node(K_ARITH, e, parseMultiplicative(st), t.v);
    }

    return e;
  }

  function parseMultiplicative(st) {
    var e = parseUnary(st);
    for (var t = peek(st); isOp(t, '*') || isOp(t, 'div') || isOp(t, 'mod'); t = peek(st)) {
      st.i++;
      e = node(K_ARITH, e, parseUnary(st), t.v);
    }

    return e;
  }

  function parseUnary(st) {
    if (isOp(peek(st), '-')) {
      st.i++;
      return node(K_NEG, parseUnary(st), null, null);
    }

    return parseUnion(st);
  }

  function parseUnion(st) {
    var e = parsePathExpr(st);
    while (isOp(peek(st), '|')) {
      st.i++;
      e = node(K_UNION, e, parsePathExpr(st), null);
    }

    return e;
  }

  function startsStep(t) {
    return (
      t.k === T_NAME ||
      t.k === T_NODETYPE ||
      t.k === T_DOT ||
      t.k === T_DOTDOT ||
      t.k === T_AT ||
      t.k === T_AXIS
    );
  }

  function path(filter, abs, steps) {
    var p = node(K_PATH, filter, null, null);
    p.abs = abs;
    p.steps = steps;
    return p;
  }

  function parsePathExpr(st) {
    var t = peek(st);
    if (
      t.k === T_VAR ||
      t.k === T_LPAREN ||
      t.k === T_LITERAL ||
      t.k === T_NUMBER ||
      t.k === T_FUNC
    ) {
      var filter = parseFilter(st);
      t = peek(st);
      if (!isOp(t, '/') && !isOp(t, '//')) return filter;
      var steps = [];
      parseRelative(st, steps);
      return path(filter, false, steps);
    }

    if (isOp(t, '/')) {
      st.i++;
      var rest = [];
      if (startsStep(peek(st))) parseSteps(st, rest);
      return path(null, true, rest);
    }

    if (isOp(t, '//')) {
      var all = [];
      parseRelative(st, all);
      return path(null, true, all);
    }

    if (!startsStep(t)) throw SYNTAX;
    var rel = [];
    parseSteps(st, rel);
    return path(null, false, rel);
  }

  // `/` or `//` then a relative location path, appended to steps.
  function parseRelative(st, steps) {
    var t = peek(st);
    st.i++;
    if (t.v === '//') steps[steps.length] = step(AX_DESCENDANT_OR_SELF, TEST_NODE);
    parseSteps(st, steps);
  }

  function parseSteps(st, steps) {
    steps[steps.length] = parseStep(st);
    for (var t = peek(st); isOp(t, '/') || isOp(t, '//'); t = peek(st)) {
      st.i++;
      if (t.v === '//') steps[steps.length] = step(AX_DESCENDANT_OR_SELF, TEST_NODE);
      steps[steps.length] = parseStep(st);
    }

    fuseDescendant(steps);
  }

  // `//name` is descendant-or-self::node()/child::name; with no predicate on the
  // child step that is descendant::name, which is already in document order and saves
  // a sort over every node of the subtree. A predicate is positional among siblings
  // (`//li[1]`), so a step that has one keeps the long form.
  function fuseDescendant(steps) {
    var out = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var prev = out > 0 ? steps[out - 1] : null;
      if (
        prev !== null &&
        prev.axis === AX_DESCENDANT_OR_SELF &&
        prev.test === TEST_NODE &&
        prev.preds.length === 0 &&
        s.axis === AX_CHILD &&
        s.preds.length === 0
      ) {
        s.axis = AX_DESCENDANT;
        steps[out - 1] = s;
        continue;
      }

      steps[out++] = s;
    }

    steps.length = out;
  }

  function step(axis, test) {
    return {
      __proto__: null,
      axis: axis,
      test: test,
      ns: null,
      local: null,
      lower: null,
      target: null,
      preds: [],
    };
  }

  function parseStep(st) {
    var t = peek(st);
    if (t.k === T_DOT) {
      st.i++;
      return step(AX_SELF, TEST_NODE);
    }

    if (t.k === T_DOTDOT) {
      st.i++;
      return step(AX_PARENT, TEST_NODE);
    }

    var axis = AX_CHILD;
    if (t.k === T_AT) {
      axis = AX_ATTRIBUTE;
      st.i++;
    } else if (t.k === T_AXIS) {
      axis = t.v;
      st.i++;
    }

    t = peek(st);
    var s;
    if (t.k === T_NAME) {
      st.i++;
      s = step(axis, TEST_NAME);
      s.local = t.v;
      s.lower = asciiLower(t.v);
      if (t.prefix !== null) s.ns = resolve(st.resolver, t.prefix);
    } else if (t.k === T_NODETYPE) {
      st.i++;
      s = step(axis, NODE_TYPES[t.v]);
      expect(st, T_LPAREN);
      if (s.test === TEST_PI && peek(st).k === T_LITERAL) s.target = st.toks[st.i++].v;
      expect(st, T_RPAREN);
    } else {
      throw SYNTAX;
    }

    while (peek(st).k === T_LBRACK) s.preds[s.preds.length] = parsePredicate(st);
    return s;
  }

  function parsePredicate(st) {
    expect(st, T_LBRACK);
    var e = parseOr(st);
    expect(st, T_RBRACK);
    return e;
  }

  function parseFilter(st) {
    var t = peek(st);
    var e;
    st.i++;
    if (t.k === T_VAR) {
      e = node(K_VAR, null, null, null);
    } else if (t.k === T_LITERAL) {
      e = node(K_STR, null, null, null);
      e.v = t.v;
    } else if (t.k === T_NUMBER) {
      e = node(K_NUM, null, null, null);
      e.v = t.v;
    } else if (t.k === T_LPAREN) {
      e = parseOr(st);
      expect(st, T_RPAREN);
    } else {
      e = parseCall(st, t);
    }

    if (peek(st).k !== T_LBRACK) return e;
    var preds = [];
    while (peek(st).k === T_LBRACK) preds[preds.length] = parsePredicate(st);
    return node(K_FILTER, e, preds, null);
  }

  function parseCall(st, t) {
    var arity = t.prefix === null ? FUNCTIONS[t.v] : undefined;
    if (arity === undefined) throw SYNTAX;
    expect(st, T_LPAREN);
    var args = [];
    if (peek(st).k !== T_RPAREN) {
      args[0] = parseOr(st);
      while (peek(st).k === T_COMMA) {
        st.i++;
        args[args.length] = parseOr(st);
      }
    }

    expect(st, T_RPAREN);
    if (args.length < arity[0] || (arity[1] !== -1 && args.length > arity[1])) throw SYNTAX;
    var e = node(K_FN, args, null, t.v);
    return e;
  }

  // XPathNSResolver: a function, or an object with lookupNamespaceURI. A prefix it
  // leaves unresolved (null, or no resolver at all) is Chrome's NamespaceError.
  function resolve(resolver, prefix) {
    if (resolver === null || resolver === undefined) throw NAMESPACE;
    var fn = resolver;
    var self;
    if (typeof resolver !== 'function') {
      fn = ReflectGet(resolver, 'lookupNamespaceURI');
      self = resolver;
    }

    if (typeof fn !== 'function') throw NAMESPACE;
    var uri = ReflectApply(fn, self, [prefix]);
    if (uri === null || uri === undefined) throw NAMESPACE;
    return StringP(uri);
  }

  // --- Values ------------------------------------------------------------------

  function asciiLower(s) {
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (c >= 0x41 && c <= 0x5a) {
        var out = StringPrototypeSlice(s, 0, i);
        for (; i < s.length; i++) {
          c = StringPrototypeCharCodeAt(s, i);
          out += c >= 0x41 && c <= 0x5a ? StringP.fromCharCode(c + 0x20) : s[i];
        }
        return out;
      }
    }

    return s;
  }

  function typeOf(n) {
    return isAttr(n) ? 2 : nNodeType(n);
  }

  function parentOf(n) {
    return isAttr(n) ? attrOwner(n) : nParent(n);
  }

  // XPath's string-value of a node.
  function stringValue(n) {
    if (isAttr(n)) return attrValue(n);
    var t = nNodeType(n);
    if (t === 1 || t === 11) return nTextContent(n);
    if (t === 9) {
      var out = '';
      for (var c = nFirstChild(n); c !== null; c = nNextSibling(c)) {
        if (nNodeType(c) === 1) out += nTextContent(c);
      }
      return out;
    }

    if (t === 3 || t === 4 || t === 7 || t === 8) return nData(n);
    return '';
  }

  // XPath's number(): optional whitespace, an optional minus, digits with an optional
  // fraction, optional whitespace; anything else (`1e3`, `-`, ``) is NaN.
  function stringToNumber(s) {
    var i = 0;
    var len = s.length;
    while (i < len && isSpace(StringPrototypeCharCodeAt(s, i))) i++;
    var start = i;
    if (i < len && StringPrototypeCharCodeAt(s, i) === 0x2d) i++;
    var digits = 0;
    while (i < len && isDigit(StringPrototypeCharCodeAt(s, i))) {
      i++;
      digits++;
    }

    if (i < len && StringPrototypeCharCodeAt(s, i) === 0x2e) {
      i++;
      while (i < len && isDigit(StringPrototypeCharCodeAt(s, i))) {
        i++;
        digits++;
      }
    }

    var end = i;
    while (i < len && isSpace(StringPrototypeCharCodeAt(s, i))) i++;
    if (digits === 0 || i !== len) return NaN;
    return NumberP(StringPrototypeSlice(s, start, end));
  }

  // Blink's number-to-string (WTF::String::Number): 6 significant digits, trailing
  // zeros trimmed unless the form is exponential.
  function numberToString(v) {
    if (v !== v) return 'NaN';
    if (v === 0) return '0';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    var s = NumberPrototypeToPrecision(v, 6);
    if (StringPrototypeIndexOf(s, 'e', 0) !== -1 || StringPrototypeIndexOf(s, '.', 0) === -1) {
      return s;
    }

    var end = s.length;
    while (StringPrototypeCharCodeAt(s, end - 1) === 0x30) end--;
    if (StringPrototypeCharCodeAt(s, end - 1) === 0x2e) end--;
    return StringPrototypeSlice(s, 0, end);
  }

  function toStr(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return numberToString(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return v.length === 0 ? '' : stringValue(v[0]);
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return stringToNumber(toStr(v));
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && v === v;
    return v.length !== 0;
  }

  function nodeSet(v) {
    if (!ArrayIsArray(v)) throw CONVERSION;
    return v;
  }

  function round(v) {
    if (v !== v || v === Infinity || v === -Infinity) return v;
    var r = MathFloor(v + 0.5);
    return r === 0 && (v < 0 || (v === 0 && 1 / v < 0)) ? -0 : r;
  }

  // --- Document order ----------------------------------------------------------

  // An evaluation's order index: a number per node, increasing in document order, built
  // one tree at a time on the first sort that needs it (nothing mutates the tree while
  // an expression runs). An attribute sorts between its element and the element's
  // first child, by its place in the element's attribute list.
  function orderOf(n, ev) {
    if (isAttr(n)) {
      var owner = attrOwner(n);
      var list = nAttributes(owner);
      var count = list.length / 4;
      var at = 0;
      while (at < count && list[at * 4 + 1] !== attrName(n)) at++;
      return orderOf(owner, ev) + (at + 1) / (count + 2);
    }

    if (ev.order === null) ev.order = new WeakMapP();
    var o = WeakMapPrototypeGet(ev.order, n);
    if (o !== undefined) return o;
    var root = n;
    for (var p = nParent(root); p !== null; p = nParent(p)) root = p;
    var next = ev.next;
    var m = root;
    while (m !== null) {
      WeakMapPrototypeSet(ev.order, m, next++);
      var c = nFirstChild(m);
      if (c !== null) {
        m = c;
        continue;
      }

      while (m !== null && m !== root) {
        var s = nNextSibling(m);
        if (s !== null) {
          m = s;
          break;
        }

        m = nParent(m);
      }

      if (m === root) break;
    }

    ev.next = next;
    return WeakMapPrototypeGet(ev.order, n);
  }

  function byNumber(a, b) {
    return a - b;
  }

  // nodes in document order without duplicates.
  function sortUnique(nodes, ev) {
    if (nodes.length < 2) return nodes;
    var keyed = { __proto__: null };
    var keys = [];
    var k = 0;
    for (var i = 0; i < nodes.length; i++) {
      var o = orderOf(nodes[i], ev);
      if (keyed[o] === undefined) {
        keyed[o] = nodes[i];
        keys[k++] = o;
      }
    }

    ArrayPrototypeSort(keys, byNumber);
    var out = [];
    for (var j = 0; j < k; j++) out[j] = keyed[keys[j]];
    return out;
  }

  // --- Axes --------------------------------------------------------------------

  function elementMatches(el, s) {
    var ns = nNamespace(el);
    if (s.local === '*') return s.ns === null || NS_URIS[ns] === s.ns;
    if (s.ns === null) {
      if (ns === NS_HTML) return nLocalName(el) === s.lower;
      return ns === NS_NONE && nLocalName(el) === s.local;
    }

    return NS_URIS[ns] === s.ns && nLocalName(el) === s.local;
  }

  function attrMatches(a, s) {
    var ns = attrNamespace(a);
    if (s.local === '*') return s.ns === null || NS_URIS[ns] === s.ns;
    if (s.ns === null) {
      if (ns !== NS_NONE) return false;
      return nNamespace(attrOwner(a)) === NS_HTML
        ? attrLocal(a) === s.lower
        : attrLocal(a) === s.local;
    }

    return NS_URIS[ns] === s.ns && attrLocal(a) === s.local;
  }

  function matches(n, s) {
    switch (s.test) {
      case TEST_NODE:
        return true;
      case TEST_TEXT: {
        var t = typeOf(n);
        return t === 3 || t === 4;
      }
      case TEST_COMMENT:
        return typeOf(n) === 8;
      case TEST_PI:
        return typeOf(n) === 7 && (s.target === null || nNodeName(n) === s.target);
    }

    // A name test, of the axis's principal node type.
    if (s.axis === AX_ATTRIBUTE) return isAttr(n) && attrMatches(n, s);
    if (s.axis === AX_NAMESPACE || isAttr(n) || nNodeType(n) !== 1) return false;
    return elementMatches(n, s);
  }

  function pushIf(out, n, s) {
    if (matches(n, s)) out[out.length] = n;
  }

  function descendants(root, s, out) {
    var n = nFirstChild(root);
    while (n !== null) {
      pushIf(out, n, s);
      var c = nFirstChild(n);
      if (c !== null) {
        n = c;
        continue;
      }

      for (;;) {
        var next = nNextSibling(n);
        if (next !== null) {
          n = next;
          break;
        }

        n = nParent(n);
        if (n === root || n === null) return;
      }
    }
  }

  function reverseSubtree(n, s, out) {
    for (var c = nLastChild(n); c !== null; c = nPreviousSibling(c)) reverseSubtree(c, s, out);
    pushIf(out, n, s);
  }

  // The nodes of `n`'s axis that pass the step's node test, in the axis's own order
  // (nearest first on a reverse axis).
  function axisNodes(n, s) {
    var out = [];
    var attr = isAttr(n);
    var m;
    switch (s.axis) {
      case AX_CHILD:
        if (!attr) for (m = nFirstChild(n); m !== null; m = nNextSibling(m)) pushIf(out, m, s);
        break;
      case AX_DESCENDANT_OR_SELF:
        pushIf(out, n, s);
      // falls through
      case AX_DESCENDANT:
        if (!attr) descendants(n, s, out);
        break;
      case AX_PARENT:
        m = parentOf(n);
        if (m !== null) pushIf(out, m, s);
        break;
      case AX_ANCESTOR_OR_SELF:
        pushIf(out, n, s);
      // falls through
      case AX_ANCESTOR:
        for (m = parentOf(n); m !== null; m = nParent(m)) pushIf(out, m, s);
        break;
      case AX_FOLLOWING_SIBLING:
        if (!attr) for (m = nNextSibling(n); m !== null; m = nNextSibling(m)) pushIf(out, m, s);
        break;
      case AX_PRECEDING_SIBLING:
        if (!attr) {
          for (m = nPreviousSibling(n); m !== null; m = nPreviousSibling(m)) pushIf(out, m, s);
        }
        break;
      case AX_FOLLOWING:
        if (attr) {
          n = attrOwner(n);
          descendants(n, s, out);
        }
        for (; n !== null; n = nParent(n)) {
          for (m = nNextSibling(n); m !== null; m = nNextSibling(m)) {
            pushIf(out, m, s);
            descendants(m, s, out);
          }
        }
        break;
      case AX_PRECEDING:
        if (attr) n = attrOwner(n);
        for (; n !== null; n = nParent(n)) {
          for (m = nPreviousSibling(n); m !== null; m = nPreviousSibling(m)) {
            reverseSubtree(m, s, out);
          }
        }
        break;
      case AX_ATTRIBUTE:
        if (!attr && nNodeType(n) === 1) {
          var list = attributesOf(n);
          for (var i = 0; i < list.length; i++) pushIf(out, list[i], s);
        }
        break;
      case AX_SELF:
        pushIf(out, n, s);
        break;
      // AX_NAMESPACE: an HTML tree has no namespace nodes Lava models; empty.
    }

    return out;
  }

  function filterPredicates(nodes, preds, ev) {
    for (var p = 0; p < preds.length; p++) {
      var out = [];
      var k = 0;
      var size = nodes.length;
      for (var i = 0; i < size; i++) {
        var r = evaluate(preds[p], nodes[i], i + 1, size, ev);
        if (typeof r === 'number' ? r === i + 1 : toBool(r)) out[k++] = nodes[i];
      }

      nodes = out;
    }

    return nodes;
  }

  function applyStep(set, s, ev) {
    var reverse = s.axis <= AX_PRECEDING_SIBLING;
    var out = [];
    var k = 0;
    for (var i = 0; i < set.length; i++) {
      var found = filterPredicates(axisNodes(set[i], s), s.preds, ev);
      for (var j = 0; j < found.length; j++) out[k++] = found[j];
    }

    // One context node on a forward axis is already in document order, and so is any
    // ordered set through self or attribute; anything else is sorted.
    if (set.length === 1 && !reverse) return out;
    if (s.axis === AX_SELF || s.axis === AX_ATTRIBUTE) return out;
    return sortUnique(out, ev);
  }

  // --- Evaluation --------------------------------------------------------------

  function evaluate(e, n, pos, size, ev) {
    switch (e.k) {
      case K_NUM:
      case K_STR:
        return e.v;
      case K_VAR:
        return '';
      case K_OR:
        return toBool(evaluate(e.a, n, pos, size, ev)) || toBool(evaluate(e.b, n, pos, size, ev));
      case K_AND:
        return toBool(evaluate(e.a, n, pos, size, ev)) && toBool(evaluate(e.b, n, pos, size, ev));
      case K_CMP:
        return compare(e.op, evaluate(e.a, n, pos, size, ev), evaluate(e.b, n, pos, size, ev));
      case K_ARITH: {
        var x = toNum(evaluate(e.a, n, pos, size, ev));
        var y = toNum(evaluate(e.b, n, pos, size, ev));
        if (e.op === '+') return x + y;
        if (e.op === '-') return x - y;
        if (e.op === '*') return x * y;
        if (e.op === 'div') return x / y;
        return x % y;
      }
      case K_NEG:
        return -toNum(evaluate(e.a, n, pos, size, ev));
      case K_UNION: {
        var left = nodeSet(evaluate(e.a, n, pos, size, ev));
        var right = nodeSet(evaluate(e.b, n, pos, size, ev));
        var all = [];
        for (var i = 0; i < left.length; i++) all[i] = left[i];
        for (var j = 0; j < right.length; j++) all[left.length + j] = right[j];
        return sortUnique(all, ev);
      }
      case K_FN:
        return call(e, n, pos, size, ev);
      case K_FILTER:
        return filterPredicates(nodeSet(evaluate(e.a, n, pos, size, ev)), e.b, ev);
    }

    // K_PATH
    var set;
    if (e.a !== null) {
      set = nodeSet(evaluate(e.a, n, pos, size, ev));
    } else if (e.abs) {
      // Blink's root: the document for a connected node, else the highest ancestor —
      // the Attr itself for an attribute, whose parentNode is null
      // (tests/dom/cases/xpath-misc.page).
      var root = n;
      if (!isAttr(n)) for (var p = nParent(root); p !== null; p = nParent(p)) root = p;
      set = [root];
    } else {
      set = [n];
    }

    for (var s = 0; s < e.steps.length && set.length !== 0; s++)
      set = applyStep(set, e.steps[s], ev);
    return set;
  }

  function compareAtoms(op, a, b) {
    if (op === '=' || op === '!=') {
      var same;
      if (typeof a === 'boolean' || typeof b === 'boolean') {
        same = toBool(a) === toBool(b);
      } else if (typeof a === 'number' || typeof b === 'number') {
        same = toNum(a) === toNum(b);
      } else {
        same = a === b;
      }
      return op === '=' ? same : !same;
    }

    var x = toNum(a);
    var y = toNum(b);
    if (op === '<') return x < y;
    if (op === '<=') return x <= y;
    if (op === '>') return x > y;
    return x >= y;
  }

  // XPath 1.0 §3.4: a node-set compares through its nodes' string-values (numbers
  // against a number), except against a boolean, which takes the set's boolean.
  function compare(op, a, b) {
    var aSet = ArrayIsArray(a);
    var bSet = ArrayIsArray(b);
    var i;
    if (aSet && bSet) {
      var right = [];
      for (var j = 0; j < b.length; j++) right[j] = stringValue(b[j]);
      for (i = 0; i < a.length; i++) {
        var sv = stringValue(a[i]);
        for (var k = 0; k < right.length; k++) if (compareAtoms(op, sv, right[k])) return true;
      }
      return false;
    }

    if (!aSet && !bSet) return compareAtoms(op, a, b);
    var set = aSet ? a : b;
    var other = aSet ? b : a;
    if (typeof other === 'boolean') {
      return aSet ? compareAtoms(op, toBool(a), b) : compareAtoms(op, a, toBool(b));
    }

    for (i = 0; i < set.length; i++) {
      var v = stringValue(set[i]);
      if (typeof other === 'number') v = stringToNumber(v);
      if (aSet ? compareAtoms(op, v, other) : compareAtoms(op, other, v)) return true;
    }

    return false;
  }

  // The optional node-set argument of name(), local-name() and friends: its first
  // node, the context node without one, null for an empty set.
  function firstArg(e, n, pos, size, ev) {
    if (e.a.length === 0) return n;
    var set = nodeSet(evaluate(e.a[0], n, pos, size, ev));
    return set.length === 0 ? null : set[0];
  }

  function stringArg(e, i, n, pos, size, ev) {
    if (i >= e.a.length) return stringValue(n);
    return toStr(evaluate(e.a[i], n, pos, size, ev));
  }

  function normalizeSpace(s) {
    var out = '';
    var pending = false;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (isSpace(c)) {
        pending = out !== '';
        continue;
      }

      if (pending) out += ' ';
      pending = false;
      out += s[i];
    }

    return out;
  }

  function idTokens(s, out) {
    var i = 0;
    while (i < s.length) {
      while (i < s.length && isSpace(StringPrototypeCharCodeAt(s, i))) i++;
      var start = i;
      while (i < s.length && !isSpace(StringPrototypeCharCodeAt(s, i))) i++;
      if (i > start) out[out.length] = StringPrototypeSlice(s, start, i);
    }
  }

  function call(e, n, pos, size, ev) {
    var args = e.a;
    var name = e.op;
    var target;
    var s;
    var t;
    var i;
    switch (name) {
      case 'last':
        return size;
      case 'position':
        return pos;
      case 'count':
        return nodeSet(evaluate(args[0], n, pos, size, ev)).length;
      case 'id': {
        var v = evaluate(args[0], n, pos, size, ev);
        var ids = [];
        if (ArrayIsArray(v)) {
          for (i = 0; i < v.length; i++) idTokens(stringValue(v[i]), ids);
        } else {
          idTokens(toStr(v), ids);
        }

        // Blink looks ids up in the context node's tree scope, which is the document
        // for a detached node too.
        var doc = nDocument();
        var found = [];
        for (i = 0; i < ids.length; i++) {
          var el = nById(doc, ids[i]);
          if (el !== null) found[found.length] = el;
        }
        return sortUnique(found, ev);
      }
      case 'local-name':
        target = firstArg(e, n, pos, size, ev);
        if (target === null) return '';
        if (isAttr(target)) return attrLocal(target);
        t = nNodeType(target);
        return t === 1 ? nLocalName(target) : t === 7 ? nNodeName(target) : '';
      case 'name':
        target = firstArg(e, n, pos, size, ev);
        if (target === null) return '';
        if (isAttr(target)) return attrName(target);
        t = nNodeType(target);
        return t === 1 ? nLocalName(target) : t === 7 ? nNodeName(target) : '';
      case 'namespace-uri':
        target = firstArg(e, n, pos, size, ev);
        if (target === null) return '';
        if (isAttr(target)) return NS_URIS[attrNamespace(target)];
        return nNodeType(target) === 1 ? NS_URIS[nNamespace(target)] : '';
      case 'string':
        return stringArg(e, 0, n, pos, size, ev);
      case 'concat':
        s = '';
        for (i = 0; i < args.length; i++) s += toStr(evaluate(args[i], n, pos, size, ev));
        return s;
      case 'starts-with':
        return StringPrototypeStartsWith(
          stringArg(e, 0, n, pos, size, ev),
          stringArg(e, 1, n, pos, size, ev),
        );
      case 'contains':
        return (
          StringPrototypeIndexOf(
            stringArg(e, 0, n, pos, size, ev),
            stringArg(e, 1, n, pos, size, ev),
            0,
          ) !== -1
        );
      case 'substring-before': {
        s = stringArg(e, 0, n, pos, size, ev);
        var at = StringPrototypeIndexOf(s, stringArg(e, 1, n, pos, size, ev), 0);
        return at === -1 ? '' : StringPrototypeSlice(s, 0, at);
      }
      case 'substring-after': {
        s = stringArg(e, 0, n, pos, size, ev);
        var needle = stringArg(e, 1, n, pos, size, ev);
        var where = StringPrototypeIndexOf(s, needle, 0);
        return where === -1 ? '' : StringPrototypeSlice(s, where + needle.length, s.length);
      }
      case 'substring': {
        s = stringArg(e, 0, n, pos, size, ev);
        var first = round(toNum(evaluate(args[1], n, pos, size, ev)));
        var end =
          args.length > 2 ? first + round(toNum(evaluate(args[2], n, pos, size, ev))) : Infinity;
        if (!(first < end)) return '';
        var from = first < 1 ? 1 : first;
        var to = end > s.length + 1 ? s.length + 1 : end;
        return from < to ? StringPrototypeSlice(s, from - 1, to - 1) : '';
      }
      case 'string-length':
        return stringArg(e, 0, n, pos, size, ev).length;
      case 'normalize-space':
        return normalizeSpace(stringArg(e, 0, n, pos, size, ev));
      case 'translate': {
        s = stringArg(e, 0, n, pos, size, ev);
        var map = stringArg(e, 1, n, pos, size, ev);
        var by = stringArg(e, 2, n, pos, size, ev);
        var out = '';
        for (i = 0; i < s.length; i++) {
          var idx = StringPrototypeIndexOf(map, s[i], 0);
          if (idx === -1) {
            out += s[i];
          } else if (idx < by.length) {
            out += by[idx];
          }
        }
        return out;
      }
      case 'boolean':
        return toBool(evaluate(args[0], n, pos, size, ev));
      case 'not':
        return !toBool(evaluate(args[0], n, pos, size, ev));
      case 'true':
        return true;
      case 'false':
        return false;
      case 'lang':
        return lang(n, toStr(evaluate(args[0], n, pos, size, ev)));
      case 'number':
        return args.length === 0
          ? stringToNumber(stringValue(n))
          : toNum(evaluate(args[0], n, pos, size, ev));
      case 'sum': {
        var set = nodeSet(evaluate(args[0], n, pos, size, ev));
        var sum = 0;
        for (i = 0; i < set.length; i++) sum += stringToNumber(stringValue(set[i]));
        return sum;
      }
      case 'floor':
        return MathFloor(toNum(evaluate(args[0], n, pos, size, ev)));
      case 'ceiling':
        return -MathFloor(-toNum(evaluate(args[0], n, pos, size, ev)));
      case 'round':
        return round(toNum(evaluate(args[0], n, pos, size, ev)));
    }

    throw SYNTAX;
  }

  // lang(): the nearest `xml:lang` on the context node or an ancestor, matched
  // ignoring ASCII case, exactly or up to a `-`. Blink reads only `xml:lang`, which the
  // HTML parser never makes, so an HTML `lang` attribute does not count
  // (tests/dom/cases/xpath-functions.page).
  function lang(n, want) {
    for (var m = isAttr(n) ? attrOwner(n) : n; m !== null; m = nParent(m)) {
      if (nNodeType(m) !== 1) continue;
      var list = nAttributes(m);
      for (var i = 0; i < list.length; i += 4) {
        if (list[i] === NS_XML && list[i + 2] === 'lang') {
          var have = asciiLower(list[i + 3]);
          var w = asciiLower(want);
          return have === w || StringPrototypeStartsWith(have, w + '-');
        }
      }
    }

    return false;
  }

  // --- Attr --------------------------------------------------------------------

  // Element -> its Attr objects by qualified name, so the same attribute is the same
  // object on every read, as in Chrome.
  var attrCache = new WeakMapP();
  var isAttr = null;
  var attrOwner = null;
  var attrName = null;
  var attrLocal = null;
  var attrNamespace = null;
  var attrValue = null;
  var makeAttr = null;

  /**
   * Attr (DOM Standard §4.9.2), for the nodes of XPath's attribute axis.
   * @node n/a — Chrome 158, tests/dom/cases/xpath-result.page (`//@data-x`).
   * @deviates Made only by XPath (Element.attributes and getAttributeNode do not exist
   *   yet), and it overrides the Node members a page reads off an attribute (nodeType,
   *   nodeName, nodeValue, textContent, ownerDocument, parentNode, …) as its own
   *   accessors, where Blink inherits them; the other Node members throw Illegal
   *   invocation on it. Its ownerElement stays set after the attribute is removed.
   */
  class Attr {
    #owner;
    #ns;
    #name;
    #local;
    #value;

    constructor(owner, ns, name, local, value) {
      this.#owner = owner;
      this.#ns = ns;
      this.#name = name;
      this.#local = local;
      this.#value = value;
    }

    static {
      isAttr = function (o) {
        return o !== null && typeof o === 'object' && #owner in o;
      };
      attrOwner = function (a) {
        return a.#owner;
      };
      attrName = function (a) {
        return a.#name;
      };
      attrLocal = function (a) {
        return a.#local;
      };
      attrNamespace = function (a) {
        return a.#ns;
      };
      attrValue = function (a) {
        var v = nGetAttribute(a.#owner, a.#name);
        if (v !== null) a.#value = v;
        return a.#value;
      };
      makeAttr = function (owner, ns, name, local, value) {
        var byName = WeakMapPrototypeGet(attrCache, owner);
        if (byName === undefined) {
          byName = { __proto__: null };
          WeakMapPrototypeSet(attrCache, owner, byName);
        }

        var a = byName[name];
        if (a === undefined) {
          a = new Attr(owner, ns, name, local, value);
          byName[name] = a;
        } else {
          a.#value = value;
        }
        return a;
      };
    }

    get namespaceURI() {
      check(this);
      return this.#ns === NS_NONE ? null : NS_URIS[this.#ns];
    }

    get prefix() {
      check(this);
      var colon = StringPrototypeIndexOf(this.#name, ':', 0);
      return this.#ns === NS_NONE || colon === -1
        ? null
        : StringPrototypeSlice(this.#name, 0, colon);
    }

    get localName() {
      check(this);
      return this.#local;
    }

    get name() {
      check(this);
      return this.#name;
    }

    get value() {
      check(this);
      return attrValue(this);
    }

    set value(v) {
      check(this);
      v = toDOMString(v, 'Attr', 'value');
      this.#value = v;
      nSetAttribute(this.#owner, this.#name, v);
    }

    get ownerElement() {
      check(this);
      return this.#owner;
    }

    get specified() {
      check(this);
      return true;
    }

    get nodeType() {
      check(this);
      return 2;
    }

    get nodeName() {
      check(this);
      return this.#name;
    }

    get nodeValue() {
      check(this);
      return attrValue(this);
    }

    set nodeValue(v) {
      check(this);
      this.value = v === null ? '' : v;
    }

    get textContent() {
      check(this);
      return attrValue(this);
    }

    set textContent(v) {
      check(this);
      this.value = v === null ? '' : v;
    }

    get ownerDocument() {
      check(this);
      return nDocument();
    }

    get parentNode() {
      check(this);
      return null;
    }

    get parentElement() {
      check(this);
      return null;
    }

    get firstChild() {
      check(this);
      return null;
    }

    get lastChild() {
      check(this);
      return null;
    }

    get previousSibling() {
      check(this);
      return null;
    }

    get nextSibling() {
      check(this);
      return null;
    }
  }

  function check(a) {
    if (!isAttr(a)) throw illegalInvocation();
  }

  // An element's attributes as Attr objects, in order. xmlns declarations are
  // namespace nodes in XPath's model, not attributes, so they are left out.
  function attributesOf(el) {
    var list = nAttributes(el);
    var out = [];
    var k = 0;
    for (var i = 0; i < list.length; i += 4) {
      if (list[i] === NS_XMLNS) continue;
      out[k++] = makeAttr(el, list[i], list[i + 1], list[i + 2], list[i + 3]);
    }

    return out;
  }

  // --- XPathResult -------------------------------------------------------------

  var newResult = null;

  /**
   * XPathResult (DOM Standard §8.6): a value of one of the ten result types.
   * @node n/a — Chrome 158, tests/dom/cases/xpath-result.page: each accessor throws
   *   Blink's TypeError for another type; an iterator throws InvalidStateError once the
   *   document mutated (children, attributes or character data) after it was made.
   * @deviates The unordered types hold their nodes in document order too.
   */
  class XPathResult {
    #type;
    #value;
    #nodes;
    #index;
    #version;

    static {
      newResult = function (type, value, nodes) {
        var r = new XPathResult();
        r.#type = type;
        r.#value = value;
        r.#nodes = nodes;
        r.#index = 0;
        r.#version = nVersion();
        return r;
      };
    }

    static #of(r, attr, types) {
      if (r === null || typeof r !== 'object' || !(#type in r)) throw illegalInvocation();
      if (attr === null) return r.#type;
      for (var i = 0; i < types.length; i++) if (types[i] === r.#type) return r.#type;
      throw pageError(
        new TypeErrorP(
          attributeContext('XPathResult', attr, false) +
            'The result type is not ' +
            RESULT_NOUN[attr],
        ),
      );
    }

    get resultType() {
      return XPathResult.#of(this, null, null);
    }

    get numberValue() {
      XPathResult.#of(this, 'numberValue', NUMBER_TYPES);
      return this.#value;
    }

    get stringValue() {
      XPathResult.#of(this, 'stringValue', STRING_TYPES);
      return this.#value;
    }

    get booleanValue() {
      XPathResult.#of(this, 'booleanValue', BOOLEAN_TYPES);
      return this.#value;
    }

    get singleNodeValue() {
      XPathResult.#of(this, 'singleNodeValue', SINGLE_TYPES);
      return this.#value;
    }

    get invalidIteratorState() {
      var type = XPathResult.#of(this, null, null);
      return (type === 4 || type === 5) && this.#version !== nVersion();
    }

    get snapshotLength() {
      XPathResult.#of(this, 'snapshotLength', SNAPSHOT_TYPES);
      return this.#nodes.length;
    }

    iterateNext() {
      var type = XPathResult.#of(this, null, null);
      if (type !== 4 && type !== 5) {
        throw typeError('XPathResult', 'iterateNext', 'The result type is not an iterator.');
      }

      if (this.#version !== nVersion()) {
        throw pageError(
          new DOMException(
            context('XPathResult', 'iterateNext') +
              'The document has mutated since the result was returned.',
            'InvalidStateError',
          ),
        );
      }

      return this.#index < this.#nodes.length ? this.#nodes[this.#index++] : null;
    }

    snapshotItem(index) {
      var type = XPathResult.#of(this, null, null);
      if (arguments.length < 1) {
        throw typeError('XPathResult', 'snapshotItem', argumentsRequired(1, arguments.length));
      }

      var i = unsignedLong(index, 'XPathResult', 'snapshotItem');
      if (type !== 6 && type !== 7) {
        throw typeError('XPathResult', 'snapshotItem', 'The result type is not a snapshot.');
      }

      return i < this.#nodes.length ? this.#nodes[i] : null;
    }
  }

  var RESULT_NOUN = {
    __proto__: null,
    numberValue: 'a number.',
    stringValue: 'a string.',
    booleanValue: 'a boolean.',
    singleNodeValue: 'a single node.',
    snapshotLength: 'a snapshot.',
  };
  var NUMBER_TYPES = [1];
  var STRING_TYPES = [2];
  var BOOLEAN_TYPES = [3];
  var SINGLE_TYPES = [8, 9];
  var SNAPSHOT_TYPES = [6, 7];

  function wrapInteger(value, iface, op, modulo) {
    var v = toNumberArg(value, iface, op);
    if (v !== v || v === Infinity || v === -Infinity) return 0;
    v = v < 0 ? -MathFloor(-v) : MathFloor(v);
    v %= modulo;
    return v < 0 ? v + modulo : v;
  }

  function unsignedLong(value, iface, op) {
    return wrapInteger(value, iface, op, 4294967296);
  }

  // --- Entry points ------------------------------------------------------------

  function isNodeArg(v) {
    return isAttr(v) || nIsNode(v);
  }

  function checkResolver(resolver, iface, op, index) {
    if (
      resolver !== null &&
      resolver !== undefined &&
      typeof resolver !== 'object' &&
      typeof resolver !== 'function'
    ) {
      throw typeError(iface, op, notOfType(index, 'Object'));
    }
  }

  // A document fragment or a doctype is no context node in Blink: NotSupportedError,
  // checked before the expression is parsed.
  function checkContext(n, iface, op) {
    if (isAttr(n)) return;
    var t = nNodeType(n);
    if (t === 11 || t === 10) {
      throw pageError(
        new DOMException(
          context(iface, op) +
            "The node provided is '" +
            nNodeName(n) +
            "', which is not a valid context node type.",
          'NotSupportedError',
        ),
      );
    }
  }

  function compile(source, resolver, iface, op) {
    try {
      return parse(source, resolver);
    } catch (e) {
      if (e === SYNTAX) {
        throw pageError(
          new DOMException(
            context(iface, op) + "The string '" + source + "' is not a valid XPath expression.",
            'SyntaxError',
          ),
        );
      }

      if (e === NAMESPACE) {
        throw pageError(
          new DOMException(
            context(iface, op) + "The string '" + source + "' contains unresolvable namespaces.",
            'NamespaceError',
          ),
        );
      }

      throw e;
    }
  }

  var newExpression = null;

  // Evaluates a compiled expression at `contextNode` into a result of `type`.
  function run(expr, contextNode, type, iface, op) {
    var ev = { __proto__: null, order: null, next: 0 };
    var v;
    try {
      v = evaluate(expr, contextNode, 1, 1, ev);
    } catch (e) {
      if (e === CONVERSION) {
        throw pageError(
          new DOMException(
            context(iface, op) + 'Type conversion failed while evaluating the expression.',
            'SyntaxError',
          ),
        );
      }

      throw e;
    }

    var set = ArrayIsArray(v);
    var natural = set ? 4 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3;
    if (type === 0 || type > 9) type = natural;
    if (type >= 4 && !set) {
      throw typeError(
        iface,
        op,
        'The result is not a node set, and therefore cannot be converted to the desired type.',
      );
    }

    switch (type) {
      case 1:
        return newResult(1, toNum(v), null);
      case 2:
        return newResult(2, toStr(v), null);
      case 3:
        return newResult(3, toBool(v), null);
      case 8:
      case 9:
        return newResult(type, v.length === 0 ? null : v[0], null);
    }

    return newResult(type, null, v);
  }

  /**
   * XPathExpression (DOM Standard §8.4): a compiled expression, re-evaluable at any
   * context node.
   * @node n/a — Chrome 158, tests/dom/cases/xpath-result.page.
   * @deviates none
   */
  class XPathExpression {
    #expr;

    static {
      newExpression = function (expr) {
        var x = new XPathExpression();
        x.#expr = expr;
        return x;
      };
    }

    evaluate(contextNode) {
      if (this === null || typeof this !== 'object' || !(#expr in this)) throw illegalInvocation();
      var op = 'evaluate';
      if (arguments.length < 1) {
        throw typeError('XPathExpression', op, argumentsRequired(1, arguments.length));
      }

      if (!isNodeArg(contextNode)) throw typeError('XPathExpression', op, notOfType(1, 'Node'));
      var type = wrapInteger(arguments.length > 1 ? arguments[1] : 0, 'XPathExpression', op, 65536);
      checkContext(contextNode, 'XPathExpression', op);
      return run(this.#expr, contextNode, type, 'XPathExpression', op);
    }
  }

  function createExpression(iface, args) {
    var op = 'createExpression';
    if (args.length < 1) throw typeError(iface, op, argumentsRequired(1, args.length));
    var source = toDOMString(args[0], iface, op);
    var resolver = args.length > 1 ? args[1] : null;
    checkResolver(resolver, iface, op, 2);
    return newExpression(compile(source, resolver, iface, op));
  }

  function createNSResolver(iface, args) {
    var op = 'createNSResolver';
    if (args.length < 1) throw typeError(iface, op, argumentsRequired(1, args.length));
    if (!isNodeArg(args[0])) throw typeError(iface, op, notOfType(1, 'Node'));
    return args[0];
  }

  // evaluate(expression, contextNode, resolver, type, result): the conversions in
  // Blink's order, then the parse, then the run. `result` is ignored: Chrome 158 hands
  // back a new XPathResult whatever it is given (tests/dom/cases/xpath-result.page).
  function evaluateApi(iface, args) {
    var op = 'evaluate';
    if (args.length < 2) throw typeError(iface, op, argumentsRequired(2, args.length));
    var source = toDOMString(args[0], iface, op);
    var contextNode = args[1];
    if (!isNodeArg(contextNode)) throw typeError(iface, op, notOfType(2, 'Node'));
    var resolver = args.length > 2 ? args[2] : null;
    checkResolver(resolver, iface, op, 3);
    var type = wrapInteger(args.length > 3 ? args[3] : 0, iface, op, 65536);
    checkContext(contextNode, iface, op);
    return run(compile(source, resolver, iface, op), contextNode, type, iface, op);
  }

  /**
   * XPathEvaluator (DOM Standard §8.3): the constructible holder of the three
   * operations Document also has.
   * @node n/a — Chrome 158, tests/dom/cases/xpath-result.page.
   * @deviates none
   */
  class XPathEvaluator {
    #brand = true;

    static #check(o) {
      if (o === null || typeof o !== 'object' || !(#brand in o)) throw illegalInvocation();
    }

    createExpression(expression) {
      XPathEvaluator.#check(this);
      return createExpression('XPathEvaluator', arguments);
    }

    createNSResolver(nodeResolver) {
      XPathEvaluator.#check(this);
      return createNSResolver('XPathEvaluator', arguments);
    }

    evaluate(expression, contextNode) {
      XPathEvaluator.#check(this);
      return evaluateApi('XPathEvaluator', arguments);
    }
  }

  var SHAPE_END = ['constructor', '@@toStringTag'];

  /**
   * Binds the DOM natives and defines the XPath interfaces and Attr on the global.
   * @param {Object} env internal/dom's natives (pkg/runtime/dom.odin), its Node
   *   interface object, a setAttribute that queues MutationObserver records, and
   *   `version`, the count of tree mutations an iterator result checks.
   * @returns {{evaluate: Function, createExpression: Function,
   *   createNSResolver: Function}} Document's operations, each taking the interface
   *   name for its errors and the call's arguments.
   */
  function install(env) {
    nIsNode = env.isNode;
    nDocument = env.document;
    nNodeType = env.nodeType;
    nNodeName = env.nodeName;
    nLocalName = env.localName;
    nNamespace = env.namespace;
    nAttributes = env.attributes;
    nParent = env.parent;
    nFirstChild = env.firstChild;
    nLastChild = env.lastChild;
    nNextSibling = env.nextSibling;
    nPreviousSibling = env.previousSibling;
    nData = env.data;
    nTextContent = env.textContent;
    nGetAttribute = env.getAttribute;
    nSetAttribute = env.setAttribute;
    nById = env.byId;
    nVersion = env.version;

    var resultMembers = [
      'resultType',
      'numberValue',
      'stringValue',
      'booleanValue',
      'singleNodeValue',
      'invalidIteratorState',
      'snapshotLength',
    ];
    for (var i = 0; i < RESULT_TYPE_NAMES.length; i++) resultMembers[7 + i] = RESULT_TYPE_NAMES[i];
    resultMembers[resultMembers.length] = 'iterateNext:0';
    resultMembers[resultMembers.length] = 'snapshotItem:1';
    nativeShape.defineInterface({
      __proto__: null,
      name: 'XPathResult',
      impl: XPathResult,
      length: 0,
      illegal: true,
      members: P.ArrayPrototypeConcat(resultMembers, SHAPE_END),
      constants: RESULT_TYPES,
      statics: RESULT_TYPE_NAMES,
    });
    nativeShape.defineInterface({
      __proto__: null,
      name: 'XPathExpression',
      impl: XPathExpression,
      length: 0,
      illegal: true,
      members: P.ArrayPrototypeConcat(['evaluate:1'], SHAPE_END),
    });
    nativeShape.defineInterface({
      __proto__: null,
      name: 'XPathEvaluator',
      impl: XPathEvaluator,
      length: 0,
      members: P.ArrayPrototypeConcat(
        ['createExpression:1', 'createNSResolver:1', 'evaluate:2'],
        SHAPE_END,
      ),
    });
    ObjectSetPrototypeOf(Attr.prototype, env.Node.prototype);
    nativeShape.defineInterface({
      __proto__: null,
      name: 'Attr',
      impl: Attr,
      length: 0,
      illegal: true,
      parent: env.Node,
      members: P.ArrayPrototypeConcat(
        [
          'namespaceURI',
          'prefix',
          'localName',
          'name',
          'value',
          'ownerElement',
          'specified',
          'nodeType',
          'nodeName',
          'nodeValue',
          'textContent',
          'ownerDocument',
          'parentNode',
          'parentElement',
          'firstChild',
          'lastChild',
          'previousSibling',
          'nextSibling',
        ],
        SHAPE_END,
      ),
    });

    return {
      __proto__: null,
      evaluate: evaluateApi,
      createExpression: createExpression,
      createNSResolver: createNSResolver,
    };
  }

  module.exports = ObjectFreeze({ __proto__: null, install: install });
});
