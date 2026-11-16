// ESM-to-CommonJS source transform.
//
// JavaScriptCore's classic C API (JSEvaluateScript) only runs *script*-goal
// source, so Lava cannot hand it `import` / `export` syntax directly. This module
// rewrites the static module syntax used by the Node compatibility corpus into an
// equivalent CommonJS body and wraps it so the existing native `require` resolves
// specifiers. The wrapper exposes `import.meta` (as `__import_meta`) and tags the
// resulting namespace with a non-enumerable `__esModule` flag so CJS<->ESM default
// interop matches Node/Babel/TS conventions.
//
// The scanner is string/template/comment-aware: a masking pass (buildMask) blanks
// every character inside a string, template literal, or comment so structural
// scanning (statement boundaries, brace depth, the import/export keywords
// themselves) never trips over `{` in a string, an `import` line inside a template
// literal, a commented-out `export`, or a trailing line comment.
//
// It handles only static, statement-position import/export forms. Anything it does
// not recognize (e.g. destructuring exports, top-level await) is surfaced as an
// explicit error rather than silently mistranslated. Dynamic `import()` and
// `import.meta` member access are left to JSC. Note: named imports/exports are
// value copies, not live bindings — a later mutation of an `export let` is not
// reflected in importers (a transform limitation, not modeled here).
//
// THREAT MODEL. What this file returns is EXECUTED SOURCE, which puts it a class
// above the rest of the hardened surface: a forged match group here is not a wrong
// answer or a hang, it is attacker-chosen code in the module body. `export default
// function foo` pulls the declared name out of a match group and interpolates it
// into the emitted CommonJS as an identifier, so a `RegExp.prototype.exec` that
// answers `['x', '0, (globalThis.pwned = 1)']` for that one pattern gets exactly
// that expression evaluated at module scope. Measured before this hardening:
// `pwned=CODE INJECTED` under Lava while node printed `pwned=undefined`
// (tests/node-compat/cases/58-esm-pollution.js, probe `targeted`). Reachability is
// ordinary rather than exotic — `exec` is a writable data property, and any CJS
// dependency required before the first `.mjs` can assign it.
//
// Four carriers, and the count is deliberately not "three": the first review of this
// file said three, and the fourth is both the cheapest to reach and the one the
// ratchet is structurally blind to. Carrier 2 is the one a RegExp-only pass would
// have left open.
//
//   1. The regexes. Every pattern is a LITERAL (a literal consults no `RegExp`
//      global, so it cannot be swapped) matched through the captured
//      `RegExpPrototypeExec`. `.match`/`.test`/`.replace(re, …)` are all gone:
//      each of them re-reads `R.exec` off the receiver per RegExpExec, so
//      capturing them would look like a fix and not be one. None of the patterns
//      is global-flagged, so the `lastIndex` spin url.js and fetch.js hit is absent.
//      That is NOT the same as "no DoS here", which an earlier version of this
//      comment claimed: `RE_IMPORT_FROM`'s lazy `[\s\S]+?` backtracks superlinearly,
//      measured through `bin/lava run` at 0.10 s / 0.30 s / 2.80 s for a whitespace
//      run of 500 / 1000 / 2000 after `import` (~8x per doubling). Accepted, not
//      fixed: the input is a local `.mjs`, and a `.mjs` you can write is one you can
//      execute. It is written down so the next reader does not re-derive "no DoS".
//   2. The scanner's character reads. buildMask decides what counts as string
//      versus code, so it decides which spans are eligible to be spliced out and
//      re-emitted at all. It read every character through a live
//      `String.prototype.charAt` and its mode stack through `Array.prototype.at`,
//      both ordinary writable properties: a gadget lying only about quote
//      characters makes a string body scan as code, and statement-shaped text the
//      module wrote as DATA is then transformed. Now code units through the
//      captured `StringPrototypeCharCodeAt`, with the stack read by index.
//   3. Emission. Every string literal in the output — require specifiers, export
//      keys, `__filename`/`__dirname`/`import.meta.url` — comes out of
//      `JSON.stringify` after a `String()` coercion. Both are captured; a replaced
//      `JSON.stringify` writes the emitted literals directly. The joins that assemble
//      the output are captured for the same reason: with `Array.prototype.join`
//      lying only for `'\n'`, the wrapper join hands an attacker the WHOLE emitted
//      module, which is strictly worse than carrier 1.
//   4. The transform's own result objects, which is the one the four-class ratchet
//      cannot count. `transformExport` carries an own `tail` on ONE of eight return
//      shapes, so `ex.tail` used to resolve off `Object.prototype` on the other
//      seven — and that value is joined into `tailStr` and emitted as executed
//      source. A data-only `{"__proto__":{"tail":["…"]}}` merge is therefore code
//      execution in the module body, needing no function value at all, i.e. a
//      CHEAPER gadget than carrier 1's forged `exec`. An absent-property read is
//      none of the four counted classes, so `esm.js` read 0/0/0/0 while this was
//      open. Closed by `__proto__: null` plus an own `tail` on every branch.
//
// It got FASTER, which is not the usual direction for a hardening pass and is worth
// recording so nobody "optimizes" it back — but only ONE of the three changes is
// responsible, and the first draft of this comment credited all three equally.
// Ablations reverting exactly one optimization at a time, same corpus:
//
//   preReplaceMeta's indexOf fast path   ~all of it. The old code rebuilt BOTH the
//                                        source and the mask one character at a time
//                                        on every module, whether or not
//                                        `import.meta` appeared. Most modules do not.
//   buildMask's run batching             ~1 ms here, but 2.4x on a 1 MB code-dominated
//                                        module — it earns its keep off this corpus,
//                                        not on it.
//   hoisting the regexes to literals     NOT resolvable against the noise floor, even
//                                        though it removes 660 `new RegExp` compiles
//                                        per run. It is a SECURITY change; do not
//                                        sell it as the speedup.
//
// Method, because a ratio without one is folklore: 61-module corpus (~600 bytes each,
// license block comment, template literals with nested `${}`, five export forms),
// `lava run` cold, medians of 21 interleaved launches per arm, this branch vs a build
// of origin/master. End to end 0.83x (86.0 -> 71.7 ms on a loaded box; 58.2 -> 48.5 ms
// quiet — the ratio is stable across sessions, the absolute ms are not, so trust the
// ratio).
//
// The transform's OWN ratio needs a control, and an earlier version of this comment
// got it wrong by subtracting only process startup: what survives that subtraction is
// transform + module resolution + JSC compile + evaluation, and the remainder is not
// small (14.1 ms here, against 25.9 ms of transform). Measured instead against a
// pre-transformed CommonJS twin of the same corpus — same module count, same bodies,
// no import/export syntax, so the transform never runs — the twin is unchanged between
// the two builds (0.99x, i.e. nothing outside the transform moved) and the transform
// itself is 39.7 -> 25.9 ms, 0.65x. An independent reviewer's harness on a
// differently generated corpus put it at 0.52x, so treat this as 0.5-0.65x rather than
// a third significant figure.
//
// RESIDUAL, deliberately out of scope: the wrapper text below calls
// `Object.defineProperty` and `require` in the TRANSFORMED module's own scope. Those
// run as part of the user's module, not as part of the transform, and every
// ESM-to-CJS compiler (Babel, tsc, esbuild) emits the same shape — hardening them
// would mean emitting a different program than the toolchain consensus.
//
// RESIDUAL, dormant rather than closed: `StringPrototypeSplit(inner, ',')` in
// splitSpecs. Per spec, `String.prototype.split` does `GetMethod(separator, @@split)`
// even for a primitive-string separator, so `String.prototype[Symbol.split]` steers it
// — a well-known SYMBOL, so there is no named property for the ratchet to count. It is
// inert on Lava only because JSC skips that lookup on the primitive-separator fast
// path (verified: the same gadget steers node and does not steer bin/lava), so it is
// engine behavior holding it shut, not this file. The blast radius if a WebKit bump
// changes that is identifier substitution, not arbitrary code — every element is
// gated by `isIdent`/`RE_SPEC_AS` — which is why it is recorded here rather than
// rewritten into a code-unit scan.
//
// This module cannot `require('internal/primordials')`: the runtime evaluates it standalone
// and keeps the result on Runtime_State rather than registering it as a requireable
// module (globals.odin), precisely so user code cannot reach the transform. It
// therefore takes the table as an argument — loader.js hands out the one already
// instantiated for everyone else.
//
// Evaluates to a factory: factory(primordials) -> transform(source, url, filename,
// dirname) -> string.
(function (primordials) {
  'use strict';

  var RegExpPrototypeExec = primordials.RegExpPrototypeExec;
  var StringPrototypeCharCodeAt = primordials.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = primordials.StringPrototypeSlice;
  var StringPrototypeIndexOf = primordials.StringPrototypeIndexOf;
  var StringPrototypeSplit = primordials.StringPrototypeSplit;
  var StringPrototypeTrim = primordials.StringPrototypeTrim;
  var ArrayPrototypePush1 = primordials.ArrayPrototypePush1;
  var ArrayPrototypePop = primordials.ArrayPrototypePop;
  var ArrayPrototypeJoin = primordials.ArrayPrototypeJoin;
  var JSONStringify = primordials.JSONStringify;
  var StringG = primordials.String;
  var ErrorG = primordials.Error;

  /**
   * Renders `value` as a JavaScript string literal for emission into the output.
   * @param {*} value
   * @returns {string}
   * @node No Node counterpart — this is Lava's transform, not a spec surface.
   * @deviates none
   */
  function jsonString(value) {
    return JSONStringify(StringG(value));
  }

  // --- character classes, as code-unit predicates --------------------------
  //
  // These replace `/[\w$]/.test(c)` and `new RegExp('^' + IDENT + '$')`. A plain
  // character class does not need a regex at all, and CLAUDE.md §5 prefers the
  // code-unit loop: it is immune by construction rather than by capture, and it
  // skips the RegExp machinery on a path that runs per import specifier.

  // `[A-Za-z_$]` — the first code unit of an identifier.
  function isIdentStart(c) {
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24;
  }

  // `[\w$]` — `\w` is [A-Za-z0-9_], plus `$`.
  function isIdentPart(c) {
    return isIdentStart(c) || (c >= 0x30 && c <= 0x39);
  }

  // `^[A-Za-z_$][\w$]*$`. Empty is false, matching the anchored pattern.
  function isIdent(s) {
    var n = s.length;
    if (n === 0 || !isIdentStart(StringPrototypeCharCodeAt(s, 0))) return false;
    for (var i = 1; i < n; i++) {
      if (!isIdentPart(StringPrototypeCharCodeAt(s, i))) return false;
    }
    return true;
  }

  // Length of the identifier at the START of `s`, or 0 — `^([A-Za-z_$][\w$]*)`
  // used as an extractor rather than a predicate.
  function identLength(s) {
    var n = s.length;
    if (n === 0 || !isIdentStart(StringPrototypeCharCodeAt(s, 0))) return 0;
    var i = 1;
    while (i < n && isIdentPart(StringPrototypeCharCodeAt(s, i))) i++;
    return i;
  }

  // Regex `\s`: ES WhiteSpace plus LineTerminator. Spelled out in full rather than
  // narrowed to the ASCII five, because the `\s*$` strips these replace would have
  // eaten a trailing NBSP and narrowing it would be a silent behavior change.
  function isSpace(c) {
    return (
      c === 0x20 ||
      (c >= 0x09 && c <= 0x0d) ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    );
  }

  // `s.replace(/\s+$/, '')`.
  function stripTrailingSpace(s) {
    var end = s.length;
    while (end > 0 && isSpace(StringPrototypeCharCodeAt(s, end - 1))) end--;
    return end === s.length ? s : StringPrototypeSlice(s, 0, end);
  }

  // `s.replace(/;?\s*$/, '')` — trailing whitespace, then ONE optional semicolon.
  // Whitespace BEFORE that semicolon survives, because the pattern is leftmost-first
  // and `\s*` cannot span the `;`: `'foo ;  '` -> `'foo '`, not `'foo'`.
  function stripTrailingSemi(s) {
    var end = s.length;
    while (end > 0 && isSpace(StringPrototypeCharCodeAt(s, end - 1))) end--;
    if (end > 0 && StringPrototypeCharCodeAt(s, end - 1) === 0x3b) end--;
    return end === s.length ? s : StringPrototypeSlice(s, 0, end);
  }

  // `s.replace(/^(?:const|let|var)\s+/, '')`. The `\s+` is required: a keyword not
  // followed by whitespace is not a declaration head and `s` comes back untouched.
  function stripDeclKeyword(s) {
    var kwLen = 0;
    if (StringPrototypeSlice(s, 0, 5) === 'const') kwLen = 5;
    else {
      var three = StringPrototypeSlice(s, 0, 3);
      if (three === 'let' || three === 'var') kwLen = 3;
      else return s;
    }
    var i = kwLen;
    while (i < s.length && isSpace(StringPrototypeCharCodeAt(s, i))) i++;
    return i === kwLen ? s : StringPrototypeSlice(s, i);
  }

  // The operator/comma set that makes a newline a CONTINUATION rather than a
  // statement end — `'+-*/%=<>&|^,.?:('.indexOf(ch) !== -1` without the live indexOf.
  function isContinuation(c) {
    return (
      c === 0x2b || // +
      c === 0x2d || // -
      c === 0x2a || // *
      c === 0x2f || // /
      c === 0x25 || // %
      c === 0x3d || // =
      c === 0x3c || // <
      c === 0x3e || // >
      c === 0x26 || // &
      c === 0x7c || // |
      c === 0x5e || // ^
      c === 0x2c || // ,
      c === 0x2e || // .
      c === 0x3f || // ?
      c === 0x3a || // :
      c === 0x28 //    (
    );
  }

  // --- patterns ------------------------------------------------------------
  //
  // LITERALS, hoisted to module scope. Two reasons, and the first is the load-bearing
  // one: a literal is compiled by the parser and consults no `RegExp` global, so
  // unlike `new RegExp(...)` it cannot be pointed at a different constructor. The
  // second is hygiene — these used to be rebuilt from string concatenation on every
  // import specifier and every export statement, compiling a fresh regex per binding
  // (660 `new RegExp` per run of the 61-module bench corpus). Do not sell that as the
  // speedup: an ablation that reverts ONLY the hoisting is not resolvable against the
  // noise floor, so this is a security change that happens to remove work.
  //
  // Sharing one object across calls is safe because none carries the `g` flag. The
  // precise reason is not "non-global exec ignores lastIndex" — RegExpBuiltinExec does
  // `Get(R, "lastIndex")` unconditionally and merely DISCARDS it when the regex is
  // neither global nor sticky, and it skips only the write-back. What makes sharing
  // safe is that discard plus the fact that `lastIndex` is a non-configurable own data
  // property of a literal, on objects unreachable from user code.
  //
  // Every `[A-Za-z_$][\w$]*` below is the identifier pattern that used to be spliced
  // in as the `IDENT` variable; isIdent()/identLength() above are the same class.
  var RE_IMPORT_BARE = /^import\s+(['"])([^'"]*)\1\s*;?\s*$/;
  var RE_IMPORT_FROM = /^import\s+([\s\S]+?)\s+from\s+(['"])([^'"]*)\2\s*;?\s*$/;
  var RE_SPEC_AS = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/;
  var RE_CLAUSE_DEFAULT_STAR = /^([A-Za-z_$][\w$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)$/;
  var RE_CLAUSE_DEFAULT_NAMED = /^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*)\}$/;
  var RE_CLAUSE_STAR = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/;
  var RE_CLAUSE_NAMED = /^\{([\s\S]*)\}$/;
  var RE_EXPORT_DEFAULT = /^export\s+default\s+([\s\S]+)$/;
  var RE_DEFAULT_FUNCTION = /^(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)/;
  var RE_DEFAULT_CLASS = /^class\s+([A-Za-z_$][\w$]*)\b/;
  var RE_EXPORT_NAMED_FROM = /^export\s+\{([\s\S]*)\}\s+from\s+(['"])([^'"]*)\2\s*;?\s*$/;
  var RE_EXPORT_STAR_FROM = /^export\s+\*\s+from\s+(['"])([^'"]*)\1\s*;?\s*$/;
  var RE_EXPORT_NAMED = /^export\s+\{([\s\S]*)\}\s*;?\s*$/;
  var RE_EXPORT_DECL = /^export\s+((?:const|let|var)\b[\s\S]*)$/;
  var RE_EXPORT_FUNCTION =
    /^export\s+((?:async\s+function|function|class)\s+([A-Za-z_$][\w$]*)[\s\S]*)$/;

  var IMPORT_META = 'import.meta';
  var IMPORT_META_CJS = '__import_meta';

  // buildMask returns a copy of `src` with every character inside a string, a
  // template literal, a line comment, or a block comment replaced by a space.
  // Template `${ ... }` expressions are kept as code so nested braces/strings are
  // tracked correctly. The result is used only for structural scanning; the original
  // source is what gets emitted.
  //
  // LENGTH parity is the invariant — every index into the mask means the same index
  // into the source, which is what lets preReplaceMeta and the main scan slice one
  // using offsets found in the other. NEWLINE parity is NOT, and the difference is
  // deliberate: an escape pair inside a string emits two spaces even when the escaped
  // character is a line terminator, so a line continuation loses its newline in the
  // mask. Do not "fix" that — it is load-bearing in the opposite direction. Emitting
  // the terminator instead puts a `\n` at depth 0 in the middle of an import
  // statement, and findStmtEnd ends the statement there: `import d from './dep\<LF>
  // .mjs';` degrades from a resolvable specifier to `unsupported import form`.
  // Verified by applying that exact change and re-running.
  //
  // Code spans are copied one SLICE at a time rather than one character at a time:
  // the mask is identical to the source across a run of ordinary code, so the only
  // characters worth handling individually are the ones being blanked. Masked spans
  // still append per character, which keeps this shaped like the original.
  function buildMask(src) {
    var n = src.length;
    var out = '';
    // Stack of modes: 'code' (with brace depth for ${} tracking), 'line',
    // 'block', 'sq' (single-quote), 'dq' (double-quote), 'tpl' (template).
    var stack = [{ mode: 'code', brace: 0 }];
    // Start of the verbatim code run not yet copied, or -1 when no run is open
    // (i.e. we are inside a masked mode and every character is being blanked).
    var runStart = 0;
    function flushRun(upto) {
      if (runStart >= 0 && upto > runStart) out += StringPrototypeSlice(src, runStart, upto);
      runStart = -1;
    }
    var i = 0;
    while (i < n) {
      var c = StringPrototypeCharCodeAt(src, i);
      var d = i + 1 < n ? StringPrototypeCharCodeAt(src, i + 1) : -1;
      var top = stack[stack.length - 1];
      var m = top.mode;

      if (m === 'code') {
        if (c === 0x2f && d === 0x2f) {
          // //
          flushRun(i);
          ArrayPrototypePush1(stack, { mode: 'line', brace: 0 });
          out += '  ';
          i += 2;
          continue;
        }
        if (c === 0x2f && d === 0x2a) {
          // /*
          flushRun(i);
          ArrayPrototypePush1(stack, { mode: 'block', brace: 0 });
          out += '  ';
          i += 2;
          continue;
        }
        if (c === 0x27) {
          // '
          flushRun(i);
          ArrayPrototypePush1(stack, { mode: 'sq', brace: 0 });
          out += ' ';
          i++;
          continue;
        }
        if (c === 0x22) {
          // "
          flushRun(i);
          ArrayPrototypePush1(stack, { mode: 'dq', brace: 0 });
          out += ' ';
          i++;
          continue;
        }
        if (c === 0x60) {
          // `
          flushRun(i);
          ArrayPrototypePush1(stack, { mode: 'tpl', brace: 0 });
          out += ' ';
          i++;
          continue;
        }
        if (c === 0x7b) {
          // { — verbatim, so it stays inside the open run
          top.brace++;
          i++;
          continue;
        }
        if (c === 0x7d) {
          // }
          if (top.brace === 0 && stack.length > 1 && stack[stack.length - 2].mode === 'tpl') {
            // Closes a `${ ... }` template expression; the brace belongs to the
            // template, so blank it (it is not a statement brace). Popping the code
            // frame returns to 'tpl', which is masked, so no run reopens here.
            flushRun(i);
            ArrayPrototypePop(stack);
            out += ' ';
            i++;
            continue;
          }
          if (top.brace > 0) top.brace--;
          i++;
          continue;
        }
        i++;
        continue;
      }

      if (m === 'line') {
        if (c === 0x0a) {
          ArrayPrototypePop(stack);
          out += '\n';
          runStart = i + 1;
        } else {
          out += ' ';
        }
        i++;
        continue;
      }

      if (m === 'block') {
        if (c === 0x2a && d === 0x2f) {
          // */
          ArrayPrototypePop(stack);
          out += '  ';
          i += 2;
          runStart = i;
          continue;
        }
        out += c === 0x0a ? '\n' : ' ';
        i++;
        continue;
      }

      if (m === 'sq' || m === 'dq') {
        if (c === 0x5c && d >= 0) {
          out += '  ';
          i += 2;
          continue;
        }
        if ((m === 'sq' && c === 0x27) || (m === 'dq' && c === 0x22)) {
          ArrayPrototypePop(stack);
          out += ' ';
          i++;
          runStart = i;
          continue;
        }
        out += c === 0x0a ? '\n' : ' ';
        i++;
        continue;
      }

      if (m === 'tpl') {
        if (c === 0x5c && d >= 0) {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === 0x60) {
          ArrayPrototypePop(stack);
          out += ' ';
          i++;
          runStart = i;
          continue;
        }
        if (c === 0x24 && d === 0x7b) {
          // Enter a template expression: subsequent chars are code until the
          // matching `}` (tracked via the code frame's brace depth above).
          ArrayPrototypePush1(stack, { mode: 'code', brace: 0 });
          out += '  ';
          i += 2;
          runStart = i;
          continue;
        }
        out += c === 0x0a ? '\n' : ' ';
        i++;
        continue;
      }

      // Unreachable, but keep length parity defensively.
      out += c === 0x0a ? '\n' : ' ';
      i++;
    }
    flushRun(n);
    return out;
  }

  // preReplaceMeta rewrites `import.meta` -> `__import_meta` everywhere it appears
  // as real code (per the mask), keeping src and mask in sync (the replacement is
  // all code, so the mask copy is identical). Done up front so the statement
  // scanner never mistakes `import.meta` for an import statement and so member
  // access works inside any expression.
  //
  // Searching the mask means an `import.meta` inside a string or comment is not a
  // match — the mask has blanked it. The no-match case returns both inputs
  // untouched, which is most modules: this used to rebuild the entire source one
  // character at a time whether or not there was anything to replace.
  function preReplaceMeta(src, mask) {
    var at = StringPrototypeIndexOf(mask, IMPORT_META);
    if (at === -1) return { __proto__: null, src: src, mask: mask };
    var srcParts = [];
    var maskParts = [];
    var from = 0;
    while (at !== -1) {
      ArrayPrototypePush1(srcParts, StringPrototypeSlice(src, from, at));
      ArrayPrototypePush1(maskParts, StringPrototypeSlice(mask, from, at));
      ArrayPrototypePush1(srcParts, IMPORT_META_CJS);
      ArrayPrototypePush1(maskParts, IMPORT_META_CJS);
      from = at + IMPORT_META.length;
      at = StringPrototypeIndexOf(mask, IMPORT_META, from);
    }
    ArrayPrototypePush1(srcParts, StringPrototypeSlice(src, from));
    ArrayPrototypePush1(maskParts, StringPrototypeSlice(mask, from));
    return {
      __proto__: null,
      src: ArrayPrototypeJoin(srcParts, ''),
      mask: ArrayPrototypeJoin(maskParts, ''),
    };
  }

  // splitTopLevel splits `text` on the code unit `sep` at brace/paren/bracket depth
  // 0, ignoring separators inside strings/comments/templates (via a fresh mask).
  function splitTopLevel(text, sep) {
    var mask = buildMask(text);
    var out = [];
    var depth = 0;
    var start = 0;
    for (var k = 0; k < text.length; k++) {
      var ch = StringPrototypeCharCodeAt(mask, k);
      if (ch === 0x28 || ch === 0x5b || ch === 0x7b) depth++;
      else if (ch === 0x29 || ch === 0x5d || ch === 0x7d) {
        if (depth > 0) depth--;
      } else if (ch === sep && depth === 0) {
        ArrayPrototypePush1(out, StringPrototypeSlice(text, start, k));
        start = k + 1;
      }
    }
    ArrayPrototypePush1(out, StringPrototypeSlice(text, start));
    return out;
  }

  // Split a `{ a, b as c }` binding list into trimmed, non-empty specifiers.
  function splitSpecs(inner) {
    var out = [];
    var parts = StringPrototypeSplit(inner, ',');
    for (var i = 0; i < parts.length; i++) {
      var p = StringPrototypeTrim(parts[i]);
      if (p) ArrayPrototypePush1(out, p);
    }
    return out;
  }

  // Render an import binding list as an object-destructuring pattern. `a` stays
  // `a`; `a as b` becomes `a: b`; the reserved `default` is a valid key here.
  function destructurePattern(inner) {
    var specs = splitSpecs(inner);
    var rendered = [];
    for (var i = 0; i < specs.length; i++) {
      var p = specs[i];
      var as = RegExpPrototypeExec(RE_SPEC_AS, p);
      if (as) {
        ArrayPrototypePush1(rendered, as[1] + ': ' + as[2]);
        continue;
      }
      if (isIdent(p)) {
        ArrayPrototypePush1(rendered, p);
        continue;
      }
      throw new ErrorG('lava ESM transform: unsupported import binding: ' + p);
    }
    return ArrayPrototypeJoin(rendered, ', ');
  }

  // Parse an export binding list into {local, exported} pairs. `a` exports `a`;
  // `a as b` exports local `a` under the name `b`.
  function parseExportSpecs(inner) {
    var specs = splitSpecs(inner);
    var pairs = [];
    for (var i = 0; i < specs.length; i++) {
      var p = specs[i];
      var as = RegExpPrototypeExec(RE_SPEC_AS, p);
      if (as) {
        ArrayPrototypePush1(pairs, { local: as[1], exported: as[2] });
        continue;
      }
      if (isIdent(p)) {
        ArrayPrototypePush1(pairs, { local: p, exported: p });
        continue;
      }
      throw new ErrorG('lava ESM transform: unsupported export specifier: ' + p);
    }
    return pairs;
  }

  // firstLine is the head of `stmt`, for an error message — without allocating the
  // whole split just to read element 0.
  function firstLine(stmt) {
    var nl = StringPrototypeIndexOf(stmt, '\n');
    return nl === -1 ? stmt : StringPrototypeSlice(stmt, 0, nl);
  }

  /**
   * Rewrites ES module `source` into a self-contained CommonJS expression.
   * @param {string} source Module source; coerced with the captured String.
   * @param {string} url Value exposed as `import.meta.url`.
   * @param {string} filename Absolute path, emitted as `__filename`.
   * @param {string} dirname Directory `require` resolves relative specifiers against.
   * @returns {string} A parenthesized expression evaluating to the namespace object.
   * @throws {Error} On an import/export form the transform does not recognize —
   *         explicitly, rather than mistranslating it.
   * @node Not a Node surface: node's ESM loader is native and needs no transform.
   *       That is what makes node an oracle for the pollution case rather than a
   *       peer implementation — it is immune to every gadget in
   *       tests/node-compat/cases/58-esm-pollution.js, so its output is the answer
   *       Lava must match.
   * @deviates Named imports/exports are value copies, not live bindings (see the
   *       header): after `bump()`, node reports the mutated `counter` and Lava
   *       reports the value at import time. UNPINNED, stated plainly rather than
   *       credited to a test that does not cover it — an earlier version of this tag
   *       named 12-esm-features.mjs, which exports only `const`/`function` and
   *       cannot pin it. No oracle case can: the deviation IS a node-vs-Lava byte
   *       divergence, so any case exercising it would fail test-compat-lava by
   *       construction. Closing it needs a Lava-only pin; tracked in ROADMAP.
   */
  function transform(source, url, filename, dirname) {
    source = StringG(source);
    var pre = preReplaceMeta(source, buildMask(source));
    var src = pre.src;
    var mask = pre.mask;
    var n = src.length;

    var pieces = []; // verbatim gaps + transformed statements, emitted in order
    var tail = []; // deferred local named-export assignments (`export { ... }`)
    var counter = 0;

    function nextTemp(prefix) {
      counter++;
      return prefix + counter;
    }

    // --- statement-position detection over the mask ---

    function isStmtStart(pos) {
      for (var k = pos - 1; k >= 0; k--) {
        var ch = StringPrototypeCharCodeAt(mask, k);
        if (ch === 0x20 || ch === 0x09 || ch === 0x0d || ch === 0x0a) continue;
        // ; { }
        return ch === 0x3b || ch === 0x7b || ch === 0x7d;
      }
      return true; // start of source
    }

    function keywordAt(pos) {
      var kw = StringPrototypeSlice(mask, pos, pos + 6);
      if (kw !== 'import' && kw !== 'export') return null;
      var after = pos + 6 < n ? StringPrototypeCharCodeAt(mask, pos + 6) : -1;
      // Must be a word boundary (not `imported`, `exports`).
      if (after >= 0 && isIdentPart(after)) return null;
      return kw;
    }

    // Code unit of the first non-space character at or after `pos`, or -1.
    function firstNonSpaceAfter(pos) {
      for (var k = pos; k < n; k++) {
        var ch = StringPrototypeCharCodeAt(mask, k);
        if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0d && ch !== 0x0a) return ch;
      }
      return -1;
    }

    // findStmtEnd scans from `from` to the end of the import/export statement: the
    // first `;` at depth 0, or a newline at depth 0 that is not a continuation
    // (the previous meaningful char is not an operator/comma). Returns the index
    // just past the terminator (exclusive of a terminating newline).
    function findStmtEnd(from) {
      var depth = 0;
      var lastMeaningful = -1;
      // Before any meaningful character, a newline continues the statement. This
      // used to fall out of `'+-*/%=<>&|^,.?:('.indexOf('')` returning 0 rather than
      // -1; it is load-bearing for `import\n  foo from './x.mjs';`, so it is spelled
      // out now instead of riding on that.
      var seenMeaningful = false;
      for (var k = from; k < n; k++) {
        var ch = StringPrototypeCharCodeAt(mask, k);
        if (ch === 0x28 || ch === 0x5b || ch === 0x7b) {
          depth++;
          lastMeaningful = ch;
          seenMeaningful = true;
        } else if (ch === 0x29 || ch === 0x5d || ch === 0x7d) {
          if (depth > 0) depth--;
          lastMeaningful = ch;
          seenMeaningful = true;
        } else if (ch === 0x3b && depth === 0) {
          return k + 1;
        } else if (ch === 0x0a && depth === 0) {
          // Continuation if the line ended on an operator or comma.
          if (!seenMeaningful || isContinuation(lastMeaningful)) continue;
          return k;
        } else if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0d && ch !== 0x0a) {
          lastMeaningful = ch;
          seenMeaningful = true;
        }
      }
      return n;
    }

    function transformImport(stmt) {
      // Side-effect import: `import 'spec';`
      var m = RegExpPrototypeExec(RE_IMPORT_BARE, stmt);
      if (m) return 'require(' + jsonString(m[2]) + ');';

      m = RegExpPrototypeExec(RE_IMPORT_FROM, stmt);
      if (!m) return null;
      var clause = StringPrototypeTrim(m[1]);
      var req = 'require(' + jsonString(m[3]) + ')';

      // default, * as ns
      var dm = RegExpPrototypeExec(RE_CLAUSE_DEFAULT_STAR, clause);
      if (dm) {
        var t1 = nextTemp('__lava_imp_');
        return (
          'var ' +
          t1 +
          ' = ' +
          req +
          '; var ' +
          dm[1] +
          ' = __importDefault(' +
          t1 +
          '); var ' +
          dm[2] +
          ' = __importStar(' +
          t1 +
          ');'
        );
      }
      // default, { named }
      dm = RegExpPrototypeExec(RE_CLAUSE_DEFAULT_NAMED, clause);
      if (dm) {
        var t2 = nextTemp('__lava_imp_');
        return (
          'var ' +
          t2 +
          ' = ' +
          req +
          '; var ' +
          dm[1] +
          ' = __importDefault(' +
          t2 +
          '); var { ' +
          destructurePattern(dm[2]) +
          ' } = ' +
          t2 +
          ';'
        );
      }
      // * as ns
      dm = RegExpPrototypeExec(RE_CLAUSE_STAR, clause);
      if (dm) return 'var ' + dm[1] + ' = __importStar(' + req + ');';
      // { named }
      dm = RegExpPrototypeExec(RE_CLAUSE_NAMED, clause);
      if (dm) return 'var { ' + destructurePattern(dm[1]) + ' } = ' + req + ';';
      // default
      if (isIdent(clause)) return 'var ' + clause + ' = __importDefault(' + req + ');';

      return null;
    }

    function transformExport(stmt) {
      // export default <expr|decl>
      var m = RegExpPrototypeExec(RE_EXPORT_DEFAULT, stmt);
      if (m) {
        var expr = stripTrailingSemi(m[1]);
        // A named function/class declaration keeps its binding: declare it (so a
        // hoisted module-scope name exists) and assign it as the default — rather
        // than turning it into an anonymous expression that loses `foo`.
        var fn = RegExpPrototypeExec(RE_DEFAULT_FUNCTION, expr);
        if (fn) {
          return {
            __proto__: null,
            body: expr + '; module.exports["default"] = ' + fn[1] + ';',
            tail: null,
          };
        }
        var cls = RegExpPrototypeExec(RE_DEFAULT_CLASS, expr);
        if (cls) {
          return {
            __proto__: null,
            body: expr + '; module.exports["default"] = ' + cls[1] + ';',
            tail: null,
          };
        }
        return { __proto__: null, body: 'module.exports["default"] = ' + expr + ';', tail: null };
      }
      // export { ... } from 'spec'  (re-export named)
      m = RegExpPrototypeExec(RE_EXPORT_NAMED_FROM, stmt);
      if (m) {
        var pairs = parseExportSpecs(m[1]);
        var t = nextTemp('__lava_reexp_');
        var s = '{ var ' + t + ' = require(' + jsonString(m[3]) + ');';
        for (var i = 0; i < pairs.length; i++) {
          s +=
            ' module.exports[' +
            jsonString(pairs[i].exported) +
            '] = ' +
            t +
            '[' +
            jsonString(pairs[i].local) +
            '];';
        }
        return { __proto__: null, body: s + ' }', tail: null };
      }
      // export * from 'spec'  (re-export all but default)
      m = RegExpPrototypeExec(RE_EXPORT_STAR_FROM, stmt);
      if (m) {
        var ta = nextTemp('__lava_reexp_');
        return {
          __proto__: null,
          tail: null,
          body:
            '{ var ' +
            ta +
            ' = require(' +
            jsonString(m[2]) +
            '); for (var __k in ' +
            ta +
            ') { if (__k !== "default") module.exports[__k] = ' +
            ta +
            '[__k]; } }',
        };
      }
      // export { ... }  (local named export) — deferred to the tail so names
      // declared anywhere in the module body are in scope when assigned.
      m = RegExpPrototypeExec(RE_EXPORT_NAMED, stmt);
      if (m) {
        var locals = parseExportSpecs(m[1]);
        var t2 = [];
        for (var j = 0; j < locals.length; j++) {
          ArrayPrototypePush1(
            t2,
            'module.exports[' + jsonString(locals[j].exported) + '] = ' + locals[j].local + ';',
          );
        }
        return { __proto__: null, body: '', tail: t2 };
      }
      // export const|let|var NAME = ... (possibly multiple declarators) — declare
      // and assign each exported name in place, so a multi-declarator list exports
      // every name and a cycle partner sees them as the body runs.
      m = RegExpPrototypeExec(RE_EXPORT_DECL, stmt);
      if (m) {
        var decl = stripTrailingSemi(m[1]);
        var names = declaratorNames(decl);
        var assigns = '';
        for (var d = 0; d < names.length; d++) {
          assigns += ' module.exports[' + jsonString(names[d]) + '] = ' + names[d] + ';';
        }
        return { __proto__: null, body: decl + ';' + assigns, tail: null };
      }
      // export [async] function NAME / export class NAME — declare and assign in
      // place (function declarations hoist, so the export is visible eagerly).
      m = RegExpPrototypeExec(RE_EXPORT_FUNCTION, stmt);
      if (m) {
        return {
          __proto__: null,
          tail: null,
          body:
            stripTrailingSemi(m[1]) + '; module.exports[' + jsonString(m[2]) + '] = ' + m[2] + ';',
        };
      }
      return null;
    }

    // declaratorNames extracts the bound names from a `const|let|var a = 1, b = 2`
    // declaration (top-level comma split, leading identifier of each declarator).
    function declaratorNames(decl) {
      var rest = stripDeclKeyword(decl);
      var parts = splitTopLevel(rest, 0x2c); // ,
      var names = [];
      for (var i = 0; i < parts.length; i++) {
        var p = StringPrototypeTrim(parts[i]);
        var len = identLength(p);
        if (len === 0) {
          throw new ErrorG('lava ESM transform: unsupported export declaration: ' + p);
        }
        ArrayPrototypePush1(names, StringPrototypeSlice(p, 0, len));
      }
      return names;
    }

    // --- main scan: copy verbatim, transform import/export statements in place ---

    var i = 0;
    var depth = 0;
    var lastCopy = 0;
    while (i < n) {
      var c = StringPrototypeCharCodeAt(mask, i);
      if (c === 0x28 || c === 0x5b || c === 0x7b) {
        depth++;
        i++;
        continue;
      }
      if (c === 0x29 || c === 0x5d || c === 0x7d) {
        if (depth > 0) depth--;
        i++;
        continue;
      }
      // i | e
      if (depth === 0 && (c === 0x69 || c === 0x65)) {
        var kw = keywordAt(i);
        if (kw && isStmtStart(i)) {
          var after = firstNonSpaceAfter(i + 6);
          // Leave dynamic import() and import.meta (already rewritten) to JSC.
          if (kw === 'import' && (after === 0x28 || after === 0x2e)) {
            i += 6;
            continue;
          }
          var end = findStmtEnd(i + 6);
          var stmt = stripTrailingSpace(StringPrototypeSlice(src, i, end));
          // Emit the verbatim gap before this statement.
          ArrayPrototypePush1(pieces, StringPrototypeSlice(src, lastCopy, i));
          if (kw === 'import') {
            var im = transformImport(stmt);
            if (im === null) {
              throw new ErrorG('lava ESM transform: unsupported import form: ' + firstLine(stmt));
            }
            ArrayPrototypePush1(pieces, im);
          } else {
            var ex = transformExport(stmt);
            if (ex === null) {
              throw new ErrorG('lava ESM transform: unsupported export form: ' + firstLine(stmt));
            }
            // `ex` is null-prototype and carries an own `tail` on every branch, which
            // is load-bearing rather than tidy: `tail` is present on ONE of the eight
            // return shapes, so on the other seven this read used to walk the chain to
            // `Object.prototype.tail` — and whatever it found was joined into `tailStr`
            // and emitted as executed source. A data-only `{"__proto__":{"tail":[…]}}`
            // merge was therefore full code execution in the module body, a CHEAPER
            // gadget than the forged `exec` this file was hardened against (that one
            // needs a function value). The ratchet cannot see it: an absent-property
            // read is none of the four counted classes. Probe `tail:` in
            // tests/node-compat/cases/58-esm-pollution.js, with a mutation entry.
            if (ex.body) ArrayPrototypePush1(pieces, ex.body);
            if (ex.tail) {
              for (var ti = 0; ti < ex.tail.length; ti++) {
                ArrayPrototypePush1(tail, ex.tail[ti]);
              }
            }
          }
          lastCopy = end;
          i = end;
          continue;
        }
      }
      i++;
    }
    ArrayPrototypePush1(pieces, StringPrototypeSlice(src, lastCopy));

    var bodyStr = ArrayPrototypeJoin(pieces, '');
    var tailStr = ArrayPrototypeJoin(tail, '\n');

    return ArrayPrototypeJoin(
      [
        '(function(){',
        'var module = { exports: {}, children: [] };',
        'var exports = module.exports;',
        'Object.defineProperty(module.exports, "__esModule", { value: true });',
        // Register this module's (still-empty) namespace in the loader cache BEFORE
        // running the body, mirroring the CommonJS wrapper's __lava_precache. Without
        // this an ESM<->ESM import cycle (A imports B imports A) re-enters require
        // with nothing cached and recurses to a stack overflow; with it the cycle
        // partner sees the partial namespace, matching Node. (__lava_precache is a
        // no-op for `lava eval` sources, where the global is absent.)
        'if (typeof __lava_precache === "function") __lava_precache(' +
          jsonString(filename) +
          ', module.exports);',
        'function __importDefault(m){ return (m && m.__esModule) ? m["default"] : m; }',
        'function __importStar(m){ if (m && m.__esModule) return m; var ns = {}; if (m) { for (var k in m) ns[k] = m[k]; } ns["default"] = m; return ns; }',
        '(function(require, module, exports, __filename, __dirname, __import_meta){',
        '"use strict";',
        bodyStr,
        tailStr,
        // Bind require to this module's directory so relative specifiers (and any
        // deferred require) resolve against it, not the entry file's directory.
        '})(function(s){ return require(s, ' +
          jsonString(dirname) +
          '); }, module, exports, ' +
          jsonString(filename) +
          ', ' +
          jsonString(dirname) +
          ', { url: ' +
          jsonString(url) +
          ' });',
        'return module.exports;',
        '})()',
      ],
      '\n',
    );
  }

  return transform;
});
