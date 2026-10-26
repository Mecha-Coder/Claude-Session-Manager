'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bindTabs, cut, PLACEHOLDER } = require('../lib/match');

const session = (sessionId, title, live = true, updatedAt = 0) => ({ sessionId, title, live, updatedAt });

test('tab titles are cut the way Claude Code cuts them, so long titles still match', () => {
  // Labels exactly as Claude Code shows them on the tabs (seen in VS Code on 22 Oct 2026).
  assert.equal(cut('Backend out-of-memory investigation'), 'Backend out-of-memory in…');
  assert.equal(cut('Admin sync page UI/UX review'), 'Admin sync page UI/UX re…');
  assert.equal(cut('Exactly twenty-five chars'), 'Exactly twenty-five chars');
  assert.equal(cut(undefined), PLACEHOLDER);
});

test('a tab shows the session whose title matches its (cut) label', () => {
  const out = bindTabs(
    [{ id: 1, label: 'Backend out-of-memory in…' }, { id: 2, label: 'Admin sync page UI/UX re…' }],
    [session('a', 'Admin sync page UI/UX review'), session('b', 'Backend out-of-memory investigation')],
    new Map()
  );
  assert.equal(out.get(1), 'b');
  assert.equal(out.get(2), 'a');
});

test('when two titles start with the same 24 characters, the running session wins', () => {
  const out = bindTabs(
    [{ id: 1, label: 'Chatbot out-of-memory in…' }],
    [session('old', 'Chatbot out-of-memory investigation 1', false, 9), session('now', 'Chatbot out-of-memory investigation 2', true, 1)],
    new Map()
  );
  assert.equal(out.get(1), 'now');
});

test('two tabs with the same title get two different sessions, and keep them on later refreshes', () => {
  const tabs = [{ id: 1, label: 'Test' }, { id: 2, label: 'Test' }];
  const sessions = [session('a', 'Test', true, 1), session('b', 'Test', true, 2)];
  const first = bindTabs(tabs, sessions, new Map());
  assert.equal(new Set(first.values()).size, 2);

  // The more recent session changes activity order; the tabs must not swap statuses.
  const again = bindTabs(tabs, [session('a', 'Test', true, 9), session('b', 'Test', true, 2)], first);
  assert.deepEqual([...again], [...first]);
});

test('a tab keeps its session while the new title has not reached the transcript yet', () => {
  const previous = new Map([[1, 'a']]);
  const out = bindTabs([{ id: 1, label: 'New title' }], [session('a', 'Old title')], previous);
  assert.equal(out.get(1), 'a');
});

test('a renamed tab moves to the session that now has that title', () => {
  const previous = new Map([[1, 'a']]);
  const out = bindTabs([{ id: 1, label: 'Second chat' }], [session('a', 'First chat'), session('b', 'Second chat')], previous);
  assert.equal(out.get(1), 'b');
});

test('a "Claude Code" tab pairs with an untitled running session only when there is exactly one of each', () => {
  const one = bindTabs([{ id: 1, label: PLACEHOLDER }], [session('a', undefined)], new Map());
  assert.equal(one.get(1), 'a');

  // Two new tabs and two untitled sessions: any pairing would be a guess, so none is made.
  const two = bindTabs([{ id: 1, label: PLACEHOLDER }, { id: 2, label: PLACEHOLDER }], [session('a', undefined), session('b', undefined)], new Map());
  assert.equal(two.size, 0);

  // A pairing made earlier, while it was unambiguous, is kept.
  const kept = bindTabs([{ id: 1, label: PLACEHOLDER }, { id: 2, label: PLACEHOLDER }], [session('a', undefined), session('b', undefined)], new Map([[1, 'b']]));
  assert.equal(kept.get(1), 'b');
});

test('a session that is not running never matches a "Claude Code" tab', () => {
  const out = bindTabs([{ id: 1, label: PLACEHOLDER }], [session('a', undefined, false)], new Map());
  assert.equal(out.size, 0);
});

test('a running session wins over an old transcript with the same title', () => {
  const out = bindTabs([{ id: 1, label: 'Fix login' }], [session('old', 'Fix login', false, 50), session('now', 'Fix login', true, 10)], new Map());
  assert.equal(out.get(1), 'now');
});
