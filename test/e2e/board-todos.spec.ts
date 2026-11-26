import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('TODO 通过真 IPC 保存，重启恢复，状态列与自由画布双击编辑，不生成会话', async ({}, testInfo) => {
  test.setTimeout(100_000);
  const repo = path.resolve(__dirname, '../..');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'board-todos-e2e-'));
  const workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(workspace); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'light', uiFont: 'system', activeWorkspaceId: 'todo-test', defaultCwd: workspace,
    workspaces: [{ id: 'todo-test', name: 'TODO 测试', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd) } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  const consoleErrors: string[] = [];
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [repo, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    const win = await app.firstWindow();
    win.on('pageerror', error => consoleErrors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
    return win;
  };
  const stop = async () => {
    await app?.evaluate(({ app }) => app.exit()).catch(() => {});
    await app?.close().catch(() => {}); app = undefined;
  };
  const capture = async (name: string) => {
    const win = (await app!.windows())[0];
    await win.evaluate(async () => {
      await document.fonts.ready;
      // Wait for finite transitions; decorative loops keep running.
      for (let pass = 0; pass < 3; pass++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map(animation => animation.finished.catch(() => {})));
      }
    });
    await win.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' });
    fs.writeFileSync(testInfo.outputPath(`${name}.json`), JSON.stringify(await win.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.g-board-sheet, .g-board-content, .board-utility-panel, .board-toolbar, .board-grid, [data-todo-id]')]
        .map(el => ({ tag: el.className, left: el.getBoundingClientRect().left, width: el.clientWidth, scrollWidth: el.scrollWidth, scrollLeft: el.scrollLeft,
          transform: getComputedStyle(el).transform }))), null, 2));
  };
  try {
    let win = await launch();
    const originalSessions = (await win.evaluate(() => window.api.sessions.list())).sessions.map(session => session.id);
    await win.locator('.chrome-gboard-btn').click();
    await win.getByRole('button', { name: '新建', exact: true }).click();
    // The dialog focuses its task field after opening; wait before editing another field.
    await expect(win.getByRole('textbox', { name: '任务', exact: true })).toBeFocused();
    await win.getByRole('textbox', { name: /会话名称/ }).fill('全局 TODO 示例');
    await win.getByRole('textbox', { name: '任务', exact: true }).fill('第一步：整理待办需求\n第二步：明天继续完善，保留这段完整内容。');
    await expect(win.getByRole('textbox', { name: /会话名称/ })).toHaveValue('全局 TODO 示例');
    await win.getByRole('dialog', { name: '新建任务' }).locator('input[type=file]').setInputFiles({
      name: 'todo-note.txt', mimeType: 'text/plain', buffer: Buffer.from('first attachment')
    });
    await expect(win.getByRole('button', { name: '移除附件 todo-note.txt' })).toBeVisible();
    await win.getByRole('button', { name: '添加代办', exact: true }).click();
    const card = win.locator('[data-zone="todo"] [data-todo-id]');
    await expect(card).toHaveCount(1);
    await expect(win.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0);
    expect((await win.evaluate(() => window.api.sessions.list())).sessions.map(session => session.id)).toEqual(originalSessions);
    await expect(win.locator('.left-panel [data-todo-id]')).toHaveCount(0);
    const saved = await win.evaluate(() => window.api.boardTodos.list());
    expect(saved).toHaveLength(1); expect(saved[0].task).toContain('\n第二步');
    expect(saved[0].name).toBe('全局 TODO 示例');
    await win.getByRole('button', { name: '过滤' }).click();
    const filter = win.getByRole('dialog', { name: '过滤' });
    await expect(filter.getByRole('button', { name: '当前工作区', exact: true })).toBeVisible();
    await expect(filter.getByRole('button', { name: '全选工作区' })).toBeVisible();
    await expect(filter.getByRole('button', { name: '全选面板' })).toBeVisible();
    await expect(filter.getByRole('group', { name: '工作区', exact: true }).locator('.filter-color-dot')).toHaveCount(0);
    const working = filter.getByRole('checkbox', { name: '进行中', exact: true });
    await expect(working).toBeChecked();
    const workingDot = filter.locator('label').filter({
      has: win.getByRole('checkbox', { name: '进行中', exact: true })
    }).locator('.filter-color-dot');
    const columnDotColor = await win.locator('[data-zone="working"] .board-head-dot')
      .evaluate(element => getComputedStyle(element).backgroundColor);
    await expect(workingDot).toHaveCSS('background-color', columnDotColor);
    await working.uncheck();
    await expect(win.locator('[data-zone="working"]')).toHaveCount(0);
    await filter.getByRole('button', { name: '全选面板' }).click();
    await expect(win.locator('[data-zone="working"]')).toHaveCount(1);
    await expect(working).toBeChecked();
    await capture('todo-filter-light.png');
    await app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(640, 600);
      window.setSize(680, 700);
    });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(680);
    await capture('todo-filter-narrow-light.png');
    const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const filterBounds = (await filter.boundingBox())!;
    expect(filterBounds.x).toBeGreaterThanOrEqual(8);
    expect(filterBounds.x + filterBounds.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(filterBounds.y + filterBounds.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(await filter.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
    await win.evaluate(() => window.api.themes.activate('dark'));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    await filter.getByRole('checkbox', { name: '归档', exact: true }).scrollIntoViewIfNeeded();
    await capture('todo-filter-narrow-dark.png');
    await win.evaluate(() => window.api.themes.activate('light'));
    await app!.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1440, 1000); });
    await win.getByRole('button', { name: '过滤' }).click();
    await capture('todo-status-light.png');
    await expect(card).toBeInViewport();
    await stop();

    win = await launch();
    await win.locator('.chrome-gboard-btn').click();
    const restored = win.locator('[data-zone="todo"] [data-todo-id]');
    await expect(restored).toHaveCount(1); await restored.dblclick();
    const edit = win.getByRole('dialog', { name: '编辑代办' });
    await expect(edit).toBeVisible();
    await expect(edit.getByRole('button', { name: '移除附件 todo-note.txt' })).toBeVisible();
    await expect(edit.getByRole('textbox', { name: /会话名称/ })).toHaveValue('全局 TODO 示例');
    await expect(edit.getByRole('textbox', { name: '任务', exact: true })).toHaveText(saved[0].task, { useInnerText: true });
    await edit.getByRole('textbox', { name: '任务', exact: true }).fill('已经二次编辑\n保留在 TODO 中，不启动 Worker。');
    await capture('todo-edit-light.png');
    await edit.getByRole('button', { name: '保存代办', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await win.getByRole('tab', { name: '自由', exact: true }).click();
    const node = win.locator('.fc-node[data-fc-kind="todo"]');
    await expect(node).toHaveCount(1);
    await win.getByRole('button', { name: '适配', exact: true }).click();
    await capture('todo-free-light.png');
    await node.dblclick();
    await expect(edit).toBeVisible();
    await expect(edit.getByRole('textbox', { name: '任务', exact: true })).toHaveText('已经二次编辑\n保留在 TODO 中，不启动 Worker。', { useInnerText: true });
    await edit.getByRole('button', { name: '取消', exact: true }).click();
    await expect(edit).toHaveCount(0);
    expect((await win.evaluate(() => window.api.themes.activate('dark', { scope: 'global' }))).ok).toBe(true);
    await capture('todo-free-dark.png');
    await win.getByRole('button', { name: '过滤' }).click();
    await expect(win.getByRole('dialog', { name: '过滤' })).toBeVisible();
    await capture('todo-filter-dark.png');
    await win.getByRole('button', { name: '过滤' }).click();
    await win.getByRole('tab', { name: '状态', exact: true }).click();
    await capture('todo-status-dark.png');
    await win.locator('[data-zone="todo"] [data-todo-id]').dblclick();
    await app!.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(360, 600); win.setSize(520, 860); });
    await capture('todo-edit-dark-narrow.png');
    await edit.getByRole('button', { name: '删除代办', exact: true }).click();
    await expect(win.locator('.fc-node[data-fc-kind="todo"]')).toHaveCount(0);
    expect(await win.evaluate(() => window.api.boardTodos.list())).toEqual([]);
    expect((await win.evaluate(() => window.api.sessions.list())).sessions.map(session => session.id)).toEqual(originalSessions);
    expect(consoleErrors).toEqual([]);
  } finally { await stop(); fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
