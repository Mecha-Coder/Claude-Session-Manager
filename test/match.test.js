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

test('a session with no title yet is never given to a tab, because its own tab may already be named after the prompt', () => {
  // Seen on 31 Oct 2026: you send the first prompt in tab 2, and Claude Code names that tab after the
  // prompt at once; the AI title reaches the transcript a few seconds later. An unused "Claude Code"
  // tab (tab 1) was still open in another group. Giving the new session to tab 1 put it in tab 1's
  // group for good, so the row jumped to that group when the title arrived.
  const out = bindTabs(
    [{ id: 1, label: PLACEHOLDER }, { id: 2, label: 'Please refactor the logi…' }],
    [session('new', undefined)],
    new Map()
  );
  assert.equal(out.size, 0);

  // One "Claude Code" tab and one untitled session are still not proof: the session may run in
  // Claude Code's sidebar, or in a tab VS Code has not reported yet.
  assert.equal(bindTabs([{ id: 1, label: PLACEHOLDER }], [session('new', undefined)], new Map()).size, 0);
});

test('a new session reaches its own tab once its title arrives, even with an unused "Claude Code" tab open', () => {
  const tabs = [{ id: 1, label: PLACEHOLDER }, { id: 2, label: 'Refactor the login form …' }];
  const out = bindTabs(tabs, [session('new', 'Refactor the login form validation')], new Map());
  assert.deepEqual([...out], [[2, 'new']]);
});

test('a running session wins over an old transcript with the same title', () => {
  const out = bindTabs([{ id: 1, label: 'Fix login' }], [session('old', 'Fix login', false, 50), session('now', 'Fix login', true, 10)], new Map());
  assert.equal(out.get(1), 'now');
});
