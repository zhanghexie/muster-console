// Actual production bundles + real domains; only SDK transport and file selection are mocked.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalExtensionSource } from './external-extension-source.mjs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
const { createDomainRuntime: createCube } = await import(pathToFileURL(path.join(externalExtensionSource('rubiks-cube'), 'domain.mjs')).href);
const { createDomainRuntime: createLibrary } = await import(pathToFileURL(path.join(externalExtensionSource('library'), 'domain.mjs')).href);

const root = process.cwd(), out = path.join(root, '.tmp/ui-captures/teaching-extensions');
await fs.mkdir(out, { recursive: true });
await build({ stdin: { contents: "import {applyTheme,BUILTIN_THEMES} from './src/renderer/src/theme';applyTheme(BUILTIN_THEMES.find(row=>row.appearance===new URLSearchParams(location.search).get('theme')),{persist:false});", resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'theme.js') });
const bookTitles = ['山间札记', '阅读的方法', '日常的秩序', '把时间留给生活'];
const prose = [
  '清晨的光从窗边落进来，桌上的书还停在昨天读到的地方。我们不必急着翻过这一页，可以先看看作者如何展开一个念头，再想想自己的经验。',
  '阅读不是把所有句子都记住。有时只要留下一个问题、一段值得回看的文字，就足以让这次相遇延续到日常生活里。',
  '一段好的文字，需要留一点呼吸的空间。书页的边距、字与字的关系，以及段落之间的停顿，共同决定了我们愿不愿意继续读下去。',
  '把复杂的事拆成可以理解的小步骤，然后亲手试一遍。这样得到的认识，不只留在纸上，也会成为下次遇到问题时可以使用的经验。',
];
function epub(index) {
  const titles = ['从一页书开始', '留白里的时间', '观察与理解', '重新出发'];
  const files = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>',
    'OPS/content.opf': '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>' + bookTitles[index] + '</dc:title><dc:creator>界面验收样书</dc:creator></metadata><manifest>' + titles.map((_, i) => '<item id="c' + i + '" href="c' + i + '.xhtml" media-type="application/xhtml+xml"/>').join('') + '</manifest><spine>' + titles.map((_, i) => '<itemref idref="c' + i + '"/>').join('') + '</spine></package>',
  };
  titles.forEach((title, i) => { files['OPS/c' + i + '.xhtml'] = '<html><body><h1>' + title + '</h1>' + Array.from({ length: 70 }, (_, p) => '<p>' + prose[(p + i + index) % prose.length] + '</p>').join('') + '</body></html>'; });
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}
const books = bookTitles.map((_, i) => epub(i)), domains = new Map();
function domain(id, kind) {
  if (!domains.has(id)) {
    const files = new Map();
    domains.set(id, kind === 'rubiks-cube' ? createCube() : createLibrary({ broker: async (method, args) => {
      if (method === 'data.read') return files.has(args[0]) ? { content: files.get(args[0]) } : null;
      if (method === 'data.write') { files.set(args[0], args[1]); return true; }
      throw new Error('Unexpected broker ' + method);
    } }));
  }
  return domains.get(id);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/call') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body), runtime = domain(input.id, input.kind);
      const result = input.method === 'snapshot' ? await runtime.getSnapshot() : await runtime[input.method](input.name, input.args, { actor: 'human' });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
    }
    if (url.pathname.startsWith('/book/')) { res.setHeader('Content-Type', 'application/epub+zip'); res.end(books[Number(url.pathname.split('/').pop())]); return; }
    const kind = url.pathname.split('/')[1], extension = externalExtensionSource(kind);
    if (url.pathname.endsWith('/ui/panel.html')) {
      const sdk = '<script>const params=new URLSearchParams(location.search),id=params.get("id"),kind=' + JSON.stringify(kind) + ';const handlers=new Map();const rpc=(method,name,args)=>fetch("/call",{method:"POST",body:JSON.stringify({id,kind,method,name,args})}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error);return result;});window.ma={ready:Promise.resolve({}),on:(type,callback)=>{handlers.set(type,callback);return()=>handlers.delete(type);},agent:{domain:{snapshot:()=>rpc("snapshot"),query:(n,a)=>rpc("query",n,a),command:(n,a)=>rpc("execute",n,a)}},files:{pick:async()=>[0,1,2,3].map(i=>"/sample/"+i+".epub")},media:{import:async p=>({assetId:p,size:10000,url:"/book/"+p.split("/").pop().split(".")[0]}),release:async()=>true}};</script><script src="/theme.js"></script>';
      const html = (await fs.readFile(path.join(extension, 'ui/panel.html'), 'utf8')).replace('<script src="../__sdk__/sdk.js"></script>', sdk);
      res.setHeader('Content-Type', 'text/html'); res.end(html); return;
    }
    const file = url.pathname === '/theme.js' ? path.join(out, 'theme.js') : url.pathname.endsWith('/__sdk__/theme.css') ? path.join(root, 'src/main/extensions/sdk/theme.css') : path.join(extension, ...url.pathname.split('/').slice(2));
    res.setHeader('Content-Type', path.extname(file) === '.css' ? 'text/css' : 'text/javascript'); res.end(await fs.readFile(file));
  } catch (error) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const captures = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 940 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const shot = async label => { await page.screenshot({ path: path.join(out, theme + '-' + width + '-' + label + '.png'), animations: 'disabled' }); captures.push({ theme, width, label, errors: [...errors], overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) }); };
    await page.goto('http://127.0.0.1:' + server.address().port + '/rubiks-cube/ui/panel.html?theme=' + theme + '&id=cube-' + theme + width);
    await page.locator('canvas').waitFor(); await page.getByText('六面同色', { exact: true }).waitFor();
    if (width === 1440) {
      // Reproduce the iframe widths with the docked AI shown, hidden, then shown again.
      for (const panelWidth of [1104, 1406, 1104, width]) {
        await page.setViewportSize({ width: panelWidth, height: 940 });
        const visible = await page.locator('.cube-actions button').evaluateAll(buttons =>
          buttons.length === 3 && buttons.every(button => {
            const box = button.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return box.bottom <= innerHeight && button.contains(hit);
          }));
        assert.ok(visible, 'Cube actions must stay on screen at panel width ' + panelWidth);
      }
    }
    await shot('cube');
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
    await page.getByText('1 步', { exact: true }).waitFor({ timeout: 8000 });
    await shot('cube-turned');
    await page.mouse.move(box.x + 8, box.y + 12); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 50, { steps: 8 }); await page.mouse.up();
    if (await page.locator('#moves').textContent() !== '1 步') throw new Error('Orbit must not turn a layer');
    await page.getByRole('button', { name: '六面观察' }).click(); await shot('cube-faces');
    if (theme === 'light' && width === 1440) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByRole('button', { name: '转动与公式' }).click();
      await page.getByRole('button', { name: 'R 顺时针', exact: true }).click();
      await page.getByText('2 步', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'R 顺时针', exact: true }).click();
      await page.getByText('3 步', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('canvas')?.getAttribute('aria-busy') !== 'true');
      const target = await page.locator('canvas').boundingBox();
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2); await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2 + 105, target.y + target.height / 2, { steps: 12 }); await page.mouse.up();
      await page.getByText('4 步', { exact: true }).waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    await page.getByRole('button', { name: '转动与公式' }).click(); await page.getByRole('button', { name: /右手公式/ }).click(); await shot('cube-lesson'); await page.keyboard.press('Escape');
    await page.goto('http://127.0.0.1:' + server.address().port + '/library/ui/panel.html?theme=' + theme + '&id=library-' + theme + width);
    await page.getByRole('button', { name: '选择一本书' }).waitFor(); await shot('library-empty');
    await page.getByRole('button', { name: '选择一本书' }).click();
    await page.getByRole('button', { name: /导入书籍/ }).waitFor();
    await page.getByRole('button', { name: '阅读《山间札记》' }).waitFor(); await shot('library-shelf');
    await page.getByRole('button', { name: '阅读《山间札记》' }).click();
    await page.getByRole('heading', { name: '从一页书开始' }).waitFor(); await shot('reader');
    const body = page.getByLabel('阅读正文'); await body.hover(); await page.mouse.wheel(0, 980);
    await page.waitForFunction(() => document.querySelector('.reader-page')?.scrollTop > 800);
    await page.getByText('进度已保存', { exact: true }).waitFor();
    const anchor = () => body.evaluate(container => {
      const line = container.getBoundingClientRect().top + 26;
      return [...container.querySelectorAll('[data-paragraph]')].find(element => element.getBoundingClientRect().bottom > line)?.getAttribute('data-paragraph');
    });
    const before = await anchor();
    await page.getByRole('button', { name: '添加当前位置书签' }).click();
    await page.getByRole('button', { name: '书架', exact: true }).click(); await page.getByRole('button', { name: '继续阅读' }).click();
    await page.getByRole('heading', { name: '从一页书开始' }).waitFor();
    if (Math.abs(Number(await anchor()) - Number(before)) > 1) {
      console.log('RESTORE', {before, after:await anchor(), saved:(await domain('library-'+theme+width,'library').getSnapshot()).state.entries[0].progress, geometry:await body.evaluate(container=>({scrollTop:container.scrollTop,scrollHeight:container.scrollHeight,height:container.clientHeight,top:container.getBoundingClientRect().top,first:container.querySelector('[data-paragraph]')?.getBoundingClientRect().top}))});
      await shot('reader-restore-failed'); throw new Error('Reader failed to restore paragraph after reopening');
    }
    await page.getByRole('button', { name: '阅读设置' }).click(); await shot('reader-settings');
    const font = page.getByRole('slider', { name: '正文字号' }); await font.focus(); await font.press('ArrowRight');
    await page.keyboard.press('Escape');
    if (Math.abs(Number(await anchor()) - Number(before)) > 1) throw new Error('Font change lost paragraph position');
    await page.getByRole('button', { name: '查看书签' }).click(); await shot('reader-bookmarks'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '书架', exact: true }).click(); await page.getByRole('button', { name: '继续阅读' }).waitFor(); await shot('library-resume');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.close();
  }
} finally {
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(captures, null, 2));
  await browser.close(); for (const runtime of domains.values()) await runtime.close(); await new Promise(resolve => server.close(resolve));
}
console.log('Teaching extension visual captures: ' + out);
