import { test, expect, _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(__dirname, '../..');
const requireModule = createRequire(__filename);

// 固定到右侧：真实 PTY/xterm 与 GUI 会话的同一 DOM 在中栏与右侧之间移动，不重建实例、不丢草稿。
test('左栏右键固定终端与 GUI 会话到右侧，再移回中栏', async ({}, info) => {
  test.setTimeout(110_000);
  const cwd = info.outputDir, root = path.join(cwd, 'workspace'), userData = path.join(cwd, '.dev-sandbox', 'userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'pin-e2e', workspaces: [{ id: 'pin-e2e', name: 'Pin fixture', path: root, accentOff: true }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `right-pin-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: requireModule('electron') as string, args: [project, '--disable-gpu'], cwd, env, timeout: 45_000 });
  const images = path.join(project, 'output', 'right-pin'); fs.mkdirSync(images, { recursive: true });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1900, 1000));
    await win.locator('.app-shell').waitFor({ timeout: 40_000 });
    const ids = await win.evaluate(async root => {
      const profiles = await window.api.shell.listProfiles();
      const shell = await window.api.sessions.create({ shellProfileId: profiles[0]!.id, cwd: root, workspaceId: 'pin-e2e', name: 'Pin shell' });
      const guiOptions = { runtime: 'pi', force: true, cwd: root, workspaceId: 'pin-e2e', name: 'Pin GUI' };
      const gui = await window.api.sessions.create(guiOptions);
      await window.api.sessions.select(gui.id);
      await window.api.sessions.select(shell.id);
      return { shell: shell.id, gui: gui.id };
    }, root);
    const pane = win.locator('.right-workspace');
    const centerTerm = win.locator(`.center-panel .terminal-wrap[data-session-id="${ids.shell}"]`);
    await expect(centerTerm).toBeVisible({ timeout: 20_000 });
    await centerTerm.evaluate(element => { (element as HTMLElement & { __pinMark?: string }).__pinMark = 'same-xterm'; });

    const pinFromLeft = async (name: string) => {
      await win.locator('.left-panel .session-item', { hasText: name }).first().click({ button: 'right' });
      await win.getByRole('menuitemcheckbox', { name: '固定到右侧' }).click();
    };
    await pinFromLeft('Pin shell');
    const rightTerm = pane.locator(`.right-dock-host .terminal-wrap[data-session-id="${ids.shell}"]`);
    await expect(rightTerm).toBeVisible();
    expect(await rightTerm.evaluate(element => (element as HTMLElement & { __pinMark?: string }).__pinMark)).toBe('same-xterm');
    await expect(pane.getByRole('tab', { name: /Pin shell/ })).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator('.center-panel [data-testid="center-docked-placeholder"]')).toBeVisible();
    const box = await rightTerm.locator('.xterm-screen').boundingBox();
    expect(box && box.width > 200 && box.height > 100).toBe(true);
    await win.screenshot({ path: path.join(images, 'terminal-pinned.png') });

    // GUI 会话：中栏先输入草稿，固定后在右侧仍是同一 composer 与草稿
    await win.evaluate(async id => window.api.sessions.select(id), ids.gui);
    const centerChat = win.locator(`.center-panel .agent-chat-view[data-session-id="${ids.gui}"]`);
    await expect(centerChat).toBeVisible({ timeout: 20_000 });
    const composer = centerChat.locator('[contenteditable="true"], textarea').first();
    await composer.click(); await win.keyboard.type('右侧草稿');
    await pinFromLeft('Pin GUI');
    const rightChat = pane.locator(`.right-dock-host .agent-chat-view[data-session-id="${ids.gui}"]`);
    await expect(rightChat).toBeVisible();
    await expect(rightChat).toContainText('右侧草稿');
    await expect(pane.getByRole('tablist', { name: '内容标签页' }).getByRole('tab')).toHaveCount(2);
    await win.screenshot({ path: path.join(images, 'gui-pinned.png') });

    // 右侧工具栏「移回中栏」：终端回到中栏，仍是同一实例
    await pane.getByRole('tab', { name: /Pin shell/ }).click();
    await pane.getByRole('button', { name: '移回中栏' }).click();
    await expect(centerTerm).toBeVisible();
    expect(await centerTerm.evaluate(element => (element as HTMLElement & { __pinMark?: string }).__pinMark)).toBe('same-xterm');
    await expect(pane.getByRole('tablist', { name: '内容标签页' }).getByRole('tab')).toHaveCount(1);
    await win.screenshot({ path: path.join(images, 'terminal-back.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
