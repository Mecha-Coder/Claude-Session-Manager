// The panel's layout: groups, the order of sessions, pins and the archive.
// Plain data and plain functions, so the rules can be tested without VS Code.
'use strict';

const { PLACEHOLDER } = require('./match');

// Group colors: [id, name, hex]. Fixed colors, not theme colors, so they look the same in every theme.
// No bright orange, green or blue: those mean Needs input, Done and Working in the status dots.
// Top row light (dark text), bottom row deep (white text); each column is one color family.
const PALETTE = [
  ['red', 'Red', '#f28b82'],
  ['pink', 'Pink', '#ff8bcb'],
  ['purple', 'Purple', '#c58af9'],
  ['indigo', 'Indigo', '#a5b4fc'],
  ['sky', 'Sky', '#8ab4f8'],
  ['cyan', 'Cyan', '#78d9ec'],
  ['lemon', 'Lemon', '#fff475'],
  ['sand', 'Sand', '#e6c9a8'],
  ['crimson', 'Crimson', '#c5221f'],
  ['berry', 'Berry', '#b80672'],
  ['violet', 'Violet', '#7e3ff2'],
  ['navy', 'Navy', '#3949ab'],
  ['slate', 'Slate', '#546e7a'],
  ['teal', 'Teal', '#00796b'],
  ['grey', 'Grey', '#9aa0a6'],
  ['brown', 'Brown', '#795548'],
];
const COLORS = PALETTE.map((c) => c[0]);
// Theme color ids saved before v0.3.0, so existing groups keep a similar color.
const OLD_COLORS = {
  'charts.blue': 'sky',
  'terminal.ansiMagenta': 'pink',
  'charts.green': 'teal',
  'charts.yellow': 'lemon',
  'charts.red': 'red',
  'charts.purple': 'purple',
  'terminal.ansiCyan': 'cyan',
  'charts.orange': 'sand',
  disabledForeground: 'grey',
};
const PINNED = 'pinned';
const UNGROUPED = 'ungrouped';
// Keys of tabs whose session is not known yet. They live in memory only and are never saved.
const TEMP = 'tab:';
// A closed session keeps its place this long, so reopening it from Claude Code's history puts it back.
const KEEP_DAYS = 30;
const MAX_ARCHIVED = 200;

const today = (now = Date.now()) => Math.floor(now / 86400000);

function empty() {
  return {
    v: 2,
    groups: [], // [{ id, name, color, collapsed }], in display order
    lists: { [PINNED]: [], [UNGROUPED]: [] }, // list id -> session keys in display order
    pinnedFrom: {}, // pinned key -> the list it was pinned from
    archived: [], // [{ key, title, from, at }], newest first
    archivedCollapsed: true,
    seen: {}, // key -> day it was last open
    legacy: {}, // tab title -> group id, carried over from the first version
  };
}

// Reads saved state. Also accepts the first version's state: { groups, assign: { "label:<title>": groupId } }.
function load(raw) {
  const s = empty();
  if (!raw || typeof raw !== 'object') return s;
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || s.lists[g.id]) continue;
    s.groups.push({ id: g.id, name: g.name, color: COLORS.includes(g.color) ? g.color : OLD_COLORS[g.color] || COLORS[0], collapsed: !!g.collapsed });
    s.lists[g.id] = [];
  }
  if (raw.v === 2) {
    for (const [id, keys] of Object.entries(raw.lists || {})) {
      if (s.lists[id] && Array.isArray(keys)) s.lists[id] = keys.filter((k) => typeof k === 'string');
    }
    s.pinnedFrom = { ...raw.pinnedFrom };
    s.archived = Array.isArray(raw.archived) ? raw.archived.filter((a) => a && typeof a.key === 'string') : [];
    s.archivedCollapsed = raw.archivedCollapsed !== false;
    s.seen = { ...raw.seen };
    s.legacy = { ...raw.legacy };
  } else if (raw.assign && typeof raw.assign === 'object') {
    // The first version remembered groups by tab title. Keep those until each tab's session is known —
    // except "Claude Code", the title every new tab starts with: remembering it put new tabs in old groups.
    for (const [k, gid] of Object.entries(raw.assign)) {
      if (k.startsWith('label:') && k !== `label:${PLACEHOLDER}` && s.lists[gid]) s.legacy[k.slice('label:'.length)] = gid;
    }
  }
  return s;
}

function toJSON(s) {
  const real = (k) => !k.startsWith(TEMP);
  const lists = {};
  for (const [id, keys] of Object.entries(s.lists)) lists[id] = keys.filter(real);
  const realKeys = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => real(k)));
  return {
    v: 2,
    groups: s.groups.map((g) => ({ ...g })),
    lists,
    pinnedFrom: realKeys(s.pinnedFrom),
    archived: s.archived.map((a) => ({ ...a })),
    archivedCollapsed: s.archivedCollapsed,
    seen: realKeys(s.seen),
    legacy: { ...s.legacy },
  };
}

const group = (s, id) => s.groups.find((g) => g.id === id);
const isList = (s, id) => id === PINNED || id === UNGROUPED || !!group(s, id);

function listOf(s, key) {
  for (const [id, keys] of Object.entries(s.lists)) if (keys.includes(key)) return id;
  return undefined;
}

function remove(s, key) {
  for (const id of Object.keys(s.lists)) s.lists[id] = s.lists[id].filter((k) => k !== key);
}

// Puts a session into a list, just before another session or at the end. Moving into Pinned
// remembers where it came from, so unpinning puts it back.
function place(s, key, list, before) {
  if (before === key) return;
  if (!isList(s, list)) list = UNGROUPED;
  const from = listOf(s, key);
  remove(s, key);
  if (list === PINNED) {
    if (from !== PINNED) s.pinnedFrom[key] = from || UNGROUPED;
  } else {
    delete s.pinnedFrom[key];
  }
  const keys = s.lists[list];
  const i = before ? keys.indexOf(before) : -1;
  if (i >= 0) keys.splice(i, 0, key);
  else keys.push(key);
}

const pin = (s, key) => place(s, key, PINNED);

function unpin(s, key) {
  const back = s.pinnedFrom[key];
  place(s, key, back && back !== PINNED && isList(s, back) ? back : UNGROUPED);
}

// Gives a session seen for the first time a place: back where it was archived from, its group from
// the first version, or the end of `list`. Returns true when the state changed.
function addKey(s, key, list, label) {
  if (listOf(s, key)) return false;
  if (restore(s, key)) return true; // reopened some other way, e.g. from Claude Code's own history
  const old = key.startsWith(TEMP) ? undefined : s.legacy[label];
  if (old && isList(s, old)) {
    delete s.legacy[label];
    place(s, key, old);
    return true;
  }
  place(s, key, list || UNGROUPED);
  return true;
}

// A tab's session became known or changed (for example after /clear): the new session takes the
// old one's place, unless it already has a place of its own. Returns true when the state changed.
function renameKey(s, from, to) {
  const list = listOf(s, from);
  if (from === to || !list) return false;
  const taken = listOf(s, to) !== undefined || s.archived.some((a) => a.key === to);
  if (!taken) {
    const pinnedFrom = s.pinnedFrom[from];
    place(s, to, list, from);
    if (list === PINNED && pinnedFrom) s.pinnedFrom[to] = pinnedFrom;
  }
  if (from.startsWith(TEMP)) {
    s.lists[list] = s.lists[list].filter((k) => k !== from);
    delete s.pinnedFrom[from];
  }
  return true;
}

function archive(s, key, title, now = Date.now()) {
  const from = listOf(s, key) || UNGROUPED;
  remove(s, key);
  delete s.pinnedFrom[key];
  s.archived = [{ key, title, from, at: now }, ...s.archived.filter((a) => a.key !== key)].slice(0, MAX_ARCHIVED);
}

// Takes a session out of the archive and puts it back where it was. Returns false if it was not archived.
function restore(s, key) {
  const a = s.archived.find((x) => x.key === key);
  if (!a) return false;
  s.archived = s.archived.filter((x) => x !== a);
  place(s, key, a.from);
  return true;
}

function forget(s, key) {
  s.archived = s.archived.filter((a) => a.key !== key);
}

function addGroup(s, name, now = Date.now()) {
  const used = new Set(s.groups.map((g) => g.color));
  const g = {
    id: `g${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    color: COLORS.find((c) => !used.has(c)) || COLORS[s.groups.length % COLORS.length],
    collapsed: false,
  };
  s.groups.push(g);
  s.lists[g.id] = [];
  return g;
}

// Deleting a group never closes or loses its sessions: they move to Ungrouped.
function deleteGroup(s, id) {
  if (!group(s, id)) return;
  s.lists[UNGROUPED].push(...s.lists[id]);
  delete s.lists[id];
  s.groups = s.groups.filter((g) => g.id !== id);
  for (const [k, v] of Object.entries(s.pinnedFrom)) if (v === id) s.pinnedFrom[k] = UNGROUPED;
  for (const a of s.archived) if (a.from === id) a.from = UNGROUPED;
}

function moveGroup(s, id, before) {
  const g = group(s, id);
  if (!g || id === before) return;
  s.groups = s.groups.filter((x) => x !== g);
  const i = before ? s.groups.findIndex((x) => x.id === before) : -1;
  if (i >= 0) s.groups.splice(i, 0, g);
  else s.groups.push(g);
}

// Records that these sessions are open today. Returns true when the state changed.
function touch(s, keys, day = today()) {
  let changed = false;
  for (const k of keys) {
    if (k.startsWith(TEMP) || s.seen[k] === day) continue;
    s.seen[k] = day;
    changed = true;
  }
  return changed;
}

// Forgets the place of sessions that have not been open for KEEP_DAYS.
function prune(s, day = today()) {
  for (const id of Object.keys(s.lists)) {
    s.lists[id] = s.lists[id].filter((k) => {
      if (s.seen[k] === undefined) s.seen[k] = day; // saved before `seen` existed: start counting now
      return day - s.seen[k] <= KEEP_DAYS;
    });
  }
  const placed = new Set(Object.values(s.lists).flat());
  for (const k of Object.keys(s.seen)) if (!placed.has(k)) delete s.seen[k];
  for (const k of Object.keys(s.pinnedFrom)) if (!placed.has(k)) delete s.pinnedFrom[k];
}

module.exports = {
  PALETTE,
  COLORS,
  PINNED,
  UNGROUPED,
  TEMP,
  KEEP_DAYS,
  today,
  load,
  toJSON,
  group,
  listOf,
  place,
  pin,
  unpin,
  addKey,
  renameKey,
  archive,
  restore,
  forget,
  addGroup,
  deleteGroup,
  moveGroup,
  touch,
  prune,
};
