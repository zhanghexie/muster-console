import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkbenchApi } from '../../src/preload/index';
import type { UsageResource } from '../../src/shared/capabilityUsage';
import { seedAvailableWorkers, fixtureLlm } from './helpers/available-workers';

test('Worker settings: connection metadata and drafts; resource policy stays in Capability Management', async () => {
  test.setTimeout(120_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'worker-layout-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  seedAvailableWorkers(project, userData, { includeCustom: true });
  const home = path.join(userData, 'capability-home');
  const workspace = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  const skillDir = path.join(home, '.agents/skills/worker-layout-fixture');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: worker-layout-fixture\ndescription: Worker layout fixture\n---\n\nOriginal retained.\n');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', defaultRuntime: 'claude-code', workspace,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Fixture project', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' }, llm: fixtureLlm,
    mcp: { enabled: true, servers: [{ name: 'worker-fixture-mcp', transport: 'stdio', enabled: false, command: 'fixture-not-launched' }] }
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_HOST', 'MUSTER_STATUS_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `worker-layout-${process.pid}`, MUSTER_WEB_PORT: '0', APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'), HOME: home, USERPROFILE: home });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu', ...(process.env.MUSTER_E2E_CHROMIUM_SANDBOX === '1' ? [] : ['--no-sandbox'])], cwd: fixture, env, timeout: 60_000 });
  const shots = path.join(project, '.tmp/ui-captures/worker-settings-layout'); fs.mkdirSync(shots, { recursive: true });
  const errors: string[] = [], screenshots: string[] = [], checks: unknown[] = [];
  const mainErrors: string[] = [];
  app.process().stderr?.on('data', chunk => { mainErrors.push(String(chunk)); if (mainErrors.length > 30) mainErrors.shift(); });
  try {
    const win = await app.firstWindow();
    win.on('pageerror', error => errors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.app.bootWait());
    await win.getByRole('button', { name: '设置', exact: true }).first().click();
    await win.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: 'Worker', exact: true }).click();
    const pane = win.locator('.worker-pane'), nav = pane.getByRole('navigation', { name: 'Worker 列表' });
    const select = (label: string) => nav.getByRole('button', { name: `选择 Worker ${label}`, exact: true }).click();
    const settle = async (): Promise<void> => {
      await win.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
    };
    const capture = async (file: string): Promise<void> => { await win.mouse.move(5, 5); await settle(); await win.screenshot({ path: path.join(shots, file) }); screenshots.push(file); };
    await select('Claude Code CLI');
    await pane.getByRole('textbox', { name: 'Worker 显示名', exact: true }).fill('CLI unsaved draft');
    await pane.getByRole('textbox', { name: '额外启动参数（空格分词）', exact: true }).fill('--model fixture-draft');
    await select('Codex CLI'); await select('Claude Code CLI');
    await expect(pane.getByRole('textbox', { name: 'Worker 显示名', exact: true })).toHaveValue('CLI unsaved draft');
    await expect(pane.getByRole('textbox', { name: '额外启动参数（空格分词）', exact: true })).toHaveValue('--model fixture-draft');
    await expect(pane.locator('.capability-usage')).toHaveCount(0);
    await expect(pane.locator('.worker-page.is-shown .worker-integrations')).toContainText('技能目录与 MCP 接入');
    await expect(pane.locator('.worker-page.is-shown .worker-integrations')).toContainText('.agents/skills');
    await expect(pane.locator('.worker-page.is-shown .worker-integrations')).toContainText('.claude.json');
    const settingsNav = win.getByRole('navigation', { name: '设置分组' });
    await settingsNav.getByRole('button', { name: '能力管理', exact: true }).click();
    const capabilities = win.locator('.cm-pane');
    await capabilities.getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
    await capabilities.getByRole('button', { name: '使用开关与范围', exact: true }).click();
    // Actual renderer -> preload -> production IPC -> persisted policy and readback.
    const policyPanel = win.getByRole('dialog').locator('.capability-usage');
    await policyPanel.getByRole('button', { name: '编辑使用范围', exact: true }).click();
    await win.getByRole('option', { name: 'Claude Code CLI', exact: true }).click();
    const skillToggle = policyPanel.getByRole('checkbox', { name: '允许使用 worker-layout-fixture', exact: true });
    await skillToggle.uncheck();
    await expect(policyPanel.getByText('已关闭 · 此 Harness', { exact: true })).toBeVisible();
    const policyRead = () => win.evaluate(async () => {
      const api = (window as Window & { api: WorkbenchApi }).api;
      return api.capabilityManagement.usageList({ kind: 'skill', runtimeId: 'claude-code' });
    });
    const disabled = await policyRead();
    const skill = disabled.resources.find((resource: UsageResource) => resource.name === 'worker-layout-fixture')!;
    expect(skill.state.enabled).toBe(false);
    const other = await win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.capabilityManagement.usageList({ kind: 'skill', runtimeId: 'codex' }));
    expect(other.resources.find((resource: UsageResource) => resource.name === 'worker-layout-fixture')?.state.enabled).toBe(true);
    await policyPanel.getByRole('button', { name: '恢复本层允许', exact: true }).click();
    await expect(skillToggle).toBeChecked();
    await win.evaluate(async id => {
      const api = (window as Window & { api: WorkbenchApi }).api;
      const snapshot = await api.capabilityManagement.usageList({ kind: 'skill' });
      await api.capabilityManagement.usageSet({ kind: 'skill', scope: { kind: 'global' }, resourceIds: [id], enabled: false, expectedRevision: snapshot.revision });
    }, skill.id);
    await expect(skillToggle).toBeDisabled();
    await policyPanel.getByRole('button', { name: '查看全局设置', exact: true }).click();
    await expect(skillToggle).toBeEnabled(); await skillToggle.check();
    await expect(skillToggle).toBeChecked();
    const context = await win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.config.get());
    const fixtureWorkspace = context.workspaces.find(item => item.path === workspace) ?? context.workspaces.find(item => item.id === context.activeWorkspaceId)!;
    await policyPanel.getByRole('button', { name: '查看工作区使用状态', exact: true }).click();
    await win.getByRole('option', { name: fixtureWorkspace.name, exact: true }).click();
    await policyPanel.getByRole('button', { name: '编辑使用范围', exact: true }).click();
    await win.getByRole('option', { name: '当前工作区', exact: true }).click();
    await skillToggle.uncheck();
    await expect(policyPanel.getByText('已关闭 · 当前工作区', { exact: true })).toBeVisible();
    expect((await policyRead()).resources.find((resource: UsageResource) => resource.id === skill.id)?.state.enabled).toBe(true);
    await capture('workspace-skill-disabled.png');
    await policyPanel.getByRole('button', { name: '恢复本层允许', exact: true }).click();
    await expect(skillToggle).toBeChecked();
    await policyPanel.getByRole('button', { name: '编辑使用范围', exact: true }).click();
    await win.getByRole('option', { name: 'Claude Code CLI', exact: true }).click();
    await policyPanel.getByRole('button', { name: '批量管理', exact: true }).click();
    await expect(policyPanel.getByRole('checkbox', { name: '选择 worker-layout-fixture', exact: true })).toBeVisible();
    await capture('bulk-skill-selection.png');
    await policyPanel.getByRole('button', { name: '结束选择', exact: true }).click();
    await win.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await settingsNav.getByRole('button', { name: 'Worker', exact: true }).click();
    await expect(pane.getByRole('textbox', { name: 'Worker 显示名', exact: true })).toHaveValue('CLI unsaved draft');
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async id => (window as Window & { api: WorkbenchApi }).api.themes.activate(id), theme);
      for (const width of [800, 390]) {
        await pane.evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px`; (node as HTMLElement).style.maxWidth = '100%'; }, width);
        if (width === 390) await expect(pane).toHaveClass(/is-narrow/);
        else await expect(pane).not.toHaveClass(/is-narrow/);
        await settle();
        if (width === 390) {
          if (await nav.isVisible()) await select('Claude Code CLI');
          await expect(nav).toBeHidden();
        } else await expect(nav).toBeVisible();
        const geometry = await pane.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, columns: getComputedStyle(node).gridTemplateColumns, detailWidth: node.querySelector('.worker-detail')?.clientWidth, pages: [...node.querySelectorAll('.worker-page.is-shown')].map(page => ({ scrollWidth: page.scrollWidth, clientWidth: page.clientWidth })) }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.pages.every(page => page.scrollWidth <= page.clientWidth + 1)).toBe(true);
        checks.push({ theme, requestedWidth: width, state: 'selected-worker-and-connection-metadata', ...geometry });
        await pane.locator('.worker-page.is-shown').evaluate(node => { node.scrollTop = 0; });
        await capture(`${theme}-${width}-worker.png`);
        await pane.locator('.worker-page.is-shown .worker-integrations').scrollIntoViewIfNeeded();
        await capture(`${theme}-${width}-integrations.png`);
        await pane.locator('.worker-page.is-shown').evaluate(node => { node.scrollTop = 0; });
        if (width === 390) {
          const scroller = pane.locator('.worker-list-scroll');
          await pane.getByRole('button', { name: '返回 Worker 列表', exact: true }).click();
          await expect(nav).toBeVisible();
          await nav.getByRole('searchbox', { name: '搜索 Worker', exact: true }).fill('Claude');
          await expect(nav.getByRole('button', { name: '选择 Worker Codex CLI', exact: true })).toHaveCount(0);
          await capture(`${theme}-${width}-list.png`);
          await nav.getByRole('searchbox', { name: '搜索 Worker', exact: true }).fill('');
          await scroller.evaluate(node => { node.scrollTop = 80; });
          const row = nav.getByRole('button', { name: '选择 Worker Claude Code CLI', exact: true });
          await row.click();
          // Clicking a partially visible row may scroll it into view before entering detail.
          const before = await scroller.evaluate(node => node.scrollTop);
          await pane.getByRole('button', { name: '返回 Worker 列表', exact: true }).click();
          await expect(row).toBeFocused(); expect(await scroller.evaluate(node => node.scrollTop)).toBe(before);
          await row.click();
          await expect(pane.getByRole('textbox', { name: 'Worker 显示名', exact: true })).toHaveValue('CLI unsaved draft');
        }
      }
    }
    await pane.evaluate(node => { (node as HTMLElement).style.width = '800px'; });
    await expect(pane).not.toHaveClass(/is-narrow/);
    await expect(nav.getByRole('button', { name: '选择 Worker 本地测试工具', exact: true })).toHaveCount(0);
    const custom = await win.evaluate(async () => (window as Window & { api: WorkbenchApi }).api.runtimes.list());
    expect(custom.some(item => item.id === 'fixture-custom')).toBe(false);
    expect(fs.readFileSync(path.join(userData, 'agent-runtimes/registry.json'), 'utf8')).toContain('fixture-custom');
    await pane.getByRole('button', { name: '默认与通用', exact: true }).click();
    await expect(pane.getByRole('button', { name: '默认 runtime', exact: true })).toBeVisible();
    await expect(pane.getByRole('button', { name: '终端环境', exact: true })).toHaveCount(0);
    await settingsNav.getByRole('button', { name: '通用', exact: true }).click();
    await expect(win.getByRole('heading', { name: '命令行环境', exact: true })).toBeVisible();
    await capture('light-general-shell.png');
    await settingsNav.getByRole('button', { name: 'Harness 接入', exact: true }).click();
    await expect(pane.getByRole('button', { name: '添加自定义', exact: true })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: '注册聊天 Agent', exact: true })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: '注册新 runtime', exact: true })).toHaveCount(0);
    await select('Codex CLI');
    await capture('light-registration-hidden.png');
    expect(errors, errors.join('\n')).toEqual([]);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('Original retained.');
    fs.writeFileSync(path.join(shots, 'manifest.json'), JSON.stringify({ fixture, userData, screenshots, checks, errors, build: fs.statSync(path.join(project, 'out/renderer/index.html')).mtime.toISOString() }, null, 2));
  } finally {
    const processHandle = app.process();
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
    if (processHandle.exitCode === null && processHandle.pid && process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Owned fixture only. */ }
    }
  }
});
