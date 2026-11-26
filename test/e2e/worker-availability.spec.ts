import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkbenchApi } from '../../src/preload/index';
import { seedAvailableWorkers } from './helpers/available-workers';

test('可用 Worker：真实预检、新建选择与创建、动态禁用及能力关联', async () => {
  test.setTimeout(115_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'worker-availability-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox', 'userData');
  const home = path.join(userData, 'capability-home');
  const initial = path.join(fixture, '.dev-sandbox', 'workspaces', 'demo-frontend');
  const skillDir = path.join(home, '.claude', 'skills', 'external-worker-fixture');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: external-worker-fixture\ndescription: Isolated fixture\n---\n\nSource retained.\n');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', workspace: initial, activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Initial', path: initial }], openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  seedAvailableWorkers(project, userData, { pi: false, includeCustom: true, labels: { 'claude-code': 'Claude 本机入口' } });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_HOST', 'MUSTER_STATUS_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `worker-availability-${process.pid}`, MUSTER_WEB_PORT: '0', APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'), USERPROFILE: home, HOME: home });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu', ...(process.env.MUSTER_E2E_CHROMIUM_SANDBOX === '1' ? [] : ['--no-sandbox'])], cwd: fixture, env, timeout: 60_000 });
  const shots = path.join(project, '.tmp', 'ui-captures', 'worker-availability');
  fs.mkdirSync(shots, { recursive: true });
  const pageErrors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', error => pageErrors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.app.bootWait());
    const settled = async (): Promise<void> => {
      await win.evaluate(async () => {
        const transitions = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
        await Promise.all(transitions.map(animation => animation.finished.catch(() => {})));
      });
    };
    const availability = () => win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.runtimes.availability(true));
    expect((await availability()).runtimes.map(entry => entry.id).sort()).toEqual(['claude-code', 'codex', 'cursor-cli', 'fixture-custom']);
    await expect(win.getByText('点击 ＋ 新建任务', { exact: true })).toBeVisible();
    await expect(win.getByText(/点击 ＋ 选择 .*未安装测试工具/)).toHaveCount(0);
    const openTask = async () => {
      const button = win.getByTitle(/新建任务（先填任务再拉起会话）/);
      await button.locator('..').locator('..').hover();
      await button.click();
      const dialog = win.getByRole('dialog', { name: '新建任务', exact: true });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const task = await openTask();
    await expect(task.getByRole('button', { name: '运行方式', exact: true })).toBeEnabled();
    await task.getByRole('button', { name: '运行方式', exact: true }).click();
    await expect(win.getByRole('option', { name: '本地测试工具', exact: true })).toBeVisible();
    await expect(win.getByRole('option', { name: 'Claude 本机入口', exact: true })).toBeVisible();
    await expect(win.getByRole('option', { name: /未安装测试工具|OpenCode|Gemini|ACP|Pi/ })).toHaveCount(0);
    await settled();
    await win.screenshot({ path: path.join(shots, 'dark-available-options.png') });
    await win.getByRole('option', { name: '本地测试工具', exact: true }).click();
    await task.getByLabel('会话名称').fill('可用 Worker 测试');
    await expect(task.getByRole('button', { name: '新建空白', exact: true })).toBeEnabled();
    await task.getByRole('button', { name: '新建空白', exact: true }).click();
    await expect(task).toBeHidden();
    await expect.poll(async () => (await win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.sessions.list())).sessions.filter(entry => entry.runtime === 'fixture-custom').length).toBe(1);
    await openTask();
    await task.getByRole('textbox', { name: '任务', exact: true }).fill('保留未提交草稿');
    const update = async (id: string, patch: { enabled?: boolean; label?: string }): Promise<void> => {
      const pending = win.evaluate(async args => (window as Window & { api: WorkbenchApi }).api.runtimes.update(args), { id, ...patch }).catch(error => ({ ok: false, error: String(error) }));
      const confirmation = win.getByRole('dialog', { name: '更新 Agent Runtime', exact: true });
      await expect(confirmation).toBeVisible();
      const layers = await win.evaluate(() => ({
        confirmation: Number(getComputedStyle(document.querySelector('.app-confirm-mask')!).zIndex),
        task: Number(getComputedStyle(document.querySelector('.new-task-overlay') ?? document.querySelector('.cm-pane')!).zIndex) || 0
      }));
      expect(layers.confirmation).toBeGreaterThan(layers.task);
      await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
      expect((await pending).ok).toBe(true);
    };
    for (const id of ['fixture-custom', 'claude-code', 'codex', 'cursor-cli']) await update(id, { enabled: false });
    await expect.poll(async () => (await availability()).runtimes.length).toBe(0);
    await expect(task.getByRole('button', { name: '新建空白', exact: true })).toBeDisabled();
    await expect(task.getByRole('button', { name: '开始任务', exact: true })).toBeDisabled();
    await expect(task.getByRole('textbox', { name: '任务', exact: true })).toHaveValue('保留未提交草稿');
    await expect(task).toContainText('暂无可用 Worker，请在设置中安装或配置');
    await settled();
    await win.screenshot({ path: path.join(shots, 'dark-no-available-worker.png') });
    await task.getByRole('button', { name: '关闭新建任务', exact: true }).click();
    await win.getByRole('button', { name: '设置', exact: true }).first().click();
    await win.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: /能力管理/ }).click();
    const pane = win.locator('.cm-pane');
    await pane.getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
    await pane.getByRole('button', { name: /external-worker-fixture/ }).click();
    const detail = pane.getByRole('complementary', { name: '能力详情' });
    await expect(detail.getByRole('checkbox', { name: /^关联 / })).toHaveCount(0);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('Source retained.');
    await update('claude-code', { enabled: true, label: 'Claude 重命名入口' });
    await expect(detail.getByRole('checkbox', { name: '关联 Claude 重命名入口', exact: true })).toBeVisible();
    await expect(detail.getByRole('checkbox', { name: /Codex|Cursor|Pi|ACP|未安装|本地测试/ })).toHaveCount(0);
    expect((await availability()).runtimes.map(entry => entry.label)).toEqual(['Claude 重命名入口']);
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async id => (window as Window & { api: WorkbenchApi }).api.themes.activate(id), theme);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await settled();
      await win.screenshot({ path: path.join(shots, `${theme}-association.png`) });
    }
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    fs.writeFileSync(path.join(shots, 'manifest.json'), JSON.stringify({ fixture, pageErrors }, null, 2));
  } finally {
    const processHandle = app.process();
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
    if (processHandle.exitCode === null && processHandle.pid && process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Only this owned fixture process. */ }
    }
  }
});
