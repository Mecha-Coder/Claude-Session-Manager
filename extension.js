// Claude Session Manager — a sidebar list of the open Claude Code tabs with live status, colored groups,
// pins and an archive. Plain JavaScript, no build step, no dependencies.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const vscode = require('vscode');
const model = require('./lib/model');
const { PLACEHOLDER, bindTabs, cut } = require('./lib/match');
const sessions = require('./lib/sessions');

const VIEW_ID = 'claudeTabGroups.view';
const STATE_V1 = 'claudeTabGroups.state.v1';
const STATE_V2 = 'claudeTabGroups.state.v2';
const PENDING_MS = 20000;
// Also refresh on a timer: context size and dead processes change without a status-file event.
const REFRESH_MS = 10000;
const STATUS_ICON = {
  working: 'sync~spin',
  'needs-input': 'bell-dot',
  done: 'pass-filled',
  idle: 'circle-small-filled',
  stopped: 'circle-outline',
  unknown: 'question',
};
const STATUS_TEXT = {
  working: 'working',
  'needs-input': 'needs your input',
  done: 'finished',
  idle: 'idle',
  stopped: 'not running',
  unknown: 'status unknown',
};

const cfg = () => vscode.workspace.getConfiguration('claudeTabGroups');

// ---------------------------------------------------------------- tabs

function claudePattern() {
  try {
    return new RegExp(cfg().get('viewTypePattern') || 'claudeVSCodePanel', 'i');
  } catch {
    return /claudeVSCodePanel/i;
  }
}

function isClaude(tab, re) {
  const i = tab.input;
  return (i instanceof vscode.TabInputWebview || i instanceof vscode.TabInputCustom) && re.test(i.viewType || '');
}

// Every open Claude Code tab in visual order: editor group by editor group, left to right.
function claudeTabs() {
  const re = claudePattern();
  const out = [];
  for (const editorGroup of vscode.window.tabGroups.all) {
    editorGroup.tabs.forEach((tab, index) => {
      if (isClaude(tab, re)) out.push({ tab, editorGroup, index });
    });
  }
  return out;
}

function findLocation(tab) {
  for (const editorGroup of vscode.window.tabGroups.all) {
    const index = editorGroup.tabs.indexOf(tab);
    if (index >= 0) return { editorGroup, index };
  }
  return undefined;
}

const NTH = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];

// Webview tabs (Claude Code) have no "open" API, so focus the editor group, then open by index.
async function focusTab(tab) {
  const loc = findLocation(tab);
  if (!loc) return;
  const { editorGroup, index } = loc;
  if (!editorGroup.isActive) {
    const n = editorGroup.viewColumn;
    if (n >= 1 && n <= NTH.length) await vscode.commands.executeCommand(`workbench.action.focus${NTH[n - 1]}EditorGroup`);
  }
  if (index < 8) await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
  else await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
}

// ---------------------------------------------------------------- panel

class Panel {
  constructor(context) {
    this.context = context;
    this.state = model.load(context.workspaceState.get(STATE_V2) || context.workspaceState.get(STATE_V1));
    model.prune(this.state);
    this.transcripts = new sessions.TranscriptCache();
    this.view = undefined;
    this.ready = false; // the webview has loaded and asked for data
    this.ids = new WeakMap(); // Tab -> number that stays the same while the tab is open
    this.nextId = 1;
    this.keys = new Map(); // tab id -> the row key it had last time
    this.bindings = new Map(); // tab id -> session id
    this.lastStatus = new Map(); // session id -> its status last time
    this.unread = new Set(); // session ids that finished and you have not gone back to yet
    this.looking = new Set(); // session ids whose tab you were looking at last refresh
    this.pending = null; // { gid, until }: the next new Claude tab joins this group
    this.joining = new Map(); // tab id -> group it joins when it gets a place
    this.rows = new Map(); // row key -> { tab, label, status, row } from the last refresh
    this.editNext = undefined; // group whose editor opens once the webview is ready
    this.badge = undefined;
    this.posted = '';
    this.timer = undefined;
    this.interval = undefined;
    this.watcher = undefined;
    this.output = undefined;
  }

  tabId(tab) {
    let id = this.ids.get(tab);
    if (!id) {
      id = this.nextId++;
      this.ids.set(tab, id);
    }
    return id;
  }

  start() {
    this.watchSessions();
    this.interval = setInterval(() => {
      if (!this.watcher) this.watchSessions();
      this.refresh();
    }, REFRESH_MS);
    this.refresh();
  }

  // Claude Code rewrites a session's status file whenever its status changes.
  watchSessions() {
    try {
      this.watcher = fs.watch(sessions.SESSIONS_DIR, () => this.schedule());
      this.watcher.on('error', () => {
        this.watcher.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined; // the folder does not exist yet; the timer tries again
    }
  }

  dispose() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    if (this.watcher) this.watcher.close();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 60);
  }

  save() {
    return this.context.workspaceState.update(STATE_V2, model.toJSON(this.state));
  }

  onTabsOpened(opened) {
    if (!this.pending) return;
    if (Date.now() > this.pending.until) {
      this.pending = null;
      return;
    }
    const re = claudePattern();
    const tab = opened.find((t) => isClaude(t, re));
    if (tab) {
      this.joining.set(this.tabId(tab), this.pending.gid);
      this.pending = null;
    }
  }

  refresh() {
    const tabs = claudeTabs().map((e) => ({ ...e, id: this.tabId(e.tab), label: e.tab.label }));
    const live = sessions.readLiveSessions();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const inWorkspace = (cwd) => !folders.length || folders.some((f) => cwd === f || String(cwd).startsWith(`${f}/`));

    // Sessions running in VS Code for this workspace, with their title and context size.
    const known = live.sessions
      .filter((s) => s.entrypoint === 'claude-vscode' && inWorkspace(s.cwd))
      .map((s) => ({ sessionId: s.sessionId, live: s, info: this.transcripts.get(sessions.transcriptPath(s.cwd, s.sessionId)), updatedAt: s.updatedAt }));
    // Tabs Claude Code restored after a reload have no running session yet: look their titles up on disk.
    const runningTitles = new Set(known.map((k) => k.info && k.info.title && cut(k.info.title)).filter(Boolean));
    const missing = tabs.map((t) => t.label).filter((l) => l !== PLACEHOLDER && !runningTitles.has(l));
    if (missing.length) {
      const running = new Set(known.map((k) => k.sessionId));
      for (const f of sessions.findByTitles(folders.map(sessions.projectDir), missing, this.transcripts)) {
        if (!running.has(f.sessionId)) known.push({ sessionId: f.sessionId, live: null, info: f.info, updatedAt: f.updatedAt });
      }
    }
    const byId = new Map(known.map((k) => [k.sessionId, k]));
    this.bindings = bindTabs(
      tabs,
      known.map((k) => ({ sessionId: k.sessionId, title: k.info ? k.info.title : undefined, live: !!k.live, updatedAt: k.updatedAt })),
      this.bindings
    );

    // Row keys: the session id once known. A tab keeps its last key while its session is briefly
    // unknown, so it keeps its place in the list.
    let dirty = false;
    const bound = new Set(this.bindings.values());
    for (const t of tabs) {
      const sid = this.bindings.get(t.id);
      const prev = this.keys.get(t.id);
      t.key = sid || (prev && !bound.has(prev) ? prev : `${model.TEMP}${t.id}`);
      if (prev && prev !== t.key) dirty = model.renameKey(this.state, prev, t.key) || dirty;
      dirty = model.addKey(this.state, t.key, this.joining.get(t.id), t.label) || dirty;
      this.joining.delete(t.id);
      this.keys.set(t.id, t.key);
      t.session = sid ? byId.get(sid) : undefined;
    }
    const open = new Set(tabs.map((t) => t.id));
    for (const id of [...this.keys.keys()]) if (!open.has(id)) this.keys.delete(id);

    // Status. "Done" marks every session that finished; it stays until you go to its tab (switch to
    // it, or click its row) or the session starts working again.
    const focused = vscode.window.state.focused;
    const lookingNow = new Set();
    // Only an idle session can be hiding a background command or agent, so skip these checks otherwise.
    const idle = live.sessions.filter((l) => l.status === 'idle');
    const background = idle.length ? sessions.readBackgroundPids() : new Set();
    for (const l of idle) {
      if (sessions.hasRunningAgent(sessions.subagentsDir(l.cwd, l.sessionId), l.startedAt)) background.add(l.pid);
    }
    for (const t of tabs) {
      const s = t.session;
      t.status = !s ? 'unknown' : s.live ? sessions.statusOf(s.live, background) : 'stopped';
      if (!s) continue;
      // Claude's last message is a question you never answered (a reload can interrupt it). Claude Code
      // still shows that question in the tab, so the session needs you even though it is idle.
      t.unanswered = !!(s.info && s.info.asked) && (t.status === 'idle' || t.status === 'stopped');
      if (t.unanswered) t.status = 'needs-input';
      const before = this.lastStatus.get(s.sessionId);
      const looking = focused && t.tab.isActive && t.editorGroup.isActive;
      if (looking) lookingNow.add(s.sessionId);
      const arrived = looking && !this.looking.has(s.sessionId); // you just switched to this tab
      if (arrived || t.status === 'working' || t.status === 'needs-input') this.unread.delete(s.sessionId);
      if (t.status === 'idle' && (before === 'working' || before === 'needs-input')) this.unread.add(s.sessionId);
      this.lastStatus.set(s.sessionId, t.status);
      if (this.unread.has(s.sessionId)) t.status = 'done';
    }
    this.looking = lookingNow;
    const shown = new Set(tabs.map((t) => t.session && t.session.sessionId));
    for (const sid of [...this.lastStatus.keys()]) {
      if (shown.has(sid)) continue;
      this.lastStatus.delete(sid);
      this.unread.delete(sid);
    }

    this.rows = new Map();
    for (const t of tabs) {
      const s = t.session;
      const info = s && s.info;
      // Tabs show titles cut to 25 characters; the panel has room for the whole title.
      const title = (info && info.title) || t.label;
      this.rows.set(t.key, {
        tab: t.tab,
        label: title,
        status: t.status,
        row: {
          key: t.key,
          title,
          status: t.status,
          waitingFor: t.unanswered ? 'a question you have not answered' : s && s.live ? s.live.waitingFor : undefined,
          tokens: info ? info.tokens : undefined,
          model: info ? info.model : undefined,
          activity: info ? info.mtimeMs : undefined,
          active: t.tab.isActive && t.editorGroup.isActive,
          canArchive: !t.key.startsWith(model.TEMP),
        },
      });
    }
    const rowsOf = (id) => (this.state.lists[id] || []).filter((k) => this.rows.has(k)).map((k) => this.rows.get(k).row);

    const needs = tabs.filter((t) => t.status === 'needs-input').length;
    const done = tabs.filter((t) => t.status === 'done').length;
    const parts = [];
    if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} your input`);
    if (done) parts.push(`${done} finished`);
    this.badge = parts.length ? { value: needs + done, tooltip: parts.join(' · ') } : undefined;
    if (this.view) this.view.badge = this.badge;

    if (model.touch(this.state, tabs.map((t) => t.key)) || dirty) this.save();
    this.post({
      type: 'model',
      colors: model.PALETTE,
      pinned: rowsOf(model.PINNED),
      groups: this.state.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed, rows: rowsOf(g.id) })),
      ungrouped: rowsOf(model.UNGROUPED),
      archived: this.state.archived.map((a) => ({ key: a.key, title: a.title, at: a.at })),
      archivedCollapsed: this.state.archivedCollapsed,
      notice: live.ok ? '' : live.problem,
      empty: tabs.length === 0,
    });
  }

  post(message) {
    const json = JSON.stringify(message);
    if (!this.view || !this.ready || json === this.posted) return;
    this.posted = json;
    this.view.webview.postMessage(message);
  }

  // ---- webview

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.badge = this.badge;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    // Hidden webviews are unloaded; the page asks for data again when it is shown.
    view.onDidChangeVisibility(() => {
      if (!view.visible) this.ready = false;
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Claude sessions</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="toolbar" class="toolbar"></div>
<div id="notice" class="notice" role="status" hidden></div>
<div id="list" role="tree" aria-label="Claude Code sessions" tabindex="0"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  async onMessage(m) {
    const s = this.state;
    const g = m.gid ? model.group(s, m.gid) : undefined;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.posted = '';
        this.refresh();
        this.flushEdit();
        return;
      case 'focus': {
        const r = this.rows.get(m.key);
        if (!r) return;
        this.unread.delete(m.key); // clicking the row counts as seeing it, even if its tab was already open
        await focusTab(r.tab);
        this.refresh();
        return;
      }
      case 'close':
        return this.closeTab(m.key);
      case 'archive':
        return this.archive(m.key);
      case 'reopen':
        return this.reopen(m.key);
      case 'newSession':
        return this.newSession(m.gid);
      case 'move':
        model.place(s, m.key, m.to, m.before);
        break;
      case 'moveGroup':
        model.moveGroup(s, m.gid, m.before);
        break;
      case 'renameGroup': {
        const name = String(m.name || '').trim().slice(0, 60);
        if (!g || !name) return;
        g.name = name;
        break;
      }
      case 'recolorGroup':
        if (!g || !model.COLORS.includes(m.color)) return;
        g.color = m.color;
        break;
      case 'toggleGroup':
        if (!g) return;
        g.collapsed = !g.collapsed;
        break;
      case 'deleteGroup':
        model.deleteGroup(s, m.gid);
        break;
      case 'pin':
        model.pin(s, m.key);
        break;
      case 'unpin':
        model.unpin(s, m.key);
        break;
      case 'forget':
        model.forget(s, m.key);
        break;
      case 'toggleArchived':
        s.archivedCollapsed = !s.archivedCollapsed;
        break;
      default:
        return;
    }
    await this.save();
    this.refresh();
  }

  // ---- actions

  // Closing the tab of a session that is working stops it, so ask first.
  async confirmStop(key, action) {
    const r = this.rows.get(key);
    if (!r || (r.status !== 'working' && r.status !== 'needs-input')) return true;
    const what = r.status === 'working' ? 'is still working' : 'is waiting for your input';
    const choice = await vscode.window.showWarningMessage(
      `"${r.label}" ${what}. ${action === 'archive' ? 'Archiving' : 'Closing'} its tab stops it.`,
      { modal: true },
      action === 'archive' ? 'Archive' : 'Close Tab'
    );
    return choice !== undefined;
  }

  async closeTab(key) {
    const r = this.rows.get(key);
    if (!r || !(await this.confirmStop(key, 'close'))) return;
    await vscode.window.tabGroups.close(r.tab);
  }

  // Close first, archive after: while the tab is still open, a refresh would see it and take it
  // straight back out of the archive.
  async archive(key) {
    const r = this.rows.get(key);
    if (!r || key.startsWith(model.TEMP) || !(await this.confirmStop(key, 'archive'))) return;
    await vscode.window.tabGroups.close(r.tab);
    if (findLocation(r.tab)) return; // closing was cancelled
    model.archive(this.state, key, r.label);
    await this.save();
    this.refresh();
  }

  // Claude Code's "open" command takes a session id: it shows that session's tab, or reopens it.
  // When the tab appears, the session leaves the archive and goes back to its old place.
  async reopen(key) {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', key);
    } catch (err) {
      vscode.window.showErrorMessage(`Couldn't reopen the session: ${err && err.message ? err.message : err}`);
    }
  }

  async newSession(gid) {
    const id = cfg().get('newSessionCommand') || 'claude-vscode.editor.open';
    this.pending = gid ? { gid, until: Date.now() + PENDING_MS } : null;
    try {
      await vscode.commands.executeCommand(id);
    } catch (err) {
      this.pending = null;
      const open = 'Open Setting';
      const choice = await vscode.window.showErrorMessage(
        `Couldn't open a new Claude Code tab with the command "${id}". Is the Claude Code extension installed? (${err && err.message ? err.message : err})`,
        open
      );
      if (choice === open) vscode.commands.executeCommand('workbench.action.openSettings', 'claudeTabGroups.newSessionCommand');
    }
  }

  async newGroup() {
    const g = model.addGroup(this.state, 'New group');
    await this.save();
    this.refresh();
    await this.editGroup(g.id);
  }

  // Opens the group's name and color editor in the panel, showing the panel first if needed.
  async editGroup(gid) {
    this.editNext = gid;
    if (this.view && this.view.visible && this.ready) this.flushEdit();
    else await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  flushEdit() {
    if (!this.editNext || !this.view || !this.ready) return;
    this.view.webview.postMessage({ type: 'editGroup', gid: this.editNext });
    this.editNext = undefined;
  }

  async setAllCollapsed(collapsed) {
    for (const g of this.state.groups) g.collapsed = collapsed;
    await this.save();
    this.refresh();
  }

  async closeGroupTabs(gid) {
    const g = model.group(this.state, gid);
    if (!g) return;
    const tabs = (this.state.lists[gid] || []).filter((k) => this.rows.has(k)).map((k) => this.rows.get(k).tab);
    if (!tabs.length) return;
    const ok = 'Close Tabs';
    const choice = await vscode.window.showWarningMessage(
      `Close ${tabs.length} tab${tabs.length === 1 ? '' : 's'} in "${g.name}"? The group stays, and the sessions can be reopened from Claude Code's history.`,
      { modal: true },
      ok
    );
    if (choice === ok) await vscode.window.tabGroups.close(tabs);
  }

  async moveActiveToGroup() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const key = tab && this.keys.get(this.ids.get(tab));
    if (!key) {
      vscode.window.showInformationMessage('The active tab is not a Claude Code session.');
      return;
    }
    await this.moveToGroup(key);
  }

  // A dot in the group's color for the "Move to group" list. Theme icons only take theme colors.
  swatch(id) {
    const hex = model.PALETTE.find((c) => c[0] === id)[2];
    const dir = this.context.globalStorageUri;
    fs.mkdirSync(dir.fsPath, { recursive: true });
    const file = vscode.Uri.joinPath(dir, `color-${id}.svg`);
    fs.writeFileSync(file.fsPath, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${hex}"/></svg>`);
    return file;
  }

  async moveToGroup(key) {
    const r = this.rows.get(key);
    if (!r) return;
    const current = model.listOf(this.state, key);
    const items = this.state.groups.map((g) => ({
      label: g.name,
      iconPath: this.swatch(g.color),
      description: g.id === current ? 'current' : '',
      gid: g.id,
    }));
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'New group', iconPath: new vscode.ThemeIcon('new-folder'), gid: 'new' },
      { label: 'No group', iconPath: new vscode.ThemeIcon('close'), gid: model.UNGROUPED }
    );
    const pick = await vscode.window.showQuickPick(items, { title: `Move "${r.label}" to group` });
    if (!pick) return;
    const gid = pick.gid === 'new' ? model.addGroup(this.state, 'New group').id : pick.gid;
    model.place(this.state, key, gid);
    await this.save();
    this.refresh();
    if (pick.gid === 'new') await this.editGroup(gid);
  }

  async quickJump() {
    if (!this.rows.size) {
      vscode.window.showInformationMessage('No Claude Code tabs are open.');
      return;
    }
    const items = [];
    const section = (title, keys) => {
      const rows = keys.filter((k) => this.rows.has(k)).map((k) => this.rows.get(k));
      if (!rows.length) return;
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
      for (const r of rows) items.push({ label: `$(${STATUS_ICON[r.status]}) ${r.label}`, description: STATUS_TEXT[r.status], tab: r.tab });
    };
    section('Pinned', this.state.lists[model.PINNED]);
    for (const g of this.state.groups) section(g.name, this.state.lists[g.id]);
    section('Ungrouped', this.state.lists[model.UNGROUPED]);
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Jump to Claude session',
      placeHolder: 'Type to search open sessions',
      matchOnDescription: true,
    });
    if (pick && pick.tab) await focusTab(pick.tab);
  }

  // Shows how each Claude tab was matched to a session, for when status looks wrong.
  diagnose() {
    if (!this.output) {
      this.output = vscode.window.createOutputChannel('Claude Session Manager');
      this.context.subscriptions.push(this.output);
    }
    const out = this.output;
    const live = sessions.readLiveSessions();
    out.clear();
    out.appendLine(`Status files: ${live.ok ? 'OK' : live.problem}  (${sessions.SESSIONS_DIR}, ${live.sessions.length} running)`);
    out.appendLine('');
    for (const e of claudeTabs()) {
      const id = this.tabId(e.tab);
      const sid = this.bindings.get(id);
      const r = this.rows.get(this.keys.get(id));
      out.appendLine(
        `col ${e.editorGroup.viewColumn} #${e.index + 1}  "${e.tab.label}"  ->  ${sid ? `session ${sid}` : 'no session matched'}  (${r ? STATUS_TEXT[r.status] : 'not listed yet'})`
      );
    }
    const shown = new Set(this.bindings.values());
    const others = live.sessions.filter((s) => !shown.has(s.sessionId));
    if (others.length) {
      out.appendLine('');
      out.appendLine('Running Claude sessions not shown as a tab in this window:');
      for (const s of others) out.appendLine(`  ${s.sessionId}  ${s.entrypoint}  ${s.status}  ${s.cwd}`);
    }
    out.show(true);
  }
}

// ---------------------------------------------------------------- activation

function activate(context) {
  const panel = new Panel(context);
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      panel.onTabsOpened(e.opened);
      panel.schedule();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => panel.schedule()),
    vscode.window.onDidChangeWindowState(() => panel.schedule()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTabGroups')) panel.schedule();
    }),
    { dispose: () => panel.dispose() }
  );

  reg('claudeTabGroups.newSession', () => panel.newSession());
  reg('claudeTabGroups.newGroup', () => panel.newGroup());
  reg('claudeTabGroups.collapseAll', () => panel.setAllCollapsed(true));
  reg('claudeTabGroups.expandAll', () => panel.setAllCollapsed(false));
  reg('claudeTabGroups.quickJump', () => panel.quickJump());
  reg('claudeTabGroups.moveActiveToGroup', () => panel.moveActiveToGroup());
  reg('claudeTabGroups.diagnose', () => panel.diagnose());

  // Right-click menu items in the panel. VS Code passes the clicked element's data-vscode-context.
  reg('claudeTabGroups.ctx.pin', (c) => panel.onMessage({ type: 'pin', key: c.key }));
  reg('claudeTabGroups.ctx.unpin', (c) => panel.onMessage({ type: 'unpin', key: c.key }));
  reg('claudeTabGroups.ctx.moveToGroup', (c) => panel.moveToGroup(c.key));
  // A session's key is its session id (the same id /status shows).
  reg('claudeTabGroups.ctx.copyId', async (c) => {
    await vscode.env.clipboard.writeText(c.key);
    vscode.window.setStatusBarMessage(`Copied session ID ${c.key}`, 3000);
  });
  reg('claudeTabGroups.ctx.archive', (c) => panel.onMessage({ type: 'archive', key: c.key }));
  reg('claudeTabGroups.ctx.close', (c) => panel.onMessage({ type: 'close', key: c.key }));
  reg('claudeTabGroups.ctx.newSessionInGroup', (c) => panel.newSession(c.gid));
  reg('claudeTabGroups.ctx.editGroup', (c) => panel.editGroup(c.gid));
  reg('claudeTabGroups.ctx.closeGroupTabs', (c) => panel.closeGroupTabs(c.gid));
  reg('claudeTabGroups.ctx.deleteGroup', (c) => panel.onMessage({ type: 'deleteGroup', gid: c.gid }));
  reg('claudeTabGroups.ctx.reopen', (c) => panel.onMessage({ type: 'reopen', key: c.key }));
  reg('claudeTabGroups.ctx.forget', (c) => panel.onMessage({ type: 'forget', key: c.key }));

  panel.start();
}

function deactivate() {}

module.exports = { activate, deactivate };
