/** Check that the real board heading paints a flat lower edge, including asymmetric corners. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { acquireTestLease } from './helpers/lease.mjs';

const root = process.cwd();
const release = acquireTestLease(root);
let app;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'board-heading-'));
try {
  const bootstrap = path.join(fixture, 'main.cjs');
  fs.writeFileSync(bootstrap, `const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(fixture)}); app.whenReady().then(() => { const win = new BrowserWindow({ show:false, width:700, height:260, webPreferences:{ backgroundThrottling:false } }); win.loadURL('data:text/html,<html><body></body></html>'); });`);
  app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [bootstrap] });
  const page = await app.firstWindow();
  await page.setContent('<div class="board-workspace-group" style="width:260px"><button class="board-workspace-heading" aria-expanded="true" type="button"></button><div class="board-workspace-cards"></div></div><div class="board-workspace-group" style="width:440px"><button class="board-workspace-heading" aria-expanded="true" type="button"></button><div class="board-workspace-cards"></div></div>');
  for (const name of ['base', 'board']) await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', name + '.css') });
  await page.addStyleTag({ content: 'body { margin: 20px; } .board-workspace-group { margin-bottom: 20px; } :root { --surface-raised: rgb(50,50,50); --surface-board-column: rgb(20,20,20); --border-subtle: rgb(80,80,80); }' });
  const headings = page.locator('.board-workspace-heading');
  const corners = await headings.evaluateAll(elements => elements.map(element => {
    const header = getComputedStyle(element), group = getComputedStyle(element.parentElement);
    return {
      headerShape: header.getPropertyValue('corner-shape'), groupShape: group.getPropertyValue('corner-shape'),
      headerLeft: parseFloat(header.borderTopLeftRadius), headerRight: parseFloat(header.borderTopRightRadius),
      groupLeft: parseFloat(group.borderTopLeftRadius) - parseFloat(group.borderLeftWidth),
      groupRight: parseFloat(group.borderTopRightRadius) - parseFloat(group.borderRightWidth)
    };
  }));
  for (const corner of corners) {
    assert.equal(corner.headerShape, corner.groupShape, 'heading and group need matching corner curves');
    assert.equal(corner.headerLeft, corner.groupLeft, 'left corner must follow the inside edge');
    assert.equal(corner.headerRight, corner.groupRight, 'right corner must follow the inside edge');
  }
  const screenshot = await page.screenshot({ timeout: 10000 });
  const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const scaleX = info.width / viewport.width, scaleY = info.height / viewport.height;
  const sample = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  for (let i = 0; i < 2; i++) {
    const bounds = await headings.nth(i).boundingBox();
    assert.ok(bounds);
    const y = Math.floor((bounds.y + bounds.height - 4) * scaleY);
    for (const offset of [20, Math.floor(bounds.width / 2), bounds.width - 20]) {
      const x = Math.floor((bounds.x + offset) * scaleX);
      const pixel = sample(x, y);
      assert.ok(pixel.every(c => Math.abs(c - 50) <= 2), `heading bottom must stay flat at x=${x}, width=${bounds.width}; got ${pixel}`);
    }
  }
  console.log('Board workspace heading has a flat bottom at both widths.');
} finally {
  await app?.close();
  const resolved = fs.realpathSync(fixture), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('board-heading-'));
  fs.rmSync(resolved, { recursive: true, force: true });
  release();
}
