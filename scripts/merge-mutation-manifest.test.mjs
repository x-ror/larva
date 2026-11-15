// Tests for the mutation-manifest merge driver. A wrong merge here silently drops
// or overwrites a recorded mutation, so most cases are about refusing to guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeManifests } from './merge-mutation-manifest.mjs';

const e = (name, extra = {}) => ({ name, find: 'a', replace: 'b', ...extra });
const m = (...entries) => ({ $comment: ['c'], mutations: entries });

test('entries appended on both sides are both kept', () => {
  const r = mergeManifests(m(e('x')), m(e('x'), e('ours')), m(e('x'), e('theirs')));
  assert.deepEqual(
    r.merged.mutations.map((x) => x.name),
    ['x', 'ours', 'theirs'],
  );
});

test('an entry changed on one side only takes that change', () => {
  const r = mergeManifests(m(e('x')), m(e('x')), m(e('x', { replace: 'new' })));
  assert.equal(r.merged.mutations[0].replace, 'new');
});

test('an entry changed differently on both sides is a conflict', () => {
  const r = mergeManifests(m(e('x')), m(e('x', { replace: 'o' })), m(e('x', { replace: 't' })));
  assert.deepEqual(r.conflicts, ['mutation "x"']);
});

test('removed on one side and untouched on the other is removed', () => {
  const r = mergeManifests(m(e('x'), e('y')), m(e('x')), m(e('x'), e('y')));
  assert.deepEqual(
    r.merged.mutations.map((x) => x.name),
    ['x'],
  );
});

test('removed on one side and changed on the other is a conflict', () => {
  const r = mergeManifests(m(e('x'), e('y')), m(e('x')), m(e('x'), e('y', { replace: 't' })));
  assert.deepEqual(r.conflicts, ['mutation "y"']);
});

test('the header comment follows the same three-way rule', () => {
  const r = mergeManifests(m(), { ...m(), $comment: ['o'] }, { ...m(), $comment: ['t'] });
  assert.deepEqual(r.conflicts, ['$comment']);
});
