'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('../lib/sessions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-manager-'));
const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (usage, extra = {}) => ({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', usage }, ...extra });

test('a title set with rename wins over the generated one, so a renamed tab still finds its session', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'Generated' }) + line({ type: 'custom-title', customTitle: 'Renamed' }) + line({ type: 'ai-title', aiTitle: 'Generated again' }));
  assert.equal(sessions.readTranscriptInfo(file).title, 'Renamed');
});

test('text copied inside a message never counts as the title', () => {
  // A tool result that shows transcript lines stores them escaped inside a string.
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'Real title' }) + line({ type: 'user', message: { content: '{"type":"custom-title","customTitle":"Fake"}' } }));
  assert.equal(sessions.readTranscriptInfo(file).title, 'Real title');
});

test('context size is the latest main-conversation reply, not a subagent or synthetic one', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(
    file,
    line(assistant({ input_tokens: 10, cache_read_input_tokens: 400000, cache_creation_input_tokens: 8000, output_tokens: 200 })) +
      line(assistant({ input_tokens: 5, output_tokens: 5 }, { isSidechain: true })) +
      line({ type: 'assistant', isSidechain: false, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } })
  );
  const info = sessions.readTranscriptInfo(file);
  assert.equal(info.tokens, 408210);
  assert.equal(info.model, 'claude-opus-5-5');
});

test('a question that a reload interrupted still counts as asked until Claude replies again', () => {
  // Real shape from 21 Oct: Claude asked, the tool call was interrupted, nothing came after.
  const dir = tmp();
  const ask = { type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: {} };
  const interrupted = [
    line(assistant({ input_tokens: 1 }, { message: { model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [ask] } })),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'The user doesn\'t want to proceed' }] } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  ].join('');
  const asked = path.join(dir, 'asked.jsonl');
  fs.writeFileSync(asked, interrupted);
  assert.equal(sessions.readTranscriptInfo(asked).asked, true);

  const answered = path.join(dir, 'answered.jsonl');
  fs.writeFileSync(answered, interrupted + line(assistant({ input_tokens: 2 }, { message: { model: 'claude-opus-5-5', usage: { input_tokens: 2 }, content: [{ type: 'text', text: 'Thanks' }] } })));
  assert.equal(sessions.readTranscriptInfo(answered).asked, false);
});

test('a long transcript is read from both ends: early title, latest context size', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  const filler = line({ type: 'user', message: { content: 'x'.repeat(1000) } }).repeat(600); // ~600 KB
  fs.writeFileSync(file, line({ type: 'custom-title', customTitle: 'Named early' }) + filler + line(assistant({ input_tokens: 1, cache_read_input_tokens: 999 })));
  const info = sessions.readTranscriptInfo(file);
  assert.equal(info.title, 'Named early');
  assert.equal(info.tokens, 1000);
});

test('status files of dead processes and half-written files are skipped', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'alive', status: 'waiting', waitingFor: 'input needed', entrypoint: 'claude-vscode', cwd: '/w' }));
  fs.writeFileSync(path.join(dir, '2147483646.json'), JSON.stringify({ pid: 2147483646, sessionId: 'dead', status: 'busy' }));
  fs.writeFileSync(path.join(dir, '77.json'), '{"pid": 77, "sessionId": ');
  const live = sessions.readLiveSessions(dir);
  assert.equal(live.ok, true);
  assert.deepEqual(live.sessions.map((s) => s.sessionId), ['alive']);
  assert.equal(sessions.statusOf(live.sessions[0]), 'needs-input');
  assert.equal(live.sessions[0].waitingFor, 'input needed');
});

test('a missing status folder or a changed file format is reported, not shown as idle', () => {
  assert.equal(sessions.readLiveSessions(path.join(tmp(), 'nope')).ok, false);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'a', state: 'busy' }));
  assert.equal(sessions.readLiveSessions(dir).ok, false);
});

test('busy, waiting and idle map to the panel statuses', () => {
  assert.equal(sessions.statusOf({ status: 'busy' }), 'working');
  assert.equal(sessions.statusOf({ status: 'waiting' }), 'needs-input');
  assert.equal(sessions.statusOf({ status: 'idle' }), 'idle');
  assert.equal(sessions.statusOf({ status: 'something-new' }), 'unknown');
});

test('the transcript folder name follows Claude Code: every non-letter, non-digit becomes "-"', () => {
  assert.equal(path.basename(sessions.projectDir('/Users/me/work/my_app.v2')), '-Users-me-work-my-app-v2');
});

test('restored tabs find their session by title, newest transcript first', () => {
  const dir = tmp();
  const write = (id, title, mtime) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, line({ type: 'ai-title', aiTitle: title }));
    fs.utimesSync(f, mtime, mtime);
  };
  write('older', 'Fix login', 1000);
  write('newer', 'Fix login', 2000);
  write('other', 'Other', 3000);
  const found = sessions.findByTitles([dir], ['Fix login'], new sessions.TranscriptCache());
  assert.deepEqual(found.map((f) => f.sessionId), ['newer']);
});

test('an idle session still running a background command shows as working, not idle', () => {
  // Lines as `ps -o ppid=,command=` printed them on 22 Oct for a session whose turn had ended while
  // `bun run test:required` ran in the background. Its MCP servers are children of the same process.
  const ps = [
    '61217 /opt/homebrew/bin/uv tool uvx --from git+https://github.com/oraios/serena serena start-mcp-server',
    '61217 npm exec @playwright/mcp@latest --output-dir /tmp/screenshot',
    '61217 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1792623570980-z5f2zy.sh 2>/dev/null || true && eval \'bun run test:required\'',
    '  4532 /opt/homebrew/bin/uv tool uvx mcp-proxy-for-aws==1.6.4',
  ].join('\n');
  const background = sessions.backgroundPids(ps);
  assert.deepEqual([...background], [61217]);
  assert.equal(sessions.statusOf({ pid: 61217, status: 'idle' }, background), 'working');
  assert.equal(sessions.statusOf({ pid: 4532, status: 'idle' }, background), 'idle', 'MCP servers alone are not work');
  assert.equal(sessions.statusOf({ pid: 61217, status: 'waiting' }, background), 'needs-input', 'a question still wins');
});

test('an idle session with a background helper agent still running shows as working', () => {
  // On 23 Oct session 9f13e2f4 was idle while its "Implement Story 12.1 spec" agent ran in the
  // background. Claude picks up again when the agent ends, so the panel must not call it idle.
  const dir = tmp();
  const started = Date.now() - 60000;
  const meta = (name, o, mtime = Date.now()) => {
    const file = path.join(dir, `agent-${name}.meta.json`);
    fs.writeFileSync(file, JSON.stringify({ agentType: 'general-purpose', ...o }));
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  meta('done', { requestShape: 'background', finished: true });
  meta('fg', { requestShape: 'foreground' });
  meta('stopped', { requestShape: 'background', stoppedByUser: true });
  // Older Claude Code never wrote "finished": an agent from before this process started is not running.
  meta('old', { requestShape: 'background' }, started - 3600000);
  assert.equal(sessions.hasRunningAgent(dir, started), false, 'finished, foreground, stopped and old agents are not work');

  meta('running', { requestShape: 'background' });
  assert.equal(sessions.hasRunningAgent(dir, started), true);
  assert.equal(sessions.hasRunningAgent(path.join(dir, 'missing'), started), false);
});
