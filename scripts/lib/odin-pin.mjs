// The Odin toolchain pin (`.odin-version`) and the facts about the local toolchain
// that `make env`, the SessionStart hook and `make sdk-diff` compare against it.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Parses `.odin-version` (`key=value` lines, `#` comments).
 * @param {string} text
 * @returns {{commit: string, release: string, llvm: string}}
 * @throws {Error} when `commit` is not a full 40-hex SHA — a short or symbolic ref
 *   would let the pin drift silently.
 */
export function parsePin(text) {
  const pin = { commit: '', release: '', llvm: '' };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`.odin-version: not key=value: ${raw}`);
    const k = line.slice(0, eq).trim();
    if (!(k in pin)) throw new Error(`.odin-version: unknown key ${k}`);
    pin[k] = line.slice(eq + 1).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit))
    throw new Error('.odin-version: commit must be a full 40-hex SHA');
  if (!/^\d+$/.test(pin.llvm))
    throw new Error('.odin-version: llvm must be a major version number');
  return pin;
}

export function readPin(root = REPO_ROOT) {
  return parsePin(readFileSync(join(root, '.odin-version'), 'utf8'));
}

/**
 * Extracts the commit prefix from `odin version` output. Git builds print
 * `odin version dev-2026-11:6a275d863`; a build without git metadata prints no hash.
 * @param {string} out
 * @returns {{tag: string, commit: string|null}}
 */
export function parseOdinVersion(out) {
  const m = /odin version\s+(\S+?)(?::([0-9a-f]{7,40}))?\s*$/m.exec(out);
  if (!m) return { tag: out.trim(), commit: null };
  return { tag: m[1], commit: m[2] ?? null };
}

/** True when a commit prefix names the same commit as a full SHA. */
export function sameCommit(prefix, full) {
  return prefix !== null && prefix.length >= 7 && full.startsWith(prefix);
}

/**
 * Whether a compiler's `odin version` names the pinned toolchain. A git build is
 * matched by commit; a prebuilt release that prints no hash is matched by its tag,
 * and only when the pin names that release.
 * @param {{tag: string, commit: string|null}} version
 * @param {{commit: string, release: string}} pin
 */
export function matchesPin(version, pin) {
  if (version.commit !== null) return sameCommit(version.commit, pin.commit);
  return pin.release !== '' && version.tag === pin.release;
}

export function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The local compiler and the SDK source next to it.
 * @returns {{odin: string|null, version: {tag: string, commit: string|null}|null,
 *   root: string|null, git: boolean, head: string|null, dirty: boolean}}
 */
export function localToolchain() {
  const odin = process.env.ODIN || 'odin';
  const out = run(odin, ['version']);
  const root = process.env.ODIN_ROOT || run(odin, ['root']);
  const head = root ? run('git', ['-C', root, 'rev-parse', 'HEAD']) : null;
  const dirty = head
    ? (run('git', ['-C', root, 'status', '--porcelain', '--', 'core', 'vendor', 'base']) ?? '') !==
      ''
    : false;
  return {
    odin: out === null ? null : (run('sh', ['-c', `command -v ${odin}`]) ?? odin),
    version: out === null ? null : parseOdinVersion(out),
    root: root ? root.replace(/\/$/, '') : null,
    git: head !== null,
    head,
    dirty,
  };
}

/**
 * Relation of two commits in a checkout: `same`, `ahead N` (b is N commits after a),
 * `behind N`, `diverged`, or `unknown` (a commit is not in the checkout).
 */
export function relation(repo, a, b) {
  const full = (c) => run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
  const fa = full(a);
  const fb = full(b);
  if (!fa || !fb) return 'unknown';
  if (fa === fb) return 'same';
  const ahead = run('git', ['-C', repo, 'rev-list', '--count', `${fa}..${fb}`]);
  const behind = run('git', ['-C', repo, 'rev-list', '--count', `${fb}..${fa}`]);
  if (behind === '0') return `ahead ${ahead}`;
  if (ahead === '0') return `behind ${behind}`;
  return 'diverged';
}
