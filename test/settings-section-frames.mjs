/** Real settings pages: section content is framed, headings are not underlined. No screenshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseLease = acquireTestLease(root);
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/settings-redesign.tsx')], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'import.meta.url': '"http://127.0.0.1/fixture.js"' },
  loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent' });
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
try {
  for (const width of [1440, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto(`http://fixture.local/?theme=${width === 1440 ? 'dark' : 'light'}`);
    for (const file of ['base', 'skel', 'float', 'settings', 'responsive', 'dialogs'])
      await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${file}.css`) });
    for (const file of ['settings-content', 'settings-resource', 'worker-pane', 'capability-management', 'capability-usage', 'local-storage'])
      await page.addStyleTag({ path: path.join(root, `src/renderer/src/components/settings/${file}.css`) });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const nav = page.getByRole('navigation', { name: '设置分组' });
    try { await nav.waitFor({ timeout: 6000 }); }
    catch (cause) { throw new Error(`Settings fixture failed to load: ${errors.join('; ')}`, { cause }); }
    const current = () => page.locator('.settings-tabpane.is-shown');
    const navigate = async name => {
      await nav.getByRole('button', { name, exact: true }).click();
      await current().getByRole('heading', { name, exact: true, level: 1 }).waitFor();
      const title = await current().locator('.settings-pane-title').evaluate(node => ({
        position: getComputedStyle(node).position,
        border: getComputedStyle(node).borderBottomWidth,
        rule: getComputedStyle(node, '::after').content
      }));
      assert.equal(title.position, 'static', `${width}px ${name}: page title must not stick`);
      assert.equal(title.border, '0px', `${width}px ${name}: page title must have no underline`);
      assert.ok(['none', 'normal'].includes(title.rule), `${width}px ${name}: page title must have no underline pseudo-element`);
    };
    const verifySections = async label => {
      const sections = await current().locator('.s-sec:visible, .settings-detail-section:visible').evaluateAll(nodes => nodes.map(node => {
        const heading = node.querySelector(':scope > .s-sec-h, :scope > .settings-detail-section-head');
        const body = node.querySelector(':scope > .settings-group-body');
        const style = body && getComputedStyle(body), headStyle = heading && getComputedStyle(heading);
        return { name: heading?.textContent?.trim(), hasBody: !!body, border: style?.borderTopWidth,
          radius: parseFloat(style?.borderTopLeftRadius || '0'), underline: headStyle?.borderBottomWidth,
          overflow: body ? body.scrollWidth - body.clientWidth : 0 };
      }));
      assert.ok(sections.length, `${width}px ${label}: expected settings sections`);
      for (const section of sections) {
        assert.ok(section.hasBody && section.border === '1px' && section.radius > 0, `${width}px ${label}/${section.name}: content needs a rounded frame`);
        assert.equal(section.underline, '0px', `${width}px ${label}/${section.name}: title should have no underline`);
        assert.ok(section.overflow <= 1, `${width}px ${label}/${section.name}: content overflows by ${section.overflow}px`);
      }
    };
    const verifyTitleScroll = async label => {
      const moved = await current().evaluate(async pane => {
        pane.scrollTop = 0;
        await new Promise(requestAnimationFrame);
        const title = pane.querySelector('.settings-pane-title');
        const before = title.getBoundingClientRect().top;
        pane.scrollTop = 200;
        await new Promise(requestAnimationFrame);
        const result = { before, after: title.getBoundingClientRect().top, scroll: pane.scrollTop };
        pane.scrollTop = 0;
        return result;
      });
      assert.ok(moved.scroll > 0, `${width}px ${label}: page should scroll`);
      assert.ok(Math.abs(moved.before - moved.after - moved.scroll) <= 1,
        `${width}px ${label}: title must move with the page, ${JSON.stringify(moved)}`);
    };

    await navigate('外观');
    const theme = current().getByRole('region', { name: '主题', exact: true });
    await theme.locator('.theme-grid').waitFor();
    assert.equal(await theme.locator(':scope > .settings-group-body .theme-grid').count(), 1);
    assert.equal(await theme.locator(':scope > .settings-group-body [data-settings-item="appearance-workspace-theme"]').count(), 1);
    assert.equal(await theme.locator(':scope > .settings-group-body [data-settings-item="appearance-folder"]').count(), 0);
    await verifySections('appearance');

    await navigate('通用');
    await current().getByRole('heading', { name: '语言与文字' }).waitFor();
    await verifySections('general');
    await verifyTitleScroll('general');

    await navigate('模型与输入');
    await current().getByLabel('供应商名称').waitFor();
    await current().getByRole('heading', { name: '模型服务商', level: 2 }).waitFor();
    await current().getByRole('heading', { name: '文件与输入', level: 2 }).waitFor();
    await current().getByRole('heading', { name: '文件限制', level: 3 }).waitFor();
    assert.equal(await current().getByRole('group', { name: '模型与输入分类' }).count(), 0);
    await verifySections('model-and-input');
    await verifyTitleScroll('model-and-input');

    await navigate('Harness 接入');
    await current().getByRole('button', { name: '配置 Muster Core' }).click();
    await current().getByRole('heading', { name: '基本信息' }).waitFor();
    await verifySections('harness');

    await navigate('能力管理');
    await current().getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
    await current().getByRole('button', { name: '查看 code-review' }).click();
    await current().getByRole('heading', { name: '基本信息' }).waitFor();
    await verifySections('capability');
    const usage = current().locator('.capability-usage:visible');
    await usage.waitFor();
    assert.equal(await usage.locator(':scope > .usage-heading').evaluate(node => getComputedStyle(node).borderBottomWidth), '0px');
    assert.equal(await usage.locator(':scope > .settings-group-body').evaluate(node => getComputedStyle(node).borderTopWidth), '1px');

    await navigate('通知');
    await current().getByRole('heading', { name: '什么时候提醒' }).waitFor();
    await verifySections('notifications');
    await navigate('远程访问');
    await current().getByRole('heading', { name: '用网址打开' }).waitFor();
    await verifySections('remote');

    await navigate('快捷键');
    const shortcuts = current().locator('.kb-workbench-section');
    await shortcuts.getByRole('heading', { name: '工作台快捷键' }).waitFor();
    assert.equal(await shortcuts.locator(':scope > .settings-group-body .kb-toolbar').count(), 1);
    assert.equal(await shortcuts.locator(':scope > .settings-group-body').evaluate(node => getComputedStyle(node).borderTopWidth), '1px');
    assert.equal(await shortcuts.locator(':scope > h2').evaluate(node => getComputedStyle(node).borderBottomWidth), '0px');
    await verifySections('shortcuts');

    for (const [name, heading] of [['调度 Agent', '调度提示词'], ['记忆', '记忆子系统'], ['文本工具', '默认模型'], ['关于', '版本']]) {
      await navigate(name);
      await current().getByRole('heading', { name: heading, exact: true }).waitFor();
      await verifySections(name);
    }

    await page.evaluate(() => {
      const original = window.api;
      window.api = new Proxy(original, { get(target, key) {
        if (key === 'feedback') return { ...target.feedback, credentialStatus: async () => ({ configured: false }), snapshot: async () => ({ entries: [] }) };
        if (key === 'localStorage') return { scan: async () => ({ id: 'fixture', partial: false, workspaces: [], items: [
          { id: 'w1', category: 'worktrees', name: '示例任务', paths: ['/worktree'], bytes: 100, partial: false, action: 'worktree' }
        ] }) };
        return Reflect.get(target, key);
      } });
    });
    await navigate('关于');
    await current().getByRole('heading', { name: '反馈' }).waitFor();
    await verifySections('feedback');
    await navigate('本机存储');
    await current().getByRole('button', { name: '开始扫描' }).click();
    await current().getByRole('navigation', { name: '存储类别' }).waitFor();
    const storage = await current().locator('.local-storage').evaluate(node => {
      const heading = node.querySelector('.local-storage-heading'), body = node.querySelector('.local-storage-body');
      const list = node.querySelector('.local-storage-layout'), bar = node.querySelector('.local-storage-bar');
      return { underline: getComputedStyle(heading).borderBottomWidth, border: getComputedStyle(body).borderTopWidth,
        radius: parseFloat(getComputedStyle(body).borderTopLeftRadius), listBorder: getComputedStyle(list).borderTopWidth,
        barHeight: bar.getBoundingClientRect().height, bodyHeight: body.getBoundingClientRect().height,
        detailHeight: node.querySelector('.local-storage-detail').getBoundingClientRect().height };
    });
    assert.equal(storage.underline, '0px'); assert.equal(storage.border, '1px'); assert.ok(storage.radius > 0);
    assert.equal(storage.listBorder, '0px', 'storage contents should not have a duplicate outer frame');
    assert.equal(storage.barHeight, 5); assert.ok(storage.bodyHeight > 100 && storage.detailHeight > 50, 'storage list should retain usable height');
    assert.deepEqual(errors, [], `${width}px: page errors`);
    await page.close();
  }
  console.log('settings-section-frames: ok');
} finally { await browser.close(); releaseLease(); }
