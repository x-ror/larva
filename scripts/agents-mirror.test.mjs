// agents/specialists/ is the canonical text of every specialist; .claude/agents/ is a
// byte-for-byte copy that exists only so the Claude Code harness discovers them
// (CLAUDE.md §8). Copies, not symlinks, so discovery does not depend on how a given
// harness version treats links. The cost of copies is drift: an edit to one side is
// silently not the agent that runs. This test is what makes the copy safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const canonical = join(root, 'agents', 'specialists');
const mirror = join(root, '.claude', 'agents');
// The reply contract every specialist carries. One canonical copy, checked here for
// the same reason the mirror is: a specialist whose copy drifted is a worker that
// answers the conductor in the wrong shape, and nothing else would notice.
const contract = readFileSync(
  join(root, 'agents', 'prompts', 'conductor-reference', 'report-contract.md'),
  'utf8',
)
  .split('<!-- contract:start -->')[1]
  .split('<!-- contract:end -->')[0]
  .trim();
const mdFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();

test('.claude/agents mirrors agents/specialists file-for-file', () => {
  assert.deepEqual(mdFiles(mirror), mdFiles(canonical));
});

for (const f of mdFiles(canonical)) {
  test(`.claude/agents/${f} is identical to agents/specialists/${f}`, () => {
    assert.equal(
      readFileSync(join(mirror, f), 'utf8'),
      readFileSync(join(canonical, f), 'utf8'),
      `edit agents/specialists/${f}, then copy it to .claude/agents/`,
    );
  });

  test(`agents/specialists/${f} declares name: matching its file name`, () => {
    const m = /^---\n[\s\S]*?^name: (.+)$/m.exec(readFileSync(join(canonical, f), 'utf8'));
    assert.ok(m, 'frontmatter has a name:');
    assert.equal(m[1].trim(), f.slice(0, -'.md'.length));
  });

  // `inherit` would run a worker on the session's (conductor's) model — the most
  // expensive one — for exactly the volume work the split exists to move off it.
  test(`agents/specialists/${f} pins model: opus or sonnet, never inherit`, () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(canonical, f), 'utf8'));
    assert.ok(fm, 'has frontmatter');
    const m = /^model: (.+)$/m.exec(fm[1]);
    assert.ok(m, 'frontmatter has a model:');
    assert.match(m[1].trim(), /^(opus|sonnet)$/);
  });

  test(`agents/specialists/${f} carries the reply contract verbatim`, () => {
    const text = readFileSync(join(canonical, f), 'utf8');
    assert.ok(contract.length > 200, 'canonical contract was found');
    assert.ok(
      text.includes(`## Reply to the conductor\n\n${contract}\n`),
      'copy the block from agents/prompts/conductor-reference/report-contract.md',
    );
  });
}
