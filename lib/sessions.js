// Reads what Claude Code itself writes to disk: one status file per running Claude process and one
// transcript per session. Both are Claude Code internals, not a public API — when a Claude Code update
// changes them, the panel shows a warning instead of quietly showing wrong status.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cut } = require('./match');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 256 * 1024;

// ---------------------------------------------------------------- live status

// ~/.claude/sessions/<pid>.json — Claude Code rewrites it whenever the session's status changes:
// "busy", "waiting" (with waitingFor, e.g. "input needed") or "idle".
function readLiveSessions(dir = SESSIONS_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { ok: false, problem: `Live status is off: Claude Code's status folder (${dir}) was not found.`, sessions: [] };
  }
  const sessions = [];
  let changedFormat = false;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // being rewritten right now; the next refresh reads it
    }
    if (!d || typeof d.sessionId !== 'string' || !isAlive(d.pid)) continue;
    if (typeof d.status !== 'string') changedFormat = true;
    sessions.push({
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: d.cwd,
      entrypoint: d.entrypoint,
      status: d.status,
      waitingFor: typeof d.waitingFor === 'string' ? d.waitingFor : undefined,
      updatedAt: d.statusUpdatedAt || d.updatedAt || 0,
      startedAt: d.startedAt || 0,
    });
  }
  if (changedFormat) {
    return { ok: false, problem: "Live status may be wrong: Claude Code's status files changed format.", sessions };
  }
  return { ok: true, problem: '', sessions };
}

function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const STATUS = { busy: 'working', waiting: 'needs-input', idle: 'idle' };
// An idle session with a background command or helper agent still running is still at work: Claude
// picks up again when it ends. `background` holds the pids of such sessions.
const statusOf = (live, background = new Set()) =>
  live.status === 'idle' && background.has(live.pid) ? 'working' : STATUS[live.status] || 'unknown';

// Claude Code runs every command in a shell that first sources a file in ~/.claude/shell-snapshots/,
// as a child of the Claude process. Its MCP servers are children too, but never such a shell. So an
// idle Claude process with such a child has a background command running. Takes `ps -o ppid=,command=`.
function backgroundPids(psOutput) {
  const pids = new Set();
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && m[2].includes('/.claude/shell-snapshots/')) pids.add(Number(m[1]));
  }
  return pids;
}

function readBackgroundPids() {
  try {
    return backgroundPids(execFileSync('ps', ['-A', '-o', 'ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return new Set();
  }
}

// <project folder>/<sessionId>/subagents/agent-<id>.meta.json, one per helper agent. Claude Code adds
// "finished": true when a background agent ends ("stoppedByUser" when you stop it). Older Claude Code
// versions never wrote "finished", so only files written since this Claude process started count.
const subagentsDir = (cwd, sessionId) => path.join(projectDir(cwd), sessionId, 'subagents');

function hasRunningAgent(dir, since) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false; // this session never started a helper agent
  }
  return names.some((name) => {
    if (!name.endsWith('.meta.json')) return false;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < since) return false;
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      return m.requestShape === 'background' && !m.finished && !m.stoppedByUser;
    } catch {
      return false; // being rewritten right now; the next refresh reads it
    }
  });
}

// ---------------------------------------------------------------- transcripts

// ~/.claude/projects/<folder>/<sessionId>.jsonl — the folder is the session's working directory with
// every character that is not a letter or digit replaced by "-".
const projectDir = (cwd) => path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const transcriptPath = (cwd, sessionId) => path.join(projectDir(cwd), `${sessionId}.jsonl`);

// Title, context size and model of a session. Reads only the start and the end of the transcript
// (as Claude Code does), so very long transcripts stay cheap.
function readTranscriptInfo(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    const whole = size <= HEAD_BYTES + TAIL_BYTES;
    const head = readText(fd, 0, whole ? size : HEAD_BYTES);
    const tail = whole ? head : readText(fd, size - TAIL_BYTES, TAIL_BYTES);
    const reply = lastReply(tail, whole);
    return {
      // A title set with Claude Code's rename wins over the generated one, as in Claude Code's own list.
      title: lastField(tail, 'customTitle') ?? lastField(head, 'customTitle') ?? lastField(tail, 'aiTitle') ?? lastField(head, 'aiTitle'),
      tokens: reply && reply.tokens,
      model: reply && reply.model,
      asked: !!(reply && reply.asked),
      mtimeMs,
      size,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readText(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.toString('utf8', 0, n);
}

// The last `"name":"…"` in the text. Copies of transcript text inside messages are escaped (\"name\"),
// so they never match.
function lastField(text, name) {
  const re = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m;
  let last;
  while ((m = re.exec(text))) last = m[1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(`"${last}"`);
  } catch {
    return undefined;
  }
}

// Claude's latest reply in the main conversation: the context size after it (everything the model
// read plus what it wrote), and whether it was a question to you (AskUserQuestion) that nothing has
// followed yet. Subagent replies and Claude Code's own synthetic messages are skipped.
function lastReply(text, startsAtLine) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= (startsAtLine ? 0 : 1); i--) {
    const line = lines[i];
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"') || line.includes('"isSidechain":true')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message;
    if (d.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') continue;
    const u = m.usage;
    const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    const asked = Array.isArray(m.content) && m.content.some((c) => c && c.type === 'tool_use' && c.name === 'AskUserQuestion');
    return { tokens, model: m.model, asked };
  }
  return null;
}

// Re-reads a transcript only when it changed on disk.
class TranscriptCache {
  constructor() {
    this.map = new Map();
  }

  get(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      this.map.delete(file);
      return null;
    }
    const hit = this.map.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const info = readTranscriptInfo(file);
    if (info) this.map.set(file, info);
    return info;
  }
}

// Sessions whose title is one of `titles`, newest transcript first. Used for tabs Claude Code restored
// after a reload without starting their session. Stops once every title is found, and reads at most
// `limit` transcripts.
function findByTitles(dirs, titles, cache, limit = 200) {
  const wanted = new Set(titles);
  const files = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        files.push({ file, sessionId: name.slice(0, -'.jsonl'.length), mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        // deleted while listing
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const found = [];
  for (const f of files.slice(0, limit)) {
    if (!wanted.size) break;
    const info = cache.get(f.file);
    const title = info && info.title && cut(info.title);
    if (title && wanted.has(title)) {
      found.push({ sessionId: f.sessionId, info, updatedAt: f.mtimeMs });
      wanted.delete(title);
    }
  }
  return found;
}

module.exports = {
  SESSIONS_DIR,
  readLiveSessions,
  statusOf,
  backgroundPids,
  readBackgroundPids,
  subagentsDir,
  hasRunningAgent,
  projectDir,
  transcriptPath,
  readTranscriptInfo,
  TranscriptCache,
  findByTitles,
};
