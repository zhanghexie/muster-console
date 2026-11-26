/** SDK 在真实 iframe 中接收主题/字体变化；样式和字体注册不可只修宿主消息。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-sdk-visual-'));
const compile = createSharedCompiler(root, tmp);
const { builtinTheme } = await import(pathToFileURL(compile('shared/theme.ts')).href);
const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
const palette = (mode, accent, revision) => resolveAppearance(builtinTheme(mode), { accent, enabled: true }, revision);
const initAppearance = palette('light', '#b7667e', 1);
const fontFaces = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n').match(/@font-face\s*\{[^}]+\}/g);
assert.deepEqual(fontFaces('src/main/extensions/sdk/theme.css'), fontFaces('src/renderer/src/styles/base.css'), '宿主与 iframe 的默认字体注册保持同源值');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage();
  await page.route('https://**/*', route => route.abort());
  await page.setContent('<iframe sandbox="allow-scripts" srcdoc="<p>工作日报内容</p>"></iframe>');
  const frame = page.frames()[1];
  await frame.addStyleTag({ path: path.join(root, 'src/main/extensions/sdk/theme.css') });
  await frame.addScriptTag({ path: path.join(root, 'src/main/extensions/sdk/extension-sdk.js') });
  const send = async message => page.evaluate(m => document.querySelector('iframe').contentWindow.postMessage({ __ma: true, ...m }, '*'), message);
  await send({ type: 'init', context: { appearance: { colorScheme: 'light', revision: 1, theme: initAppearance.cssVars } } });
  await frame.waitForFunction(() => document.documentElement.style.colorScheme === 'light');
  const bodyColors = () => frame.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color }));
  const toRGB = hex => 'rgb(' + hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ') + ')';
  assert.deepEqual(await bodyColors(), { bg: toRGB(initAppearance.surfaces.canvas), fg: toRGB(initAppearance.foreground.primary) });
  const initial = await frame.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    size: getComputedStyle(document.body).fontSize,
    registered: [...document.fonts].filter(f=>f.family.includes('OPPO')).map(f=>f.weight)
  }));
  assert.match(initial.font, /OPPO Sans/);
  assert.equal(initial.size, '15px');
  assert.deepEqual(initial.registered.sort(), ['400','500','700']);
  const optionalFont = 'https://example.test/font.css';
  const darkAppearance = palette('dark', '#4d9bbf', 2);
  await send({ type: 'appearance', revision: 2, colorScheme: 'dark', theme: { ...darkAppearance.cssVars, '--font-sans': 'MiSans, sans-serif', '--font-body': '16px' }, fontStylesheets: [optionalFont] });
  await frame.waitForFunction(() => getComputedStyle(document.body).fontSize === '16px');
  assert.equal(await frame.locator('link[data-ma-font]').count(), 1);
  assert.deepEqual(await bodyColors(), { bg: toRGB(darkAppearance.surfaces.canvas), fg: toRGB(darkAppearance.foreground.primary) });
  await send({ type: 'appearance', revision: 1, colorScheme: 'light', theme: initAppearance.cssVars });
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await frame.evaluate(() => document.documentElement.dataset.appearanceRevision), '2', 'Delayed palettes cannot roll an iframe back');
  await send({ type: 'appearance', revision: 3, colorScheme: 'light', theme: { ...initAppearance.cssVars, '--font-sans': "'OPPO Sans', sans-serif", '--font-body': '15px' }, fontStylesheets: [] });
  await frame.waitForFunction(() => document.documentElement.style.colorScheme === 'light');
  assert.equal(await frame.locator('link[data-ma-font]').count(), 0, '切回默认字体清理可选资源');
  console.log('extension-appearance-visual: OK (SDK init, theme switch, registered OPPO, optional font cleanup)');
} finally {
  await browser.close();
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('appearance-sdk-visual-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
