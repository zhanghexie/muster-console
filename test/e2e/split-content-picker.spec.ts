import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('空分屏搜索限定当前工作区，新终端进入空槽且主侧不变', async () => {
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'split-picker-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const workspaces = ['current', 'other'].map(id => ({ id, name: id, path: path.join(fixture, id) }));
  fs.mkdirSync(userData, { recursive: true });
  workspaces.forEach(workspace => fs.mkdirSync(workspace.path));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    workspace: workspaces[0].path, workspaces, activeWorkspaceId: 'current', mcp: { enabled: false, servers: [] } }));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `split-picker-${process.pid}`,
    MUSTER_WEB_PORT: '0', APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--no-sandbox'], cwd: fixture, env });
  try {
  const win = await app.firstWindow();
  await win.waitForSelector('.app-shell', { timeout: 25000 });
  const seeded = await win.evaluate(async () => {
    const api = (window as any).api;
    const { activeWorkspaceId: workspaceId } = await api.workspaces.list();
    const profiles = await api.shell.listProfiles();
    if (!profiles.length) throw new Error('E2E requires an installed shell');
    const primary = await api.sessions.create({ workspaceId, shellProfileId: profiles[0].id, name: 'picker-primary' });
    const other = await api.sessions.create({ workspaceId, shellProfileId: profiles[0].id, name: 'picker-search-candidate', activate: false });
    const { workspaces } = await api.workspaces.list();
    const foreignWorkspace = workspaces.find((workspace: any) => workspace.id !== workspaceId);
    if (!foreignWorkspace) throw new Error('E2E requires a second workspace');
    const foreign = await api.sessions.create({ workspaceId: foreignWorkspace.id, shellProfileId: profiles[0].id, name: 'picker-foreign', activate: false });
    await api.sessions.select(primary.id);
    return { primary: primary.id, other: other.id, foreign: foreign.id, profile: profiles[0].id, workspaceId };
  });
  await expect(win.locator('.center-panel')).toBeVisible();
  await expect(win.getByTestId('center-pane-handle-0')).toContainText('picker-primary');
  await win.getByTestId('center-pane-handle-0').focus();
  await win.keyboard.press('Control+\\');
  const picker = win.locator('.center-snap-picker');
  await expect(picker).toBeVisible();
  await expect(win.getByTestId(`center-snap-fill-1-${seeded.other}`)).toBeVisible();
  await expect(win.getByTestId(`center-snap-fill-1-${seeded.foreign}`)).toHaveCount(0);
  await picker.getByRole('searchbox').fill('picker-search-candidate');
  await expect(picker.locator('.center-snap-assist-choice')).toHaveCount(1);
  const before = await win.evaluate(async () => (await (window as any).api.sessions.list()).sessions.map((session: any) => session.id));
  await picker.getByRole('button', { name: '新建终端' }).click();
  await win.getByRole('dialog', { name: '选择 Shell' }).locator('.split-shell-list button').first().click();
  await expect(picker).toHaveCount(0);
  const after = await win.evaluate(async () => (window as any).api.sessions.list());
  expect(after.activeId).toBe(seeded.primary);
  const created = after.sessions.filter((session: any) => !before.includes(session.id));
  expect(created).toHaveLength(1);
  expect(created[0].workspaceId).toBe(seeded.workspaceId);
  await expect(win.getByTestId('center-pane-1').locator('.center-split-handle')).toContainText(created[0].name);
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
});
