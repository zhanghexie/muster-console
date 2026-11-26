import { test as base, expect, _electron } from '@playwright/test';
import type { AppContext } from './fixtures/electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 使用独立配置，不重置共享开发沙盒，也不继承个人配置。
const repoRoot = path.resolve(__dirname, '../..');
const test = base.extend<{}, { appCtx: AppContext }>({
  appCtx: [async ({}, use) => {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    const cwd = fs.mkdtempSync(path.join(repoRoot, '.tmp/e2e-composer-'));
    const userData = path.join(cwd, '.dev-sandbox/userData');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      locale: 'zh-CN', themeId: 'dark', uiFont: 'oppo', activeWorkspaceId: 'demo-playground',
      workspaces: [], mcp: { enabled: false, servers: [] }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.MUSTER_SANDBOX = '1';
    env.MUSTER_INSTANCE_ID = path.basename(cwd);
    for (const key of ['MUSTER_NO_SANDBOX', 'MUSTER_DEV_MOBILE_WS', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
    const app = await _electron.launch({ executablePath: createRequire(__filename)('electron'), args: [repoRoot], cwd, env, timeout: 60_000 });
    try {
      const win = await app.firstWindow();
      const consoleErrors: string[] = [];
      win.on('pageerror', e => consoleErrors.push(e.message));
      await win.waitForSelector('.app-shell', { timeout: 60_000 });
      await use({ app, win, consoleErrors });
    } finally {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
  }, { scope: 'worker' }]
});


// 独立目录承载设置/短语/待发送消息；不启动 LLM 或继承个人连接。
test('紧凑输入区：按钮相邻、首字稳定、队列和短语在深浅及窄面板不溢出', async ({ appCtx }, testInfo) => {
  const { app, win: page } = appCtx;
  await page.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
  const shell = page.locator('.agent-float-panel .chat-input-shell');
  await expect(shell).toBeVisible();
  const editor = shell.locator('.composer-editable');
  const hold = shell.getByRole('button', { name: '留待确认', exact: true });
  const send = shell.getByRole('button', { name: '发送', exact: true });
  const settleMotion = () => shell.evaluate(async el => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const measure = () => shell.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hold = el.querySelector('[aria-label="留待确认"]')!.getBoundingClientRect();
    const send = el.querySelector('[aria-label="发送"]')!.getBoundingClientRect();
    return { h: r.height, hold: { x: hold.x, y: hold.y, w: hold.width, h: hold.height },
      send: { x: send.x, y: send.y, w: send.width, h: send.height } };
  });
  // 面板 mp-pop 的缩放入场完成后才量静态边界。
  await expect.poll(async () => (await measure()).hold.w).toBeCloseTo(24, 3);
  const empty = await measure();
  expect(empty.hold.w).toBeCloseTo(24, 1); expect(empty.send.w).toBeCloseTo(30, 1);
  expect(empty.send.x - empty.hold.x - empty.hold.w).toBeCloseTo(5);
  expect(empty.send.y + 15).toBeCloseTo(empty.hold.y + 12);
  await expect(hold).toBeDisabled();
  await editor.fill('检查字体和间距');
  await expect(hold).toBeEnabled();
  expect((await measure()).h).toBeCloseTo(empty.h);
  await editor.fill('');
  expect((await measure()).h).toBeCloseTo(empty.h);
  await editor.fill('请确认后再处理这条消息'); await hold.click();
  await expect(shell.locator('.agent-composer-qslane-head.is-manual').getByText(/手动确认发送/)).toBeVisible();
  await expect(shell.getByText('不会自动发送', { exact: true })).toHaveCount(0);
  const wsId = await page.evaluate(async () => (await window.api.config.get()).activeWorkspaceId);
  await app.evaluate(({ BrowserWindow }, workspaceId) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:history', { workspaceId, messages: [{
      id: 'study-question', role: 'assistant', content: '请确认这版界面的阅读效果。', createdAt: Date.now(),
      parts: [{ kind: 'text', text: '请确认这版界面的阅读效果。' }],
      userQuestion: { questionId: 'study-qa', status: 'pending', questions: [{ id: 'style',
        question: '输入区与辅助卡片是否保持同一套材质？', options: [
          { label: '保持统一', description: '沿用纯色与中性选中，减少多余轮廓。' },
          { label: '继续调整', description: '再调整字号或间距。' }
        ] }] }
    }] });
  }, wsId);
  await expect(page.locator('.ac-uq')).toBeVisible();
  await page.locator('.ac-uq-option').first().click();
  await expect(page.locator('.ac-uq-option').first()).toHaveAttribute('aria-pressed', 'true');
  for (const themeId of ['dark', 'light']) {
    await page.evaluate(themeId => window.api.themes.activate(themeId), themeId);
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(themeId);
    await editor.fill('检查后再发送');
    await settleMotion();
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-composer.png`) });
    await editor.fill('/quickInput'); await editor.press('Enter');
    const phrases = page.getByRole('dialog', { name: '快捷短语' });
    await expect(phrases).toBeVisible(); await expect(hold).toBeDisabled(); await expect(send).toBeDisabled();
    await phrases.getByRole('button', { name: '新增短语' }).click();
    await phrases.getByPlaceholder('名称（如：地址）').fill(`确认-${themeId}`);
    await phrases.getByPlaceholder('内容（点选该短语时插入输入框的文本）').fill('按确认后的方案继续处理。');
    await phrases.getByRole('button', { name: '保存', exact: true }).click();
    await settleMotion();
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-phrases.png`) });
    await editor.focus();
    await expect(editor).toBeFocused();
    await editor.press('Escape');
    await expect(phrases).toBeHidden();
    await shell.getByRole('button', { name: '收起排队面板' }).click();
    await expect(shell.getByRole('button', { name: '展开排队面板' })).toBeVisible();
    await expect(shell.locator('.agent-composer-qspanel')).toHaveCount(0);
    await settleMotion();
    await page.locator('.agent-float-panel').evaluate(el => { (el as HTMLElement).style.width = '320px'; });
    const bounds = await shell.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, overflowing: [...el.querySelectorAll('.agent-composer-toolbar button')]
        .filter(b => getComputedStyle(b).display !== 'none').filter(b => { const v = b.getBoundingClientRect(); return v.width && (v.left < r.left || v.right > r.right); }).map(b => b.className) };
    });
    expect(bounds.overflowing).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-narrow-collapsed.png`) });
    await page.locator('.agent-float-panel').evaluate(el => { (el as HTMLElement).style.width = ''; });
    await shell.getByRole('button', { name: '展开排队面板' }).click();
    await expect(shell.locator('.agent-composer-qscapsule')).toHaveCount(0);
    await settleMotion();
  }
  expect(appCtx.consoleErrors).toEqual([]);
});

test('底部划词批注：不重复原文、拉高编辑框后保存仍可点击', async ({ appCtx }, testInfo) => {
  const { app, win: page } = appCtx;
  if (!(await page.locator('.agent-float-panel').count())) {
    await page.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
  const wsId = await page.evaluate(async () => (await window.api.config.get()).activeWorkspaceId);
  for (const themeId of ['light', 'dark']) {
    await page.evaluate(themeId => window.api.themes.activate(themeId), themeId);
    await app.evaluate(({ BrowserWindow }, { wsId, themeId }) => {
      const text = ('上一段用于提供阅读上下文。\n\n').repeat(8) + '这是已划线的原文，面板不需要再重复显示。';
      BrowserWindow.getAllWindows()[0].webContents.send('agent:history', { workspaceId: wsId, messages: [{
        id: 'note-bottom-' + themeId, role: 'assistant', content: text, createdAt: Date.now(),
        parts: [{ kind: 'text', text }]
      }] });
    }, { wsId, themeId });
    const selected = page.locator('.agent-float-panel [data-mid] p').filter({ hasText: '这是已划线的原文' });
    await expect(selected).toBeVisible();
    await selected.evaluate(el => {
      el.scrollIntoView({ block: 'center' });
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 30, clientY: r.top + 8 }));
    });
    await page.getByRole('button', { name: '批注', exact: true }).click();
    const card = page.locator('[data-note-pending]');
    await expect(card).toBeVisible();
    await expect(card.getByText('这是已划线的原文，面板不需要再重复显示。')).toHaveCount(0);
    const input = card.getByRole('textbox');
    await input.fill(`确认可点-${themeId}`);
    await input.evaluate(el => { (el as HTMLElement).style.height = '200px'; });
    const save = card.getByRole('button', { name: '保存', exact: true });
    await expect.poll(() => save.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 8 && r.bottom <= innerHeight - 8 && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    })).toBe(true);
    await card.evaluate(async el => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: testInfo.outputPath(`${themeId}-bottom-note.png`) });
    await save.click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.agent-float-panel .composer-token-label').filter({ hasText: `确认可点-${themeId}` })).toBeVisible();
  }
  expect(appCtx.consoleErrors).toEqual([]);
});
