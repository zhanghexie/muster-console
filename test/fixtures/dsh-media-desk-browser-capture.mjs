// Runs the shipped extension bundle and real DomainRuntime with a synthetic SDK.
// Playwright intercepts every request, so no server or user data is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalExtensionSource } from './external-extension-source.mjs';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
const extension = externalExtensionSource('dsh-media-desk');
const { createDomainRuntime } = await import(pathToFileURL(path.join(extension, 'domain.mjs')).href);

const root = process.cwd();
const out = path.join(root, '.tmp/modern-web-guidance-review/extensions-visual');
await fs.mkdir(out, { recursive: true });
await build({ stdin: { contents: `import {applyTheme,BUILTIN_THEMES} from './src/renderer/src/theme';applyTheme(BUILTIN_THEMES.find(row=>row.appearance===new URLSearchParams(location.search).get('theme')),{persist:false});`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'theme.js') });
const runtimes = new Map();
function runtime(id) {
  if (!runtimes.has(id)) {
    const files = new Map([['media-desk/settings.json', JSON.stringify({ language: 'zh' })]]);
    runtimes.set(id, createDomainRuntime({ identity: { workspaceId: id }, broker: async (method, args) => {
      if (method === 'models.list') return [];
      if (method === 'data.read') return files.has(args[0]) ? { content: files.get(args[0]) } : null;
      if (method === 'data.write') { files.set(args[0], args[1]); return true; }
      throw new Error(`Unexpected fixture host call ${method}`);
    } }));
  }
  return runtimes.get(id);
}
const origin = 'http://extension.test';
async function serve(route) {
  try {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/call') {
      const input = JSON.parse(route.request().postData());
      const domain = runtime(input.id);
      const result = input.method === 'snapshot' ? await domain.getSnapshot() : await domain[input.method](input.name, input.args);
      await route.fulfill({ json: result });
      return;
    }
    if (url.pathname === '/ui/panel.html') {
      const sdk = `<script>const id=new URLSearchParams(location.search).get('id');const rpc=(method,name,args)=>fetch('/call',{method:'POST',body:JSON.stringify({id,method,name,args})}).then(r=>r.json());window.ma={ready:Promise.resolve({}),models:{list:async()=>[]},agent:{domain:{snapshot:()=>rpc('snapshot'),query:(n,a)=>rpc('query',n,a),command:(n,a)=>rpc('execute',n,a)}}};</script><script src='/theme.js'></script>`;
      const html = (await fs.readFile(path.join(extension, 'ui/panel.html'), 'utf8')).replace('<script src="../__sdk__/sdk.js"></script>', sdk);
      await route.fulfill({ contentType: 'text/html', body: html });
      return;
    }
    const files = {
      '/theme.js': path.join(out, 'theme.js'),
      '/__sdk__/theme.css': path.join(root, 'src/main/extensions/sdk/theme.css'),
      '/ui/host.css': path.join(extension, 'ui/host.css'),
      '/ui/client.js': path.join(extension, 'ui/client.js'),
    };
    const asset = /^\/assets\/[\w.-]+$/.test(url.pathname) ? url.pathname.slice(1) : undefined;
    const file = files[url.pathname] ?? (asset && path.join(extension, asset));
    await (file ? route.fulfill({ path: file }) : route.fulfill({ status: 404 }));
  } catch (error) {
    await route.fulfill({ status: 500, json: { error: error.message } });
  }
}
const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const browser = await chromium.launch({ headless: true, executablePath });

async function verifyGesture(page, theme, width) {
  const commits = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/call') return;
    const input = request.postDataJSON();
    if (input.method === 'execute' && input.args?.path === 'ops') commits.push(input.args.body.ops);
  });
  await page.getByRole('textbox', { name: '记下灵感' }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const point = await page.locator('[data-card]').evaluateAll(cards => {
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      for (const fraction of [0.3, 0.5, 0.7]) {
        const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height * fraction);
        if (x < 50 || x > innerWidth - 50 || y < 100 || y > innerHeight - 50) continue;
        if (document.elementFromPoint(x, y)?.closest('[data-card]') === card) return { x, y, id: card.dataset.card };
      }
    }
    throw new Error('No visible card area to drag');
  });
  const node = page.locator('[data-node]').filter({ has: page.locator(`[data-card="${point.id}"]`) });
  const originX = await node.evaluate(element => element.style.left);
  const dragX = point.x + (point.x < width / 2 ? 65 : -65);
  await page.evaluate(() => {
    let pointerId;
    window.addEventListener('pointerdown', event => { pointerId = event.pointerId; }, true);
    window.cancelTestPointer = () => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId }));
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(dragX, point.y, { steps: 5 });
  await page.locator('.md-node.is-dragging').waitFor();
  await page.screenshot({ path: path.join(out, `media-drag-${theme}-active.png`), animations: 'disabled' });
  await page.evaluate(() => window.cancelTestPointer());
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await page.locator('.md-node.is-dragging').waitFor({ state: 'hidden' });
  assert.equal(await node.evaluate(element => element.style.left), originX);
  assert.deepEqual(commits, []);
  await page.screenshot({ path: path.join(out, `media-drag-${theme}-cancelled.png`), animations: 'disabled' });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(dragX, point.y, { steps: 5 });
  await page.locator('.md-node.is-dragging').waitFor();
  const write = page.waitForRequest(request => request.url() === origin + '/call' && request.postDataJSON().method === 'execute');
  await page.mouse.up();
  await write;
  assert.equal(commits.length, 1);
  assert.equal(commits[0][0].op, 'update_item');
}

async function verifyTable(page, theme, width) {
  await page.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: '内容', exact: true }).click();
  await page.getByRole('radio', { name: '表格' }).click();
  const table = page.getByRole('table');
  const firstRow = table.locator('tbody tr').first();
  const trigger = firstRow.getByRole('button');
  await table.getByRole('columnheader').last().getByRole('button').focus();
  await page.keyboard.press('Tab');
  assert.equal(await trigger.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true);
  if (width === 390) {
    assert.equal(await table.evaluate(el => el.parentElement.scrollWidth > el.parentElement.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await trigger.evaluate(el => {
      const button = el.getBoundingClientRect(), scrollport = el.closest('.md-table-wrap').getBoundingClientRect();
      return button.left - 3 >= scrollport.left && button.right + 3 <= scrollport.right;
    }), true, 'keyboard focus keeps the whole title button and focus ring visible');
  }
  await page.screenshot({ path: path.join(out, `media-table-${theme}-${width}.png`), animations: 'disabled' });
  await page.keyboard.press('Space');
  await page.getByRole('dialog', { name: '灵感' }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '灵感' }).waitFor({ state: 'hidden' });
  await trigger.press('Enter');
  await page.getByRole('dialog', { name: '灵感' }).waitFor({ state: 'visible' });
}

const gesture = process.argv.includes('--gesture');
const widths = gesture ? [1024] : [1024, 390];
const verify = gesture ? verifyGesture : verifyTable;
try {
  for (const [theme, width] of ['light', 'dark'].flatMap(theme => widths.map(width => [theme, width]))) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', serve);
    await page.goto(`${origin}/ui/panel.html?theme=${theme}&id=${theme}-${width}`);
    await verify(page, theme, width);
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
  for (const domain of runtimes.values()) await domain.close();
}
console.log(`Media desk browser screenshots: ${out}`);
