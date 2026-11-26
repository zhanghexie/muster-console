import { test, expect } from './fixtures/electron';
import { hasExtensionTestCenter, installCenterExtension } from './fixtures/centerExtension';
import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

test.skip(!hasExtensionTestCenter, 'Requires an explicit extension center fixture or GitHub credential');

test('imports a real EPUB through the host and restores its paragraph after returning to the shelf', async ({ appCtx }) => {
  const { win, app } = appCtx;
  await installCenterExtension(win, 'library');
  const directory = path.resolve('.tmp/ui-captures/teaching-extensions');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'electron-reader-test.epub');
  const bookTitle = '阅读器验收样书 ' + Date.now();
  const paragraphs = '<p>' + bookTitle + '</p>' + Array.from({ length: 70 }, (_, i) => '<p>' + (i + 1) + '．清晨的光落在书页上。阅读不必匆忙，给每一个念头留一点安静的时间。读到有意思的地方，可以留下书签，再从同一段落继续。</p>').join('');
  const sources = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    'OPS/book.opf': '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>' + bookTitle + '</dc:title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    'OPS/one.xhtml': '<html><body><h1>第一章 阅读的开始</h1>' + paragraphs + '</body></html>',
    'OPS/two.xhtml': '<html><body><h1>第二章 继续出发</h1><p>这里是第二章。章节顺序由 EPUB 的 spine 决定。</p></body></html>',
  };
  await fs.writeFile(file, zipSync(Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, strToU8(text)]))));
  // Mock only the operating system's selection; import, MediaStore, HTTP serving,
  // EPUB parsing, worker persistence and SDK routing remain real.
  await app.evaluate(({ dialog }, selected) => {
    (globalThis as any).__libraryOriginalPicker = dialog.showOpenDialog;
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, file);
  try {
    const expand = win.getByRole('button', { name: '展开更多工具' });
    if (await expand.isVisible().catch(() => false)) await expand.click();
    await win.locator('[role="treeitem"][aria-label="图书馆"]').click();
    const trust = win.getByRole('button', { name: '信任开发目录' });
    if (await trust.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) await trust.click();
    const frame = win.frameLocator('iframe[aria-label="扩展面板 图书馆"]');
    await frame.getByRole('button', { name: /导入书籍/ }).waitFor({ timeout: 20000 });
    const closeAI = win.getByRole('button', { name: '关闭 AI', exact: true });
    if (await closeAI.isVisible().catch(() => false)) await closeAI.click();
    await frame.getByRole('button', { name: /导入书籍/ }).click();
    await frame.getByRole('button', { name: '阅读《' + bookTitle + '》' }).waitFor({ timeout: 15000 });
    await frame.getByRole('button', { name: '阅读《' + bookTitle + '》' }).click();
    await frame.getByRole('heading', { name: '第一章 阅读的开始' }).waitFor({ timeout: 10000 }).catch(async error => {
      console.log('Reader failure:', (await frame.locator('.library-app').innerText()).slice(0, 1600));
      await win.screenshot({ path: path.join(directory, 'electron-reader-failed.png') }); throw error;
    });
    const body = frame.getByLabel('阅读正文');
    await body.hover(); await win.mouse.wheel(0, 1000);
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(800);
    const paragraph = () => body.evaluate(element => {
      const top = element.getBoundingClientRect().top + 26;
      return Number([...element.querySelectorAll('[data-paragraph]')].find(p => p.getBoundingClientRect().bottom > top)?.getAttribute('data-paragraph'));
    });
    const before = await paragraph();
    await frame.getByRole('button', { name: '添加当前位置书签' }).click();
    await frame.getByRole('button', { name: '书架', exact: true }).click();
    await frame.getByRole('button', { name: '继续阅读' }).click();
    await frame.getByRole('heading', { name: '第一章 阅读的开始' }).waitFor();
    await expect.poll(paragraph).toBeGreaterThanOrEqual(before - 1);
    expect(await paragraph()).toBeLessThanOrEqual(before + 1);
    await expect.poll(() => frame.locator('#reader').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await win.screenshot({ path: path.join(directory, 'electron-reader.png') });
    await frame.getByRole('button', { name: '查看书签' }).click();
    await expect(frame.getByRole('dialog', { name: '我的书签' })).toContainText('第一章 阅读的开始');
    await expect.poll(() => frame.getByRole('dialog', { name: '我的书签' }).evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await win.screenshot({ path: path.join(directory, 'electron-bookmarks.png') });
    await frame.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(frame.getByRole('dialog')).toHaveCount(0);
    await frame.getByRole('button', { name: '下一章', exact: true }).last().click();
    await frame.getByRole('heading', { name: '第二章 继续出发' }).waitFor();
    await frame.getByRole('button', { name: '书架', exact: true }).click();
    await frame.getByRole('button', { name: '继续阅读' }).click();
    await frame.getByRole('heading', { name: '第二章 继续出发' }).waitFor();
    expect(appCtx.consoleErrors).toEqual([]);
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = (globalThis as any).__libraryOriginalPicker; delete (globalThis as any).__libraryOriginalPicker; });
  }
});
