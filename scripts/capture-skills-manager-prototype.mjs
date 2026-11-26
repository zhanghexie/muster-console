/** Real Chromium checks for the source-built design prototype, with local demonstration state. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveSkillsManagerPrototype } from './serve-skills-manager-prototype.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(root, outIndex < 0 ? '.tmp/ui-captures/skills-manager' : process.argv[outIndex + 1]);
const relativeOut = path.relative(root, out);
if (relativeOut === '..' || relativeOut.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOut) || relativeOut.split(path.sep).includes('.metaAgent')) {
  throw new Error('Capture output must be inside this repository, outside .metaAgent.');
}
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const report = {
  mode: 'source-built-interactive-design-prototype',
  realConfigurationAccess: false,
  visualReview: 'pending',
  fontPolicy: 'No external fonts. Production font stack falls back to installed system fonts; OPPO Sans is not verified.',
  startedAt: new Date().toISOString(),
  cases: []
};

async function measure(page) {
  return page.evaluate(() => {
    const target = document.getElementById('skills-manager-mount');
    const element = target?.firstElementChild ?? target;
    if (!element) throw new Error('Prototype root not mounted.');
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].map(dialog => {
      const d = dialog.getBoundingClientRect();
      return { label: dialog.getAttribute('aria-label'), x: d.x, y: d.y, width: d.width, height: d.height, right: d.right, bottom: d.bottom };
    });
    return {
      rootBounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      fontFamily: css.fontFamily, fontSize: css.fontSize,
      scrollX: window.scrollX, scrollY: window.scrollY,
      activeElement: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.trim().slice(0, 80) },
      documentOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      dialogBounds: dialogs,
      dialogOverflowX: dialogs.some(d => d.x < -1 || d.right > window.innerWidth + 1),
      dialogOverflowY: dialogs.some(d => d.y < -1 || d.bottom > window.innerHeight + 1)
    };
  });
}

async function platformFonts(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root: documentRoot } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '#skills-manager-mount' });
    return (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  } finally { await session.detach(); }
}

async function exercise(page, capture, { width, theme }) {
  // Public labels are shared with component tests; all actions use real pointer / keyboard events.
  const scope = page.getByRole('group', { name: '作用范围' });
  const navigation = page.getByRole('navigation', { name: '管理分类' });
  const details = page.getByRole(width < 980 ? 'dialog' : 'complementary', { name: '能力详情', exact: true });
  const closeDetails = async () => {
    if (await details.isVisible()) {
      await details.getByRole('button', { name: '关闭详情' }).click();
      await details.waitFor({ state: 'hidden' });
    }
  };
  await scope.getByRole('button', { name: '当前项目', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme, 'Production theme matches the query.');
  await capture('project-skills');
  await closeDetails();
  await scope.getByRole('button', { name: '全局', exact: true }).click();
  assert.equal(await scope.getByRole('button', { name: '全局', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: '查看 journal', exact: true }).count(), 0, 'Project skill does not appear in the global inventory.');
  await capture('global-skills');
  await scope.getByRole('button', { name: '当前项目', exact: true }).click();
  await page.getByRole('combobox', { name: '选择项目' }).selectOption('playground');
  await page.getByRole('button', { name: '查看 api-smoke', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '查看 journal', exact: true }).count(), 0, 'The inventory follows the chosen project.');
  await page.getByRole('combobox', { name: '选择项目' }).selectOption('workbench');
  await page.getByRole('button', { name: '查看 journal', exact: true }).click();
  if (width < 980) {
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '关闭详情');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '编辑 SKILL.md', 'Shift+Tab wraps to the last control in the details dialog.');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '关闭详情', 'Tab wraps to the first control in the details dialog.');
    await page.keyboard.press('Escape');
    await details.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查看 journal', 'Escape returns keyboard focus to the triggering skill row.');
    await page.getByRole('button', { name: '查看 journal', exact: true }).click();
  }
  await capture('skill-details');
  const cursor = details.getByRole('checkbox', { name: '关联 Cursor', exact: true });
  assert.equal(await cursor.isChecked(), false);
  await cursor.check();
  await details.getByRole('button', { name: '保存关联' }).click();
  assert.equal(await cursor.isChecked(), true);
  assert.equal(await details.getByRole('button', { name: '保存关联' }).isDisabled(), true, 'Saved links are no longer dirty.');
  await details.getByText('待刷新', { exact: true }).first().waitFor();
  await cursor.uncheck();
  await details.getByRole('button', { name: '保存关联' }).click();
  assert.equal(await cursor.isChecked(), false, 'The CLI link can be reversed.');
  await details.getByRole('button', { name: '编辑 SKILL.md' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑技能' });
  const editor = dialog.getByRole('textbox', { name: '技能正文' });
  await editor.waitFor();
  const original = await editor.inputValue();
  await editor.fill(original + '\n\n原型编辑验证。');
  await capture('skill-editor');
  await dialog.getByRole('button', { name: '保存内容' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await details.getByRole('button', { name: '编辑 SKILL.md' }).click();
  assert((await editor.inputValue()).includes('原型编辑验证。'), 'Edited content persists in demonstration state.');
  await editor.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await closeDetails();
  await page.getByRole('button', { name: '试一下', exact: true }).click();
  await page.getByRole('button', { name: /^模拟 CLI 新建技能/ }).click();
  await page.getByRole('button', { name: '查看 release-notes', exact: true }).waitFor();
  assert((await details.locator('.sm-source-path').innerText()).includes('.claude/skills/release-notes'), 'Discovery retains the external source location.');
  const codex = details.getByRole('checkbox', { name: '关联 Codex', exact: true });
  await codex.check();
  await details.getByRole('button', { name: '保存关联' }).click();
  assert.equal(await codex.isChecked(), true, 'The discovered skill can be linked to another CLI.');
  await capture('discovered-client-link');
  await closeDetails();
  await page.getByRole('button', { name: '查看 code-review', exact: true }).click();
  assert.equal(await details.getByRole('checkbox', { name: '关联 Codex', exact: true }).isDisabled(), true, 'Global inherited links are read-only in the project view.');
  await closeDetails();
  await page.getByRole('button', { name: '查看 perf-trace', exact: true }).click();
  await details.getByRole('button', { name: '查看内容差异' }).click();
  const compare = page.getByRole('dialog', { name: '比较同名技能' });
  await compare.waitFor();
  await compare.getByRole('radio', { name: '选用外部副本', exact: true }).check();
  await capture('compare-conflict');
  await compare.getByRole('button', { name: '保存使用偏好' }).click();
  await compare.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '查看 perf-trace', exact: true }).count(), 1, 'Conflict choice preserves the original skill.');
  assert.equal(await page.getByRole('button', { name: '查看 perf-trace 外部副本', exact: true }).count(), 1, 'Conflict choice preserves the other source.');
  assert.equal(await details.getByRole('checkbox', { name: '关联 Claude Code', exact: true }).isChecked(), false, 'A preference does not silently change the other source deployment.');
  await page.getByRole('button', { name: '查看 perf-trace 外部副本', exact: true }).getByText('优先内容', { exact: true }).waitFor();
  assert.equal(await page.getByText('内容不同', { exact: true }).count(), 2, 'Source conflicts remain visible after saving a preference.');
  await closeDetails();
  await navigation.getByRole('button', { name: /^MCP/ }).click();
  await page.getByRole('button', { name: '查看 browser-tools', exact: true }).click();
  const browserClaude = details.getByRole('checkbox', { name: '关联 Claude Code', exact: true });
  await browserClaude.check();
  await details.getByRole('button', { name: '模拟连接测试' }).click();
  await details.getByText('示例握手成功 · 6 个工具可发现', { exact: true }).waitFor();
  assert.equal(await browserClaude.isChecked(), true, 'A connection result preserves the unsaved CLI association draft.');
  assert.equal(await details.getByRole('button', { name: '保存关联' }).isEnabled(), true, 'The pending association can still be saved after a connection test.');
  await browserClaude.uncheck();
  assert.equal(await details.getByRole('button', { name: '保存关联' }).isDisabled(), true, 'Reverting a pending draft restores the saved association state.');
  await closeDetails();
  await page.getByRole('button', { name: '查看 filesystem', exact: true }).click();
  await details.getByRole('button', { name: '模拟连接测试' }).click();
  await details.getByText('示例握手成功 · 6 个工具可发现', { exact: true }).waitFor();
  await capture('mcp-test-result');
  await closeDetails();
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme === 'dark' ? 'light' : 'dark', 'Theme toggle updates production color variables.');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme, 'Theme toggle can return to the original theme.');
}

let browser, server;
await fs.mkdir(out, { recursive: true });
try {
  const preview = await serveSkillsManagerPrototype({ quiet: true });
  server = preview.server;
  const chromeFlag = process.argv.indexOf('--chrome');
  const browserPath = chromeFlag < 0 ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.argv[chromeFlag + 1];
  const chromeExists = await fs.access(browserPath).then(() => true, () => false);
  if (chromeFlag >= 0 && !chromeExists) throw new Error(`Browser not found: ${browserPath}`);
  browser = await chromium.launch({ headless: true, ...(chromeExists ? { executablePath: browserPath } : {}) });
  for (const theme of ['dark', 'light']) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(15000);
    const item = { theme, width, height: 900, status: 'passed', screenshots: [], errors: [], failedRequests: [], externalRequests: [] };
    report.cases.push(item);
    page.on('pageerror', error => item.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') item.errors.push(message.text()); });
    page.on('requestfailed', request => item.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
    page.on('request', request => {
      if (!request.url().startsWith(preview.url) && !request.url().startsWith('data:')) item.externalRequests.push(request.url());
    });
    const capture = async label => {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        if (window.innerWidth < 980) document.querySelector('.sm-detail')?.scrollTo(0, 0);
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await measure(page);
      assert.equal(metrics.documentOverflowX, false, `No horizontal overflow in ${theme}/${width}/${label}.`);
      assert.equal(metrics.dialogOverflowX, false, `Dialog fits horizontally in ${theme}/${width}/${label}.`);
      assert.equal(metrics.dialogOverflowY, false, `Dialog fits vertically in ${theme}/${width}/${label}.`);
      await page.mouse.move(width - 2, 2);
      const file = `${theme}-${width}-${label}.png`;
      await page.screenshot({ path: path.join(out, file), animations: 'disabled', caret: 'hide' });
      item.screenshots.push({ label, file, metrics });
    };
    try {
      await page.goto(`${preview.url}?theme=${theme}`);
      await page.locator('#skills-manager-mount > *').waitFor();
      await exercise(page, capture, { theme, width });
      item.platformFonts = await platformFonts(page);
      assert.equal(item.externalRequests.length, 0, 'Self-contained prototype makes no external requests.');
      assert.equal(item.failedRequests.length, 0, 'Local requests complete successfully.');
    } catch (error) {
      item.errors.push(error.stack ?? String(error));
      const file = `${theme}-${width}-failure.png`;
      await page.screenshot({ path: path.join(out, file), animations: 'disabled', caret: 'hide' }).then(() => { item.failureScreenshot = file; }, () => {});
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
}
report.finishedAt = new Date().toISOString();
report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
const cards = report.cases.flatMap(item => [...item.screenshots, ...(item.failureScreenshot ? [{ file: item.failureScreenshot, label: 'failure' }] : [])].map(shot =>
  `<article><h2>${escapeHtml(`${item.theme} / ${item.width}px / ${shot.label}`)}</h2><p>${escapeHtml(item.status)}</p><a href="${escapeHtml(shot.file)}"><img src="${escapeHtml(shot.file)}" loading="lazy" alt="${escapeHtml(shot.label)}"></a></article>`)).join('\n');
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Skills / MCP prototype QA</title><style>body{font:14px system-ui;margin:24px}article{display:inline-block;vertical-align:top;width:380px;padding:12px;margin:8px;border:1px solid #ccc}img{width:100%}h2{font-size:16px}</style><h1>原型截图 · 视觉检查待完成</h1><p>真实 Chromium；演示数据；系统字体回退。<a href="manifest.json">诊断清单</a></p>${cards}</html>`);
const failed = !!report.setupError || report.cases.some(item => item.status === 'failed');
console.log(`${failed ? 'FAILED' : 'Behavior checks passed'}; visual review pending: ${out}`);
for (const item of report.cases) console.log(`${item.theme}/${item.width}: ${item.status}; ${item.screenshots.length} screenshots; ${item.errors.length} errors.`);
if (report.setupError) console.error(report.setupError);
for (const item of report.cases.filter(item => item.errors.length)) console.error(`${item.theme}/${item.width}: ${item.errors.join('\n')}`);
if (failed) process.exitCode = 1;
