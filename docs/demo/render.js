// Renders the README demo: docs/demo.png (still) and docs/demo.gif (animated loop).
// Needs Playwright with Chromium, and ffmpeg for the GIF:
//   npm install --no-save playwright && npx playwright install chromium
//   node docs/demo/render.js
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { PALETTE } = require('../../lib/model');

const DOCS = path.join(__dirname, '..');
const PAGE = `file://${path.join(__dirname, 'hero.html')}`;
const FRAMES = 20; // 20 frames x 80 ms = 1.6 s: two spinner turns and one pulse, so the loop is seamless
const STEP_MS = 80;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript((p) => {
      window.__palette = p;
    }, PALETTE);
    await page.goto(PAGE);
    await page.waitForSelector('.row');
    await page.evaluate(() => window.drawCallouts());
    return page;
  };
  // Pause every CSS animation at an exact time, so each frame is the same on every run.
  const at = (page, ms) => page.evaluate((t) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; }), ms);

  const page = await open();
  await at(page, 300);
  await page.screenshot({ path: path.join(DOCS, 'demo.png') });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frames-'));
  for (let i = 0; i < FRAMES; i++) {
    await at(page, i * STEP_MS);
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(2, '0')}.png`) });
  }
  await browser.close();
  if (errors.length) throw new Error(errors.join('\n'));

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', String(1000 / STEP_MS), '-i', path.join(dir, 'f%02d.png'),
    '-vf', 'split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', path.join(DOCS, 'demo.gif'),
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wrote docs/demo.png and docs/demo.gif');
})();
