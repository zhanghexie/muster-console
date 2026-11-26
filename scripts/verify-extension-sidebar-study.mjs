// Real Chromium verification for the isolated folder prototype. Does not open the app or real user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { acquireTestLease } from '../test/helpers/lease.mjs';
import { armProcessDeadline } from '../test/helpers/execute.mjs';
import { testDeadline } from '../test/helpers/resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layoutOnly = process.argv.includes('--layout-only');
const out = path.join(root, `.tmp/ui-captures/extension-sidebar-${layoutOnly ? 'layout' : 'study'}`);
const release = acquireTestLease(root);
const disarm = armProcessDeadline(testDeadline(55_000), 'extension sidebar Chromium verification');
const allowFallback = process.argv.includes('--allow-fallback-font');
const report = { mode: 'isolated-prototype-real-chromium', startedAt: new Date().toISOString(), visualReview: 'pending', assertions: [], screenshots: [], fonts: [], errors: [], warnings: [] };
fs.mkdirSync(out, { recursive: true });
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(root, 'docs/prototypes/extension-sidebar-study/extension-sidebar-study.html')));
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  // Playwright hides scrollbars by default in headless mode, masking overflow-induced width changes.
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const isFont = /\.(woff2?|ttf|otf)(?:\?|$)/i.test(message.location().url);
    (isFont ? report.warnings : report.errors).push(`${message.text()} ${message.location().url}`);
  });
  page.on('requestfailed', request => report.warnings.push(`${request.failure()?.errorText} ${request.url()}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  const row = name => page.getByRole('treeitem', { name, exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  const checked = label => report.assertions.push(label);
  async function attribute(locator, name, expected) {
    await page.waitForFunction(({ id, name, expected }) => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute(name) === expected,
      { id: await locator.getAttribute('data-node-id'), name, expected });
  }
  async function capture(label) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = await page.evaluate(() => ({
      width: innerWidth, height: innerHeight,
      documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      treeOverflowX: !!document.querySelector('.ext-nav-tree') && document.querySelector('.ext-nav-tree').scrollWidth > document.querySelector('.ext-nav-tree').clientWidth + 1,
      font: getComputedStyle(document.querySelector('.utility-navigation')).fontFamily,
      overlays: [...document.querySelectorAll('[role="dialog"], [role="menu"]')].map(element => {
        const rect = element.getBoundingClientRect();
        return { role: element.getAttribute('role'), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      })
    }));
    assert.equal(metrics.documentOverflowX, false, `${label}: document overflows`);
    assert.equal(metrics.treeOverflowX, false, `${label}: navigation overflows`);
    for (const overlay of metrics.overlays) {
      assert.ok(overlay.left >= 0 && overlay.right <= metrics.width + 1 && overlay.top >= 0 && overlay.bottom <= metrics.height + 1,
        `${label}: ${overlay.role} is clipped by viewport: ${JSON.stringify(overlay)}`);
    }
    const file = `${label}.png`;
    await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
    report.screenshots.push({ file, ...metrics });
  }
  async function drag(source, target, placement, screenshot) {
    await source.scrollIntoViewIfNeeded();
    const from = await source.boundingBox();
    await page.mouse.move(from.x + 80, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 88, from.y + from.height / 2 + 3);
    await target.scrollIntoViewIfNeeded();
    const to = await target.boundingBox();
    const y = to.y + (placement === 'before' ? 2 : placement === 'after' ? to.height - 2 : to.height / 2);
    await page.mouse.move(to.x + 100, y, { steps: 12 });
    await page.mouse.move(to.x + 101, y);
    await attribute(target, 'data-drop', placement);
    if (screenshot) await capture(screenshot);
    await page.mouse.up();
  }
  await button('展开更多工具').waitFor();
  assert.equal(await page.getByRole('tree').count(), 0, 'library starts fully collapsed');
  assert.equal(await page.getByText('常用', { exact: true }).count(), 0, 'no redundant favorites heading');
  assert.equal(await page.locator('.utility-favorites-grid > :last-child').getAttribute('aria-label'), '展开更多工具');
  await page.waitForFunction(() => [...document.fonts].filter(font => font.family === 'OPPO Sans' && ['400', '500'].includes(font.weight)).every(font => font.status === 'loaded'), null, { timeout: 8000 }).catch(() => {});
  report.fonts = await page.evaluate(() => [...document.fonts].map(font => ({ family: font.family, weight: font.weight, status: font.status })));
  const settleLibrary = () => page.waitForFunction(() => !document.querySelector('.utility-navigation-library').getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
  const utilityGeometry = () => page.evaluate(() => ({
    anchors: [...document.querySelectorAll('.utility-feature-list, .utility-feature-list > *')].map(element => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
    libraryHeight: document.querySelector('.utility-navigation-library').getBoundingClientRect().height,
    sessionTop: document.querySelector('.ext-study-sessions').getBoundingClientRect().top
  }));

  // Cross the scrollbar threshold using actual folder clicks. jsdom cannot detect this layout shift.
  for (const viewport of [{ width: 832, height: 884 }, { width: 1440, height: 900 }, { width: 390, height: 1360 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 1440) await button('深色').click();
    if (viewport.width === 390) await button('浅色').click();
    await capture(`library-${viewport.width}-collapsed`);
    const compact = await utilityGeometry();
    assert.equal(compact.libraryHeight, 0, 'folding leaves no list, divider or action-row gap');
    await button('展开更多工具').press('Enter');
    await row('创作工具').waitFor();
    await settleLibrary();
    assert.equal(await page.getByText('网页与扩展', { exact: true }).count(), 0, 'no redundant library heading');
    await capture(`library-${viewport.width}-expanded`);
    const full = await utilityGeometry();
    assert.deepEqual(full.anchors, compact.anchors, `${viewport.width}: library disclosure changes grid geometry`);
    assert.ok(full.libraryHeight > 300, 'expanded list contains the folder tree');
    if (viewport.width > 600) assert.ok(full.sessionTop - compact.sessionTop > 300, 'collapsing frees space above the session list');
    await button('收起更多工具').press('Space');
    await page.locator('.ext-nav-tree').waitFor({ state: 'detached' });
    await settleLibrary();
    assert.deepEqual(await utilityGeometry(), compact, 'collapse returns the whole grid and session list to their original positions');
    assert.equal(await page.getByRole('button', { name: '固定网页', exact: true }).count(), 0, 'creation actions fold with the list');
    await button('展开更多工具').click();
    await row('创作工具').waitFor();
    await settleLibrary();
    checked(`${viewport.width}px: keyboard disclosure fully hides the library and frees session space without shifting the grid`);
    const geometry = () => page.evaluate(() => {
      const scroller = document.querySelector('.ext-study-nav-scroll');
      const selectors = ['.ext-study-workspace', '.ext-study-sidebar-footer', '.utility-feature-list',
        '.utility-feature-list > *', '.ext-nav-tree', '[data-node-id="studio"]'];
      return {
        overflow: scroller.scrollHeight > scroller.clientHeight,
        clientWidth: scroller.clientWidth,
        scrollbarWidth: scroller.offsetWidth - scroller.clientWidth,
        scrollTop: scroller.scrollTop,
        anchors: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
          const rect = element.getBoundingClientRect();
          return { selector, x: rect.x, y: rect.y, width: rect.width, ...(selector !== '.ext-nav-tree' ? { height: rect.height } : {}) };
        }))
      };
    });
    await row('创作工具').click();
    await attribute(row('创作工具'), 'aria-expanded', 'false');
    const collapsed = await geometry();
    await row('创作工具').click();
    await attribute(row('创作工具'), 'aria-expanded', 'true');
    const expanded = await geometry();
    report.layout ??= [];
    report.layout.push({ viewport, collapsed, expanded });
    assert.equal(collapsed.overflow, false, `${viewport.width}: collapsed fixture should fit`);
    assert.equal(expanded.overflow, true, `${viewport.width}: expansion must trigger scrolling`);
    assert.ok(expanded.scrollbarWidth > 0, `${viewport.width}: fixture must retain classic scrollbar width`);
    assert.equal(expanded.clientWidth, collapsed.clientWidth, `${viewport.width}: expansion changes sidebar content width`);
    assert.equal(expanded.scrollTop, collapsed.scrollTop, `${viewport.width}: expansion scrolls the whole utility section`);
    assert.deepEqual(expanded.anchors, collapsed.anchors, `${viewport.width}: expansion shifts grid or tree margins`);
    await row('创作工具').click();
    await attribute(row('创作工具'), 'aria-expanded', 'false');
    assert.deepEqual(await geometry(), collapsed, `${viewport.width}: collapse must restore the same geometry`);
    await row('创作工具').click();
    checked(`${viewport.width}px: folder expand/collapse crosses scrollbar threshold without shifting utility grid or list margins`);
    await button('收起更多工具').click();
    await page.locator('.ext-nav-tree').waitFor({ state: 'detached' });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await button('展开更多工具').waitFor();
  await button('项目文档的常用操作').click();
  await page.getByRole('menuitem', { name: '在列表中显示', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await settleLibrary();
  await attribute(row('项目文档'), 'aria-selected', 'true');
  assert.equal(await page.locator('.utility-navigation-library .acc-body').evaluate(element => element.scrollTop), 0, 'revealing a favorite must not scroll the clipped animation wrapper');
  checked('collapsed preference survives reload; explicit reveal expands the library and locates the entry');

  if (!layoutOnly) {
  await button('恢复示例').click();
  await capture('light-1440-initial');

  const common = page.getByRole('group', { name: '常用工具' });
  await row('工作笔记').hover();
  await button('工作笔记的更多操作').click();
  await capture('light-1440-add-favorite-menu');
  await page.getByRole('menuitem', { name: '添加到常用', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await common.getByRole('button', { name: '工作笔记', exact: true }).click();
  await attribute(row('工作笔记'), 'aria-selected', 'true');
  await attribute(row('工作笔记'), 'data-parent-id', 'daily');
  assert.equal(await common.getByRole('button', { name: '工作笔记', exact: true }).count(), 1);
  await capture('light-1440-favorite-added');
  checked('list more menu adds one shared shortcut to the existing utility grid without moving the entry');
  await button('工作笔记的常用操作').click();
  await capture('light-1440-remove-favorite-menu');
  await page.getByRole('menuitem', { name: '从常用移除', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await common.getByRole('button', { name: '工作笔记', exact: true }).count(), 0);
  await attribute(row('工作笔记'), 'data-parent-id', 'daily');
  await button('撤销').click();
  await common.getByRole('button', { name: '工作笔记', exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await common.getByRole('button', { name: '工作笔记', exact: true }).waitFor();
  checked('upper menu removes only the shortcut; undo and reload retain favorite state');
  await button('恢复示例').click();

  await drag(row('日常工具'), row('创作工具'), 'before', 'light-1440-drag-reorder');
  assert.deepEqual(await page.locator('[role="treeitem"][data-parent-id=""]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))), ['日常工具', '创作工具', '参考图库']);
  await attribute(row('项目文档'), 'data-parent-id', 'research');
  checked('native mouse drag reorders folders and retains descendants');

  await drag(row('参考图库'), row('灵感参考'), 'inside', 'light-1440-drag-inside');
  await attribute(row('参考图库'), 'data-parent-id', 'research');
  checked('native mouse drag moves a webpage into a nested folder');
  await row('参考图库').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动到…', exact: true }).click();
  await capture('light-1440-move-menu');
  await page.getByRole('menuitem', { name: '最外层', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await attribute(row('参考图库'), 'data-parent-id', '');
  checked('context menu moves a nested entry to the root');

  await row('创作工具').click();
  await attribute(row('创作工具'), 'aria-expanded', 'false');
  await drag(row('参考图库'), row('创作工具'), 'inside');
  await attribute(row('创作工具'), 'aria-expanded', 'true');
  await attribute(row('参考图库'), 'data-parent-id', 'studio');
  checked('dragging into a collapsed folder expands it and keeps the dropped entry visible');

  await button('新建文件夹').click();
  await page.getByLabel('名称', { exact: true }).fill('交付与参考');
  await capture('light-1440-create-dialog');
  await button('添加').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await row('交付与参考').press('F2');
  await page.getByLabel('名称', { exact: true }).fill('本周项目');
  await button('保存').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await drag(row('创作工具'), row('本周项目'), 'inside');
  await attribute(row('创作工具'), 'data-parent-id', await row('本周项目').getAttribute('data-node-id'));
  await attribute(row('项目文档'), 'data-parent-id', 'research');
  checked('creating, F2 renaming, and nesting a folder preserve its full subtree');
  await row('本周项目').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '解散文件夹，保留内容', exact: true }).click();
  await attribute(row('创作工具'), 'data-parent-id', '');
  await button('撤销').click();
  await row('本周项目').waitFor();
  checked('dissolving a folder promotes entries and undo restores the hierarchy');

  await button('固定网页').click();
  await page.getByLabel('名称', { exact: true }).fill('本地工作面板');
  await page.getByLabel('网址', { exact: true }).fill('localhost:8188');
  await button('添加').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('.ext-study-address').textContent(), /http:\/\/localhost:8188\//);
  await row('工作笔记').click();
  await page.getByRole('textbox', { name: '工作笔记' }).fill('切换后保留的草稿');
  await row('任务队列').click();
  await row('工作笔记').click();
  assert.equal(await page.getByRole('textbox', { name: '工作笔记' }).inputValue(), '切换后保留的草稿');
  checked('web pin input normalizes localhost; note draft survives view changes');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await row('本周项目').waitFor();
  await row('本地工作面板').waitFor();
  await attribute(row('创作工具'), 'data-parent-id', await row('本周项目').getAttribute('data-node-id'));
  checked('navigation titles, order, and hierarchy survive page reload');

  await button('恢复示例').click();
  await button('深色').click();
  await capture('dark-1440-initial');
  await page.setViewportSize({ width: 780, height: 900 });
  await capture('dark-780-narrow');
  await button('浅色').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('light-390-narrow');
  await button('新建文件夹').click();
  await capture('light-390-dialog');
  await page.getByLabel('名称', { exact: true }).press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checked('two utility sections, light/dark themes and 1440/780/390px layouts remain within viewport');
  }

  const fontReady = report.fonts.some(font => font.family === 'OPPO Sans' && font.weight === '400' && font.status === 'loaded')
    && report.fonts.some(font => font.family === 'OPPO Sans' && font.weight === '500' && font.status === 'loaded');
  report.fontStatus = fontReady ? 'OPPO 400/500 loaded' : 'fallback; OPPO readability not verified';
  if (!fontReady && !allowFallback) throw new Error('OPPO Sans did not load; inspect the report or rerun with --allow-fallback-font for behavior/layout verification only.');
  assert.deepEqual(report.errors, [], 'browser errors');
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, assertions: report.assertions.length, screenshots: report.screenshots.length, fontStatus: report.fontStatus, out }, null, 2));
} catch (error) {
  report.status = 'failed'; report.failure = String(error.stack ?? error);
  console.error(report.failure); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  disarm(); release();
}
