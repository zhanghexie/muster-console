/**
 * 启动真实数据环境的 Electron 开发版，遍历主要 UI 页面并生成截图索引。
 * 运行：node scripts/capture-ui.mjs [--out <目录>] [--width 1440] [--height 900]
 * 截图可能包含真实会话与设置内容；默认写到 Git 忽略的 .tmp/ui-captures/。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

function options(argv) {
  const opt = { out: path.join(root, '.tmp', 'ui-captures', stamp), width: 1440, height: 900 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log('用法: node scripts/capture-ui.mjs [--out <目录>] [--width 1440] [--height 900]');
      process.exit(0);
    }
    if (!['--out', '--width', '--height'].includes(arg) || !argv[i + 1]) {
      throw new Error(`未知或缺少值的参数: ${arg}`);
    }
    opt[arg.slice(2)] = argv[++i];
  }
  opt.width = Number(opt.width);
  opt.height = Number(opt.height);
  if (!Number.isInteger(opt.width) || opt.width < 900 || !Number.isInteger(opt.height) || opt.height < 650) {
    throw new Error('截图尺寸至少为 900 × 650，且必须是整数');
  }
  opt.out = path.resolve(opt.out);
  const localStorageRoot = path.join(root, '.metaAgent');
  if (opt.out === localStorageRoot || opt.out.startsWith(`${localStorageRoot}${path.sep}`)) {
    throw new Error('截图输出目录不能位于 .metaAgent 本地存储下');
  }
  return opt;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function main() {
  const opt = options(process.argv.slice(2));
  await fs.mkdir(opt.out, { recursive: true });
  const devPort = await freePort();
  let cdpPort = await freePort();
  while (cdpPort === devPort) cdpPort = await freePort();
  const logs = [];
  const startupDiagnostics = new Set();
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'dev-no-sandbox.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RENDERER_PORT: String(devPort),
      MUSTER_DEVTOOLS_PORT: String(cdpPort),
      MUSTER_NO_SANDBOX: '1'
    },
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const line = String(chunk);
      logs.push(line);
      if (logs.length > 80) logs.shift();
      if (line.includes('another consumer') || line.includes('[feishu] card stream exit')) {
        startupDiagnostics.add('飞书卡片事件已有消费者；截图实例的重复订阅被拒绝');
      }
      if (line.includes('Unable to create cache') || line.includes('Gpu Cache Creation failed')) {
        startupDiagnostics.add('Chromium 磁盘缓存创建失败；可能与真实数据目录的并发实例有关');
      }
    });
  }
  let browser;
  const shots = [];
  const errors = [];
  let count = 0;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`应用启动进程退出 (${child.exitCode})`);
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1200 });
        break;
      } catch { await sleep(350); }
    }
    if (!browser) throw new Error('90 秒内未等到 Electron 调试端口');
    let page;
    while (Date.now() < deadline && !page) {
      for (const candidate of browser.contexts().flatMap((ctx) => ctx.pages())) {
        try {
          if (await candidate.locator('.app-shell').count()) { page = candidate; break; }
        } catch { /* 页面仍在加载 */ }
      }
      if (!page) await sleep(350);
    }
    if (!page) throw new Error('90 秒内未找到工作台主窗口');
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    const sandbox = await page.evaluate(() => window.api.sandbox.getInfo());
    if (sandbox?.enabled !== false) throw new Error('安全检查失败：当前实例仍处于 Dev 沙盒');
    await page.setViewportSize({ width: opt.width, height: opt.height });
    await sleep(500);

    const capture = async (group, label, detail = '', parkPointer = true) => {
      const name = `${String(++count).padStart(2, '0')}-${group}-${label}`.replace(/[^a-zA-Z0-9_-]/g, '-');
      // 顶栏空白区不会触发虚拟屏露条的「悬停切页」，也能收起按钮 tooltip。
      if (parkPointer) await page.mouse.move(Math.round(opt.width * 0.75), 18);
      await sleep(140);
      await page.screenshot({ path: path.join(opt.out, `${name}.png`), animations: 'disabled', caret: 'hide', timeout: 15_000 });
      shots.push({ group, label, detail, file: `${name}.png` });
      console.log(`截图 ${shots.length}: ${group} / ${detail || label}`);
    };
    const step = async (label, fn) => {
      try { await fn(); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ label, message });
        console.warn(`跳过 ${label}: ${message.split('\n')[0]}`);
      }
    };
    const clickVisible = async (selector, index = 0) => {
      const loc = page.locator(selector).nth(index);
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      await loc.click({ timeout: 5000 });
    };

    await capture('workspace', 'current', '当前工作页');
    const sessionsInitiallyOpen = (await page.locator('.sessions-column .left-panel').count()) > 0;
    await step('折叠左栏划开速览', async () => {
      if (sessionsInitiallyOpen) await clickVisible('.chrome-sessions-toggle');
      await page.locator('.main-view.sessions-hidden').waitFor({ state: 'visible', timeout: 5000 });
      await sleep(300);
      await capture('workspace', 'dock-closed', '左栏折叠 · 工作面闭合');
      // 鼠标先离开检测带再进入，遵守把手的武装语义。
      await page.mouse.move(100, Math.round(opt.height / 2));
      await page.mouse.move(34, Math.round(opt.height / 2));
      await page.locator('.sessions-hot-ghost').waitFor({ state: 'visible', timeout: 5000 });
      await page.mouse.move(12, Math.round(opt.height / 2));
      await page.locator('.main-view.sessions-peek').waitFor({ state: 'visible', timeout: 5000 });
      await page.mouse.move(100, Math.round(opt.height / 2));
      await sleep(320);
      await capture('workspace', 'dock-peek', '左栏折叠 · 工作面划开', false);
      await page.evaluate(() => {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement) focused.blur();
      });
      await page.keyboard.press('Escape');
      await page.locator('.main-view.sessions-peek').waitFor({ state: 'detached', timeout: 5000 });
      if (sessionsInitiallyOpen) await clickVisible('.chrome-sessions-toggle');
    });
    if (!(await page.locator('.sessions-column .left-panel').count())) {
      await step('展开会话栏', () => clickVisible('.chrome-sessions-toggle'));
    }

    // 左栏所有内置实用功能及已安装的扩展面板。
    const utilityCount = await page.locator('.left-panel .utility-feature-list > button.utility-feature-item').count();
    for (let i = 0; i < utilityCount; i++) {
      await step(`实用功能 ${i + 1}`, async () => {
        const item = page.locator('.left-panel .utility-feature-list > button.utility-feature-item').nth(i);
        const label = (await item.innerText()).trim().replace(/\s+/g, ' ') || `panel-${i + 1}`;
        // 真实工作区可能因通知/虚拟屏动画让按钮暂时移出视口；DOM 点击仍走组件 onClick。
        await item.evaluate((el) => el.click());
        await page.locator('.center-utility-layer:not([aria-hidden="true"])').waitFor({ state: 'visible', timeout: 7000 });
        await sleep(300);
        await capture('utility', String(i + 1), label);
        if (await page.locator('.center-utility-layer:not([aria-hidden="true"]) .memory-tabs').count()) {
          const tabs = page.locator('.center-utility-layer:not([aria-hidden="true"]) .memory-tabs [role="tab"]');
          const tabCount = await tabs.count();
          for (let j = 0; j < tabCount; j++) {
            await step(`记忆中心页签 ${j + 1}`, async () => {
              const tab = tabs.nth(j);
              const name = (await tab.innerText()).trim().replace(/\s+/g, ' ');
              await tab.click();
              await sleep(180);
              await capture('memory', String(j + 1), name);
            });
          }
        }
      });
    }
    await step('关闭实用功能', async () => {
      await page.locator('.left-panel .utility-feature-list > button.utility-feature-item.active').click();
      await sleep(220);
    });

    // 当前窗口右侧的文件、Git、内置浏览器。Ctrl+\\ 为项目默认的切页快捷键。
    const layoutBefore = await page.evaluate(() => ({
      virtual: !!document.querySelector('.h-strip.vs-axis'),
      git: !!document.querySelector('.main-view.h-git'),
      focus: !!document.querySelector('.main-view.is-focus')
    }));
    await step('侧工具页', async () => {
      let switcher = page.locator('.side-tools-page.is-shown .side-tools-switcher');
      if (!(await switcher.isVisible().catch(() => false))) {
        await page.keyboard.press('Control+Backslash');
        await sleep(600);
      }
      switcher = page.locator('.side-tools-page.is-shown .side-tools-switcher');
      await switcher.waitFor({ state: 'visible', timeout: 8000 });
      const initialTab = await switcher.locator('[role="tab"][aria-selected="true"]').innerText();
      for (const [index, label] of ['files', 'git', 'browser'].entries()) {
        await step(`侧工具 ${label}`, async () => {
          await page.locator('.side-tools-page.is-shown .side-tools-switcher [role="tab"]').nth(index).click();
          await sleep(380);
          await capture('side', label, label === 'files' ? '文件' : label === 'git' ? 'Git' : '内置浏览器');
          if (label === 'files') {
            // 根目录有对应文件时补拍正文：空态无法验证平面阅读与代码画布的差别。
            const examples = [
              { label: 'files-markdown', detail: '文件 · Markdown 阅读', row: '.file-tree-row.is-file[data-file-tree-row$=".md"]', ready: '.file-editor-main.is-reading-surface .file-editor-preview-md' },
              { label: 'files-plain', detail: '文件 · 普通文本阅读', row: '.file-tree-row.is-file[data-file-tree-row=".gitignore"], .file-tree-row.is-file[data-file-tree-row$=".txt"]', ready: '.file-editor-main.is-reading-surface .file-editor-cm.is-plain-reading .cm-editor' },
              { label: 'files-code', detail: '文件 · 代码画布', row: '.file-tree-row.is-file[data-file-tree-row$=".json"]', ready: '.file-editor-main:not(.is-reading-surface) .file-editor-cm .cm-editor' }
            ];
            for (const example of examples) {
              const root = page.locator('.side-tools-page.is-shown .files-panel');
              const row = root.locator(example.row).first();
              if (!(await row.count())) continue;
              await step(example.detail, async () => {
                await row.scrollIntoViewIfNeeded();
                await row.click();
                await root.locator(example.ready).waitFor({ state: 'visible', timeout: 5000 });
                await capture('side', example.label, example.detail);
              });
            }
          }
        });
      }
      const oldTab = page.locator('.side-tools-page.is-shown .side-tools-switcher [role="tab"]').filter({ hasText: initialTab }).first();
      if (await oldTab.count()) await oldTab.click();
      if (!layoutBefore.git && !layoutBefore.focus) {
        await page.keyboard.press('Control+Backslash');
        await sleep(500);
      }
      if (!layoutBefore.virtual && !layoutBefore.focus && (await page.locator('.h-strip.vs-axis').count())) {
        await page.locator('.pane-split-hit').hover();
        await page.locator('.split-expand-btn').click();
        await sleep(350);
      }
    });

    await step('全局看板', async () => {
      await clickVisible('.chrome-gboard-btn');
      await page.locator('.g-board-sheet.is-open').waitFor({ state: 'visible', timeout: 7000 });
      await capture('board', 'status', '全局看板 · 状态');
      await page.locator('.board-view-switch [role="tab"]').nth(1).click();
      await sleep(300);
      await capture('board', 'free', '全局看板 · 自由画布');
      await page.locator('.board-view-switch [role="tab"]').nth(0).click();
      await page.locator('.board-toolbar .prompt-task-toolbar-actions > button').last().click();
      await sleep(220);
    });

    await step('命令面板', async () => {
      await page.keyboard.press('Control+p');
      await page.locator('.quick-open[role="dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await capture('overlay', 'command-palette', '命令面板');
      await page.keyboard.press('Escape');
      await sleep(200);
    });
    await step('调度对话', async () => {
      const toggle = page.locator('.left-ws-slot .agent-ws-stack-item .agent-avatar').first();
      await toggle.waitFor({ state: 'visible', timeout: 3000 });
      const wasOpen = await page.locator('.agent-float.is-expanded').count();
      if (!wasOpen) await toggle.evaluate((el) => el.click());
      await page.locator('.agent-float.is-expanded').waitFor({ state: 'visible', timeout: 4000 });
      await sleep(250);
      await capture('overlay', 'scheduler-chat', '调度 Agent 对话');
      if (!wasOpen) await toggle.evaluate((el) => el.click());
    });

    await step('设置页', async () => {
      await clickVisible('.chrome-settings');
      await page.locator('.settings-page[role="dialog"]').waitFor({ state: 'visible', timeout: 7000 });
      const tabs = page.locator('.settings-nav-item');
      const n = await tabs.count();
      for (let i = 0; i < n; i++) {
        await step(`设置页签 ${i + 1}`, async () => {
          const tab = tabs.nth(i);
          const name = (await tab.innerText()).trim().replace(/\s+/g, ' ');
          await tab.click();
          await page.locator('.settings-tabpane.is-shown').waitFor({ state: 'visible', timeout: 5000 });
          await sleep(180);
          await capture('settings', String(i + 1), name);
        });
      }
      await clickVisible('.settings-back');
    });

    if (!sessionsInitiallyOpen && (await page.locator('.sessions-column .left-panel').count())) {
      await step('恢复会话栏折叠', () => clickVisible('.chrome-sessions-toggle'));
    }
  } catch (error) {
    errors.push({ label: '启动或主流程', message: error instanceof Error ? error.message : String(error) });
    console.error(errors.at(-1).message);
  } finally {
    const manifest = { createdAt: new Date().toISOString(), mode: 'non-sandbox', viewport: { width: opt.width, height: opt.height }, shots, errors, startupDiagnostics: [...startupDiagnostics] };
    try {
      await fs.writeFile(path.join(opt.out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      const cards = shots.map((s) => `<a class="card" href="${escapeHtml(s.file)}"><img loading="lazy" src="${escapeHtml(s.file)}" alt="${escapeHtml(s.detail)}"><span>${escapeHtml(s.group)} / ${escapeHtml(s.detail || s.label)}</span></a>`).join('\n');
      const failures = errors.length ? `<details><summary>${errors.length} 个未拍到的入口</summary><pre>${escapeHtml(errors.map((e) => `${e.label}: ${e.message}`).join('\n'))}</pre></details>` : '';
      const diagnostics = startupDiagnostics.size ? `<details><summary>${startupDiagnostics.size} 条启动诊断</summary><pre>${escapeHtml([...startupDiagnostics].join('\n'))}</pre></details>` : '';
      await fs.writeFile(path.join(opt.out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MetaAgent UI 截图</title><style>body{font:14px system-ui;background:#17191d;color:#eee;margin:32px}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}.card{color:inherit;text-decoration:none;background:#252932;border-radius:12px;overflow:hidden}.card img{width:100%;display:block}.card span{display:block;padding:10px 14px}pre{white-space:pre-wrap}</style><h1>MetaAgent UI 截图 · ${shots.length} 张</h1><p>非沙盒真实数据环境 · ${escapeHtml(manifest.createdAt)}</p>${failures}${diagnostics}<div class="grid">${cards}</div></html>`, 'utf8');
    } finally {
      // Even a full disk/report write failure must not leave our Electron instance running.
      try { await browser?.close().catch(() => {}); }
      finally { stopTree(child.pid); }
    }
    console.log(`完成：${shots.length} 张截图，${errors.length} 个未拍到的入口，${startupDiagnostics.size} 条启动诊断\n${path.join(opt.out, 'index.html')}`);
    if (!shots.length || errors.length) {
      console.error(logs.join('').slice(-3000));
      process.exitCode = 1;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
