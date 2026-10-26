// Claude Session Manager — the sidebar panel. Runs inside VS Code's webview: draws what the extension
// sends and reports clicks, drags and edits back to it.
'use strict';

(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const notice = document.getElementById('notice');
  const toolbar = document.getElementById('toolbar');

  const ICONS = {
    search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13.5 13.5"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    pencil: '<path d="M10.8 2.7 13.3 5.2 5.6 12.9 2.6 13.4 3.1 10.4z"/>',
    pin: '<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>',
    archive: '<rect x="2.5" y="3" width="11" height="3" rx=".5"/><path d="M3.5 6v6.5h9V6M6.5 8.5h3"/>',
    close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    chevron: '<path d="M6 4l4 4-4 4"/>',
    reopen: '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 2.8v2.4h2.4"/>',
  };
  const svg = (name) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // Group colors come from the extension with each model: [id, name, hex].
  const cssColor = (id) => (model.colors.find((c) => c[0] === id) || model.colors[0])[2];

  const STATUS = {
    working: 'Working',
    'needs-input': 'Needs your input',
    done: 'Finished, not viewed yet',
    idle: 'Idle',
    stopped: 'Not running (starts when you open it)',
    unknown: 'Status unknown',
  };

  let model = null;
  let waiting = null; // a model that arrived during a drag or an edit; drawn when it ends
  let editing = null; // id of the group whose name and color editor is open
  let drag = null; // { kind: 'row', key } or { kind: 'group', gid } while dragging
  let drop = null; // where the dragged item would land
  let query = (vscode.getState() || {}).query || '';
  const post = (type, data) => vscode.postMessage({ type, ...data });

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(icon, label, onClick, cls) {
    const b = el('button', `icon${cls ? ` ${cls}` : ''}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = svg(icon);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  function actions(buttons) {
    const box = el('span', 'actions');
    for (const b of buttons) if (b) box.append(b);
    return box;
  }

  const context = (node, data) => {
    node.dataset.vscodeContext = JSON.stringify({ ...data, preventDefaultContextMenuItems: true });
  };

  // Black or white text, whichever reads better on the group's color.
  const probe = el('span', 'probe');
  document.body.append(probe);
  function textOn(colorId) {
    probe.style.color = cssColor(colorId);
    const value = getComputedStyle(probe).color;
    let [r, g, b] = (value.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number);
    if (value.startsWith('color(')) [r, g, b] = [r * 255, g * 255, b * 255];
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? '#000000' : '#ffffff';
  }

  function highlight(node, text) {
    const q = query.trim().toLowerCase();
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) {
      node.textContent = text;
      return;
    }
    node.append(text.slice(0, i), el('mark', '', text.slice(i, i + q.length)), text.slice(i + q.length));
  }

  function tokens(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return `${Math.round(n / 1000)}k`;
    return `${(n / 1e6).toFixed(1)}M`;
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function tip(r) {
    const lines = [r.title, STATUS[r.status] + (r.status === 'needs-input' && r.waitingFor ? ` (${r.waitingFor})` : '')];
    if (r.tokens) lines.push(`Context: ${r.tokens.toLocaleString()} tokens${r.model ? ` · ${r.model}` : ''}`);
    if (r.activity) lines.push(`Last activity: ${ago(r.activity)}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- toolbar

  toolbar.innerHTML = `<label class="search">${svg('search')}<input id="q" type="text" placeholder="Search sessions" aria-label="Search sessions" spellcheck="false"></label>`;
  const search = toolbar.querySelector('.search');
  const q = document.getElementById('q');
  const clear = button('close', 'Clear search', () => {
    setQuery('');
    q.focus();
  });
  search.append(clear);
  q.value = query;
  clear.hidden = !query;
  q.addEventListener('input', () => setQuery(q.value));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setQuery('');
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = list.querySelector('.row, .group-head');
      if (first) first.focus();
    }
  });

  function setQuery(v) {
    query = v;
    q.value = v;
    clear.hidden = !v;
    vscode.setState({ query });
    render();
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!model) return;
    const active = document.activeElement;
    const focusKey = list.contains(active) ? active.dataset.key || (active.dataset.gid && `group:${active.dataset.gid}`) : null;
    list.textContent = '';
    notice.hidden = !model.notice;
    notice.textContent = model.notice || '';

    if (model.empty) {
      const box = el('div', 'empty-state');
      box.append(el('p', '', 'No Claude Code sessions are open.'));
      const b = el('button', 'primary', 'New Claude session');
      b.type = 'button';
      b.addEventListener('click', () => post('newSession', {}));
      box.append(b);
      list.append(box);
    }

    const searching = !!query.trim();
    const hit = (title) => !searching || title.toLowerCase().includes(query.trim().toLowerCase());
    let shown = 0;

    const pinned = model.pinned.filter((r) => hit(r.title));
    shown += pinned.length;
    list.append(section('pinned', 'Pinned', pinned));

    for (const g of model.groups) {
      const rows = g.rows.filter((r) => hit(r.title));
      shown += rows.length;
      if (searching && !rows.length) continue;
      list.append(groupBlock(g, rows, searching));
    }

    const ungrouped = model.ungrouped.filter((r) => hit(r.title));
    shown += ungrouped.length;
    list.append(section('ungrouped', 'Ungrouped', ungrouped, !model.groups.length && !model.pinned.length));

    if (searching && !shown) list.append(el('div', 'no-match', `No open session matches “${query.trim()}”.`));

    const archived = model.archived.filter((a) => hit(a.title));
    if (archived.length) list.append(archivedBlock(archived, searching));

    if (focusKey) {
      const again = focusKey.startsWith('group:')
        ? list.querySelector(`.group-head[data-gid="${CSS.escape(focusKey.slice(6))}"]`)
        : list.querySelector(`.row[data-key="${CSS.escape(focusKey)}"]`);
      if (again) again.focus();
    }
  }

  // Pinned and Ungrouped. An empty one stays hidden, except as a drop target while dragging.
  function section(id, label, rows, headless) {
    const sec = el('div', `section${rows.length ? '' : ' empty'}`);
    sec.dataset.list = id;
    if (!headless) {
      const head = el('div', 'section-head', label);
      head.dataset.list = id;
      sec.append(head);
    }
    for (const r of rows) sec.append(row(r, id));
    return sec;
  }

  function groupBlock(g, rows, searching) {
    const open = searching || !g.collapsed;
    const block = el('div', 'group');
    block.dataset.gid = g.id;
    block.style.setProperty('--c', cssColor(g.color));

    const head = el('div', 'group-head');
    head.dataset.gid = g.id;
    head.tabIndex = -1;
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-label', `Group ${g.name}, ${g.rows.length} open`);
    head.draggable = !searching && editing !== g.id;
    context(head, { webviewSection: 'group', gid: g.id });
    const chevron = el('span', `chevron${open ? ' open' : ''}`);
    chevron.innerHTML = svg('chevron');
    const chip = el('span', 'chip', g.name);
    chip.style.color = textOn(g.color);
    head.append(
      chevron,
      chip,
      el('span', 'count', String(g.rows.length)),
      actions([
        button('plus', 'New Claude session in this group', () => post('newSession', { gid: g.id })),
        button('pencil', 'Rename or recolor group (F2)', () => openEditor(g.id)),
      ])
    );
    head.addEventListener('click', () => {
      g.collapsed = !g.collapsed; // show it at once; the extension saves it
      post('toggleGroup', { gid: g.id });
      render();
    });
    block.append(head);
    if (editing === g.id) block.append(editor(g));

    if (open) {
      const body = el('div', 'group-body');
      body.setAttribute('role', 'group');
      for (const r of rows) body.append(row(r, g.id));
      if (!rows.length) {
        const hint = el('div', 'hint', 'Drag sessions here');
        hint.dataset.list = g.id;
        body.append(hint);
      }
      block.append(body);
    }
    return block;
  }

  function row(r, listId) {
    const pinned = listId === 'pinned';
    const d = el('div', `row${r.active ? ' active' : ''}${r.status === 'done' ? ' unread' : ''}`);
    d.dataset.key = r.key;
    d.dataset.list = listId;
    d.tabIndex = -1;
    d.setAttribute('role', 'treeitem');
    d.setAttribute('aria-label', `${r.title}, ${STATUS[r.status]}`);
    d.title = tip(r);
    d.draggable = !query.trim();
    context(d, { webviewSection: 'session', key: r.key, pinned, canArchive: r.canArchive });

    const status = el('span', `status s-${r.status}`);
    status.setAttribute('aria-hidden', 'true');
    // A thick arc with round ends, in the title's text color, so it stands out on any row.
    if (r.status === 'working') {
      status.innerHTML =
        '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="22 40"/></svg>';
    }
    const title = el('span', 'title');
    highlight(title, r.title);
    const meta = el('span', 'meta');
    // A sidebar is narrow: "Needs input" matters more than the context size, which stays in the tooltip.
    if (r.status === 'needs-input') meta.append(el('span', 'pill ask', 'Needs input'));
    else if (r.status === 'done') meta.append(el('span', 'pill done', 'Done'));
    else if (r.tokens) meta.append(el('span', 'tokens', tokens(r.tokens)));
    d.append(
      status,
      title,
      meta,
      actions([
        button('pin', pinned ? 'Unpin' : 'Pin to top', () => post(pinned ? 'unpin' : 'pin', { key: r.key }), pinned ? 'on' : ''),
        r.canArchive ? button('archive', 'Archive: close the tab and keep it here to reopen', () => post('archive', { key: r.key })) : null,
        button('close', 'Close tab', () => post('close', { key: r.key })),
      ])
    );
    d.addEventListener('click', () => post('focus', { key: r.key }));
    return d;
  }

  function archivedBlock(items, searching) {
    const open = searching || !model.archivedCollapsed;
    const sec = el('div', 'section archived');
    const head = el('div', 'section-head toggle');
    head.tabIndex = -1;
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-expanded', String(open));
    const chevron = el('span', `chevron${open ? ' open' : ''}`);
    chevron.innerHTML = svg('chevron');
    head.append(chevron, el('span', '', 'Archived'), el('span', 'count', String(items.length)));
    head.addEventListener('click', () => {
      model.archivedCollapsed = !model.archivedCollapsed;
      post('toggleArchived');
      render();
    });
    sec.append(head);
    if (!open) return sec;
    for (const a of items) {
      const d = el('div', 'row archived-row');
      d.dataset.key = a.key;
      d.tabIndex = -1;
      d.setAttribute('role', 'treeitem');
      d.setAttribute('aria-label', `${a.title}, archived`);
      d.title = `${a.title}\nArchived ${ago(a.at)}. Click to reopen.`;
      context(d, { webviewSection: 'archived', key: a.key });
      const icon = el('span', 'status s-archived');
      icon.innerHTML = svg('archive');
      const title = el('span', 'title');
      highlight(title, a.title);
      const meta = el('span', 'meta');
      meta.append(el('span', 'tokens', ago(a.at)));
      d.append(
        icon,
        title,
        meta,
        actions([
          button('reopen', 'Reopen', () => post('reopen', { key: a.key })),
          button('close', 'Remove from archive', () => post('forget', { key: a.key })),
        ])
      );
      d.addEventListener('click', () => post('reopen', { key: a.key }));
      sec.append(d);
    }
    return sec;
  }

  // ---------------------------------------------------------------- group editor (name + color)

  function openEditor(gid) {
    if (!model || !model.groups.some((g) => g.id === gid)) return;
    editing = gid;
    const g = model.groups.find((x) => x.id === gid);
    if (g.collapsed && !query.trim()) g.collapsed = false; // show its sessions while editing
    render();
  }

  function closeEditor() {
    editing = null;
    if (waiting) {
      model = waiting;
      waiting = null;
    }
    render();
  }

  function editor(g) {
    let done = false; // saved, cancelled or deleted: ignore the focus leaving afterwards
    const box = el('div', 'editor');
    const input = el('input');
    input.type = 'text';
    input.value = g.name;
    input.maxLength = 60;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Group name');

    const swatches = el('div', 'swatches');
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', 'Group color');
    for (const [id, name] of model.colors) {
      const s = el('button', `swatch${id === g.color ? ' selected' : ''}`);
      s.type = 'button';
      s.title = name;
      s.setAttribute('role', 'radio');
      s.setAttribute('aria-label', name);
      s.setAttribute('aria-checked', String(id === g.color));
      s.style.setProperty('--c', cssColor(id));
      s.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the name field
      s.addEventListener('click', () => {
        g.color = id;
        post('recolorGroup', { gid: g.id, color: id });
        const block = box.closest('.group');
        block.style.setProperty('--c', cssColor(id));
        block.querySelector('.chip').style.color = textOn(id);
        for (const x of swatches.children) {
          x.classList.toggle('selected', x === s);
          x.setAttribute('aria-checked', String(x === s));
        }
      });
      swatches.append(s);
    }

    const foot = el('div', 'editor-foot');
    const del = el('button', 'link danger', 'Delete group');
    del.type = 'button';
    del.title = 'Delete the group. Its sessions stay open and move to Ungrouped.';
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', () => {
      done = true;
      post('deleteGroup', { gid: g.id });
      closeEditor();
    });
    foot.append(del, el('span', 'keys', 'Enter saves · Esc cancels'));
    box.append(input, swatches, foot);

    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name && name !== g.name) {
        for (const m of [model, waiting]) {
          const x = m && m.groups.find((y) => y.id === g.id);
          if (x) x.name = name; // show the new name at once; the extension saves it
        }
        post('renameGroup', { gid: g.id, name });
      }
      closeEditor();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        closeEditor();
      }
    });
    box.addEventListener('focusout', (e) => {
      if (!box.contains(e.relatedTarget)) commit();
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return box;
  }

  // ---------------------------------------------------------------- drag and drop

  const line = el('div', 'drop-line');
  line.hidden = true;
  document.body.append(line);
  let into = null;

  function showDrop(t) {
    if (into) into.classList.remove('drop-into');
    into = null;
    line.hidden = true;
    if (!t) return;
    if (t.into) {
      into = t.into;
      into.classList.add('drop-into');
    } else if (t.line !== undefined) {
      line.hidden = false;
      line.style.top = `${t.line - 1}px`;
      line.style.left = `${t.left || 8}px`;
    }
  }

  const sameListNext = (rowEl) => {
    let n = rowEl.nextElementSibling;
    while (n && !(n.classList.contains('row') && n.dataset.list === rowEl.dataset.list)) n = n.nextElementSibling;
    return n;
  };

  // Where a dragged session lands: between two sessions (a line), or into a group or section.
  function rowTarget(e) {
    const over = e.target.closest('.row[data-list], .group-head, .section-head[data-list], .hint, .section[data-list]');
    if (!over) {
      // Empty space below everything: the end of Ungrouped.
      if (e.target !== list) return null;
      const last = [...list.querySelectorAll('.row[data-list="ungrouped"]')].pop();
      if (!last) return { list: 'ungrouped', before: null, into: list.querySelector('.section[data-list="ungrouped"]') };
      const r = last.getBoundingClientRect();
      return { list: 'ungrouped', before: null, line: r.bottom, left: r.left + 4 };
    }
    if (over.classList.contains('group-head')) return { list: over.dataset.gid, before: null, into: over };
    if (over.classList.contains('row')) {
      const r = over.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const next = after ? sameListNext(over) : over;
      return { list: over.dataset.list, before: next ? next.dataset.key : null, line: after ? r.bottom : r.top, left: r.left + 4 };
    }
    const id = over.dataset.list;
    const first = list.querySelector(`.row[data-list="${CSS.escape(id)}"]`);
    return { list: id, before: first ? first.dataset.key : null, into: over.closest('.section') || over };
  }

  // Where a dragged group lands: before the first group whose middle is below the pointer.
  function groupTarget(e) {
    const blocks = [...list.querySelectorAll('.group')];
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return { before: b.dataset.gid, line: r.top };
    }
    if (!blocks.length) return null;
    return { before: null, line: blocks[blocks.length - 1].getBoundingClientRect().bottom };
  }

  // Apply a move here at once so the list does not jump back while the extension saves it.
  function moveLocally(key, to, before) {
    if (before === key) return;
    const lists = [model.pinned, model.ungrouped, ...model.groups.map((g) => g.rows)];
    let moved;
    for (const l of lists) {
      const i = l.findIndex((r) => r.key === key);
      if (i >= 0) moved = l.splice(i, 1)[0];
    }
    if (!moved) return;
    const g = model.groups.find((x) => x.id === to);
    const target = to === 'pinned' ? model.pinned : g ? g.rows : model.ungrouped;
    const j = before ? target.findIndex((r) => r.key === before) : -1;
    if (j >= 0) target.splice(j, 0, moved);
    else target.push(moved);
  }

  function moveGroupLocally(gid, before) {
    if (gid === before) return;
    const i = model.groups.findIndex((g) => g.id === gid);
    if (i < 0) return;
    const [g] = model.groups.splice(i, 1);
    const j = before ? model.groups.findIndex((x) => x.id === before) : -1;
    if (j >= 0) model.groups.splice(j, 0, g);
    else model.groups.push(g);
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    drop = null;
    showDrop(null);
    document.body.classList.remove('drag-row', 'drag-group');
    if (waiting) {
      model = waiting;
      waiting = null;
    }
    render();
  }

  list.addEventListener('dragstart', (e) => {
    const rowEl = e.target.closest('.row[data-list]');
    const headEl = e.target.closest('.group-head');
    if (rowEl) drag = { kind: 'row', key: rowEl.dataset.key };
    else if (headEl) drag = { kind: 'group', gid: headEl.dataset.gid };
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/vnd.claude-session-manager', drag.key || drag.gid);
    // Change the page only after the drag has started: showing the empty Pinned zone moves the list,
    // and Chromium drops a drag whose page moves during dragstart.
    const dragged = rowEl || headEl.parentElement;
    const kind = drag.kind;
    setTimeout(() => {
      if (!drag) return;
      dragged.classList.add('dragging');
      document.body.classList.add(kind === 'row' ? 'drag-row' : 'drag-group');
    });
  });

  list.addEventListener('dragover', (e) => {
    if (!drag) return;
    drop = drag.kind === 'row' ? rowTarget(e) : groupTarget(e);
    showDrop(drop);
    if (drop) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (drag && !list.contains(e.relatedTarget)) showDrop(null);
  });

  list.addEventListener('drop', (e) => {
    if (!drag || !drop) return;
    e.preventDefault();
    if (drag.kind === 'row') {
      post('move', { key: drag.key, to: drop.list, before: drop.before });
      moveLocally(drag.key, drop.list, drop.before);
    } else {
      post('moveGroup', { gid: drag.gid, before: drop.before });
      moveGroupLocally(drag.gid, drop.before);
    }
    waiting = null; // older than this move; the extension sends a fresh one
    endDrag();
  });

  list.addEventListener('dragend', endDrag);

  // ---------------------------------------------------------------- keyboard

  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.row, .group-head, .section-head.toggle')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) next.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault();
      document.activeElement.click();
    } else if (e.key === 'F2' && i >= 0 && document.activeElement.classList.contains('group-head')) {
      e.preventDefault();
      openEditor(document.activeElement.dataset.gid);
    }
  });

  // Tabbing into the list lands on the active session; Shift+Tab out of it goes back to search.
  list.addEventListener('focus', (e) => {
    if (list.contains(e.relatedTarget)) {
      q.focus();
      return;
    }
    const target = list.querySelector('.row.active') || list.querySelector('.row, .group-head');
    if (target) target.focus();
  });

  // ---------------------------------------------------------------- messages

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'model') {
      if (drag || editing) waiting = m;
      else {
        model = m;
        render();
      }
    } else if (m.type === 'editGroup') {
      openEditor(m.gid);
    }
  });

  post('ready');
})();
