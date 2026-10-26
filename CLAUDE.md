# Working on Claude Session Manager

> `AGENTS.md` is a symlink to this file. Edit here only.

A VS Code extension: a sidebar listing open Claude Code tabs with live status, colored groups, drag and drop, pins and an archive. **Read `README.md` first.** Sections 3–5 explain how it is built, the status rules, and the traps already hit; section 7 lists the open issues.

## Rules

- **Plain JavaScript, no build step, no runtime dependencies.** Keep it that way unless the owner agrees otherwise.
- **Logic goes in `lib/` with a test.** `lib/` must not import `vscode`. `extension.js` wires VS Code to `lib/`; `media/panel.js` only draws the model and reports user actions.
- **Tests explain why.** `npm test` (node:test) must pass. A new test must fail when the behavior it guards is broken; check that by breaking the code once.
- **Every change you install bumps `version` in `package.json`**, so VS Code replaces the old copy.
- **UI changes need a visual check.** Load the panel in `docs/demo/hero.html` (or a copy with other mock data), take Playwright screenshots in dark and light themes, and look at them. If the change shows in the demo, re-run `node docs/demo/render.js` (see the file header for setup).
- **Webview CSP**: set styles from JS (`el.style.setProperty`), never `style="…"` inside HTML strings. Don't move the page layout during `dragstart` (README §5).
- **Claude Code internals** (status files, transcripts, helper-agent files, the 25-character tab-title cut) can change with any Claude Code update. When status looks wrong, check them again before changing logic. **Diagnose** in the panel's `…` menu shows how tabs were matched.
- **Public repo**: demo data and test fixtures use made-up session titles and paths, never real work or company names.

## Owner decisions (don't re-add without asking)

- No session rename in the panel, no alerts or sounds, no hooks into Claude Code.

## Build, install, release

```sh
npm test
sh package.sh                                         # claude-tab-groups-<version>.vsix
code --install-extension claude-tab-groups-<version>.vsix --force   # then Developer: Reload Window
```

Releases are described in README §6: the asset is always named `claude-tab-groups.vsix`, so the install link in README §1 keeps working. Reloading the window restarts every running Claude session, so the owner reloads, when no session is working.
