/** Production CSS in Chromium: tinted frames/drawers and readable neutral session capsules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-material-'));
const compile = createSharedCompiler(root, tmp);
const { BUILTIN_THEMES } = await import(pathToFileURL(compile('shared/theme.ts')).href);
const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
const { WORKSPACE_ACCENTS } = await import(pathToFileURL(compile('shared/workspaceAccent.ts')).href);
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage();
  await page.route('https://www.oppo.com/**', route => route.abort());
  await page.setContent(`<div class="app-shell"><div class="sessions-column"><div class="left-panel">
    ${['active', 'waiting', 'done', 'error', 'info', 'dim'].map(state => `<span class="session-capsule ${state} session-rail-status">检查材质</span>`).join('')}
    </div></div><div class="center-panel"><div class="chat-surface-view"></div></div></div>`);
  for (const file of ['base', 'left', 'agent-chat', 'material']) {
    await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${file}.css`) });
  }
  // Optional negative control reproduces the original fade without editing the worktree.
  if (process.argv.includes('--baseline')) await page.addStyleTag({ content: '.session-rail-status.dim { opacity:.45; color:var(--text-2) }' });
  let cases = 0;
  for (const theme of BUILTIN_THEMES) for (const accent of [...WORKSPACE_ACCENTS, null]) for (const narrow of [false, true]) {
    const appearance = resolveAppearance(theme, { accent: accent ?? '#8b7bff', enabled: !!accent });
    const result = await page.evaluate(({ theme, accent, narrow, cssVars }) => {
      const html = document.documentElement;
      html.dataset.theme = theme.appearance;
      html.dataset.workspaceMaterial = accent ? 'frosted' : 'solid';
      html.classList.toggle('is-narrow', narrow);
      for (const [key, value] of Object.entries(cssVars)) html.style.setProperty(key, value);
      const rgba = color => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      const panel = getComputedStyle(document.querySelector('.center-panel'));
      const frame = getComputedStyle(document.querySelector('.app-shell'));
      const resolveToken = token => { const probe=document.createElement('i');probe.style.backgroundColor=`var(${token})`;document.querySelector('.left-panel').append(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return rgba(color); };
      return { frame: rgba(frame.backgroundColor), panel: rgba(panel.backgroundColor), composer: resolveToken('--glass-sheet'),
        expectedCapsule: resolveToken('--status-neutral-bg'),
        capsules: [...document.querySelectorAll('.session-rail-status')].map(el => {
          const css = getComputedStyle(el), bg = rgba(css.backgroundColor), fg = rgba(css.color);
          const a = luminance(fg), b = luminance(bg);
          return { opacity: Number(css.opacity), fg, bg, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        }) };
    }, { theme, accent, narrow, cssVars: appearance.cssVars });
    const label = `${theme.id}/${accent ?? 'disabled'}/${narrow ? 'drawer' : 'frame'}`;
    assert.equal(result.panel[3], 255, `${label}: reading surfaces stay opaque`);
    assert.deepEqual(result.composer, result.panel, `${label}: footer and reading surface match`);
    for (const capsule of result.capsules) {
      assert.equal(capsule.opacity, 1, `${label}: dim text cannot fade below readability`);
      assert.ok(capsule.contrast >= 4.5, `${label}: capsule contrast ${capsule.contrast}`);
      assert.deepEqual(capsule.bg, result.capsules[0].bg, `${label}: state colors remain in icons`);
      const expected = result.expectedCapsule.slice(0, 3);
      assert.ok(capsule.bg.slice(0, 3).every((v, i) => Math.abs(v - expected[i]) <= 1), `${label}: capsule follows its actual surface`);
    }
    cases++;
  }
  console.log(`workspace-material-visual: OK (${cases} theme/color/layout cases)`);
} finally {
  await browser.close();
  assert.ok(tmp.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(tmp).startsWith('workspace-material-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
