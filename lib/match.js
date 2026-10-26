// Decides which Claude Code session each open Claude Code tab is showing.
// VS Code tells other extensions only a tab's title, so tabs are matched to sessions by title.
'use strict';

// The title Claude Code gives a tab before its session has a title of its own.
const PLACEHOLDER = 'Claude Code';

// The tab title Claude Code makes from a session title: titles over 25 characters become the
// first 24 plus "…" (Claude Code's own rule, read from its webview code).
const cut = (title) => (!title ? PLACEHOLDER : title.length > 25 ? `${title.substring(0, 24)}…` : title);

// tabs:     [{ id, label }]
// sessions: [{ sessionId, title, live, updatedAt }] — live: a Claude process is running it
// previous: Map of tab id -> session id from the last run
// Returns a Map of tab id -> session id. A tab without a confident match is left out.
function bindTabs(tabs, sessions, previous) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const byTitle = new Map();
  for (const s of sessions) {
    if (!s.title) continue;
    const t = cut(s.title);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(s);
  }
  // When sessions share a title, prefer a running one, then the most recently active.
  for (const list of byTitle.values()) list.sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt);

  const out = new Map();
  const used = new Set();
  const take = (tab, s) => {
    out.set(tab.id, s.sessionId);
    used.add(s.sessionId);
  };

  // 1. A titled tab shows the session with that title — the same one as last time when possible.
  for (const tab of tabs) {
    if (tab.label === PLACEHOLDER) continue;
    const free = (byTitle.get(tab.label) || []).filter((s) => !used.has(s.sessionId));
    const pick = free.find((s) => s.sessionId === previous.get(tab.id)) || free[0];
    if (pick) take(tab, pick);
  }

  // 2. A tab whose new title no session has yet (the transcript catches up a moment later)
  //    keeps the session it showed before.
  for (const tab of tabs) {
    if (out.has(tab.id) || tab.label === PLACEHOLDER || byTitle.has(tab.label)) continue;
    const prev = byId.get(previous.get(tab.id));
    if (prev && !used.has(prev.sessionId)) take(tab, prev);
  }

  // 3. "Claude Code" tabs show a running session that has no title yet. Without a previous match,
  //    pair them only when there is exactly one of each, so the panel never guesses.
  const untitled = sessions.filter((s) => s.live && !s.title);
  const blank = tabs.filter((t) => t.label === PLACEHOLDER);
  for (const tab of blank) {
    const prev = untitled.find((s) => s.sessionId === previous.get(tab.id));
    if (prev && !used.has(prev.sessionId)) take(tab, prev);
  }
  const tabsLeft = blank.filter((t) => !out.has(t.id));
  const sessionsLeft = untitled.filter((s) => !used.has(s.sessionId));
  if (tabsLeft.length === 1 && sessionsLeft.length === 1) take(tabsLeft[0], sessionsLeft[0]);

  return out;
}

module.exports = { PLACEHOLDER, cut, bindTabs };
