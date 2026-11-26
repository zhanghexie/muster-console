// Production extension UI and real DomainRuntime. SDK transport is local HTTP,
// not Electron IPC; this fixture proves browser rendering only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalExtensionSource } from './external-extension-source.mjs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
const extension = externalExtensionSource('dsh-media-desk');
const { createDomainRuntime } = await import(pathToFileURL(path.join(extension, 'domain.mjs')).href);

const root = process.cwd(), ext = extension;
const out = path.join(root, '.tmp/ui-captures/dsh-media-desk');
await fs.mkdir(out, { recursive: true });

await build({ stdin: { contents: `import {applyTheme,BUILTIN_THEMES} from './src/renderer/src/theme';applyTheme(BUILTIN_THEMES.find(row=>row.appearance===new URLSearchParams(location.search).get('theme')),{persist:false});`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'theme.js') });
const states = new Map(), runtimes = new Map();
function runtime(id) {
  if (!runtimes.has(id)) {
    const files = new Map([['media-desk/settings.json', JSON.stringify({ language: 'zh' })]]); states.set(id, files);
    runtimes.set(id, createDomainRuntime({ identity: { workspaceId: id }, broker: async (method, args) => {
      if (method === 'models.list') return [];
      if (method === 'data.read') return files.has(args[0]) ? { content: files.get(args[0]) } : null;
      if (method === 'data.write') { files.set(args[0], args[1]); return true; }
      throw new Error(`Unexpected fixture host call ${method}`);
    } }));
  }
  return runtimes.get(id);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/call') {
      let text = ''; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text), domain = runtime(input.id);
      const result = input.method === 'snapshot' ? await domain.getSnapshot() : await domain[input.method](input.name, input.args);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return;
    }
    if (url.pathname === '/ui/panel.html') {
      const sdk = `<script>const id=new URLSearchParams(location.search).get('id');const rpc=(method,name,args)=>fetch('/call',{method:'POST',body:JSON.stringify({id,method,name,args})}).then(r=>r.json());window.ma={ready:Promise.resolve({}),models:{list:async()=>[]},agent:{domain:{snapshot:()=>rpc('snapshot'),query:(n,a)=>rpc('query',n,a),command:(n,a)=>rpc('execute',n,a)}}};</script><script src='/theme.js'></script>`;
      const html = (await fs.readFile(path.join(ext, 'ui/panel.html'), 'utf8')).replace('<script src="../__sdk__/sdk.js"></script>', sdk);
      res.setHeader('content-type', 'text/html');res.end(html);return;
    }
    const file = url.pathname === '/theme.js' ? path.join(out, 'theme.js') : url.pathname === '/__sdk__/theme.css' ? path.join(root, 'src/main/extensions/sdk/theme.css') : path.join(ext, url.pathname.slice(1));
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' }[path.extname(file)] ?? 'application/octet-stream';
    res.setHeader('content-type', mime); res.end(await fs.readFile(file));
  } catch (error) { res.statusCode = 500;res.end(JSON.stringify({error:error.message})); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const manifest = [];
try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 600], ['dark', 600], ['light', 390], ['dark', 390]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/ui/panel.html?theme=${theme}&id=${theme}-${width}`);
    await page.getByRole('textbox', { name: '记下灵感' }).waitFor();
    const shot = async label => {
      await page.screenshot({ path: path.join(out, `${theme}-${width}-${label}.png`), animations: 'disabled' });
      const clipped = await page.locator('.md-topbar > button, .md-nav').evaluateAll(elements => elements.filter(element => { const rect = element.getBoundingClientRect(); return rect.width && (rect.left < 0 || rect.right > innerWidth); }).map(element => element.className));
      manifest.push({ theme, width, label, errors: [...errors], overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), clipped });
      if (clipped.length) throw new Error(`Clipped header at ${width}: ${clipped.join(', ')}`);
    };
    await shot('home');
    for (const [label, name] of [['内容', 'content'], ['排期', 'schedule'], ['复盘', 'insights'], ['风格', 'style']]) {
      await page.getByRole('navigation', {name:'工作台导航'}).getByRole('button', {name:label,exact:true}).click();
      if (name === 'insights') await page.locator('.md-metrics').waitFor({ state: 'attached' });
      await shot(name);
    }
    await page.getByRole('navigation', {name:'工作台导航'}).getByRole('button', {name:'灵感',exact:true}).click();
    await page.locator('.md-node [data-card]').first().focus();
    await page.locator('.md-node [data-card]').first().press('Enter');
    await page.locator('.md-studio').waitFor(); await shot('studio');
    if (width < 780) await page.getByRole('button', {name:'打开对话'}).click();
    await page.getByRole('button', {name:'一键成稿',exact:true}).click();
    await page.getByRole('button', {name:'重新成稿',exact:true}).waitFor();
    if (width < 780) await page.getByRole('button', {name:'打开对话'}).click();
    await shot('produced');
    if (width < 780) await page.getByRole('button', {name:'打开对话'}).click();
    await page.getByRole('button', {name:'返回灵感'}).click();
    await page.getByRole('button', {name:'设置',exact:true}).click();
    await page.getByRole('dialog', {name:'设置',exact:true}).waitFor();await shot('settings');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.close();
  }
} finally {
  await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  await browser.close(); for (const domain of runtimes.values()) await domain.close(); await new Promise(resolve=>server.close(resolve));
}
console.log(`Media desk screenshots: ${out}`);
