// Two layout rules no formatter here enforces, for Odin and C/C++ (CLAUDE.md §4):
//
//   1. A block opened on the same line as its `if`, `else`, `for`, `when` or `defer if`
//      is spread over lines: `if x {return 2}` becomes three lines. odinfmt's convert_do
//      turns `if x do y` into the one-line form, and clang-format's InsertBraces adds the
//      braces in C, so after them every `if` has braces and this makes them multi-line.
//   2. An `if` statement has a blank line before and after it, unless it opens or closes
//      a block or a case: a `{` or `case …:` line just above, a `}` or `case` just below.
//      Comments directly above an `if` belong to it, so the blank line goes above them.
//
// Line-based on purpose: both rules are about lines, and a parser per language would be
// far more code than the rules. It tracks just enough lexical state to be safe — strings,
// runes, line and block comments, and Odin's multi-line raw strings (embedded JS in the
// tests is full of `if`) — and leaves any line it cannot read with confidence alone.
//
// Usage: node scripts/fmt-if.mjs <file|dir>...   (rewrites in place; idempotent)

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const EXTS = new Set(['.odin', '.c', '.h', '.cpp', '.hpp']);
const BLOCK_KEYWORD = /^(\} else if |\} else \{|if |else |for |when |defer if |\} else when )/;

/**
 * Splits `line` into code characters and everything else, carrying multi-line state.
 * Returns per-character flags `code[i]` (true outside strings and comments) and the
 * state at the end of the line.
 */
function scan(line, state, isC) {
  const code = new Array(line.length).fill(false);
  let { raw, block } = state;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (raw) {
      if (ch === '`') raw = false;
      continue;
    }
    if (block) {
      if (ch === '*' && line[i + 1] === '/') {
        block = false;
        i++;
      }
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') {
      block = true;
      i++;
      continue;
    }
    if (ch === '`' && !isC) {
      raw = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      for (i++; i < line.length && line[i] !== quote; i++) if (line[i] === '\\') i++;
      continue;
    }
    code[i] = true;
  }
  return { code, state: { raw, block } };
}

function braceDelta(line, code) {
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    if (!code[i]) continue;
    if (line[i] === '{') d++;
    else if (line[i] === '}') d--;
  }
  return d;
}

// Rule 1: `head {body}` on one line, where the closing brace is the line's last code
// character and matches a `{` that follows the keyword's condition.
function spreadOneLineBlock(line, code, indent) {
  const t = line.trim();
  if (!BLOCK_KEYWORD.test(t) || !t.endsWith('}')) return null;
  const end = line.lastIndexOf('}');
  if (!code[end]) return null;
  let depth = 0;
  let open = -1;
  for (let i = end; i >= 0; i--) {
    if (!code[i]) continue;
    if (line[i] === '}') depth++;
    else if (line[i] === '{' && --depth === 0) {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const head = line.slice(0, open).trimEnd();
  const body = line.slice(open + 1, end).trim();
  // `} else if c {x}`: the head's own leading `}` closes an earlier block, fine. Bail on
  // an empty body (`for {}` is deliberate) or several statements.
  if (body === '' || body.includes(';')) return null;
  if (head.trim() === '}' || head.trim() === '') return null;
  return [`${head} {`, `${indent}\t${body}`, `${indent}}`];
}

const isBlank = (s) => s.trim() === '';
const isComment = (s) => /^\s*(\/\/|\/\*|\*)/.test(s);
const opensOrLabels = (s) => {
  const t = s.trim();
  return t.endsWith('{') || /^(case\b.*|default):\s*$/.test(t) || t.endsWith(':');
};
const closesOrLabels = (s) => {
  const t = s.trim();
  return t.startsWith('}') || /^(case\b|default:)/.test(t) || t.startsWith('#');
};

function formatSource(src, isC) {
  const lines = src.split('\n');

  // Pass 1: spread one-line blocks. Odin only: in C, clang-format already did it.
  let out = [];
  let state = { raw: false, block: false };
  for (const line of lines) {
    const startState = state;
    const { code, state: next } = scan(line, state, isC);
    state = next;
    const indent = line.match(/^\s*/)[0];
    const spread = !isC && !startState.raw && !startState.block ? spreadOneLineBlock(line, code, indent) : null;
    out.push(...(spread ?? [line]));
  }

  // Pass 2: blank lines around `if` statements.
  const src2 = out;
  const ifStart = isC ? /^if\s*\(/ : /^if /;
  const result = [];
  const blankAfter = new Set(); // indexes into src2 after which a blank line goes
  state = { raw: false, block: false };
  const scans = src2.map((line) => {
    const startState = state;
    const r = scan(line, state, isC);
    state = r.state;
    return { code: r.code, inCode: !startState.raw && !startState.block };
  });

  const blankBefore = new Set(); // indexes into src2 before which a blank line goes
  for (let i = 0; i < src2.length; i++) {
    const line = src2[i];
    if (!scans[i].inCode || !ifStart.test(line.trim())) continue;
    // Before: skip up over comments attached to the if.
    let top = i;
    while (top > 0 && isComment(src2[top - 1]) && scans[top - 1].inCode) top--;
    if (top > 0 && !isBlank(src2[top - 1]) && !opensOrLabels(src2[top - 1])) blankBefore.add(top);
    // After: follow the braces to the end of the whole if/else chain.
    let depth = 0;
    let seenOpen = false;
    let end = i;
    for (let j = i; j < src2.length; j++) {
      if (!scans[j].inCode) break;
      depth += braceDelta(src2[j], scans[j].code);
      if (src2[j].includes('{')) seenOpen = true;
      end = j;
      // The chain ends on a line that closes the last block: `}` (or a one-line block's
      // `}`). `} else if a ||` continues it, and so does `} else {`.
      if (seenOpen && depth <= 0 && src2[j].trim().endsWith('}')) break;
      if (!seenOpen && isC && /;\s*$/.test(src2[j])) break; // braceless C statement
      if (!seenOpen && !isC && / do /.test(src2[j])) break; // a `do` form odinfmt left
      if (j - i > 2000) break;
    }
    if (end + 1 < src2.length && !isBlank(src2[end + 1]) && !closesOrLabels(src2[end + 1])) blankAfter.add(end);
  }

  for (let i = 0; i < src2.length; i++) {
    if (blankBefore.has(i) && !(result.length && isBlank(result[result.length - 1]))) result.push('');
    result.push(src2[i]);
    if (blankAfter.has(i)) result.push('');
  }
  return result.join('\n');
}

function walk(path, files) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === 'picohttpparser' || name.startsWith('.') || name === 'node_modules') continue;
      walk(join(path, name), files);
    }
  } else if (EXTS.has(extname(path))) files.push(path);
}

const files = [];
for (const arg of process.argv.slice(2)) walk(arg, files);
let changed = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const isC = extname(file) !== '.odin';
  const formatted = formatSource(src, isC);
  if (formatted !== src) {
    writeFileSync(file, formatted);
    changed++;
  }
}
console.log(`fmt-if: ${changed} of ${files.length} files changed`);
