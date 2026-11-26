/** Build and capture a scoped production component fixture. Run from anywhere in this repo. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { viteFixtureAssets } from './vite-fixture-assets.mjs';
import { chromium } from 'playwright-core';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(skill, '../../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const opt = {
  fixture: path.join(skill, 'assets/composer-fixture.tsx'),
  scenario: path.join(skill, 'assets/composer-scenario.mjs'),
  out: path.join(root, '.tmp/ui-captures', `verification-${stamp}-${process.pid}`),
  themes: ['light', 'dark'], widths: [780, 390], height: 900,
  styles: ['base', 'chat', 'markdown', 'agent-chat', 'float'],
  target: '.chat-input-shell', font: 'OPPO Sans', chrome: '', allowFallback: false, showScrollbars: false
};

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function contained(base, target) {
  const rel = path.relative(base, target);
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
function parse(argv) {
  const flags = new Set(['fixture', 'scenario', 'out', 'themes', 'widths', 'height', 'styles', 'target', 'font', 'chrome']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') {
      console.log('capture-component.mjs [--fixture TSX] [--scenario MJS] [--out DIR] [--themes light,dark] [--widths 780,390] [--height 900] [--styles base,chat,markdown,agent-chat,float] [--target CSS] [--font "OPPO Sans"] [--chrome EXE] [--allow-fallback-font] [--show-scrollbars]');
      return false;
    }
    if (argv[i] === '--allow-fallback-font') { opt.allowFallback = true; continue; }
    if (argv[i] === '--show-scrollbars') { opt.showScrollbars = true; continue; }
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !flags.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or missing argument: ${argv[i]}`);
    opt[key] = argv[++i];
  }
  for (const key of ['fixture', 'scenario', 'out']) opt[key] = path.resolve(opt[key]);
  if (typeof opt.themes === 'string') opt.themes = opt.themes.split(',');
  if (typeof opt.widths === 'string') opt.widths = opt.widths.split(',').map(Number);
  if (typeof opt.styles === 'string') opt.styles = opt.styles.split(',');
  opt.height = Number(opt.height);
  if (!opt.themes.length || opt.themes.some(t => !['light', 'dark'].includes(t))) throw new Error('Themes must be light/dark');
  if (!opt.widths.length || opt.widths.some(w => !Number.isInteger(w) || w < 200 || w > 4000) || !Number.isInteger(opt.height) || opt.height < 200 || opt.height > 4000) throw new Error('Viewport sizes must be integers in 200..4000');
  if (opt.styles.some(s => !/^[a-z0-9-]+$/.test(s))) throw new Error('Styles must name production CSS files');
  for (const key of ['fixture', 'scenario', 'out']) {
    if (!contained(root, opt[key]) || contained(path.join(root, '.metaAgent'), opt[key])) throw new Error(`${key} must be inside this repo, outside .metaAgent`);
  }
  return true;
}

async function fontEvidence(page) {
  return page.evaluate(async family => {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([400, 500].map(weight => document.fonts.load(`${weight} 14px "${family.replaceAll('"', '\\"')}"`, '中文测试Abc123'))),
        new Promise(resolve => { timer = setTimeout(resolve, 8000); })
      ]);
    } finally { clearTimeout(timer); }
    const clean = value => value.replace(/^["']|["']$/g, '');
    const faces = [...document.fonts].filter(face => clean(face.family) === family).map(face => ({ family: face.family, weight: face.weight, status: face.status }));
    const matches = (value, weight) => {
      if (value === 'normal') return weight === 400;
      if (value === 'bold') return weight === 700;
      const range = value.trim().split(/\s+/).map(Number);
      return range.every(Number.isFinite) && weight >= range[0] && weight <= (range[1] ?? range[0]);
    };
    return { requested: family, faces, loaded: [400, 500].every(weight => faces.some(face => matches(face.weight, weight) && face.status === 'loaded')) };
  }, opt.font);
}

async function measure(page) {
  return page.evaluate(selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing measurement target: ${selector}`);
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    return {
      target: selector,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight,
      color: css.color, background: css.backgroundColor, border: css.borderColor,
      documentOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  }, opt.target);
}

async function main() {
  if (!parse(process.argv.slice(2))) return;
  await fs.access(path.join(root, 'package.json'));
  const scenario = (await import(pathToFileURL(opt.scenario).href)).default;
  if (typeof scenario !== 'function') throw new Error('Scenario must export a default async function');
  await fs.mkdir(opt.out, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ma-ui-verification-'));
  const report = { mode: 'production-component-with-mocked-ipc', visualReview: 'pending', fixture: opt.fixture, scenario: opt.scenario, startedAt: new Date().toISOString(), cases: [] };
  let browser, server;
  try {
    await build({
      entryPoints: [opt.fixture], outfile: path.join(tmp, 'fixture.js'), bundle: true, format: 'esm',
      alias: { '@workbench': root }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
      jsx: 'automatic',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file', '.webp': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file' },
      plugins: [viteFixtureAssets]
    });
    const hasCss = await fs.access(path.join(tmp, 'fixture.css')).then(() => true, () => false);
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${hasCss ? '<link rel="stylesheet" href="/fixture.css">' : ''}</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
        return;
      }
      try {
        const assetPath = decodeURIComponent(url.pathname);
        const base = assetPath.startsWith('/assets/harness-brands/')
          ? path.join(root, 'src', 'renderer', 'src')
          : tmp;
        const requested = path.resolve(base, '.' + assetPath);
        const allowed = base === tmp ? tmp : path.join(base, 'assets', 'harness-brands');
        if (!contained(allowed, requested)) throw new Error('Outside fixture assets');
        const types = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };
        res.setHeader('Content-Type', types[path.extname(requested)] ?? 'application/octet-stream');
        res.end(await fs.readFile(requested));
      } catch { res.statusCode = 404; res.end('Not found'); }
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const chrome = opt.chrome || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '');
    const exists = chrome && await fs.access(chrome).then(() => true, () => false);
    if (opt.chrome && !exists) throw new Error(`Browser executable not found: ${chrome}`);
    browser = await chromium.launch({ headless: true, ...(opt.showScrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}), ...(exists ? { executablePath: chrome } : {}) });
    for (const theme of opt.themes) for (const width of opt.widths) {
      const page = await browser.newPage({ viewport: { width, height: opt.height } });
      page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
      const item = { theme, width, height: opt.height, status: 'passed', screenshots: [], errors: [], warnings: [], failedRequests: [] };
      report.cases.push(item);
      page.on('pageerror', error => item.errors.push(error.stack ?? error.message));
      page.on('console', message => {
        if (message.type() === 'error') {
          const isFont = /\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(message.location().url);
          const location = message.location();
          (opt.allowFallback && isFont ? item.warnings : item.errors).push(`${message.text()} [${location.url}:${location.lineNumber}]`);
        }
        else if (message.type() === 'warning') item.warnings.push(message.text());
      });
      page.on('requestfailed', request => item.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
      const capture = async (label, { animations = 'disabled', caret = 'hide' } = {}) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) throw new Error('Capture labels must be lowercase filename slugs');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const file = `${theme}-${width}-${item.screenshots.length + 1}-${label}.png`;
        const metrics = await measure(page);
        await page.screenshot({ path: path.join(opt.out, file), animations, caret });
        item.screenshots.push({ label, file, metrics });
      };
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
        for (const style of opt.styles) await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${style}.css`) });
        await page.locator(opt.target).first().waitFor();
        item.fonts = await fontEvidence(page);
        await scenario({ page, theme, width, capture, assert });
        if (!item.screenshots.length) await capture('current');
        item.unmocked = await page.evaluate(() => window.__uiFixture?.unmocked ?? []);
        const family = item.screenshots[0].metrics.fontFamily.split(',').map(value => value.trim().replace(/^["']|["']$/g, ''));
        if (!item.fonts.loaded || family[0] !== opt.font) {
          const message = `Requested font not confirmed loaded/in use: ${opt.font}`;
          if (opt.allowFallback) item.warnings.push(message + ' (explicit fallback allowed; readability remains unverified)');
          else item.errors.push(message);
        }
      } catch (error) {
        item.errors.push(error.stack ?? String(error));
        const file = `${theme}-${width}-failure.png`;
        await page.screenshot({ path: path.join(opt.out, file) }).then(() => { item.failureScreenshot = file; }, () => {});
      } finally {
        if (item.errors.length) item.status = 'failed';
        await page.close();
      }
    }
  } catch (error) {
    report.setupError = error.stack ?? String(error);
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    assert(contained(path.resolve(os.tmpdir()), tmp) && path.basename(tmp).startsWith('ma-ui-verification-'));
    await fs.rm(tmp, { recursive: true, force: true });
  }
  await fs.writeFile(path.join(opt.out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  const cards = report.cases.flatMap(item => [...item.screenshots, ...(item.failureScreenshot ? [{ label: 'failure', file: item.failureScreenshot }] : [])].map(shot => `<article><h2>${escapeHtml(`${item.theme} ${item.width}px / ${shot.label}`)}</h2><p>${escapeHtml(item.status)} · font loaded: ${item.fonts?.loaded ?? false}</p><a href="${escapeHtml(shot.file)}"><img loading="lazy" src="${escapeHtml(shot.file)}" alt="${escapeHtml(shot.label)}"></a></article>`)).join('\n');
  await fs.writeFile(path.join(opt.out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>UI verification</title><style>body{font:14px system-ui;margin:24px}article{display:inline-block;vertical-align:top;width:380px;margin:8px;border:1px solid #ccc;padding:12px}img{width:100%}h2{font-size:16px}</style><h1>截图已生成，视觉检查待完成</h1><p>Production components, mocked IPC. <a href="manifest.json">诊断清单</a></p>${report.setupError ? `<pre>${escapeHtml(report.setupError)}</pre>` : ''}${cards}</html>`);
  const failed = !!report.setupError || report.cases.some(item => item.status === 'failed');
  console.log(`${failed ? 'FAILED' : 'Behavior checks passed'}; visual review pending: ${opt.out}`);
  if (failed) {
    for (const item of report.cases.filter(item => item.errors.length)) console.error(`${item.theme}/${item.width}: ${item.errors.join('\n')}`);
    if (report.setupError) console.error(report.setupError);
    process.exitCode = 1;
  }
}
await main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
