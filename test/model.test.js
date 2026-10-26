'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../lib/model');

const withGroups = (...names) => {
  const s = model.load(null);
  const ids = names.map((n, i) => model.addGroup(s, n, 1000 + i).id);
  return { s, ids };
};

test('first-version state keeps its groups, but a new "Claude Code" tab no longer inherits an old group', () => {
  // The first version remembered groups by tab title. Every new tab is titled "Claude Code" until
  // Claude names it, so remembering that title dropped unrelated new sessions into an old group.
  const s = model.load({
    groups: [{ id: 'g1', name: 'App Infra', color: 'charts.blue', collapsed: false }],
    assign: { 'label:Claude Code': 'g1', 'label:Backend out-of-memory investigation': 'g1' },
  });
  assert.equal(s.groups[0].name, 'App Infra');

  // A brand-new tab matched at once to its untitled session still has the title "Claude Code".
  model.addKey(s, 'session-new', undefined, 'Claude Code');
  assert.equal(model.listOf(s, 'session-new'), model.UNGROUPED);

  model.addKey(s, 'session-a', undefined, 'Backend out-of-memory investigation');
  assert.equal(model.listOf(s, 'session-a'), 'g1', 'a titled tab from the old version goes back to its group');
});

test('dropping a session between two others in another group lands exactly there', () => {
  const { s, ids } = withGroups('Infra', 'UI');
  for (const k of ['a', 'b']) model.place(s, k, ids[0]);
  for (const k of ['x', 'y']) model.place(s, k, ids[1]);

  model.place(s, 'a', ids[1], 'y');

  assert.deepEqual(s.lists[ids[0]], ['b']);
  assert.deepEqual(s.lists[ids[1]], ['x', 'a', 'y']);
});

test('dropping a session just before itself does not move it to the end', () => {
  const { s, ids } = withGroups('Infra');
  for (const k of ['a', 'b', 'c']) model.place(s, k, ids[0]);
  model.place(s, 'b', ids[0], 'b');
  assert.deepEqual(s.lists[ids[0]], ['a', 'b', 'c']);
});

test('unpinning puts a session back in the group it was pinned from', () => {
  const { s, ids } = withGroups('Infra');
  model.place(s, 'a', ids[0]);
  model.pin(s, 'a');
  assert.equal(model.listOf(s, 'a'), model.PINNED);
  model.unpin(s, 'a');
  assert.equal(model.listOf(s, 'a'), ids[0]);
});

test('an archived session reopened later returns to its old group', () => {
  const { s, ids } = withGroups('Infra');
  model.place(s, 'a', ids[0]);
  model.archive(s, 'a', 'Backend OOM', 5);
  assert.equal(model.listOf(s, 'a'), undefined);
  assert.equal(s.archived[0].title, 'Backend OOM');

  // The tab comes back (from the panel's Reopen or from Claude Code's own history).
  model.addKey(s, 'a', undefined, 'Backend OOM');
  assert.equal(model.listOf(s, 'a'), ids[0]);
  assert.equal(s.archived.length, 0);
});

test('deleting a group never loses its sessions', () => {
  const { s, ids } = withGroups('Infra');
  model.place(s, 'a', ids[0]);
  model.place(s, 'b', ids[0]);
  model.pin(s, 'b');
  model.deleteGroup(s, ids[0]);
  assert.deepEqual(s.lists[model.UNGROUPED], ['a']);
  model.unpin(s, 'b');
  assert.equal(model.listOf(s, 'b'), model.UNGROUPED, 'unpinning falls back to Ungrouped when its group is gone');
});

test('a tab keeps its place when its session becomes known', () => {
  const { s, ids } = withGroups('Infra');
  model.place(s, 'x', ids[0]);
  model.place(s, 'tab:7', ids[0]);
  model.place(s, 'y', ids[0]);

  model.renameKey(s, 'tab:7', 'session-7');

  assert.deepEqual(s.lists[ids[0]], ['x', 'session-7', 'y']);
});

test('after /clear the new session takes the tab\'s place and the old one is remembered for reopening', () => {
  const { s, ids } = withGroups('Infra');
  model.place(s, 'old', ids[0]);
  model.renameKey(s, 'old', 'new');
  assert.deepEqual(s.lists[ids[0]], ['new', 'old']);
});

test('unknown tabs are never saved, so a reload does not leave dead entries', () => {
  const { s, ids } = withGroups('Infra');
  model.place(s, 'tab:3', ids[0]);
  model.place(s, 'real', ids[0]);
  model.touch(s, ['tab:3', 'real'], 100);
  const saved = model.toJSON(s);
  assert.deepEqual(saved.lists[ids[0]], ['real']);
  assert.deepEqual(Object.keys(saved.seen), ['real']);
  assert.deepEqual(model.load(saved).lists[ids[0]], ['real']);
});

test('prune forgets sessions closed for over 30 days but keeps recent ones and the archive', () => {
  const s = model.load(null);
  model.place(s, 'old', model.UNGROUPED);
  model.place(s, 'recent', model.UNGROUPED);
  model.place(s, 'gone', model.UNGROUPED);
  model.archive(s, 'gone', 'Gone', 1);
  model.touch(s, ['old'], 100);
  model.touch(s, ['recent'], 125);

  model.prune(s, 100 + model.KEEP_DAYS + 1);

  assert.deepEqual(s.lists[model.UNGROUPED], ['recent']);
  assert.equal(s.archived.length, 1);
});

test('new groups take a color no other group uses yet', () => {
  const { s } = withGroups('A', 'B', 'C');
  const colors = s.groups.map((g) => g.color);
  assert.equal(new Set(colors).size, 3);
});

test('groups saved with the old theme colors keep a similar color, not all the first one', () => {
  // Before v0.3.0 groups stored VS Code theme color ids. Unknown ids fall back to the first color,
  // so without the old-id map every existing group would turn the same color after the update.
  const s = model.load({
    v: 2,
    groups: [
      { id: 'g1', name: 'Infra', color: 'charts.red' },
      { id: 'g2', name: 'Login', color: 'charts.purple' },
      { id: 'g3', name: 'Tests', color: 'charts.green' },
    ],
  });
  assert.deepEqual(s.groups.map((g) => g.color), ['red', 'purple', 'teal']);
});

test('the palette has enough distinct colors for many groups', () => {
  const { s } = withGroups(...Array.from({ length: 16 }, (_, i) => `G${i}`));
  assert.equal(new Set(s.groups.map((g) => g.color)).size, 16);
  assert.equal(new Set(model.PALETTE.map((c) => c[2])).size, model.PALETTE.length);
});
