import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { viteFixtureAssets } from '../.agents/skills/ui-verification/scripts/vite-fixture-assets.mjs';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
import { armProcessDeadline } from './helpers/execute.mjs';

const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, '.tmp/ui-captures/chat-find-split');
const release = acquireTestLease(root), disarm = armProcessDeadline(Date.now() + 55_000, 'Chat find split Chromium');
let server, browser;
const report = { boundary: 'Production CenterPanel, search controller/bar/highlight/CSS; mock IPC and message leaves.', cases: [] };
try {
  await fs.mkdir(out, { recursive: true });
  const contentFile = path.join(root, 'test/fixtures/chat-find-split-content.tsx').replaceAll('\\', '/');
  const compiled = await build({ absWorkingDir: root, entryPoints: ['test/fixtures/center-split-production.tsx'],
    outfile: path.join(out, 'fixture.js'), bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.webp': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' }, plugins: [viteFixtureAssets, { name: 'find-fixture', setup(builder) {
      builder.onLoad({ filter: /center-split-production\.tsx$/ }, async args => ({ contents:
        `import { FindKeyboard } from ${JSON.stringify(contentFile)};\n` + (await fs.readFile(args.path, 'utf8')).replace('const sources = <aside', 'const sources = <><FindKeyboard/><aside').replace('</aside>;', '</aside></>;'), loader: 'tsx', resolveDir: path.dirname(args.path) }));
      builder.onResolve({ filter: /\/(TerminalView|AgentChatView|PromptTaskPanel|ExtensionPanel)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'find-leaf' }));
      builder.onLoad({ filter: /.*/, namespace: 'find-leaf' }, args => ({ contents: `export { ${args.path} } from ${JSON.stringify(contentFile)};`, loader: 'js', resolveDir: root }));
    } }] });
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<html><head><link rel="stylesheet" href="/src/renderer/src/styles.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); return; }
    if (pathname === '/fixture.js' || pathname === '/fixture.css') { const file = compiled.outputFiles.find(item => path.basename(item.path) === pathname.slice(1)); if (!file) { response.writeHead(404).end(); return; } response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(file.contents); return; }
    try { const file = path.resolve(root, '.' + pathname); if (!file.startsWith(root + path.sep)) throw Error('outside'); response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); response.end(await fs.readFile(file)); }
    catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1320, height: 720 } });
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&toolbar=1`);
    await page.locator('[data-session="a"]').waitFor(); await page.evaluate(() => window.__lruRetouch());
    await page.evaluate(() => window.__centerSplitTest.reset({ secondary: { kind: 'session', sessionId: 'b' } }));
    const body = page.locator('[data-find-body="b"]');
    await page.locator('[data-click-body="b"]').click();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const original = await body.boundingBox();
    await page.keyboard.press('Control+f');
    const search = page.getByRole('search', { name: '会话内查找' });
    await search.getByRole('searchbox').fill('我');
    await page.waitForFunction(() => !!document.querySelector('[data-session="b"] mark.chat-find-hit'));
    const highlight = await body.locator('mark').evaluate(mark => ({ display: getComputedStyle(mark).display, width: getComputedStyle(mark).width, top: mark.getBoundingClientRect().top }));
    assert.equal(highlight.display, 'inline', 'Search highlight must retain inline text flow');
    assert.deepEqual(await body.boundingBox(), original, 'Search cannot reflow the message bubble');
    const checkBounds = async slot => {
      const pane = await page.getByTestId(`center-pane-${slot}`).boundingBox();
      const bar = await page.locator('[data-session="' + ['a', 'b', 'c'][slot] + '"] [role="search"]').boundingBox();
      assert.ok(bar.x >= pane.x + 8 && bar.x + bar.width <= pane.x + pane.width - 8, `Search stays inside pane: ${JSON.stringify({ pane, bar })}`);
      const grip = await page.getByTestId(`center-pane-handle-${slot}`).boundingBox();
      assert.ok(bar.y >= grip.y + grip.height + 4, 'Search must clear the hover toolbar');
      return { pane, bar };
    };
    const halves = await checkBounds(1);
    const divider = await page.getByTestId('center-split-divider').boundingBox();
    const area = await page.getByTestId('center-panel').boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 120); await page.mouse.down();
    await page.mouse.move(area.x + area.width * .7, divider.y + 120); await page.mouse.up();
    const narrow = await checkBounds(1);
    // Clicking nonfocusable text must win over the stale search input in the other pane.
    await page.locator('[data-click-body="a"]').click(); await page.keyboard.press('Control+f');
    await page.waitForFunction(() => !!document.querySelector('[data-session="a"] .chat-find-pos'));
    await checkBounds(0);
    await page.keyboard.press('Escape');
    const paneB = await page.getByTestId('center-pane-1').boundingBox();
    await page.mouse.move(paneB.x + paneB.width / 2, paneB.y + 4);
    await page.getByTestId('center-pane-1').getByRole('button', { name: '查找会话消息' }).click();
    await page.waitForFunction(() => !!document.querySelector('[data-session="b"] .chat-find-pos'));
    await checkBounds(1);
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-split-find.png`) });
    await page.getByTestId('center-pane-1').getByRole('button', { name: '选择分屏布局', exact: true }).click();
    await page.getByTestId('center-snap-cell-thirds-1').click();
    await page.getByTestId('center-snap-fill-2-c').click();
    await page.locator('[data-click-body="c"]').click(); await page.keyboard.press('Control+f');
    await page.waitForFunction(() => !!document.querySelector('[data-session="c"] .chat-find-pos'));
    const thirds = await checkBounds(2);
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => document.querySelectorAll('.chat-find-pos').length === 1 &&
      [...document.querySelectorAll('.center-split-pane-toolbar')].every(el => Number(getComputedStyle(el).opacity) < .001));
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-thirds-find.png`) });
    assert.deepEqual(errors, []); report.cases.push({ theme, highlight, halves, narrow, thirds });
    await page.close();
  }
  console.log('Passed chat search: focused split shortcut/icon, pane resize bounds, toolbar clearance, inline highlight without text reflow; both themes.');
} catch (error) { report.error = String(error.stack ?? error); throw error; }
finally {
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2));
  await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve)); disarm(); release();
}
