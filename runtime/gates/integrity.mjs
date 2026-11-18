#!/usr/bin/env node
// Agent system — gate integrity filter — command-level gate integrity filter.
//
// Used as:
//   PreToolUse hook (Claude / Grok): node runtime/gates/integrity.mjs --hook
//   CLI self-check:                  node runtime/gates/integrity.mjs --check 'CMD'
//
// Policy: block env/flag bypasses that make oracle or ratchet gates green without
// a real fix. Path-based denies alone miss NODE_BIN=./bin/lava, RUN_LAVA=0, etc.
// See docs/agent-system/ARCHITECTURE.md §Gate integrity.

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @typedef {{ id: string, reason: string, re: RegExp }} Rule */

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'primordials-update',
    reason:
      'baseline rewrite / raise of check-primordials is human-only (agent-system gate integrity)',
    re: /(?:check-primordials|(?:make\s+)?check-primordials)[\s\S]{0,200}(?:--update|\bUPDATE=|\bRAISE=|--allow-raise)|(?:--update|\bUPDATE=|\bRAISE=|--allow-raise)[\s\S]{0,200}check-primordials/i,
  },
  {
    id: 'node-bin-override',
    reason:
      'NODE_BIN= turns oracle compares into lava-vs-lava or a fake oracle (scripts/lib/compare.sh)',
    re: /\bNODE_BIN\s*=/,
  },
  {
    id: 'lava-bin-to-node',
    reason: 'LAVA_BIN must not point at the Node oracle (lava-vs-node must stay distinct)',
    re: /\bLAVA_BIN\s*=\s*(?:node\b|["']node["']|[^\s]*\/node(?:\.exe)?\b)/i,
  },
  {
    id: 'run-lava-off',
    reason: 'RUN_LAVA=0 makes *-lava targets node-only while still looking like a lava gate',
    re: /\bRUN_LAVA\s*=\s*0\b/,
  },
  {
    id: 'skip-known-gaps',
    reason:
      'SKIP_KNOWN_LAVA_GAPS= on the command line weakens oracle coverage; make recipes set it internally',
    re: /\bSKIP_KNOWN_LAVA_GAPS\s*=/,
  },
  {
    id: 'mutation-override',
    reason:
      'MUTATION_MANIFEST/MUTATION_ROOT/MUTATION_BASE/--manifest/--root/--filter divert the mutation gate',
    re: /\bMUTATION_(?:MANIFEST|ROOT|BASE)\s*=|(?:run-mutations\.mjs|test-mutation)[\s\S]{0,120}(?:--manifest|--root|--filter)|\bFILTER\s*=/,
  },
  {
    id: 'property-runs',
    reason: 'PROPERTY_RUNS= shrinks the differential corpus (can pass on 1 input)',
    re: /\bPROPERTY_RUNS\s*=/,
  },
  {
    id: 'no-verify',
    reason: '--no-verify skips git hooks that protect the tree',
    re: /(?:^|[\s;|&])git\s+[\w-]*\s+[^\n]*--no-verify|\b--no-verify\b/,
  },
  {
    id: 'baseline-shell-write',
    reason:
      'shell rewrite/delete of a baseline, gaps, settings, or gate-integrity file is human-only',
    re: /(?:\b(?:rm|mv|cp|tee|truncate)\b|\b(?:sed|perl|awk)\b[^\n]*\s-(?:i|i\w)|(?:^|[\s;|&])(?:cat|printf)\b[^\n]*>)[^\n]*(?:pollution-baseline\.json|known-lava-gaps\.txt|primordials\.baseline|mutation-manifest\.json|thresholds\.json|case-counts\.json|settings\.json|gate-integrity\.(?:mjs|sh|json)|compare\.sh)/i,
  },
  {
    id: 'baseline-git-restore',
    reason: 'git checkout/restore/rm of a protected gate artifact is human-only',
    re: /\bgit\s+(?:checkout|restore|rm)\b[^\n]*(?:pollution-baseline\.json|known-lava-gaps\.txt|mutation-manifest\.json|thresholds\.json|case-counts\.json|settings\.json|gate-integrity|compare\.sh|bin\/lava\b)/i,
  },
  {
    id: 'delete-oracle-or-bench',
    reason:
      'deleting oracle cases / benches / bin/lava hides coverage without failing a counter until the next run',
    re: /\b(?:rm|mv)\b[^\n]*(?:tests\/(?:node-compat|runtime|std|property|stdio)\/|bench\/(?:micro|macro)\/|bin\/lava\b)|\bgit\s+rm\b[^\n]*(?:tests\/(?:node-compat|runtime|std|property|stdio)\/|bench\/(?:micro|macro)\/)/i,
  },
  {
    id: 'inplace-edit-tooling',
    reason: 'in-place sed/perl on Makefile/scripts/CI/settings is human-required',
    re: /\b(?:sed|perl)\b[^\n]*\s-i[^\n]*(?:scripts\/|Makefile\b|package\.json|\.github\/workflows|\.claude\/|\.grok\/)/i,
  },
  {
    id: 'git-stash-cycle',
    reason:
      'git stash push/pop/apply is forbidden in agent worktrees (shared refs/stash across worktrees); list is ok',
    re: /\bgit\s+stash\s+(?:push|pop|apply|drop|save|clear|create|store)\b|\bgit\s+stash\s*$|\bgit\s+stash\s+-/,
  },
  {
    id: 'cd-env-bypass',
    reason: 'cd … && ENV=… / env VAR= forms that reintroduce oracle bypasses',
    re: /(?:cd\s+[^\n;|&]+&&\s*)?(?:env\s+)?(?:NODE_BIN|RUN_LAVA|PROPERTY_RUNS|MUTATION_MANIFEST|SKIP_KNOWN_LAVA_GAPS)\s*=/,
  },
];

/** Paths agents must not Edit/Write without a human (F1 Edit/Write deny). */
export const PROTECTED_WRITE_PATHS = [
  // Self-protect: removing these denials is the classic agent bypass
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/gate-integrity.sh',
  '.grok/hooks/gate-integrity.json',
  'runtime/gates/integrity.mjs',
  'runtime/gates/case-counts.json',
  'runtime/gates/assert-case-counts.mjs',
  'config/agents.json',
  'config/agents.yaml',
  'config/pipeline.json',
  'workflows/pipeline.mjs',
  'commands/index.mjs',
  // Gate artifacts
  'tests/node-compat/pollution-baseline.json',
  'tests/node-compat/known-lava-gaps.txt',
  'tests/runtime/eventloop/known-lava-gaps.txt',
  'tests/mutation-manifest.json',
  'bench/thresholds.json',
  'bench/run.mjs',
  // Oracle spine + ratchet (weakening these = green without a fix)
  'scripts/lib/compare.sh',
  'scripts/lib/primordials-baseline.mjs',
  'scripts/lib/primordials-detect.mjs',
  'scripts/lib/primordials-fixtures.mjs',
  'scripts/lib/primordials-scan.mjs',
  'scripts/check-primordials.mjs',
  'scripts/run-mutations.mjs',
  'scripts/run-node-compat-all.sh',
  'scripts/run-eventloop-oracle.sh',
  'scripts/run-fs-oracle.sh',
  'scripts/run-sqlite-oracle.sh',
  'Makefile',
  'package.json',
  'bin/lava',
  '.env',
  '.env.local',
];

/** Prefixes: any path under these is hard-blocked for Edit/Write. */
export const PROTECTED_WRITE_PREFIXES = ['.github/workflows/', '.claude/hooks/', '.grok/hooks/'];

/**
 * Policy-only note for docs. Hard-blocked paths above supersede this list —
 * human work on them requires disabling hooks / editing outside the agent.
 * Kept so `human-required-paths.md` and the skill stay aligned.
 */
export const HUMAN_REQUIRED_PATHS = [...PROTECTED_WRITE_PATHS, ...PROTECTED_WRITE_PREFIXES];

/**
 * @param {string} command
 * @returns {{ blocked: boolean, id?: string, reason?: string }}
 */
export function checkCommand(command) {
  if (!command || typeof command !== 'string') return { blocked: false };
  // Normalize newlines so multi-line shell still matches.
  const cmd = command.replace(/\r\n/g, '\n');
  for (const rule of RULES) {
    if (rule.re.test(cmd)) {
      return { blocked: true, id: rule.id, reason: rule.reason };
    }
  }
  return { blocked: false };
}

/**
 * @param {string} filePath absolute or repo-relative
 */
export function checkWritePath(filePath) {
  if (!filePath) return { blocked: false };
  const norm = filePath.replace(/\\/g, '/');
  const rootNorm = ROOT.replace(/\\/g, '/');
  let rel = norm.startsWith(rootNorm)
    ? norm.slice(rootNorm.length).replace(/^\//, '')
    : norm.replace(/^\.\//, '');
  // Absolute paths outside the repo: still match by suffix on protected basenames.
  for (const p of PROTECTED_WRITE_PATHS) {
    if (rel === p || rel.endsWith('/' + p) || rel.endsWith(p)) {
      return {
        blocked: true,
        id: 'protected-write',
        reason: `Edit/Write of ${p} is blocked by agent-system gate integrity (human-only)`,
      };
    }
  }
  for (const pref of PROTECTED_WRITE_PREFIXES) {
    if (rel.startsWith(pref) || rel.includes('/' + pref)) {
      return {
        blocked: true,
        id: 'protected-write-prefix',
        reason: `Edit/Write under ${pref} is blocked by agent-system gate integrity (human-only)`,
      };
    }
  }
  if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith('.env.example')) {
    return {
      blocked: true,
      id: 'env-write',
      reason: 'Edit/Write of .env is blocked (secrets)',
    };
  }
  return { blocked: false };
}

/**
 * @param {string} filePath
 */
export function checkReadPath(filePath) {
  if (!filePath) return { blocked: false };
  const norm = filePath.replace(/\\/g, '/');
  const base = norm.split('/').pop() || '';
  if (base === '.env' || base.startsWith('.env.')) {
    if (base === '.env.example') return { blocked: false };
    return {
      blocked: true,
      id: 'env-read',
      reason: 'Read of .env is blocked (may contain live tokens)',
    };
  }
  return { blocked: false };
}

/**
 * Parse PreToolUse JSON (Claude / Grok). Exported for unit tests.
 * @param {object} input
 */
export function extractCommandFromHookInput(input) {
  // Claude Code / Grok PreToolUse shapes
  const ti = input.tool_input || input.toolInput || input.input || {};
  if (typeof ti.command === 'string') return { kind: 'bash', command: ti.command };
  if (typeof ti.cmd === 'string') return { kind: 'bash', command: ti.cmd };
  // Edit / Write / search_replace
  const path =
    ti.file_path || ti.filePath || ti.path || ti.target_file || ti.targetFile || ti.file || '';
  const tool = String(input.tool_name || input.toolName || input.tool || '');
  if (
    /edit|write|search_replace|str_replace/i.test(tool) ||
    (path &&
      !/read/i.test(tool) &&
      (ti.old_string != null || ti.new_string != null || ti.content != null))
  ) {
    return { kind: 'write', path: String(path) };
  }
  if (path && /edit|write|search_replace|str_replace/i.test(tool)) {
    return { kind: 'write', path: String(path) };
  }
  // Bare path with Write-like tools that only send file_path
  if (path && /^(Edit|Write|search_replace|MultiEdit)$/i.test(tool)) {
    return { kind: 'write', path: String(path) };
  }
  if (/^read$/i.test(tool) || /read_file/i.test(tool) || tool === 'Read') {
    return { kind: 'read', path: String(path || ti.target_file || '') };
  }
  if (path && !tool) {
    // Some harnesses omit tool_name; if content/old_string present → write
    if (ti.content != null || ti.old_string != null) return { kind: 'write', path: String(path) };
  }
  return { kind: 'unknown' };
}

function denyJson(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    const cmd = args.slice(1).join(' ');
    const r = checkCommand(cmd);
    if (r.blocked) {
      console.error(`BLOCKED [${r.id}]: ${r.reason}`);
      process.exit(2);
    }
    console.log('ok');
    process.exit(0);
  }

  if (args[0] === '--list-rules') {
    for (const r of RULES) console.log(`${r.id}\t${r.reason}`);
    process.exit(0);
  }

  // --hook: read PreToolUse JSON from stdin
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    process.exit(0);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Non-JSON stdin: treat as raw command string
    const r = checkCommand(raw);
    if (r.blocked) {
      console.error(`gate-integrity: ${r.reason}`);
      process.exit(2);
    }
    process.exit(0);
  }

  const extracted = extractCommandFromHookInput(input);
  let result = { blocked: false };
  if (extracted.kind === 'bash') result = checkCommand(extracted.command);
  else if (extracted.kind === 'write') result = checkWritePath(extracted.path);
  else if (extracted.kind === 'read') result = checkReadPath(extracted.path);

  if (result.blocked) {
    const reason = `gate-integrity[${result.id}]: ${result.reason}`;
    // Claude-style JSON decision (also understood by Grok when present)
    process.stdout.write(JSON.stringify(denyJson(reason)) + '\n');
    // Exit 2 is the portable "block" for command hooks
    process.stderr.write(reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
