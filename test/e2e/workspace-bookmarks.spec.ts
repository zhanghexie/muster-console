import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('legacy bookmarks migrate, stay independent of tab writes, and restore after restart', async ({}, info) => {
  test.setTimeout(65_000);
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir, root = path.join(cwd, 'project'), data = path.join(cwd, '.dev-sandbox/userData');
  const workspaceId = 'bookmarks-e2e';
  const settings = path.join(root, '.muster');
  const workspaceFile = path.join(settings, 'workspace.json'), bookmarkFile = path.join(settings, 'bookmarks.json');
  const legacy = [{ id: 'legacy-folder', label: '旧收藏夹', children: [{ id: 'legacy-page', label: '项目参考', url: 'https://example.test/', description: '保留描述' }] }];
  fs.mkdirSync(settings, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(workspaceFile, JSON.stringify({ hVirtualScreen: true, hDock: 'git',
    rightWorkspace: { version: 1, panel: 'browser', collapsed: false, tabs: [], selected: {}, bookmarks: legacy, bookmarkDefaultsVersion: 1 } }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    locale: 'zh-CN', activeWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, name: 'Bookmarks test', path: root }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(data, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `workspace-bookmarks-${process.pid}`, MUSTER_WEB_PORT: '0' } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env, timeout: 25_000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 900));
    await page.locator('.app-shell').waitFor();
    return page;
  };
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    let page = await launch();
    let sidebar = page.locator('.right-bookmarks');
    const folder = sidebar.getByRole('button', { name: '旧收藏夹' });
    await expect(folder).toBeVisible();
    expect(readJson(bookmarkFile)).toMatchObject({ version: 1, bookmarks: legacy, bookmarkDefaultsVersion: 1 });
    expect(readJson(workspaceFile).rightWorkspace).not.toHaveProperty('bookmarks');
    expect(readJson(workspaceFile).rightWorkspace).not.toHaveProperty('bookmarkDefaultsVersion');

    const bookmarkBytes = fs.readFileSync(bookmarkFile, 'utf8');
    const bookmarkMtime = fs.statSync(bookmarkFile, { bigint: true }).mtimeNs;
    const tabUrl = await page.evaluate(async id => {
      const tab = await window.api.browser.open({ newTab: true, workspaceId: id, sessionId: '', scope: 'workspace' });
      return (await window.api.browser.restore()).tabs.find(item => item.id === tab.id)?.url;
    }, workspaceId);
    expect(tabUrl).toMatch(/^muster-home:/);
    await expect.poll(() => readJson(workspaceFile).rightWorkspace.tabs.some((item: { content: { url?: string } }) => item.content.url === tabUrl)).toBe(true);
    expect(fs.readFileSync(bookmarkFile, 'utf8')).toBe(bookmarkBytes);
    expect(fs.statSync(bookmarkFile, { bigint: true }).mtimeNs).toBe(bookmarkMtime);

    await folder.click({ button: 'right' });
    await page.getByText('重命名', { exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名' });
    await rename.getByRole('textbox', { name: '名称' }).fill('迁移后收藏');
    await rename.getByRole('textbox', { name: '名称' }).press('Enter');
    await expect(sidebar.getByRole('button', { name: '迁移后收藏' })).toBeVisible();
    expect(readJson(bookmarkFile).bookmarks[0]).toEqual({ ...legacy[0], label: '迁移后收藏' });

    await app!.close();
    app = undefined;
    page = await launch();
    sidebar = page.locator('.right-bookmarks');
    await sidebar.getByRole('button', { name: '迁移后收藏' }).click();
    await expect(sidebar.getByRole('button', { name: '项目参考' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '旧收藏夹' })).toHaveCount(0);
  } finally {
    await app?.close();
  }
});
