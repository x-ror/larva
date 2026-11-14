#!/usr/bin/env node
// Mutation gate: prove each recorded test actually dies when the code it claims to
// pin is broken.
//
// CLAUDE.md section 6 already required this by hand ("A test is not done until a
// mutation has failed it"). Doing it by hand depends on remembering to, and three
// tests in #321 got past exactly that: an oracle case that threw inside its own
// setup and so printed identical output on both runtimes, a property suite that
// compared zero inputs after a NaN run count, and an event-loop test whose timer
// handed platform_poll a positive timeout — which counts as progress by itself, so
// the no-progress tick under test never happened. All three passed. All three
// passed just as well with the code they pinned deleted.
//
// The runner is only worth as much as its own honesty, so it refuses to report on
// anything it cannot establish:
//   * the sources it patches must be clean, or it cannot restore them (a git status
//     that FAILS is not clean either — see gitClean)
//   * `source` must stay inside the repo root
//   * `find` must appear exactly once; missing or ambiguous is a FAILURE, not a skip
//   * the gate must be GREEN before mutating, or "it went red" proves nothing
//   * red must be red for the RECORDED reason (expect_detail), or the mutation is
//     not pinning what it names
//   * sources are restored from the process `exit` listener (default SIGINT/SIGTERM
//     still fire exit; SIGKILL does not) and bin/lava is rebuilt in `finally` when
//     a mutation dirtied the binary
// A runner that skipped the green baseline would report success for a gate that was
// already broken, which is the same class of defect it exists to catch. That is not
// hypothetical for this file: every rule above replaced a version that looked right
// and did nothing, and run-mutations.test.mjs pins each one.
//
// GATE KINDS
//   compat:<path>                  oracle case — run under node and bin/lava, diff
//                                  stdout/stderr/exit. RED = any difference.
//   odin:<package>:<test.name>     one Odin test, single runner thread.
//   node-test:<path>               a node:test file.
//   make:<target>                  any Makefile target — for a gate that needs a
//                                  real socket (the *-smoke targets) or a
//                                  multi-step harness. RED = non-zero exit.
//
// `expect_detail` (REQUIRED): a substring the RED output must contain, OR an
// array of alternatives (any one match counts). Going red is not enough — a
// mutation can break something unrelated and look like it worked. That happened
// while seeding this manifest: a mis-escaped `\\d` in a replacement produced the
// regex /^\\d+$/, which matches a literal backslash, so EVERY request 400'd and
// the parity phase failed. The gate reported "killed" and the smuggling phase it
// was supposed to pin never ran.
//
// Hang pins may fail as a timeout OR as a RangeError from runaway string growth
// under a forged exec, depending on the runner — both prove the reintroduced
// global replace is wrong; the array form records that.
//
// Usage:
//   node scripts/run-mutations.mjs                 # all
//   node scripts/run-mutations.mjs --filter=clone  # substring match on `name`
//   node scripts/run-mutations.mjs --list
//   MUTATION_TIMEOUT_MS=N                          # default per-gate bound (default 120000)
//   manifest timeout_ms                            # per-entry override (hang pins use 30000)

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

// ROOT and MANIFEST are overridable so this runner can be driven against a
// throwaway fixture tree. They were hardcoded, which meant the only way to test
// the gate was to write the real manifest — i.e. the gate that exists to catch
// untested assertions could not itself be tested. See run-mutations.test.mjs.
//
// realpath once up front so containment checks and missing-source fallbacks
// compare against the same canonical root (a lexical ROOT + realpath'd source
// can disagree when the repo itself is reached through a symlink).
const ROOT_LEXICAL = resolve(
  process.env.MUTATION_ROOT ?? argOf('root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
);
let ROOT;
try {
  ROOT = realpathSync(ROOT_LEXICAL);
} catch {
  ROOT = ROOT_LEXICAL;
}
const MANIFEST = resolve(
  process.env.MUTATION_MANIFEST ??
    argOf('manifest') ??
    join(ROOT, 'tests', 'mutation-manifest.json'),
);
const NODE_BIN = process.env.NODE_BIN ?? process.execPath;
const LAVA_BIN = process.env.LAVA_BIN ?? join(ROOT, 'bin', 'lava');
const ODIN = process.env.ODIN ?? 'odin';

const filter = argOf('filter') ?? '';
const listOnly = args.includes('--list');

function die(msg) {
  console.error(`mutation gate: ${msg}`);
  process.exit(1);
}

// --- manifest ---------------------------------------------------------------

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (err) {
  die(`${MANIFEST} is not valid JSON: ${err.message}`);
}
if (!Array.isArray(manifest.mutations) || manifest.mutations.length === 0) {
  die(`${MANIFEST} has no mutations — an empty manifest must not read as a pass`);
}

// expect_detail is REQUIRED, not optional. It was optional, which meant an entry
// added without it silently reverted to "any red counts" — the exact behaviour
// 82d8a0e exists to remove. An entry that genuinely cannot name its failure text
// should say so with an explicit empty-string opt-out, so the choice is visible in
// the manifest rather than inferred from an absent key. A non-empty string[] is
// also allowed: any alternative may match (hang pins that sometimes timeout and
// sometimes throw RangeError under forged exec).
const REQUIRED = ['name', 'why', 'source', 'find', 'replace', 'gate', 'expect_detail'];
function isValidExpectDetail(v) {
  if (typeof v === 'string') return true;
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((s) => typeof s === 'string' && s !== '');
}
function expectDetailMatches(expect, detail) {
  if (expect === '') return true;
  if (typeof expect === 'string') return detail.includes(expect);
  return expect.some((s) => detail.includes(s));
}
function formatExpectDetail(expect) {
  if (typeof expect === 'string') return expect;
  return expect.join(' | ');
}
for (const [i, m] of manifest.mutations.entries()) {
  for (const field of REQUIRED) {
    // Two fields may legitimately be empty. `expect_detail: ''` is a deliberate,
    // visible opt-out. `replace: ''` is a DELETION — the canonical mutation for a
    // guard clause, and the shape the two format-guard entries need; rejecting it
    // forced a fake non-empty replacement that no longer described the break.
    if (field === 'expect_detail') {
      if (!isValidExpectDetail(m.expect_detail)) {
        die(`mutation #${i} is missing "expect_detail"`);
      }
      continue;
    }
    const mayBeEmpty = field === 'replace';
    if (typeof m[field] !== 'string' || (m[field] === '' && !mayBeEmpty)) {
      die(`mutation #${i} is missing "${field}"`);
    }
  }
  if (m.find === m.replace) die(`mutation "${m.name}" does not change anything`);
}

const selected = filter
  ? manifest.mutations.filter((m) => m.name.includes(filter))
  : manifest.mutations;
if (selected.length === 0) die(`no mutation matches --filter=${filter}`);

if (listOnly) {
  for (const m of selected) console.log(`${m.gate}\n  ${m.name}\n  ${m.why}\n`);
  process.exit(0);
}

// --- gates ------------------------------------------------------------------

// Every gate returns {ok, detail}. `ok: false` is RED, which under mutation is
// what we want and on the baseline is a hard stop.
function runGate(gate) {
  const [kind, ...rest] = gate.split(':');
  if (kind === 'compat') return gateCompat(rest.join(':'));
  if (kind === 'odin') return gateOdin(rest[0], rest[1]);
  if (kind === 'node-test') return gateNodeTest(rest.join(':'));
  if (kind === 'make') return gateMake(rest.join(':'));
  die(`unknown gate kind "${kind}" in "${gate}"`);
}

// NODE_TEST_CONTEXT is stripped from every child. When node's own test runner
// spawns something, it sets this so a NESTED `node --test` reports up to the parent
// instead of standing alone — and a nested run with a FAILING test then exits 0.
// Measured: `node --test <failing>` exits 1, and `NODE_TEST_CONTEXT=child-v8 node
// --test <failing>` exits 0. Inherited, that makes every `node-test:` gate report
// green no matter what, so the baseline passes and every mutation reads SURVIVED.
// This runner is spawned from a node:test file by its own tests, and `make
// test-mutation` can be invoked from any harness that sets it, so the fix belongs
// here rather than in the caller.
// A mutation may reintroduce a spin — several in this manifest deliberately do,
// since the bug class they pin is "a global regex replace never terminates". Odin's
// test runner has no default per-test timeout and no test here calls
// set_fail_timeout, so without a bound at THIS level a spinning gate runs until the
// allocator gives up: measured at 6.2 GB RSS and still climbing after 39 s locally,
// 3m16s on a CI runner, and SIGKILL at 17 s under a 4 GB cap — where the kill
// leaves no [ERROR] line, so the verdict degraded to WRONG REASON naming nothing
// about memory. `set_fail_timeout` is NOT the fix: Odin implements terminate as
// pthread_cancel, which in deferred mode never fires inside a JIT allocation loop,
// and would unwind a thread holding JSC and malloc locks if it did.
//
// Default 120s so make:test-http-smoke (~40s both backends) still baselines green.
// Hang pins set `timeout_ms: 30000` in the manifest — the spin is immediate under
// forged exec, and three 120s hangs were burning CI budget and killing the job
// mid-suite. MUTATION_TIMEOUT_MS overrides the default only (not per-entry).
// Empty / non-numeric / non-positive env values fall back rather than producing
// NaN or 0, which Node treats as "no timeout" / immediate kill respectively.
function positiveIntMs(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}
const GATE_TIMEOUT_MS = positiveIntMs(process.env.MUTATION_TIMEOUT_MS, 120_000);
let activeTimeoutMs = GATE_TIMEOUT_MS;

function entryTimeoutMs(m) {
  // spawnSync requires an unsigned integer timeout; a fractional manifest value
  // throws ERR_OUT_OF_RANGE before any structured gate result exists.
  if (m && typeof m.timeout_ms === 'number' && Number.isInteger(m.timeout_ms) && m.timeout_ms > 0) {
    return m.timeout_ms;
  }
  return GATE_TIMEOUT_MS;
}

function withTimeout(ms, fn) {
  const prev = activeTimeoutMs;
  activeTimeoutMs = ms;
  try {
    return fn();
  } finally {
    activeTimeoutMs = prev;
  }
}

function capture(bin, argv, opts = {}) {
  const env = { ...(opts.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  const timeout = opts.timeout ?? activeTimeoutMs;
  // detached: on POSIX the child is a new process-group leader. spawnSync's own
  // timeout only SIGKILLs that one PID; node --test workers (isolation=process)
  // stay in the group and would otherwise orphan a for(;;){} spin. After a
  // timeout we also kill the whole group via process.kill(-pid).
  const r = spawnSync(bin, argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    env,
    killSignal: 'SIGKILL',
    timeout,
    detached: process.platform !== 'win32',
  });

  const wasTimeout =
    (r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGKILL')) || r.signal === 'SIGKILL';
  if (wasTimeout && r.pid && process.platform !== 'win32') {
    try {
      process.kill(-r.pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }

  if (r.error) {
    const note = wasTimeout ? `gate timed out after ${timeout}ms` : String(r.error.message);
    return { status: -1, stdout: r.stdout ?? '', stderr: note, timedOut: wasTimeout };
  }
  if (wasTimeout) {
    return {
      status: -1,
      stdout: r.stdout ?? '',
      stderr: `gate timed out after ${timeout}ms`,
      timedOut: true,
    };
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gateCompat(relPath) {
  const file = join(ROOT, relPath);
  const n = capture(NODE_BIN, [file]);
  // A timed-out arm is RED for the timeout, not for a partial stdout diff that
  // can accidentally look identical (both empty) and report ok: true.
  const nTo = timedOut(n);
  if (nTo) return nTo;
  const l = capture(LAVA_BIN, ['run', file]);
  const lTo = timedOut(l);
  if (lTo) return lTo;
  // Accumulate every difference rather than returning on the first. Returning
  // early on an exit-status mismatch discarded the stdout/stderr diff, which left
  // a case that fails via an assertion MESSAGE with no reachable detail at all —
  // so its entry could only record `expect_detail: "exit"`, which is implied by
  // RED itself and therefore asserts nothing.
  const parts = [];
  if (n.status !== l.status) parts.push(`exit: node=${n.status} lava=${l.status}`);
  if (n.stdout !== l.stdout) parts.push(firstDiff(n.stdout, l.stdout));
  if (n.stderr !== l.stderr) parts.push(firstDiff(n.stderr, l.stderr));
  if (parts.length === 0) return { ok: true, detail: 'node and lava agree' };
  return { ok: false, detail: parts.join('\n') };
}

// EVERY differing line, not just the first. A single mutation legitimately moves
// more than one vector — reverting the utf-8 decode borrow moves both R and V in
// 55-encoding-pollution — and reporting only the earliest meant `expect_detail`
// could never name a later one, so the entry had to fall back to something
// tautological. Bounded so a wholesale divergence does not bury the report.
const MAX_DIFF_LINES = 12;
function firstDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out = [];
  let more = 0;
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] === bl[i]) continue;
    if (out.length >= MAX_DIFF_LINES) {
      more++;
      continue;
    }
    out.push(`line ${i + 1}:\n    node: ${trunc(al[i])}\n    lava: ${trunc(bl[i])}`);
  }
  if (out.length === 0) return 'outputs differ';
  if (more > 0) out.push(`(+${more} more differing line${more === 1 ? '' : 's'})`);
  return out.join('\n');
}
const trunc = (s) => (s === undefined ? '(absent)' : s.length > 140 ? s.slice(0, 137) + '...' : s);

// A timed-out gate is RED with a detail that says so, never a silent hang and never
// a verdict about something else.
function timedOut(r) {
  return r.timedOut ? { ok: false, detail: r.stderr } : null;
}

function gateOdin(pkg, testName) {
  const out = join(ROOT, 'bin', '.mutation-odin.bin');
  const r = capture(ODIN, [
    'test',
    join(ROOT, pkg),
    `-collection:lava=${ROOT}`,
    '-define:ODIN_TEST_THREADS=1',
    `-define:ODIN_TEST_NAMES=${testName}`,
    `-out:${out}`,
  ]);
  const to = timedOut(r);
  if (to) return to;
  const text = r.stdout + r.stderr;
  // The Odin runner exits 0 on a build failure in some versions, so read the
  // summary line rather than trusting the status alone.
  if (/\bAll tests were successful\.|The test was successful\./.test(text)) {
    return { ok: true, detail: 'odin test passed' };
  }
  // A crash has no [ERROR] line. When the Odin runner catches the signal it
  // exits 1 and names it in its summary ("Signal caught: Segmentation_Fault");
  // surface that, or a crash records as the same "exited 1" as any other red.
  const err = text
    .split('\n')
    .find((l) => l.includes('[ERROR]') || l.includes('Error:') || l.includes('Signal caught:'));
  return { ok: false, detail: err ? err.trim() : `odin test exited ${r.status}` };
}

// `make` gates own their own build, so the runner must not also rebuild for them —
// `rebuild: false` is correct even for an embedded-JS mutation here, because the
// target's own `build` prerequisite picks the patched source up.
function gateMake(target) {
  const r = capture('make', [target], { cwd: ROOT });
  const to = timedOut(r);
  if (to) return to;
  if (r.status === 0) return { ok: true, detail: `make ${target} passed` };
  const text = r.stdout + r.stderr;
  // Keep the phase label AND the tail of the target's own output. Preferring the
  // labelled line alone was tuned to run-http-smoke.sh's "FAILED: <phase> checks
  // failed" shape, and every other target fell through to make's generic
  // `*** [Makefile:N: target] Error 1` — which names the target but never the
  // reason, so `expect_detail` on such an entry could assert nothing better than
  // "make failed", which RED already means.
  const lines = text.split('\n');
  const labelled = lines.filter((l) => /FAILED: .* checks failed/.test(l));
  const generic = lines.filter((l) => /^FAIL |FAILED|Error \d/.test(l));
  // The last few non-empty, non-make-noise lines are where a target that prints its
  // own diagnosis puts it.
  const tail = lines.filter((l) => l.trim() !== '' && !/^make(\[\d+\])?:/.test(l)).slice(-4);
  const parts = [...new Set([...labelled, ...generic, ...tail])].map((l) => l.trim());
  return {
    ok: false,
    detail: parts.length ? parts.join(' | ') : `make ${target} exited ${r.status}`,
  };
}

function gateNodeTest(relPath) {
  const r = capture(NODE_BIN, ['--test', join(ROOT, relPath)]);
  const to = timedOut(r);
  if (to) return to;
  const text = r.stdout + r.stderr;
  if (r.status === 0) return { ok: true, detail: 'node:test passed' };
  // BOTH the failing test name and the assertion message. Returning only the `✖`
  // line gave the test's NAME and threw the reason away, so `expect_detail` could
  // never name why a gate went red — only which test did. An assertion message is
  // the one string an author controls and the natural thing to record.
  const lines = text.split('\n');
  const names = lines.filter((l) => /^\s*✖ /.test(l) && !/failing tests:/.test(l));
  const reasons = lines.filter((l) => /Error(\s\[[A-Z_]+\])?:/.test(l));
  const detail = [...new Set([...names, ...reasons])].map((l) => l.trim()).join(' | ');
  return { ok: false, detail: detail || `node --test exited ${r.status}` };
}

// --- patching ---------------------------------------------------------------

// A non-zero git status is NOT "clean". It returned only stdout, and
// `git status --porcelain -- ../outside` exits 128 with EMPTY stdout — so a path
// that escaped the repo read as clean and the runner then rewrote a file outside
// it. Paired with the containment check in applyMutation.
function gitClean(relPaths) {
  const r = capture('git', ['status', '--porcelain', '--', ...relPaths], { cwd: ROOT });
  if (r.status !== 0) {
    die(`git status failed for [${relPaths.join(', ')}] (exit ${r.status}): ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

const originals = new Map(); // absolute path -> original text

// Restore each file independently. A single writeFileSync throw used to abort the
// loop, leave the remaining entries mutated on disk, and surface as an uncaught
// exception instead of a list of unrestored paths.
function restoreAll() {
  const failed = [];
  for (const [file, text] of [...originals]) {
    try {
      writeFileSync(file, text);
      originals.delete(file);
    } catch (err) {
      failed.push(`${file}: ${err.message}`);
    }
  }
  return failed;
}

// `process.on('exit')` and NOTHING ELSE. This program's body is entirely
// SYNCHRONOUS (spawnSync throughout), so a registered signal listener never gets a
// turn to run — while its mere presence REMOVES node's default terminate
// disposition. A previous version registered SIGINT/SIGTERM/SIGHUP handlers for
// safety and made things strictly worse: measured, Ctrl-C and `kill -TERM` were
// both swallowed, the run continued to completion and exited 0 with "mutation gate
// ok", so `kill -9` became the only way to stop it — and SIGKILL is the one path
// where no restore runs at all. Registering nothing means TERM and INT kill the
// process as they always did.
//
// An 'exit' listener is synchronous and runs on every normal, thrown and
// process.exit() path, which is what restoring files needs. It does NOT run on
// SIGKILL; the warning below is the residue detector for that case.
process.on('exit', () => {
  const failed = restoreAll();
  if (failed.length > 0) {
    console.error(
      `mutation gate: failed to restore ${failed.length} source(s):\n  ${failed.join('\n  ')}`,
    );
    if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
  }
});

function applyMutation(m) {
  // Containment is enforced up front for every selected source; see the pre-flight
  // loop. Doing it here as well was unreachable — gitClean rejects an escaping path
  // first — which is why the check moved rather than being duplicated.
  const file = resolve(ROOT, m.source);
  const text = readFileSync(file, 'utf8');
  const hits = text.split(m.find).length - 1;
  if (hits === 0) {
    throw new Error(
      `"find" does not appear in ${m.source} — the code moved, so this mutation no longer describes it`,
    );
  }
  if (hits > 1) {
    throw new Error(`"find" appears ${hits}x in ${m.source} — ambiguous, make it unique`);
  }
  if (!originals.has(file)) originals.set(file, text);
  // A literal splice, NOT String.replace: with a string pattern, `$&`, `$\``,
  // `$'` and `$n` in the REPLACEMENT are substitution patterns, so a replacement
  // containing them would silently write text the manifest does not record —
  // and "it went red" would then be reported about a patch nobody wrote.
  const at = text.indexOf(m.find);
  writeFileSync(file, text.slice(0, at) + m.replace + text.slice(at + m.find.length));
}

function build() {
  const r = capture('make', ['build'], { cwd: ROOT });
  if (r.status !== 0) throw new Error(`make build failed:\n${(r.stdout + r.stderr).slice(-2000)}`);
}

// --- run --------------------------------------------------------------------

const touched = [...new Set(selected.map((m) => m.source))];

// Containment is checked HERE, before git is asked anything. It used to live inside
// applyMutation, where it was unreachable: gitClean runs first over the same paths
// and `git status -- ../outside` already exits 128, so the containment branch could
// never fire and its test could only pass by matching git's message instead. A
// security check that another check always shadows is not a check.
//
// realpathSync, not just resolve: resolve is lexical and does not follow symlinks,
// while readFileSync and writeFileSync do — so a committed in-repo symlink pointing
// outside passed the prefix test, and the runner then rewrote the target.
for (const rel of touched) {
  const lexical = resolve(ROOT, rel);
  let real;
  try {
    real = realpathSync(lexical);
  } catch {
    // A source that does not exist yet is caught later, by applyMutation's read,
    // with a message about the file rather than about paths.
    real = lexical;
  }
  if (real !== ROOT && !real.startsWith(ROOT + sep)) {
    die(`"source" escapes the repo root: ${rel} -> ${real}`);
  }
}

const dirty = gitClean(touched);
if (dirty) {
  die(
    `these sources have uncommitted changes, so they cannot be safely restored:\n${dirty}\n` +
      `commit or stash them first`,
  );
}

console.log(`mutation gate: ${selected.length} mutation(s)\n`);

let failures = 0;
let checked = 0;
// Two different questions, previously conflated into one flag:
//   needsBuild    — must bin/lava be built BEFORE the gate runs? Only `compat:`
//                   needs that; `odin:` compiles its own package, `node-test:`
//                   never touches the binary, and a `make:` target carries its own
//                   `build` prerequisite.
//   dirtiesBinary — did anything we ran leave bin/lava built from patched source?
//                   A `make:` gate DOES, precisely because of that prerequisite —
//                   so `--filter` over only `make:` entries used to finish with a
//                   clean git tree, a success message, and a bin/lava on disk that
//                   validated Content-Length with the reverted, poisonable check.
const needsBuild = selected.some((m) => m.rebuild || m.gate.startsWith('compat:'));
const dirtiesBinary = selected.some(
  (m) => m.rebuild || m.gate.startsWith('compat:') || m.gate.startsWith('make:'),
);

try {
  if (needsBuild) {
    process.stdout.write('  baseline build ... ');
    build();
    console.log('ok');
  }

  // Baseline: every gate must be GREEN before anything is mutated. A gate that is
  // already red would "go red" under mutation for free.
  const gates = [...new Set(selected.map((m) => m.gate))];
  for (const gate of gates) {
    process.stdout.write(`  baseline ${gate} ... `);
    const r = runGate(gate);
    if (!r.ok) {
      console.log('RED');
      die(`gate "${gate}" is already failing before any mutation:\n    ${r.detail}`);
    }
    console.log('green');
  }
  console.log('');

  for (const m of selected) {
    checked++;
    process.stdout.write(`  [${checked}/${selected.length}] ${m.name}\n           ... `);
    try {
      applyMutation(m);
    } catch (err) {
      // A manifest entry that no longer describes the code is a FAILURE, not a
      // skip: silently passing over it would quietly drop the coverage this gate
      // exists to guarantee, which is the same shape as the defects it catches.
      failures++;
      console.log('STALE');
      console.log(`           ${err.message}`);
      continue;
    }
    try {
      if (m.rebuild || m.gate.startsWith('compat:')) build();
      const r = withTimeout(entryTimeoutMs(m), () => runGate(m.gate));
      if (r.ok) {
        failures++;
        console.log('SURVIVED');
        console.log(`           the gate still passes with this code broken.`);
        console.log(`           expected to catch: ${m.why}`);
        console.log(`           gate: ${m.gate}`);
      } else if (m.expect_detail && !expectDetailMatches(m.expect_detail, r.detail)) {
        // Red, but not for the recorded reason — so this mutation is not pinning
        // what it claims to. Treated as a failure, because a mutation that breaks
        // something unrelated proves nothing about the test it names.
        failures++;
        console.log('WRONG REASON');
        console.log(
          `           expected the failure to mention: ${formatExpectDetail(m.expect_detail)}`,
        );
        console.log(`           got: ${r.detail.split('\n')[0]}`);
      } else {
        console.log(`killed (${r.detail.split('\n')[0]})`);
      }
    } finally {
      restoreAll();
    }
  }
} finally {
  restoreAll();
  // In the FINALLY, not as the last statement of the try. It was the latter, so any
  // throw out of the loop — a `replace` that does not compile, a transient build
  // failure — skipped it while `restoreAll` still tidied the sources, leaving a
  // clean git tree and a bin/lava built from the mutated source with nothing on
  // screen. That is the exact state the needsBuild/dirtiesBinary split exists to
  // prevent, re-entered through the exception path.
  if (dirtiesBinary) {
    process.stdout.write('\n  restore build ... ');
    try {
      build();
      console.log('ok');
    } catch (err) {
      // Report rather than mask whatever is already propagating. A successful
      // mutation loop with a failed rebuild would otherwise exit 0 while bin/lava
      // still carries mutated source — CI treats that as a pass.
      console.error(`FAILED — bin/lava may be built from mutated source: ${err.message}`);
      if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
    }
  }
}

console.log('');
if (failures > 0) {
  console.error(
    `mutation gate FAILED: ${failures}/${checked} mutation(s) did not do their job —\n` +
      `either the test survived the break (it is asserting something else), or the\n` +
      `manifest entry no longer matches the code it describes.`,
  );
  process.exit(1);
}
console.log(`mutation gate ok: ${checked}/${checked} test(s) died as recorded.`);
