/** Isolated real app + preload + config persistence; no external engine or inference. */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_CATALOG } from '../../src/shared/harnessCatalog';

const root = path.resolve(__dirname, '../..');
const requireNode = createRequire(__filename);

test('Agent settings persist independent ACP product switches through real IPC and page reload', async ({}, testInfo) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-e2e-'));
  const userData = path.join(cwd, '.dev-sandbox/userData');
  const workspace = path.join(cwd, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(userData, 'agent-runtimes'), { recursive: true });
  const disabled = HARNESS_CATALOG.flatMap(entry => entry.acpPresetId ? [entry.acpPresetId] : []);
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  for (const entry of registry.runtimes) entry.enabled = entry.id === 'acp';
  fs.writeFileSync(path.join(userData, 'agent-runtimes/registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', defaultRuntime: 'acp',
    disabledAcpAgents: disabled, activeWorkspaceId: 'settings-fixture', workspace,
    workspaces: [{ id: 'settings-fixture', name: 'Agent settings test', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd) } as Record<string, string>;
  for (const key of ['ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: requireNode('electron'), args: [root, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60000 });
    const win = await app.firstWindow();
    const pageErrors: string[] = [];
    win.on('pageerror', error => pageErrors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 60000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1380, 980));
    const openSettings = async () => {
      await win.getByRole('button', { name: '设置', exact: true }).click();
      await win.getByRole('button', { name: 'Harness 接入', exact: true }).click();
      await win.getByRole('button', { name: '全部支持', exact: true }).click();
      await win.getByRole('button', { name: '配置 OpenCode', exact: true }).click();
    };
    await openSettings();
    const toggle = win.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect.poll(async () => (await win.evaluate(() => window.api.config.get())).disabledAcpAgents).not.toContain('opencode');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    expect(saved.disabledAcpAgents).toContain('kimi');
    expect(saved.disabledAcpAgents).toContain('mimo-code');
    const runtimes = await win.evaluate(() => window.api.runtimes.list());
    expect(runtimes.find(entry => entry.id === 'acp')?.enabled).toBe(true);
    await win.getByRole('button', { name: '配置 Kimi Code', exact: true }).click();
    await expect(win.getByRole('checkbox', { name: '启用 Kimi Code 工作台聊天' })).not.toBeChecked();
    await win.reload();
    await win.locator('.app-shell').waitFor();
    await openSettings();
    await expect(win.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' })).toBeChecked();
    await win.screenshot({ path: testInfo.outputPath('agent-settings-dark.png') });
    await win.getByRole('button', { name: '配置 CodeBuddy Code', exact: true }).click();
    await expect(win.getByRole('tab', { name: '工作台聊天' })).toBeVisible();
    await expect(win.getByRole('tab', { name: '原生终端' })).toBeVisible();

    await win.getByRole('button', { name: '默认与通用', exact: true }).click();
    const declaration = { id: 'e2e-runtime', label: 'E2E Runtime', terminal: { command: process.execPath },
      chat: { transport: 'acp', command: process.execPath, args: ['--acp'] } };
    await win.getByRole('textbox', { name: '运行时 JSON 声明' }).fill(JSON.stringify(declaration, null, 2));
    const register = win.getByRole('button', { name: '注册', exact: true });
    const dialog = win.getByTestId('confirm-mask');
    await register.click();
    await expect(dialog.getByText(/e2e-runtime/)).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await win.evaluate(async () => (await window.api.runtimes.list()).some(entry => entry.id === 'e2e-runtime'))).toBe(false);
    await register.click();
    await expect(dialog.getByText(/e2e-runtime/)).toBeVisible();
    await win.screenshot({ path: testInfo.outputPath('runtime-registration-confirm-dark.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(win.getByRole('button', { name: '配置 E2E Runtime', exact: true })).toBeVisible();
    await expect.poll(() => win.evaluate(async () => {
      const available = await window.api.runtimes.availability();
      return [available.runtimes.some(entry => entry.id === 'e2e-runtime'), available.acpAgents.some(agent => agent.id === 'e2e-runtime')];
    })).toEqual([true, true]);
    await win.getByRole('button', { name: '配置 E2E Runtime', exact: true }).click();
    await expect(win.getByRole('tab', { name: '工作台聊天' })).toBeVisible();
    await expect(win.getByRole('tab', { name: '原生终端' })).toBeVisible();
    await win.evaluate(() => window.api.config.update({ themeId: 'light' }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1040, 760));
    await win.reload();
    await win.locator('.app-shell').waitFor();
    await openSettings();
    await win.getByRole('button', { name: '默认与通用', exact: true }).click();
    const manifestField = win.getByRole('textbox', { name: '运行时 JSON 声明' });
    await manifestField.scrollIntoViewIfNeeded();
    await expect(manifestField).toBeVisible();
    await win.screenshot({ path: testInfo.outputPath('runtime-registration-light-narrow.png'), animations: 'disabled' });
    expect(pageErrors).toEqual([]);
  } catch (error) {
    if (app) {
      const page = await app.firstWindow().catch(() => undefined);
      if (page) {
        await page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
        const dialogs = await page.locator('[data-testid="confirm-mask"]').allTextContents().catch(() => []);
        console.error('Startup dialogs:', JSON.stringify(dialogs));
      }
    }
    throw error;
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    const resolved = path.resolve(cwd);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved)).toMatch(/^agent-settings-e2e-/);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
