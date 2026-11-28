/**
 * @fileoverview Module scripts (`<script type=module>`) and `import()` inside them (#13):
 * a source transform plus a module map, because the JavaScriptCore C API has no module
 * records (pkg/runtime/page_module.odin says what was measured on the linked library).
 *
 * The transform rewrites one module's source into a classic script, keeping every line
 * where it was (stack lines match the file): static `import`/`export` statements are
 * blanked or stripped of their keyword, `import(…)` and `import.meta` become calls on a
 * per-module handle, and the body is wrapped in a strict generator function:
 *
 *     (function ($lava$s) { with ($lava$s) { return function* ($lava$m) {
 *       'use strict'; $lava$m.e({x: function () { return x; }, …}); yield;
 *       …the module's own statements…
 *     } } })
 *
 * What that buys, each a module semantic the C API cannot give directly:
 *   - live bindings: an import is a getter on `$lava$s`, the object of the sloppy `with`
 *     around the strict body, so `x` in the body reads the exporter's binding at every
 *     access, through the exporter's own closure `function () { return x; }`; and an
 *     assignment to it throws as Chrome's does. Shadowing is the engine's own scoping:
 *     a local `x` resolves before the `with` object.
 *   - hoisting across a cycle: stepping the generator once runs only the prologue, which
 *     hands the export getters over after function declarations are hoisted, so every
 *     module of a graph is linked before any body runs, as in HTML's link-then-evaluate.
 *   - top-level await: the body is compiled as an `async function*` when the plain
 *     generator does not parse (await outside a function is a SyntaxError there).
 *   - module scope: `var` and function declarations stay local to the module and
 *     `this` is undefined at its top level.
 *
 * The module map is keyed by absolute URL, per realm (one per page): a module imported
 * twice, or both imported and named by a `src`, is fetched and evaluated once.
 *
 * Deviations (each a cost of not having engine module records; documented, MVP-grade):
 *   - A namespace object's members are enumerable getters, not data properties
 *     (Object.getOwnPropertyDescriptor tells); its keys, null prototype, @@toStringTag
 *     and non-extensibility match.
 *   - The body is a generator, so `arguments`, a top-level `return` and `new.target`
 *     do not raise the SyntaxError a module would.
 *   - An anonymous `export default class`/arrow is named `$lava$default`, not `default`
 *     (an anonymous default function is renamed to `default`).
 *   - Import maps and import attributes (`with {type: 'json'}`) are not implemented:
 *     a bare specifier fails to resolve, an attribute is ignored.
 *   - `import()` settles in the importing script's microtask checkpoint: the fetch is
 *     a synchronous file read, where Chrome fetches and settles in a later task
 *     (pinned by cmd/lava/module_script_test.odin).
 *   - `import()` in a classic script is not rewritten: it rejects with JSC's own
 *     "Could not import the module" (no host hook on this JSC build).
 *   - The transform's tokenizer decides regex-versus-division from the token before a
 *     `/`; `a++ / b` style code after a postfix operator can mis-scan.
 *
 * Lazy: required by bootstrap/loader.js's runModule on a page's first module script,
 * so a page without one never compiles this file.
 *
 * @module lava/internal/module_loader
 */

(function (require, module, _exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var reportException = require('internal/deferred').reportException;
  var URLCtor = require('internal/url').URL;

  var ArrayPrototypeJoin = P.ArrayPrototypeJoin;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var AsyncGeneratorPrototypeNext = P.AsyncGeneratorPrototypeNext;
  var GeneratorPrototypeNext = P.GeneratorPrototypeNext;
  var JSONParse = P.JSONParse;
  var JSONStringify = P.JSONStringify;
  var ObjectCreate = P.ObjectCreate;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var PromiseCtor = P.Promise;
  var PromisePrototypeThen = P.PromisePrototypeThen;
  var PromiseResolve = P.PromiseResolve;
  var ReflectApply = P.ReflectApply;
  var StringCtor = P.String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var SymbolToStringTag = P.SymbolToStringTag;
  var SyntaxErrorCtor = P.SyntaxError;
  var TypeErrorCtor = P.TypeError;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var pageError = webErrors.pageError;

  // The natives (pkg/runtime/page_module.odin): fetch(url) is the module's source text,
  // or undefined when it cannot be fetched; compile(source, name) evaluates a classic
  // script and returns its completion value, throwing what it throws.
  var nFetch = native.fetch;
  var nCompile = native.compile;

  // Token types.
  var T_NAME = 1;
  var T_PUNCT = 2;
  var T_STRING = 3;
  var T_TEMPLATE = 4;
  var T_REGEX = 5;
  var T_NUMBER = 6;

  // Template tokens: what each part is bounded by.
  var TPL_OPENS = 1; // ends with `${`
  var TPL_CLOSES = 2; // starts after the `}` of a `${`

  // Names after which a `/` starts a regular expression, not a division.
  var REGEX_AFTER = {
    __proto__: null,
    return: true,
    typeof: true,
    instanceof: true,
    in: true,
    of: true,
    new: true,
    delete: true,
    void: true,
    throw: true,
    case: true,
    do: true,
    else: true,
    yield: true,
    await: true,
  };

  // Names that continue an expression across a line break (ASI does not end it there).
  var CONTINUES = { __proto__: null, in: true, instanceof: true, of: true };

  // Module records by absolute URL: this realm's module map.
  var registry = ObjectCreate(null);

  // The errors a failed fetch made, which `run` turns into the element's `error` event
  // rather than a report.
  var fetchErrors = new P.WeakMap();

  // Record states.
  var S_NEW = 0;
  var S_LINKED = 1;
  var S_EVALUATING = 2;
  var S_EVALUATED = 3;

  function isNewline(c) {
    return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
  }

  function isSpace(c) {
    return (
      c === 32 ||
      c === 9 ||
      c === 11 ||
      c === 12 ||
      c === 0xa0 ||
      c === 0xfeff ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000
    );
  }

  function isIdStart(c) {
    return (
      (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) ||
      c === 36 ||
      c === 95 ||
      c === 92 ||
      c === 35 ||
      c >= 128
    );
  }

  function isIdPart(c) {
    return isIdStart(c) || (c >= 48 && c <= 57);
  }

  function isDigit(c) {
    return c >= 48 && c <= 57;
  }

  /**
   * Splits `s` into tokens: enough of the ECMAScript lexical grammar to find the
   * statements and expressions the transform rewrites, never mistaking text inside a
   * string, template, comment or regular expression for code.
   * @param {string} s
   * @returns {{n: number, type: number[], start: number[], end: number[], nl: boolean[], flag: number[]}}
   */
  function tokenize(s) {
    var len = s.length;
    var type = [];
    var start = [];
    var end = [];
    var nl = [];
    var flag = [];
    var n = 0;
    // Open braces: true for the `${` of a template, false for a `{`.
    var braces = [];
    var depth = 0;
    var newline = false;
    var i = 0;

    function emit(t, a, b, f) {
      type[n] = t;
      start[n] = a;
      end[n] = b;
      nl[n] = newline;
      flag[n] = f;
      n++;
      newline = false;
    }

    function regexAllowed() {
      if (n === 0) return true;
      var t = type[n - 1];
      if (t === T_PUNCT) {
        var c = StringPrototypeCharCodeAt(s, start[n - 1]);
        return c !== 41 && c !== 93; // ) ]
      }
      if (t === T_NAME)
        return REGEX_AFTER[StringPrototypeSlice(s, start[n - 1], end[n - 1])] === true;
      if (t === T_TEMPLATE) return (flag[n - 1] & TPL_OPENS) !== 0;
      return false;
    }

    // A template part from `from` (just past a backquote or a `}`) to its closing
    // backquote or its next `${`.
    function template(a, from, f) {
      var j = from;
      while (j < len) {
        var c = StringPrototypeCharCodeAt(s, j);
        if (c === 92) {
          j += 2;
          continue;
        }
        if (c === 96) {
          emit(T_TEMPLATE, a, j + 1, f);
          return j + 1;
        }
        if (c === 36 && StringPrototypeCharCodeAt(s, j + 1) === 123) {
          braces[depth++] = true;
          emit(T_TEMPLATE, a, j + 2, f | TPL_OPENS);
          return j + 2;
        }
        j++;
      }
      emit(T_TEMPLATE, a, len, f);
      return len;
    }

    while (i < len) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (isNewline(c)) {
        newline = true;
        i++;
        continue;
      }
      if (isSpace(c)) {
        i++;
        continue;
      }
      if (c === 47) {
        var d = StringPrototypeCharCodeAt(s, i + 1);
        if (d === 47) {
          i += 2;
          while (i < len && !isNewline(StringPrototypeCharCodeAt(s, i))) i++;
          continue;
        }
        if (d === 42) {
          var close = StringPrototypeIndexOf(s, '*/', i + 2);
          var stop = close < 0 ? len : close + 2;
          for (var k = i + 2; k < stop; k++) {
            if (isNewline(StringPrototypeCharCodeAt(s, k))) {
              newline = true;
              break;
            }
          }
          i = stop;
          continue;
        }
        if (regexAllowed()) {
          var r = i + 1;
          var inClass = false;
          while (r < len) {
            var rc = StringPrototypeCharCodeAt(s, r);
            if (rc === 92) {
              r += 2;
              continue;
            }
            if (isNewline(rc)) break;
            if (rc === 91) inClass = true;
            else if (rc === 93) inClass = false;
            else if (rc === 47 && !inClass) break;
            r++;
          }
          r++;
          while (r < len && isIdPart(StringPrototypeCharCodeAt(s, r))) r++;
          emit(T_REGEX, i, r, 0);
          i = r;
          continue;
        }
        emit(T_PUNCT, i, i + 1, 0);
        i++;
        continue;
      }
      if (c === 39 || c === 34) {
        var q = i + 1;
        while (q < len) {
          var qc = StringPrototypeCharCodeAt(s, q);
          if (qc === 92) {
            q += 2;
            continue;
          }
          if (qc === c || isNewline(qc)) break;
          q++;
        }
        emit(T_STRING, i, q + 1, 0);
        i = q + 1;
        continue;
      }
      if (c === 96) {
        i = template(i, i + 1, 0);
        continue;
      }
      if (c === 123) {
        braces[depth++] = false;
        emit(T_PUNCT, i, i + 1, 0);
        i++;
        continue;
      }
      if (c === 125) {
        if (depth > 0 && braces[--depth] === true) {
          i = template(i, i + 1, TPL_CLOSES);
          continue;
        }
        emit(T_PUNCT, i, i + 1, 0);
        i++;
        continue;
      }
      if (isIdStart(c)) {
        var e = i + 1;
        while (e < len) {
          var ec = StringPrototypeCharCodeAt(s, e);
          if (ec === 92) {
            e += 2;
            continue;
          }
          if (!isIdPart(ec) || isSpace(ec) || isNewline(ec)) break;
          e++;
        }
        emit(T_NAME, i, e, 0);
        i = e;
        continue;
      }
      if (isDigit(c) || (c === 46 && isDigit(StringPrototypeCharCodeAt(s, i + 1)))) {
        var m = i + 1;
        while (m < len) {
          var mc = StringPrototypeCharCodeAt(s, m);
          if (isIdPart(mc) || mc === 46) {
            m++;
            continue;
          }
          var prev = StringPrototypeCharCodeAt(s, m - 1);
          if (
            (mc === 43 || mc === 45) &&
            (prev === 101 || prev === 69) &&
            StringPrototypeCharCodeAt(s, i + 1) !== 120
          ) {
            m++;
            continue;
          }
          break;
        }
        emit(T_NUMBER, i, m, 0);
        i = m;
        continue;
      }
      if (
        c === 46 &&
        StringPrototypeCharCodeAt(s, i + 1) === 46 &&
        StringPrototypeCharCodeAt(s, i + 2) === 46
      ) {
        emit(T_PUNCT, i, i + 3, 0);
        i += 3;
        continue;
      }
      if (c === 61 && StringPrototypeCharCodeAt(s, i + 1) === 62) {
        emit(T_PUNCT, i, i + 2, 0);
        i += 2;
        continue;
      }
      if (
        c === 63 &&
        StringPrototypeCharCodeAt(s, i + 1) === 46 &&
        !isDigit(StringPrototypeCharCodeAt(s, i + 2))
      ) {
        emit(T_PUNCT, i, i + 2, 0);
        i += 2;
        continue;
      }
      emit(T_PUNCT, i, i + 1, 0);
      i++;
    }
    return { n: n, type: type, start: start, end: end, nl: nl, flag: flag };
  }

  /**
   * Rewrites a module's source to the generator-wrapped classic script described in the
   * file comment.
   * @param {string} s
   * @returns {object} The rewritten source pieces and the module's import/export tables.
   * @throws {SyntaxError} An import or export form the transform does not recognize.
   */
  function transform(s) {
    var tk = tokenize(s);
    var n = tk.n;
    var type = tk.type;
    var start = tk.start;
    var end = tk.end;
    var nl = tk.nl;

    // Edits, in source order: [from, to, replacement].
    var editFrom = [];
    var editTo = [];
    var editText = [];
    var edits = 0;

    // Module requests in source order (specifier strings, deduplicated).
    var requests = [];
    var requestIndex = ObjectCreate(null);
    // Import bindings: local name -> [request index, imported name or '*'].
    var importLocal = [];
    var importReq = [];
    var importName = [];
    // Local exports: exported name -> local binding name.
    var localExported = [];
    var localName = [];
    // Indirect exports: exported name -> [request index, imported name or '*'].
    var indirectExported = [];
    var indirectReq = [];
    var indirectName = [];
    // `export * from`: request indices.
    var stars = [];
    var renameDefault = false;

    function text(k) {
      return StringPrototypeSlice(s, start[k], end[k]);
    }

    function isPunct(k, ch) {
      return k < n && type[k] === T_PUNCT && text(k) === ch;
    }

    function isName(k, name) {
      return k < n && type[k] === T_NAME && text(k) === name;
    }

    function fail(k, what) {
      var line = 1;
      var at = k < n ? start[k] : s.length;
      for (var j = 0; j < at; j++) {
        if (StringPrototypeCharCodeAt(s, j) === 10) line++;
      }
      return pageError(new SyntaxErrorCtor(what + ' (line ' + line + ')'));
    }

    function edit(from, to, replacement) {
      editFrom[edits] = from;
      editTo[edits] = to;
      editText[edits] = replacement;
      edits++;
    }

    // Blank [from, to) but keep its line breaks, so every later line stays put.
    function blank(from, to) {
      var out = '';
      for (var j = from; j < to; j++) {
        var c = StringPrototypeCharCodeAt(s, j);
        if (c === 10) out += '\n';
      }
      edit(from, to, out);
    }

    function stringValue(k) {
      if (k >= n || type[k] !== T_STRING) throw fail(k, 'Unexpected token in import or export');
      var raw = StringPrototypeSlice(s, start[k] + 1, end[k] - 1);
      if (StringPrototypeIndexOf(raw, '\\') < 0) return raw;
      if (StringPrototypeCharCodeAt(s, start[k]) === 34) return JSONParse('"' + raw + '"');
      return JSONParse('"' + raw + '"');
    }

    function moduleName(k) {
      // ModuleExportName: an identifier name or a string.
      if (k < n && type[k] === T_NAME) return text(k);
      return stringValue(k);
    }

    function request(spec) {
      var index = requestIndex[spec];
      if (index === undefined) {
        index = requests.length;
        requests[index] = spec;
        requestIndex[spec] = index;
      }
      return index;
    }

    // Past `from 'x'`, an optional `with {…}`/`assert {…}` and an optional `;`.
    function fromClause(k) {
      if (!isName(k, 'from')) throw fail(k, "Unexpected token: expected 'from'");
      var spec = stringValue(k + 1);
      k += 2;
      if ((isName(k, 'with') || isName(k, 'assert')) && isPunct(k + 1, '{') && !nl[k]) {
        k = skipBalanced(k + 1);
      }
      return { k: k, req: request(spec) };
    }

    function semicolon(k) {
      return isPunct(k, ';') ? k + 1 : k;
    }

    // From an opening bracket to just past its match.
    function skipBalanced(k) {
      var d = 0;
      for (; k < n; k++) {
        if (type[k] === T_PUNCT) {
          var c = StringPrototypeCharCodeAt(s, start[k]);
          if (c === 40 || c === 91 || c === 123) d++;
          else if (c === 41 || c === 93 || c === 125) {
            d--;
            if (d === 0) return k + 1;
          }
        } else if (type[k] === T_TEMPLATE) {
          if (tk.flag[k] & TPL_OPENS) d++;
          if (tk.flag[k] & TPL_CLOSES) d--;
        }
      }
      return n;
    }

    // Whether a token ends an expression, so that a line break after it can end the
    // statement (ASI).
    function endsExpression(k) {
      var t = type[k];
      if (t === T_PUNCT) {
        var c = StringPrototypeCharCodeAt(s, start[k]);
        return c === 41 || c === 93 || c === 125;
      }
      if (t === T_TEMPLATE) return (tk.flag[k] & TPL_OPENS) === 0;
      return true;
    }

    // An initializer: from k to the `,`/`;`/closer that ends it at its own depth, or a
    // line break ASI ends it at.
    function skipExpression(k) {
      var d = 0;
      var first = k;
      for (; k < n; k++) {
        var t = type[k];
        if (k > first && d === 0 && nl[k] && endsExpression(k - 1)) {
          if (t === T_NAME ? CONTINUES[text(k)] !== true : t !== T_PUNCT) return k;
        }
        if (t === T_PUNCT) {
          var c = StringPrototypeCharCodeAt(s, start[k]);
          if (c === 40 || c === 91 || c === 123) d++;
          else if (c === 41 || c === 93 || c === 125) {
            if (d === 0) return k;
            d--;
          } else if (d === 0 && (c === 44 || c === 59)) return k;
        } else if (t === T_TEMPLATE) {
          if (tk.flag[k] & TPL_OPENS) d++;
          if (tk.flag[k] & TPL_CLOSES) d--;
        }
      }
      return n;
    }

    // A binding identifier or pattern: its names go to `names`.
    function binding(k, names) {
      if (isPunct(k, '{')) {
        k++;
        while (k < n && !isPunct(k, '}')) {
          if (isPunct(k, '...')) {
            k = binding(k + 1, names);
          } else if (type[k] === T_NAME && !isPunct(k + 1, ':')) {
            names[names.length] = text(k);
            k++;
          } else {
            if (isPunct(k, '[')) k = skipBalanced(k);
            else k++;
            if (!isPunct(k, ':')) throw fail(k, 'Unexpected token in an exported pattern');
            k = binding(k + 1, names);
          }
          if (isPunct(k, '=')) k = skipExpression(k + 1);
          if (isPunct(k, ',')) k++;
        }
        return k + 1;
      }
      if (isPunct(k, '[')) {
        k++;
        while (k < n && !isPunct(k, ']')) {
          if (isPunct(k, ',')) {
            k++;
            continue;
          }
          if (isPunct(k, '...')) k = binding(k + 1, names);
          else k = binding(k, names);
          if (isPunct(k, '=')) k = skipExpression(k + 1);
          if (isPunct(k, ',')) k++;
        }
        return k + 1;
      }
      if (k < n && type[k] === T_NAME) {
        names[names.length] = text(k);
        return k + 1;
      }
      throw fail(k, 'Unexpected token in an exported declaration');
    }

    function exportLocal(exported, local) {
      var j = localExported.length;
      localExported[j] = exported;
      localName[j] = local;
    }

    function importDeclaration(k0) {
      var k = k0 + 1;
      if (k < n && type[k] === T_STRING) {
        request(stringValue(k));
        k++;
        if ((isName(k, 'with') || isName(k, 'assert')) && isPunct(k + 1, '{') && !nl[k])
          k = skipBalanced(k + 1);
        k = semicolon(k);
        blank(start[k0], end[k - 1]);
        return k;
      }
      var locals = [];
      var names = [];
      if (k < n && type[k] === T_NAME && !isName(k, 'from')) {
        locals[locals.length] = text(k);
        names[names.length] = 'default';
        k++;
        if (isPunct(k, ',')) k++;
      } else if (isName(k, 'from') && isName(k + 1, 'from')) {
        locals[locals.length] = 'from';
        names[names.length] = 'default';
        k++;
      }
      if (isPunct(k, '*')) {
        if (!isName(k + 1, 'as') || k + 2 >= n || type[k + 2] !== T_NAME)
          throw fail(k, 'Unexpected token in import');
        locals[locals.length] = text(k + 2);
        names[names.length] = '*';
        k += 3;
      } else if (isPunct(k, '{')) {
        k++;
        while (k < n && !isPunct(k, '}')) {
          var imported = moduleName(k);
          var local = imported;
          k++;
          if (isName(k, 'as')) {
            local = text(k + 1);
            k += 2;
          }
          locals[locals.length] = local;
          names[names.length] = imported;
          if (isPunct(k, ',')) k++;
        }
        k++;
      }
      var from = fromClause(k);
      k = semicolon(from.k);
      for (var j = 0; j < locals.length; j++) {
        var at = importLocal.length;
        importLocal[at] = locals[j];
        importReq[at] = from.req;
        importName[at] = names[j];
      }
      blank(start[k0], end[k - 1]);
      return k;
    }

    function exportDeclaration(k0) {
      var k = k0 + 1;
      if (isPunct(k, '*')) {
        var exported = null;
        k++;
        if (isName(k, 'as')) {
          exported = moduleName(k + 1);
          k += 2;
        }
        var from = fromClause(k);
        k = semicolon(from.k);
        if (exported === null) stars[stars.length] = from.req;
        else {
          var at = indirectExported.length;
          indirectExported[at] = exported;
          indirectReq[at] = from.req;
          indirectName[at] = '*';
        }
        blank(start[k0], end[k - 1]);
        return k;
      }
      if (isPunct(k, '{')) {
        var locals = [];
        var exports = [];
        var stringLocal = false;
        k++;
        while (k < n && !isPunct(k, '}')) {
          if (type[k] === T_STRING) stringLocal = true;
          var local = moduleName(k);
          var name = local;
          k++;
          if (isName(k, 'as')) {
            name = moduleName(k + 1);
            k += 2;
          }
          locals[locals.length] = local;
          exports[exports.length] = name;
          if (isPunct(k, ',')) k++;
        }
        k++;
        if (isName(k, 'from')) {
          var source = fromClause(k);
          k = semicolon(source.k);
          for (var j = 0; j < locals.length; j++) {
            var at2 = indirectExported.length;
            indirectExported[at2] = exports[j];
            indirectReq[at2] = source.req;
            indirectName[at2] = locals[j];
          }
        } else {
          if (stringLocal) throw fail(k0, 'A string export name needs a from clause');
          k = semicolon(k);
          for (var j2 = 0; j2 < locals.length; j2++) exportLocal(exports[j2], locals[j2]);
        }
        blank(start[k0], end[k - 1]);
        return k;
      }
      if (isName(k, 'default')) {
        var d = k + 1;
        var fn = d;
        if (isName(fn, 'async') && isName(fn + 1, 'function') && !nl[fn + 1]) fn++;
        if (isName(fn, 'function') || isName(fn, 'class')) {
          var named = fn + 1;
          if (isPunct(named, '*')) named++;
          if (named < n && type[named] === T_NAME && !isName(named, 'extends')) {
            // A named declaration: the binding is exported as `default`.
            edit(start[k0], start[d], '');
            exportLocal('default', text(named));
            return named + 1;
          }
          if (isName(fn, 'function')) {
            // Anonymous: give it a binding, hoisted like a declaration; the prologue
            // renames it to `default` as Chrome names it.
            edit(start[k0], start[d], '');
            edit(start[named], start[named], ' $lava$default');
            exportLocal('default', '$lava$default');
            renameDefault = true;
            return named;
          }
        }
        edit(start[k0], end[k], 'const $lava$default =');
        exportLocal('default', '$lava$default');
        return d;
      }
      if (isName(k, 'var') || isName(k, 'let') || isName(k, 'const')) {
        edit(start[k0], start[k], '');
        var names = [];
        var b = k + 1;
        for (;;) {
          b = binding(b, names);
          if (isPunct(b, '=')) b = skipExpression(b + 1);
          if (!isPunct(b, ',')) break;
          b++;
        }
        for (var m = 0; m < names.length; m++) exportLocal(names[m], names[m]);
        return k + 1;
      }
      var decl = k;
      if (isName(decl, 'async')) decl++;
      if (isName(decl, 'function') || isName(decl, 'class')) {
        var id = decl + 1;
        if (isPunct(id, '*')) id++;
        if (id < n && type[id] === T_NAME) {
          edit(start[k0], start[k], '');
          exportLocal(text(id), text(id));
          return id + 1;
        }
      }
      throw fail(k, 'Unexpected token after export');
    }

    var depth = 0;
    for (var k = 0; k < n;) {
      var t = type[k];
      if (t === T_PUNCT) {
        var c = StringPrototypeCharCodeAt(s, start[k]);
        if (c === 40 || c === 91 || c === 123) depth++;
        else if (c === 41 || c === 93 || c === 125) depth--;
        k++;
        continue;
      }
      if (t === T_TEMPLATE) {
        if (tk.flag[k] & TPL_OPENS) depth++;
        if (tk.flag[k] & TPL_CLOSES) depth--;
        k++;
        continue;
      }
      if (t !== T_NAME || (k > 0 && (isPunct(k - 1, '.') || isPunct(k - 1, '?.')))) {
        k++;
        continue;
      }
      var word = text(k);
      if (word === 'import') {
        if (isPunct(k + 1, '(')) {
          // A method named import (`import() {…}`) is followed by its body.
          if (!isPunct(skipBalanced(k + 1), '{')) edit(start[k], end[k], '$lava$m.import');
          k++;
          continue;
        }
        if (isPunct(k + 1, '.') && isName(k + 2, 'meta')) {
          edit(start[k], end[k + 2], '$lava$m.meta');
          k += 3;
          continue;
        }
        if (depth === 0 && !isPunct(k + 1, ':')) {
          k = importDeclaration(k);
          continue;
        }
      } else if (word === 'export' && depth === 0 && !isPunct(k + 1, ':')) {
        k = exportDeclaration(k);
        continue;
      }
      k++;
    }

    // Apply the edits (they are in source order: each starts at or after the last).
    var parts = [];
    var at = 0;
    for (var e = 0; e < edits; e++) {
      parts[parts.length] = StringPrototypeSlice(s, at, editFrom[e]);
      parts[parts.length] = editText[e];
      at = editTo[e];
    }
    parts[parts.length] = StringPrototypeSlice(s, at);

    var getters = [];
    for (var g = 0; g < localExported.length; g++) {
      getters[g] = JSONStringify(localExported[g]) + ':function(){return ' + localName[g] + '}';
    }
    var prologue =
      "'use strict';$lava$m.e({__proto__:null," +
      ArrayPrototypeJoin(getters, ',') +
      '});' +
      (renameDefault ? '$lava$m.n($lava$default);' : '') +
      'yield;';

    return {
      __proto__: null,
      body: ArrayPrototypeJoin(parts, ''),
      prologue: prologue,
      requests: requests,
      importLocal: importLocal,
      importReq: importReq,
      importName: importName,
      localExported: localExported,
      indirectExported: indirectExported,
      indirectReq: indirectReq,
      indirectName: indirectName,
      stars: stars,
    };
  }

  // Compiles a transformed module to its generator function: plain, or async for a
  // body that awaits at its top level (which the plain one does not parse).
  function compile(rec, t, name) {
    var withScope = t.importLocal.length > 0;
    function source(prefix) {
      var head = prefix + '($lava$m){' + t.prologue;
      if (withScope) {
        return '(function($lava$s){with($lava$s){return ' + head + t.body + '\n}}})';
      }
      return '(' + head + t.body + '\n})';
    }
    var fn;
    try {
      fn = nCompile(source('function*'), name);
    } catch (error) {
      try {
        fn = nCompile(source('async function*'), name);
        rec.async = true;
      } catch (_) {
        throw error;
      }
    }
    if (withScope) {
      rec.scope = ObjectCreate(null);
      fn = ReflectApply(fn, undefined, [rec.scope]);
    }
    return fn;
  }

  function isFetchError(error) {
    return (
      error !== null &&
      typeof error === 'object' &&
      WeakMapPrototypeGet(fetchErrors, error) === true
    );
  }

  function fetchFailed(url) {
    var error = pageError(new TypeErrorCtor('Failed to fetch module script: ' + url));
    WeakMapPrototypeSet(fetchErrors, error, true);
    return error;
  }

  // HTML's "resolve a module specifier", without import maps.
  function resolveSpecifier(spec, base) {
    var c = StringPrototypeCharCodeAt(spec, 0);
    if (
      c === 47 ||
      (c === 46 &&
        (StringPrototypeCharCodeAt(spec, 1) === 47 ||
          (StringPrototypeCharCodeAt(spec, 1) === 46 && StringPrototypeCharCodeAt(spec, 2) === 47)))
    ) {
      return new URLCtor(spec, base).href;
    }
    var absolute;
    try {
      absolute = new URLCtor(spec).href;
    } catch (_) {
      throw pageError(
        new TypeErrorCtor(
          'Failed to resolve module specifier "' +
            spec +
            '". Relative references must start with either "/", "./", or "../".',
        ),
      );
    }
    return absolute;
  }

  function makeRecord(url, base) {
    var rec = {
      __proto__: null,
      url: url,
      base: base,
      status: S_NEW,
      failed: false,
      error: undefined,
      async: false,
      t: null,
      fn: null,
      gen: null,
      scope: null,
      local: null,
      deps: [],
      ns: null,
      promise: undefined,
      meta: null,
      handle: null,
    };
    var handle = {
      __proto__: null,
      e: function (getters) {
        rec.local = getters;
      },
      n: function (fn) {
        ObjectDefineProperty(fn, 'name', { __proto__: null, value: 'default', configurable: true });
      },
      import: function (specifier) {
        return dynamicImport(specifier, rec.base);
      },
      meta: null,
    };
    var meta = ObjectCreate(null);
    meta.url = url;
    meta.resolve = function resolve(specifier) {
      return resolveSpecifier(StringCtor(specifier), rec.base);
    };
    handle.meta = meta;
    rec.handle = handle;
    return rec;
  }

  // A module record for `source`, with its whole graph fetched and compiled. `url` is
  // its key in the module map (null for an inline script, which has none).
  function instantiate(source, url, base, name) {
    var rec = makeRecord(url === null ? base : url, base);
    if (url !== null) registry[url] = rec;
    try {
      var t = transform(source);
      rec.t = t;
      rec.fn = compile(rec, t, name);
      var urls = [];
      for (var i = 0; i < t.requests.length; i++) urls[i] = resolveSpecifier(t.requests[i], base);
      for (var j = 0; j < urls.length; j++) rec.deps[j] = fetchRecord(urls[j]);
    } catch (error) {
      rec.failed = true;
      rec.error = error;
      throw error;
    }
    return rec;
  }

  function fetchRecord(url) {
    var rec = registry[url];
    if (rec !== undefined) {
      if (rec.failed) throw rec.error;
      return rec;
    }
    var source = nFetch(url);
    if (source === undefined) {
      var failed = makeRecord(url, url);
      failed.failed = true;
      failed.error = fetchFailed(url);
      registry[url] = failed;
      throw failed.error;
    }
    return instantiate(source, url, url, url);
  }

  // Link: every module's prologue runs (its export getters handed over), then every
  // import binding is resolved and installed on its module's scope.
  function link(root) {
    var order = [];
    function visit(rec) {
      if (rec.status !== S_NEW) return;
      rec.status = S_LINKED;
      rec.gen = ReflectApply(rec.fn, undefined, [rec.handle]);
      if (rec.async) {
        // Runs to the prologue's `yield` synchronously; the promise is the step's.
        ReflectApply(AsyncGeneratorPrototypeNext, rec.gen, []);
      } else {
        ReflectApply(GeneratorPrototypeNext, rec.gen, []);
      }
      order[order.length] = rec;
      for (var i = 0; i < rec.deps.length; i++) visit(rec.deps[i]);
    }
    visit(root);
    for (var r = 0; r < order.length; r++) bindImports(order[r]);
  }

  function bindImports(rec) {
    var t = rec.t;
    for (var i = 0; i < t.importLocal.length; i++) {
      var dep = rec.deps[t.importReq[i]];
      var name = t.importName[i];
      var getter = name === '*' ? namespaceGetter(dep) : resolveExport(dep, name, []);
      if (getter === null) {
        throw pageError(
          new SyntaxErrorCtor(
            "The requested module '" +
              t.requests[t.importReq[i]] +
              "' does not provide an export named '" +
              name +
              "'",
          ),
        );
      }
      ObjectDefineProperty(rec.scope, t.importLocal[i], {
        __proto__: null,
        get: getter,
        set: assignToImport,
        enumerable: true,
      });
    }
  }

  function assignToImport() {
    throw pageError(new TypeErrorCtor('Assignment to constant variable.'));
  }

  function namespaceGetter(rec) {
    return function () {
      return namespace(rec);
    };
  }

  // The getter of `name` as `rec` exports it, or null when it does not (or ambiguously).
  function resolveExport(rec, name, seen) {
    for (var v = 0; v < seen.length; v += 2) {
      if (seen[v] === rec && seen[v + 1] === name) return null;
    }
    seen[seen.length] = rec;
    seen[seen.length] = name;
    var t = rec.t;
    for (var i = 0; i < t.localExported.length; i++) {
      if (t.localExported[i] === name) return localGetter(rec, name);
    }
    for (var j = 0; j < t.indirectExported.length; j++) {
      if (t.indirectExported[j] === name) {
        var dep = rec.deps[t.indirectReq[j]];
        if (t.indirectName[j] === '*') return namespaceGetter(dep);
        return resolveExport(dep, t.indirectName[j], seen);
      }
    }
    if (name === 'default') return null;
    var found = null;
    for (var k = 0; k < t.stars.length; k++) {
      var g = resolveExport(rec.deps[t.stars[k]], name, seen);
      if (g !== null) {
        if (found !== null) return null;
        found = g;
      }
    }
    return found;
  }

  function localGetter(rec, name) {
    return function () {
      return rec.local[name]();
    };
  }

  function exportNames(rec, out, seen) {
    for (var v = 0; v < seen.length; v++) {
      if (seen[v] === rec) return;
    }
    seen[seen.length] = rec;
    var t = rec.t;
    for (var i = 0; i < t.localExported.length; i++) out[t.localExported[i]] = true;
    for (var j = 0; j < t.indirectExported.length; j++) out[t.indirectExported[j]] = true;
    for (var k = 0; k < t.stars.length; k++) {
      var starred = ObjectCreate(null);
      exportNames(rec.deps[t.stars[k]], starred, seen);
      for (var key in starred) {
        if (key !== 'default') out[key] = true;
      }
    }
  }

  function namespace(rec) {
    if (rec.ns !== null) return rec.ns;
    var names = ObjectCreate(null);
    exportNames(rec, names, []);
    var keys = [];
    for (var key in names) keys[keys.length] = key;
    ArrayPrototypeSort(keys);
    var ns = ObjectCreate(null);
    for (var i = 0; i < keys.length; i++) {
      var getter = resolveExport(rec, keys[i], []);
      if (getter !== null) {
        ObjectDefineProperty(ns, keys[i], { __proto__: null, get: getter, enumerable: true });
      }
    }
    ObjectDefineProperty(ns, SymbolToStringTag, { __proto__: null, value: 'Module' });
    rec.ns = ObjectFreeze(ns);
    return rec.ns;
  }

  // Evaluates `rec` after its dependencies, in order. Returns undefined when the graph
  // below it finished synchronously, else a promise for its completion (top-level
  // await somewhere below). A throw is cached: evaluating the module again rethrows it.
  function evaluate(rec) {
    if (rec.status === S_EVALUATED) {
      if (rec.failed) throw rec.error;
      return rec.promise;
    }
    if (rec.status === S_EVALUATING) return rec.promise;
    rec.status = S_EVALUATING;
    try {
      rec.promise = evaluateFrom(rec, 0);
    } catch (error) {
      settle(rec, error);
      throw error;
    }
    if (rec.promise === undefined) rec.status = S_EVALUATED;
    return rec.promise;
  }

  function settle(rec, error) {
    rec.status = S_EVALUATED;
    rec.failed = true;
    rec.error = error;
  }

  function evaluateFrom(rec, from) {
    for (var i = from; i < rec.deps.length; i++) {
      var pending = evaluate(rec.deps[i]);
      if (pending !== undefined) {
        return ReflectApply(PromisePrototypeThen, pending, [
          function () {
            return evaluateFrom(rec, i + 1);
          },
          function (error) {
            settle(rec, error);
            throw error;
          },
        ]);
      }
    }
    if (!rec.async) {
      ReflectApply(GeneratorPrototypeNext, rec.gen, []);
      return undefined;
    }
    var step = ReflectApply(AsyncGeneratorPrototypeNext, rec.gen, []);
    return ReflectApply(PromisePrototypeThen, step, [
      function () {
        rec.status = S_EVALUATED;
        rec.promise = undefined;
      },
      function (error) {
        settle(rec, error);
        throw error;
      },
    ]);
  }

  // import(): fetch, link and evaluate on a later microtask, resolving to the namespace.
  function dynamicImport(specifier, base) {
    return ReflectApply(PromisePrototypeThen, PromiseResolve(undefined), [
      function () {
        var spec = StringCtor(specifier);
        var url;
        try {
          url = resolveSpecifier(spec, base);
        } catch (_) {
          // Chrome 158 words it shorter for import() than for a static import.
          throw pageError(new TypeErrorCtor("Failed to resolve module specifier '" + spec + "'"));
        }
        var rec;
        try {
          rec = fetchRecord(url);
        } catch (error) {
          if (isFetchError(error)) {
            throw pageError(
              new TypeErrorCtor('Failed to fetch dynamically imported module: ' + url),
            );
          }
          throw error;
        }
        link(rec);
        var pending = evaluate(rec);
        if (pending === undefined) return namespace(rec);
        return ReflectApply(PromisePrototypeThen, pending, [
          function () {
            return namespace(rec);
          },
        ]);
      },
    ]);
  }

  /**
   * Runs one module script: HTML's "create a JavaScript module script", fetch the
   * descendants, link, and "run a module script".
   * @param {string} source The script's text.
   * @param {string|null} url The script's URL, its key in the module map; null for an
   *   inline module script.
   * @param {string} base The URL its specifiers resolve against (and an inline
   *   script's import.meta.url): the document's for an inline script.
   * @param {string} name The name it runs under in a stack.
   * @returns {boolean} false when a module of its graph could not be fetched — the
   *   caller fires `error` at the element, as HTML does for a null result.
   * @throws A syntax, resolution or link error, or what the evaluation threw: the
   *   caller reports it as the page's uncaught error.
   * @node Chrome 158 (tests/dom/cases/dom-script-module.page): deferred, in document
   *   order, document.currentScript null, `this` undefined at the top level.
   * @deviates See the file comment.
   */
  function run(source, url, base, name) {
    var rec;
    try {
      if (url !== null && registry[url] !== undefined) rec = fetchRecord(url);
      else rec = instantiate(source, url, base, name);
    } catch (error) {
      if (isFetchError(error)) return false;
      throw error;
    }
    link(rec);
    var pending = evaluate(rec);
    if (pending !== undefined) {
      ReflectApply(PromisePrototypeThen, pending, [undefined, reportException]);
    }
    return true;
  }

  module.exports = { __proto__: null, run: run, transform: transform };
});
