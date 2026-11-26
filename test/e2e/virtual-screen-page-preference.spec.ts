import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { virtualScreenPageKey } from '../../src/renderer/src/virtualScreenPagePreference';

test('virtual screen remembers left and right per workspace across focus and restart', async ({}, info) => {
  test.setTimeout(75_000);
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const userData = path.join(cwd, '.dev-sandbox/userData');
  const workspaces = ['page-a', 'page-b'].map(id => ({ id, name: id, path: path.join(cwd, id) }));
  const [a, b] = workspaces;
  for (const workspace of workspaces) {
    const settings = path.join(workspace.path, '.muster');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(settings, 'workspace.json'), JSON.stringify({
      hVirtualScreen: true, hDock: workspace === a ? 'git' : 'terminal'
    }));
  }
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', activeWorkspaceId: a.id, workspaces,
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `virtual-screen-page-${process.pid}`, MUSTER_WEB_PORT: '0' } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  let app: ElectronApplication | undefined;
  const launch = async (): Promise<Page> => {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env, timeout: 25_000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 900));
    await page.locator('.app-shell').waitFor();
    return page;
  };
  const remembered = (page: Page, id: string) => page.evaluate(key => localStorage.getItem(key), virtualScreenPageKey(id));
  const expectPage = (page: Page, side: 'left' | 'right') =>
    expect(page.locator('.main-view')).toHaveClass(side === 'right' ? /\bh-git\b/ : /\bh-terminal\b/);
  const switchWorkspace = async (page: Page, id: string) => {
    expect(await page.evaluate(workspaceId => window.api.workspaces.switch(workspaceId), id)).toMatchObject({ ok: true });
    await expect(page.locator('.work-area')).toHaveAttribute('data-workspace-id', id);
  };
  const toggle = async (page: Page) => {
    await page.locator('.chrome-right-toggle').focus();
    await page.keyboard.press('Control+Shift+\\');
  };
  try {
    let page = await launch();
    await expectPage(page, 'right');
    expect(await remembered(page, a.id)).toBeNull();
    for (const side of ['left', 'right', 'left'] as const) {
      await toggle(page);
      await expectPage(page, side);
      expect(await remembered(page, a.id)).toBe(side);
    }
    const legacyA = await page.evaluate(() => window.api.workspaceFile.get());
    expect(legacyA.config.hDock).toBe('git');

    await switchWorkspace(page, b.id);
    await expectPage(page, 'left');
    expect(await remembered(page, b.id)).toBeNull();
    await toggle(page);
    await expectPage(page, 'right');
    expect(await remembered(page, b.id)).toBe('right');
    await switchWorkspace(page, a.id);
    await expectPage(page, 'left');
    expect(await remembered(page, a.id)).toBe('left');

    await switchWorkspace(page, b.id);
    await expectPage(page, 'right');
    expect(await page.evaluate(id => window.api.workspaceFile.patch({ focusMode: true }, id), b.id)).toMatchObject({ ok: true });
    await switchWorkspace(page, b.id);
    await expect(page.locator('.main-view')).toHaveClass(/\bis-focus\b/);
    await toggle(page);
    expect(await remembered(page, b.id)).toBe('right');

    await app!.close();
    app = undefined;
    page = await launch();
    await expect(page.locator('.main-view')).toHaveClass(/\bis-focus\b/);
    expect(await remembered(page, b.id)).toBe('right');
    expect(await page.evaluate(id => window.api.workspaceFile.patch({ focusMode: false }, id), b.id)).toMatchObject({ ok: true });
    await switchWorkspace(page, b.id);
    await expect(page.locator('.main-view')).not.toHaveClass(/\bis-focus\b/);
    await expectPage(page, 'right');
    await switchWorkspace(page, a.id);
    await expectPage(page, 'left');
  } finally {
    await app?.close();
  }
});
