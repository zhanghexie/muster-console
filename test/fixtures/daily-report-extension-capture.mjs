// Render the actual extension panel with production theme variables and a deterministic host.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createSharedCompiler } from '../helpers/shared-compile.mjs';

const out = path.resolve('.tmp/daily-report-extension-capture'); fs.mkdirSync(out, { recursive: true });
const compile = createSharedCompiler(process.cwd(), path.join(out, 'compiled'));
const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')));
const { builtinTheme } = await import(pathToFileURL(compile('shared/theme.ts')));
const source = fs.readFileSync('resources/extensions/daily-report/ui/panel.html', 'utf8');
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const html = source.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const css = fs.readFileSync('src/main/extensions/sdk/theme.css', 'utf8').replace(/@font-face\s*\{[^}]*\}/g, '');
const panelCss = fs.readFileSync('resources/extensions/daily-report/ui/panel.css', 'utf8');
const browser = await chromium.launch({ channel: process.env.MEMORY_CAPTURE_BROWSER || 'msedge', headless: true });
try {
  for (const [theme, width, locale] of [['dark', 1200, 'zh-CN'], ['light', 1200, 'zh-CN'], ['dark', 390, 'zh-CN'], ['light', 390, 'zh-CN'], ['dark', 1000, 'en'], ['light', 1000, 'en'], ['dark', 640, 'en']]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(html); await page.addStyleTag({ content: css + '\n' + panelCss });
    await page.evaluate(language => { document.documentElement.lang = language; }, locale);
    await page.evaluate(vars => { for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value); }, resolveAppearance(builtinTheme(theme)).cssVars);
    await page.evaluate(() => {
      const now = new Date(), day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const files = new Map([['todos.json', JSON.stringify({ todos: [
        { id: 'design', text: '完善扩展教学示例，让每一次打开都有清晰、舒适的使用体验', body: '补齐深浅主题与窄面板验证', createDate: day, createdAt: 1 },
        { id: 'read', text: '整理阅读器的交互与验收记录', body: '目录、书签与阅读进度', createDate: day, doingDate: day, createdAt: 2 },
        { id: 'done', text: '完成魔方拖动和材质调整', createDate: day, doneDate: day, createdAt: 3 }
      ] })]]);
      window.ma = { ready: Promise.resolve({ workspaceId: 'fixture' }), journal: { list: async () => ({ dates: [day] }), read: async () => ({ content: '<!-- muster-journal:fixture:1 -->\n## [扩展教学示例] 已完成\n- 问题：示例界面需要更清晰的视觉层次\n- 要点：代码可在所有工作区使用，数据按工作区隔离\n<!-- /muster-journal:fixture -->\n## [日报阅读体验] 进行中\n- 进展：整理日历、待办和日报正文，完成深浅主题适配\n- 备注：保留原有派活与工作区数据流程' }) },
        data: { read: async name => files.has(name) ? { content: files.get(name) } : null, write: async (name, text) => { files.set(name, text); }, list: async () => [] }, llm: { chat: async () => ({ text: '# 今日工作日报\n\n围绕扩展教学示例完成体验优化，让工作记录更易浏览、后续行动更明确。\n\n## 已完成\n- **扩展教学示例**：统一界面层次，保持工作区数据隔离。\n\n## 进行中\n- **日报阅读体验**：完善日历、待办与报告正文的布局。' }) }, notify: async () => {}, storage: { set: async () => {} }, commands: { execute: async () => [] } };
    });
    await page.addScriptTag({ content: script }); await page.locator('.entry').first().waitFor();
    assert.equal(await page.locator('.eyebrow').count(), 0, 'daily report has no decorative subtitle');
    assert.equal(await page.locator('.todo-caption').count(), 0, 'to-do editor has no secondary caption');
    assert.equal(await page.locator('#todoBody').evaluate(el => getComputedStyle(el).resize), 'none', 'to-do details cannot be resized');
    assert.equal(await page.locator('[data-stat="open-todos"] .stat-value').innerText(), '2');
    const firstGroup = page.locator('[data-g="todo"]');
    const sidebarWidth = await page.locator('.cal-pane').evaluate(el => el.getBoundingClientRect().width);
    await firstGroup.focus(); await page.keyboard.press('Enter');
    assert.equal(await firstGroup.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Enter');
    assert.equal(await firstGroup.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.cal-pane').evaluate(el => el.getBoundingClientRect().width), sidebarWidth, 'group expansion never changes sidebar width');
    await firstGroup.blur();
    await page.locator('.layout').evaluate(el => { el.scrollTop = 0; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow');
    assert.equal(await page.locator('.todo-item.todo .t-title').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'long to-do title wraps');
    if (width <= 720) {
      const calendar = await page.locator('.calendar-section').boundingBox(), detail = await page.locator('#detail').boundingBox(), todos = await page.locator('.todo-box').boundingBox();
      assert.ok(calendar.y + calendar.height <= detail.y + 1 && detail.y + detail.height <= todos.y + 1, 'narrow layout keeps the journal before the to-do editor');
    }
    assert.ok(!(await page.locator('#detail').innerText()).includes('muster-journal'));
    if (locale === 'en') {
      assert.match(await page.locator('.hd-title').innerText(), /Daily report/);
      assert.match(await page.locator('#detail').innerText(), /Completed/);
      assert.match(await page.locator('#detail').innerText(), /代码可在所有工作区使用/);
      assert.equal(await page.locator('#calToday').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Today label fits its button');
      const month = await page.locator('.cal-title').boundingBox(), previous = await page.locator('#calPrev').boundingBox();
      assert.ok(month.x + month.width <= previous.x, 'month title does not overlap calendar navigation');
      await page.locator('#todoText').fill('Unsaved draft');
      await page.evaluate(() => { document.documentElement.lang = 'zh-CN'; });
      await page.waitForFunction(() => document.querySelector('.hd-title')?.textContent?.includes('工作日报'));
      assert.equal(await page.locator('#todoText').inputValue(), 'Unsaved draft');
      await page.evaluate(() => { document.documentElement.lang = 'en'; });
      await page.waitForFunction(() => document.querySelector('.hd-title')?.textContent?.includes('Daily report'));
    }
    await page.locator('#todoText').blur();
    await page.locator('.layout').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(out, `${theme}-${width}-${locale}.png`) });
    if (width === 1200) {
      await page.locator('#genBtn').click(); await page.locator('.report').waitFor();
      await page.locator('.report').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `${theme}-report.png`) });
    }
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('daily-report extension browser captures passed:', out);
} finally { await browser.close(); }

