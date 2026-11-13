// Detector for the spin-forever class: a GLOBAL-flag regex reaching a method that
// loops on RegExpExec.
//
// Why this is a script and not a sentence. `RegExp.prototype[Symbol.replace]` in global
// mode only advances `lastIndex` on an EMPTY match, so under a forged
// `RegExp.prototype.exec` it never returns. The tree-wide claim "no such site remains"
// was written into ROADMAP.md by hand five times and was wrong five times, because the
// ad-hoc pass behind it kept being narrower than the prose describing it:
//
//   pass 1  matched a regex LITERAL written at the call site       -> missed 3 sites
//   pass 2  added identifiers bound to a literal                   -> missed 1 site
//   pass 3  (this file) adds `new RegExp(pattern, 'g')` bindings
//
// So the recipe lives here, is exercised by its own fixtures in
// scripts/lib/global-replace-fixtures.mjs, and runs in `make check-js`. A detector that
// has gone blind must fail loudly rather than print a reassuring zero — the fixtures are
// checked before the tree is, exactly as the primordials ratchet does.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS_DIR = join(ROOT, 'pkg', 'runtime', 'js');

// The methods whose spec algorithm loops on RegExpExec when the pattern is global.
// `search` and a non-global `match` do a single exec and cannot spin, but they are
// included for `replace`/`replaceAll`/`matchAll`/`split`/`match` parity of reporting —
// a global regex reaching any of them is worth seeing.
const LOOPING = new Set(['replace', 'replaceAll', 'match', 'matchAll', 'split', 'search']);
const PRIMORDIAL_RE = /^StringPrototype(Replace|ReplaceAll|Match|MatchAll|Split|Search)$/;

// Sites that are known, declared, and deliberately still open. Each needs a reason and
// a tracking issue; the point of listing them here rather than deleting the
// check is that the count is enforced — a NEW site cannot hide behind an old one.
//
// Keys are stable: `file:bindingName` (or `file:how:what` for literals). Keying by
// line number (#337) broke the gate on every edit above the site and taught reviewers
// to ignore a hang alarm — three moves in one PR (#330: 572→607→609→660).
const ALLOWED = new Map([
  [
    'internal/util.js:ansiRegex',
    'stripVTControlCharacters: the ANSI pattern is two alternations (OSC terminated by ' +
      'BEL/ST, CSI terminated by a final byte), not a character class, so it has no ' +
      'code-unit rewrite. node hangs on it identically, so Lava is not diverging. ' +
      'Guarded by an indexOf short-circuit, so only input containing ESC/CSI reaches it.',
  ],
]);

// Stable allowlist identity for a hit. Prefer the binding name when the pattern is
// `name = …`; fall back to how+what so literal sites stay uniquely addressable.
export function allowKey(hit) {
  const m = typeof hit.what === 'string' ? hit.what.match(/^([A-Za-z_$][\w$]*)\s*=/) : null;
  if (m) return `${hit.file}:${m[1]}`;
  return `${hit.file}:${hit.how}:${hit.what}`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// Collect identifiers bound to a global-flag regex — both `/x/g` and
// `new RegExp(p, 'g')`. Module scope only; that is where every real instance lives, and
// a wider analysis would need real scope tracking for no observed benefit.
function globalRegexBindings(ast) {
  const found = new Map();
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const init = node.init;
      if (init?.type === 'Literal' && init.regex?.flags.includes('g')) {
        found.set(node.id.name, `/${init.regex.pattern}/${init.regex.flags}`);
      } else if (
        init?.type === 'NewExpression' &&
        init.callee?.type === 'Identifier' &&
        init.callee.name === 'RegExp'
      ) {
        // The flags argument is arg 1. A non-literal flags expression is reported as
        // unknown rather than assumed safe — failing loud beats a silent miss.
        const flags = init.arguments?.[1];
        if (!flags) return;
        if (flags.type === 'Literal' && typeof flags.value === 'string') {
          if (flags.value.includes('g')) found.set(node.id.name, `new RegExp(…, '${flags.value}')`);
        } else {
          found.set(node.id.name, 'new RegExp(…, <computed flags>)');
        }
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  })(ast);
  return found;
}

export function scanSource(source, label = '<source>') {
  const ast = acorn.parse(source, { ecmaVersion: 2023, locations: true });
  const bindings = globalRegexBindings(ast);
  const hits = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const args = node.arguments || [];
      let arg = null;
      let how = null;
      if (
        node.callee?.type === 'MemberExpression' &&
        !node.callee.computed &&
        LOOPING.has(node.callee.property?.name)
      ) {
        arg = args[0];
        how = `.${node.callee.property.name}()`;
      } else if (node.callee?.type === 'Identifier' && PRIMORDIAL_RE.test(node.callee.name)) {
        // The primordial wrappers take the receiver first, so the pattern is arg 1.
        arg = args[1];
        how = `${node.callee.name}()`;
      }
      if (arg) {
        if (arg.type === 'Literal' && arg.regex?.flags.includes('g')) {
          hits.push({
            line: node.loc.start.line,
            how,
            what: `/${arg.regex.pattern}/${arg.regex.flags}`,
            via: 'literal',
          });
        } else if (arg.type === 'Identifier' && bindings.has(arg.name)) {
          hits.push({
            line: node.loc.start.line,
            how,
            what: `${arg.name} = ${bindings.get(arg.name)}`,
            via: 'binding',
          });
        }
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  })(ast);
  return hits.map((h) => ({ ...h, file: label }));
}

export function scanTree() {
  const hits = [];
  for (const file of walk(JS_DIR).sort()) {
    const key = relative(JS_DIR, file).split(sep).join('/');
    for (const hit of scanSource(readFileSync(file, 'utf8'), key)) hits.push(hit);
  }
  return hits;
}

export { ALLOWED, JS_DIR };
