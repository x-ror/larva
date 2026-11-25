#!/usr/bin/env node
// The toolchain facts an agent (or a person) needs before touching Larva, in one
// block: the pinned Odin commit, the local compiler and SDK source and how far each
// is from the pin, the linked C libraries, node/bun, and the core count CI has.
// Printed by `make env`, which CLAUDE.md §3 has agents run first, so a session
// starts knowing which SDK source to read instead of discovering it.
//
// Usage: node scripts/odin-env.mjs            report, exit 0
//        node scripts/odin-env.mjs --check    report, exit 1 unless the compiler is the pin
//                                             (CI runs this right after installing Odin)

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, localToolchain, matchesPin, readPin, relation, run } from './lib/odin-pin.mjs';

const LIBS = ['javascriptcoregtk-6.0', 'openssl', 'sqlite3', 'libzstd', 'libbrotlidec'];
const short = (c) => (c ? c.slice(0, 9) : '?');

/**
 * Builds the report.
 * @returns {{lines: string[], ok: boolean}} ok — the compiler is the pinned commit.
 */
export function report() {
  const pin = readPin();
  const tc = localToolchain();
  const lines = [];
  const pinDesc = pin.release ? `release ${pin.release}, ` : 'built from source, ';
  lines.push(
    `Larva toolchain — pin ${short(pin.commit)} (${pinDesc}llvm ${pin.llvm}) from .odin-version`,
  );

  let ok = false;
  if (!tc.version) {
    lines.push(
      '  compiler  NOT FOUND — install the pin (see .github/actions/setup-odin) or set ODIN=',
    );
  } else {
    ok = matchesPin(tc.version, pin);
    let rel = ok
      ? '= pin'
      : 'commit unknown (no hash in `odin version`, tag is not the pinned release)';
    if (!ok && tc.version.commit && tc.git)
      rel = `≠ pin, ${relation(tc.root, pin.commit, tc.version.commit)} of it`;
    else if (!ok && tc.version.commit) rel = '≠ pin';
    lines.push(`  compiler  ${tc.odin}  ${tc.version.tag}:${tc.version.commit ?? '?'}  ${rel}`);
  }

  if (tc.root) {
    let src = 'not a git checkout — cannot read the pinned tree from it';
    if (tc.git) {
      const r = relation(tc.root, pin.commit, tc.head);
      src = `HEAD ${short(tc.head)}${tc.dirty ? ' (dirty)' : ''}, ${r === 'same' ? '= pin' : `${r} of pin`}`;
    }
    lines.push(`  SDK src   ${tc.root}  ${src}`);
    if (tc.git && !(tc.head ?? '').startsWith(pin.commit)) {
      lines.push(
        `  → read the PINNED SDK, not the working tree: git -C ${tc.root} show ${short(pin.commit)}:core/<pkg>/<file>.odin`,
      );
      lines.push(
        '    (`make sdk-diff` lists what the working tree adds or changes against the pin)',
      );
    }
  }

  if (!ok && tc.version) {
    lines.push(
      '  → CI builds with the pin; a local gate result from another compiler is not evidence for CI',
    );
  }

  const libs = LIBS.map((l) => `${l} ${run('pkg-config', ['--modversion', l]) ?? 'MISSING'}`);
  lines.push(`  C libs    ${libs.join(', ')}`);

  let nvmrc = '?';
  try {
    nvmrc = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim();
  } catch {
    // No .nvmrc: report '?' rather than fail the whole report.
  }
  const node = run('node', ['--version']);
  const major = (v) => Number(/^v?(\d+)/.exec(v ?? '')?.[1] ?? NaN);
  // Node is the oracle for the Node profile (CLAUDE.md §1): an older node prints
  // older behaviour, and an oracle diff against it is not evidence.
  const below =
    node && major(node) < major(nvmrc)
      ? ' BELOW THE ORACLE FLOOR — oracle diffs are not evidence'
      : '';
  lines.push(
    `  node      ${node ?? 'MISSING'} (oracle floor .nvmrc ${nvmrc})${below}, bun ${run('bun', ['--version']) ?? 'MISSING'}`,
  );
  lines.push(
    `  cores     ${availableParallelism()} here; CI ubuntu-latest has 4 (CLAUDE.md §3 on reproducing races)`,
  );
  lines.push(
    '  gates     agents/prompts/pr-gate-reference/gates.md routes paths to gates; `make help` lists targets',
  );
  return { lines, ok };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let r;
  try {
    r = report();
  } catch (e) {
    console.log(`Larva toolchain — cannot read .odin-version: ${e.message}`);
    process.exit(check ? 1 : 0);
  }
  console.log(r.lines.join('\n'));
  if (check && !r.ok) {
    console.error('odin-env: the compiler on PATH is not the commit pinned in .odin-version');
    process.exit(1);
  }
}
