/** Real production components/CSS with a mocked host; screenshots are local. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';

const root = process.cwd(), release = acquireTestLease(root);
const output = path.join(root, '.tmp', 'turn-snapshot-visibility-visual');
fs.mkdirSync(output, { recursive: true });
let server, browser;
try {
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import './src/renderer/src/i18n';
    import './src/renderer/src/styles/base.css'; import './src/renderer/src/styles/dialogs.css';
    import './src/renderer/src/styles/git.css'; import './src/renderer/src/styles/turn-changes.css';
    import {applyTheme} from './src/renderer/src/theme'; import {builtinTheme} from './src/shared/theme';
    import {TurnChangesCard} from './src/renderer/src/chatSurface/TurnChangesCard';
    import {TurnSnapshotVisibilityProvider} from './src/renderer/src/chatSurface/TurnSnapshotVisibility';
    const owner={kind:'gui',id:'session'};
    const make=(id,path)=>({id,role:'assistant',turnChanges:{id:'snapshot-'+id,state:'ready',warnings:[],files:[{path,kind:'modified',added:6,removed:0,revertible:false}]}});
    const messages=[make('old','src/old.ts'),make('latest','docs/journal/2026-10-20.md'),make('missing','src/missing.ts')];
    window.api={turnChanges:{list:async()=>({ok:true,entries:[{target:{...owner,messageId:'latest'},summary:messages[1].turnChanges,label:'完成本轮修改',createdAt:1}]}),diff:async()=>({ok:true,diff:'--- a/a\\n+++ b/a\\n@@ -1 +1 @@\\n-old\\n+new\\n'})}};
    window.setTheme=theme=>applyTheme(builtinTheme(theme)); window.setTheme('dark');
    createRoot(document.getElementById('root')).render(<main><p>已按规约把这条答疑记入 docs/journal/2026-10-20.md。</p><TurnSnapshotVisibilityProvider owner={owner} messages={messages}>{messages.map(m=><TurnChangesCard key={m.id} summary={m.turnChanges} target={{...owner,messageId:m.id}}/>)}</TurnSnapshotVisibilityProvider></main>);
  ` }, outfile: path.join(output, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic', loader: { '.woff2': 'file', '.woff': 'file' } });
  server = createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><style>body{padding:24px;background:var(--surface-canvas);color:var(--canvas-fg-primary);font:14px sans-serif}main{max-width:720px;margin:auto}p{line-height:1.6}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');
      return;
    }
    const file = path.join(output, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  for (const theme of ['dark', 'light']) for (const width of [900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 420 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(theme => window.setTheme(theme), theme);
    await page.getByRole('button', { name: /docs\/journal/ }).waitFor();
    assert.equal(await page.locator('.turn-changes-card').count(), 1);
    assert.equal(await page.getByRole('button', { name: /src\/(old|missing)\.ts/ }).count(), 0);
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('turn-snapshot-visibility-visual: current card only, dark/light and wide/narrow screenshots saved');
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  release();
}
