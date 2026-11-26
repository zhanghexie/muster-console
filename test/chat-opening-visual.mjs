// Explicit Chromium regression: real chat components/CSS, synthetic history and IPC.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { viteFixtureAssets } from '../.agents/skills/ui-verification/scripts/vite-fixture-assets.mjs';
import { chromium } from 'playwright-core';
import scenario from './fixtures/agent-float-scroll-scenario.mjs';
import reopenScenario from './fixtures/agent-float-reopen-scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.tmp/chat-opening-visual');
await fs.mkdir(out, { recursive: true });
const bundle = await fs.mkdtemp(path.join(out, 'bundle-'));
let browser, server;
const results = [];
try {
  await build({
    stdin: { contents: [
      ...['base', 'chat', 'markdown', 'float', 'agent-chat', 'left', 'turn-changes'].map(name => `import './src/renderer/src/styles/${name}.css';`),
      "import './test/fixtures/agent-float-scroll.tsx';"
    ].join('\n'), resolveDir: root },
    outfile: path.join(bundle, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file', '.webp': 'file' },
    plugins: [viteFixtureAssets]
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    const target = path.resolve(bundle, '.' + decodeURIComponent(url.pathname));
    const relative = path.relative(bundle, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp' })[path.extname(target)] ?? 'application/octet-stream');
      res.end(await fs.readFile(target));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '');
  const installed = chrome && await fs.access(chrome).then(() => true, () => false);
  browser = await chromium.launch({ headless: true, ...(installed ? { executablePath: chrome } : {}), ignoreDefaultArgs: ['--hide-scrollbars'] });
  const surfaces = ['dispatch', 'gui', 'keepalive', 'dispatch-suggestions', 'gui-suggestions', 'dispatch-review', 'gui-review']
    .filter(surface => !process.env.CHAT_OPENING_SURFACE || surface === process.env.CHAT_OPENING_SURFACE);
  for (const surface of surfaces) for (const theme of ['dark', 'light']) for (const width of [1000, 620]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const key = `${surface}-${theme}-${width}`, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const captures = [];
    try {
      const suggestions = surface.endsWith('-suggestions');
      const review = surface.endsWith('-review');
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&surface=${surface.replace(/-(suggestions|review)$/, '')}&history=heavy${suggestions || review ? '&suggestions=1' : ''}${review ? '&review=1' : ''}`);
      await page.evaluate(async () => {
        await Promise.all([400, 500].map(weight => document.fonts.load(`${weight} 14px "OPPO Sans"`, '中文Abc')));
        if (![400, 500].every(weight => document.fonts.check(`${weight} 14px "OPPO Sans"`, '中文Abc'))) throw new Error('OPPO Sans did not load');
      });
      await (surface === 'keepalive' ? reopenScenario : scenario)({ page, assert, capture: async label => {
        const file = `${key}-${label}.png`;
        await page.screenshot({ path: path.join(out, file), animations: 'allow' });
        captures.push(file);
      } });
      assert.deepEqual(errors, []);
      results.push({ key, status: 'passed', captures });
      console.log(`ok ${key}`);
    } finally { await page.close(); }
  }
} finally {
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ visualReview: 'pending', results }, null, 2));
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  const cleanupRelative = path.relative(out, path.resolve(bundle));
  assert.ok(cleanupRelative && !cleanupRelative.startsWith('..') && !path.isAbsolute(cleanupRelative));
  await fs.rm(bundle, { recursive: true, force: true });
}
