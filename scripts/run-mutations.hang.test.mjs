// The mutation gate's SLOW tests: the cases that have to wait out a real timeout.
//
// They live apart from run-mutations.test.mjs on purpose. Every manifest entry gated
// on that file runs it whole, once per entry plus once for its baseline, so a slow
// case there is paid per entry. Measured when the split was made (008f478), with
// eight entries gated on it: those eight took 164.5 s of one full
// `make test-mutation` before the split and 61.1 s after (Larva environment,
// 4 cores, Node 24, one run each). Entries that pin the timeout logic name THIS
// file as their gate, and any new case that waits out a timeout belongs here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOURCE,
  ODIN_PASS,
  run,
  runClean,
  entry,
  sourceOf,
  withTree,
  odinStub,
} from './lib/run-mutations-fixture.mjs';

test('a gate that hangs is RED with a timeout verdict, not a hang', () => {
  // Several manifest entries deliberately reintroduce a spin, because the bug class
  // they pin is "a global regex replace never terminates". Without a bound here the
  // gate ran until the allocator gave up — 6.2 GB and climbing locally, 3m16s in CI
  // — and a SIGKILL under a memory cap produced no error line at all, so the verdict
  // degraded to WRONG REASON naming nothing about memory.
  //
  // capture() runs the gate under GNU timeout so the whole process group is killed
  // (spawnSync alone leaves a node --test worker spinning). Assert no orphan.
  withTree(
    [entry({ gate: 'node-test:fx/hang.test.mjs', expect_detail: 'timed out' })],
    {},
    (dir) => {
      const hangPath = join(dir, 'fx', 'hang.test.mjs');
      writeFileSync(
        hangPath,
        // Green when VALUE is intact, spins when it is not — the shape of the real
        // entries, without the multi-GB appetite.
        "import { VALUE } from './src.mjs';\n" + "if (VALUE !== 'expected') { for (;;) {} }\n",
      );
      const { status, out } = run(dir, [], { MUTATION_TIMEOUT_MS: '3000' });
      assert.match(out, /killed/);
      assert.match(out, /timed out/);
      assert.equal(status, 0);
      assert.equal(sourceOf(dir), SOURCE);
      // No worker still executing THIS hang fixture (process-group kill).
      // Scope to hangPath so leftovers from earlier runs do not false-positive.
      const ps = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
      const survivors = (ps.stdout ?? '').split('\n').filter((l) => l.includes(hangPath));
      assert.equal(survivors.length, 0, `orphan hang process(es):\n${survivors.join('\n')}`);
    },
  );
});

test('a hang pin is cut at the baseline-scaled bound, not its full timeout_ms', () => {
  // The entry records 60 s. Its gate's green baseline takes well under a second, so
  // the spin must be killed at the 5 s floor — and the verdict must still be a
  // timeout, since that is the reason the entry records.
  withTree(
    [
      entry({
        gate: 'node-test:fx/hang.test.mjs',
        expect_detail: 'timed out',
        timeout_ms: 60_000,
      }),
    ],
    {},
    (dir) => {
      writeFileSync(
        join(dir, 'fx', 'hang.test.mjs'),
        "import { VALUE } from './src.mjs';\n" + "if (VALUE !== 'expected') { for (;;) {} }\n",
      );
      const t0 = Date.now();
      const { status, out } = runClean(dir);
      const took = Date.now() - t0;
      assert.equal(status, 0, out);
      assert.match(out, /killed/);
      assert.match(out, /timed out after 5000ms/);
      assert.ok(took < 30_000, `waited ${took}ms — the recorded 60 s bound was not shortened`);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('an entry with timeout_ms but a non-timeout reason keeps its full bound', () => {
  // A slow kill, not a hang: the mutant takes 7 s — past the 5 s floor — and then
  // fails for the reason the entry records. Shortening its bound would replace that
  // assertion with a timeout and report WRONG REASON for a mutation that works.
  withTree(
    [
      entry({
        gate: 'node-test:fx/slow.test.mjs',
        expect_detail: 'THE-SLOW-REASON',
        timeout_ms: 60_000,
      }),
    ],
    {},
    (dir) => {
      writeFileSync(
        join(dir, 'fx', 'slow.test.mjs'),
        "import test from 'node:test';\n" +
          "import assert from 'node:assert/strict';\n" +
          "import { VALUE } from './src.mjs';\n" +
          "test('slow', async () => {\n" +
          "  if (VALUE !== 'expected') await new Promise((r) => setTimeout(r, 7000));\n" +
          "  assert.equal(VALUE, 'expected', 'THE-SLOW-REASON');\n" +
          '});\n',
      );
      const { status, out } = runClean(dir);
      assert.equal(status, 0, out);
      assert.match(out, /killed/);
      assert.doesNotMatch(out, /timed out/);
      assert.doesNotMatch(out, /WRONG REASON/);
    },
  );
});

// The two cases below drive an `odin:` gate through a stub compiler (ODIN=), since
// gateOdin is the only gate that reports a run-only time and so the only place the
// bound's scaling and its build/run split can be seen.

test('a hang pin whose baseline is slow is cut at HANG_FACTOR times it, not the floor', () => {
  // Every other hang case has a baseline far under 250 ms, where the 5 s floor wins
  // and the factor never shows. Here a healthy run takes 400 ms, so the bound must
  // be at least 20 x 400 ms — a factor of 1 would cut it at the floor and time out
  // a mutant that a slower runner might have been about to pass.
  withTree(
    [entry({ gate: 'odin:pkg:main.t', expect_detail: 'timed out', timeout_ms: 60_000 })],
    {},
    (dir) => {
      const odin = odinStub(dir, { green: `sleep 0.4; ${ODIN_PASS}`, mutant: 'exec sleep 600' });
      const { status, out } = runClean(dir, [], { ODIN: odin });
      assert.equal(status, 0, out);
      assert.match(out, /killed/);
      const ms = Number(/timed out after (\d+)ms/.exec(out)?.[1]);
      assert.ok(ms >= 8_000 && ms < 60_000, `bound ${ms}ms is not 20 x a 400 ms baseline:\n${out}`);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('an odin: hang bound scales with the test run, not with the compile', () => {
  // The build takes 1 s and the run is instant. Charging the build to the baseline
  // would make the bound 20 x ~1 s, capped here at the entry's 15 s; the run alone
  // keeps it at the 5 s floor.
  withTree(
    [entry({ gate: 'odin:pkg:main.t', expect_detail: 'timed out', timeout_ms: 15_000 })],
    {},
    (dir) => {
      const odin = odinStub(dir, { mutant: 'exec sleep 600', buildDelay: 1 });
      const { status, out } = runClean(dir, [], { ODIN: odin });
      assert.equal(status, 0, out);
      assert.match(out, /killed/);
      assert.match(out, /timed out after 5000ms/);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});
