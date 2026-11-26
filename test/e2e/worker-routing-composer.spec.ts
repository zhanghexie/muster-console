import { _electron, expect, test as base } from '@playwright/test';
import type { AppContext } from './fixtures/electron';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureLlm } from './helpers/available-workers';
import { defaultRootFor } from '../../src/shared/workspaceRoots';
import { workerModelMentions } from '../../src/shared/workerModelMention';
import { harnessModelSelectionKey } from '../../src/shared/harnessModelSelection';
import type { WorkerRoutingLayer } from '../../src/shared/workerRouting';

const project = path.resolve(__dirname, '../..');
const test = base.extend<{}, { appCtx: AppContext }>({
  appCtx: [async ({}, use) => {
    const fixtureRoot = path.join(project, '.tmp');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(fixtureRoot, 'worker-routing-e2e-'));
    const userData = path.join(cwd, '.dev-sandbox/userData');
    const workspacePath = path.join(cwd, '.dev-sandbox/workspaces/demo-frontend');
    const runtimePath = path.join(userData, 'agent-runtimes');
    const profile = path.join(userData, 'capability-home');
    const appData = path.join(profile, 'AppData', 'Roaming'), localAppData = path.join(profile, 'AppData', 'Local');
    for (const directory of [runtimePath, appData, localAppData, path.join(profile, 'Documents'), path.join(profile, 'Desktop')]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const registry = JSON.parse(fs.readFileSync(path.join(project, 'src/main/runtime/builtins/registry.json'), 'utf8')) as {
      runtimes: Array<{ id: string; enabled: boolean }>;
    };
    for (const runtime of registry.runtimes) runtime.enabled = runtime.id === 'pi';
    fs.writeFileSync(path.join(runtimePath, 'registry.json'), JSON.stringify(registry));
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      locale: 'zh-CN', defaultRuntime: 'pi', activeWorkspaceId: 'demo-frontend', workspace: workspacePath,
      workspaces: [{ id: 'demo-frontend', name: 'Routing fixture', path: workspacePath }],
      llm: { ...fixtureLlm, providers: fixtureLlm.providers.map(provider => ({ ...provider,
        thinking: { levels: { low: 'low', medium: 'medium', high: 'high' } },
        models: [...provider.models, { id: 'fixture-alternate', name: 'Fixture alternate', reasoning: true }]
      })) }, mcp: { enabled: false, servers: [] }, webAccess: { enabled: false }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
    Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd),
      APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: profile, HOME: profile,
      XDG_CONFIG_HOME: path.join(profile, '.config'), XDG_DATA_HOME: path.join(profile, '.local', 'share'),
      XDG_CACHE_HOME: path.join(profile, '.cache') });
    const app = await _electron.launch({ executablePath: createRequire(__filename)('electron'), args: [project], cwd, env, timeout: 25_000 });
    const startupErrors: string[] = [];
    app.process().stderr?.on('data', chunk => { startupErrors.push(String(chunk)); if (startupErrors.length > 12) startupErrors.shift(); });
    try {
      const win = await app.firstWindow();
      const consoleErrors: string[] = [];
      win.on('pageerror', error => consoleErrors.push(error.message));
      const boot = await win.evaluate(() => window.api.app.bootWait()).catch(error => {
        throw new Error(`${String(error)}\n${startupErrors.join('')}`);
      });
      if (!boot.ok) throw new Error(`Isolated Electron boot failed: ${boot.error}\n${startupErrors.join('')}`);
      await win.locator('.app-shell').waitFor({ timeout: 60_000 });
      await use({ app, win, consoleErrors });
    } finally {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
  }, { scope: 'worker' }]
});

test('saves global Worker routing, overrides and restores inheritance, and keeps exact model references', async ({ appCtx }) => {
  const { win: page, app } = appCtx;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1380, 980));
  const workspace = await page.evaluate(async () => {
    const config = await window.api.config.get();
    return config.workspaces.find(item => item.id === config.activeWorkspaceId);
  });
  if (!workspace) throw new Error('The Electron test sandbox needs a registered source folder.');
  const scope = { workspaceId: workspace.id, rootId: defaultRootFor(workspace).id, rootsRevision: workspace.rootsRevision ?? 0 };
  const readPool = (layer: WorkerRoutingLayer) => page.evaluate(args => window.api.workerRouting.read(args), { scope, layer });
  const chooseFixtureModel = async (name: string, confirm: string) => {
    const dialog = page.getByRole('dialog', { name });
    await dialog.getByRole('tab', { name: 'Muster Core', exact: true }).click();
    await dialog.getByRole('option', { name: 'Fixture model', exact: true }).click();
    await dialog.getByRole('button', { name: confirm }).click();
    await expect(dialog).toBeHidden();
  };

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: 'Harness 接入', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 2, name: '引擎配置', exact: true })).toBeVisible();
  await expect(settings.getByRole('heading', { level: 2, name: '自动派活', exact: true })).toBeVisible();
  const globalTab = settings.getByRole('button', { name: '全局默认', exact: true });
  const workspaceTab = settings.getByRole('button', { name: '仅当前工作区', exact: true });
  const globalPane = settings.locator('.worker-routing-pane[data-layer="global"]');
  const workspacePane = settings.locator('.worker-routing-pane[data-layer="workspace"]');
  await expect(globalTab).toHaveAttribute('aria-pressed', 'true');
  const saveButton = settings.locator('.settings-savebar').getByRole('button', { name: /^保存(?:\s*Ctrl\s*S)?$/ });
  const saveSettings = async () => {
    await expect(saveButton).toBeEnabled();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(saveButton).toBeHidden();
  };

  const low = globalPane.getByRole('group', { name: '低', exact: true });
  await low.getByRole('button', { name: '为低添加候选', exact: true }).click();
  await chooseFixtureModel('添加候选配置', '确认配置');
  await saveSettings();
  const saved = await readPool('global');
  expect(saved).toMatchObject({ origin: 'global', config: { revision: 1 } });
  expect(saved.config.tiers[0]).toMatchObject({ kind: 'low', name: '低',
    members: [{ enabled: true, config: { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui',
      model: { providerId: 'fixture', modelId: 'fixture-model' } } }] });
  await expect(globalPane.getByText('派活配置已保存', { exact: true })).toBeVisible();

  await workspaceTab.click();
  const following = workspacePane.getByText('当前工作区跟随全局默认', { exact: true });
  await expect(following).toBeVisible();
  const inherited = await readPool('workspace');
  expect(inherited).toMatchObject({ origin: 'global', config: saved.config });
  await expect(workspacePane.getByRole('group', { name: '低', exact: true }).getByRole('list', { name: '候选顺序' })).toBeVisible();

  await workspacePane.getByRole('button', { name: '仅此工作区留空', exact: true }).click();
  expect((await readPool('workspace')).version).toBe(inherited.version);
  await saveSettings();
  await expect(workspacePane.getByText('当前工作区有独立派活配置', { exact: true })).toBeVisible();
  const emptyOverride = await readPool('workspace');
  expect(emptyOverride).toMatchObject({ origin: 'workspace', config: { tiers: [] } });
  expect(emptyOverride.version).not.toBe(inherited.version);
  expect((await readPool('global')).config).toEqual(saved.config);

  await workspacePane.getByRole('button', { name: '恢复跟随全局', exact: true }).click();
  await expect(workspacePane.getByText('已保存的全局默认', { exact: true })).toBeVisible();
  expect((await readPool('workspace')).version).toBe(emptyOverride.version);
  await saveSettings();
  await expect(following).toBeVisible();
  const restored = await readPool('workspace');
  expect(restored).toMatchObject({ origin: 'global', config: saved.config });
  expect(restored.version).not.toBe(inherited.version);
  expect(await page.evaluate(async id => Object.hasOwn((await window.api.config.get()).workerRoutingByWorkspace ?? {}, id), scope.workspaceId)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  const countSessions = () => page.evaluate(async () => (await window.api.sessions.list()).sessions.length);
  const initialSessions = await countSessions();
  await page.getByText('工作会话', { exact: true }).first().hover();
  await page.getByTitle(/新建任务（先填任务再拉起会话）/).click();
  const newTask = page.getByRole('dialog', { name: '新建任务' });
  const taskText = 'Configuration confirmation must preserve this task';
  const taskEditor = newTask.getByRole('textbox', { name: '任务' });
  await taskEditor.fill('/');
  const suggestions = page.locator('.task-composer-flyout').getByRole('listbox');
  await expect(suggestions.getByRole('option').first()).toBeVisible();
  const listBox = await suggestions.boundingBox();
  const shellBox = await newTask.locator('.chat-input-shell').boundingBox();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(shellBox!.y - 3);
  await taskEditor.press('Escape');
  await expect(suggestions).toBeHidden();
  await taskEditor.fill(taskText);
  const permissionChip = newTask.getByRole('button', { name: '权限模式' });
  await permissionChip.click();
  const permissionMenu = page.getByRole('dialog', { name: '权限模式' });
  await permissionMenu.getByRole('switch', { name: '配置权限' }).click();
  await permissionMenu.getByRole('menuitemradio', { name: '计划模式' }).click();
  await expect(permissionChip).toContainText('计划模式');
  await expect(permissionMenu).toBeHidden();

  await newTask.getByRole('button', { name: '选择 Harness 和模型' }).click();
  const picker = page.getByRole('dialog', { name: '选择 Harness 和模型' });
  const model = picker.getByRole('option', { name: 'Fixture model', exact: true });
  await model.click();
  await expect(picker.getByRole('button', { name: '确认配置' })).toBeEnabled();
  const parameter = picker.getByRole('radio', { checked: true }).first();
  if (await parameter.count()) await parameter.press('Enter');
  else await model.press('Enter');
  await expect(newTask.getByRole('textbox', { name: '任务' })).toHaveText(taskText);
  await expect(newTask.getByRole('button', { name: '选择 Harness 和模型' })).toBeFocused();
  expect(await countSessions()).toBe(initialSessions);
  await newTask.getByRole('button', { name: '关闭新建任务' }).click();
  await expect(newTask).toBeHidden();

  const openComposer = async () => {
    await page.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
    const composer = page.locator('.agent-float-panel .chat-input-shell');
    await expect(composer).toBeVisible();
    return composer;
  };
  const composer = await openComposer();
  const editor = composer.locator('.composer-editable');
  await editor.pressSequentially('Use /harness');
  await expect(page.locator('.agent-float-panel').getByRole('option', { name: /\/harness/ })).toBeVisible();
  await editor.press('Enter');
  await chooseFixtureModel('插入模型引用', '插入引用');
  const chip = editor.locator('.composer-token.is-model');
  const raw = await chip.getAttribute('data-token');
  if (!raw) throw new Error('The model picker did not insert a reference.');
  const mention = workerModelMentions(raw)[0]?.mention;
  if (!mention) throw new Error('The model picker did not insert a durable reference.');
  expect(mention.targetRef).toMatch(/^wr1\.[A-Za-z0-9_-]{32}$/);
  const checked = await page.evaluate(args => window.api.workerRouting.validate(args), { scope, targetRef: mention.targetRef });
  expect(checked.config).toEqual(saved.config.tiers[0].members[0].config);
  await composer.getByRole('button', { name: '留待确认', exact: true }).click();
  await expect(chip).toHaveCount(0);

  await page.reload();
  await page.locator('.app-shell').waitFor();
  const reopened = await openComposer();
  await reopened.getByRole('button', { name: '取回输入框编辑' }).click();
  await expect(reopened.locator('.composer-token.is-model')).toHaveAttribute('data-token', raw);
  await expect.poll(async () => (await readPool('workspace')).config.tiers[0]?.members[0]?.id).toBe(saved.config.tiers[0].members[0].id);
  await page.evaluate(key => window.api.agentSession.setHarnessModelSelection({ key, modelIds: [] }), harnessModelSelectionKey('pi'));
  await expect(page.evaluate(args => window.api.workerRouting.validate(args), { scope, targetRef: mention.targetRef })).rejects.toThrow();
  await reopened.locator('.composer-editable').press('Enter');
  await expect(page.locator('.app-tip-region[role=status]')).toContainText('已失效');
  await expect(reopened.locator('.composer-token.is-model')).toHaveAttribute('data-token', raw);

  await page.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
  const sessionId = await page.evaluate(async scope => {
    await window.api.agentSession.setHarnessModelSelection({ key: 'runtime:pi', modelIds: null });
    const session = await window.api.sessions.create({ ...scope, runtime: 'pi', name: 'Picker fixture session' });
    await window.api.sessions.select(session.id);
    return session.id as string;
  }, scope);
  const sessionPicker = page.locator('.agent-chat-view:visible').getByRole('button', { name: '模型与参数' });
  await sessionPicker.click();
  const modelMenu = page.getByRole('dialog', { name: '模型与参数' });
  await expect(modelMenu.getByRole('tablist', { name: 'Harness' })).toHaveCount(0);
  await modelMenu.getByRole('option', { name: 'Fixture alternate' }).click();
  await modelMenu.getByRole('radio', { name: '高', exact: true }).click();
  expect((await page.evaluate(id => window.api.agentSession.historyRange(id), sessionId))?.modelOverride ?? null).toBeNull();
  await modelMenu.getByRole('radio', { name: '高', exact: true }).press('Enter');
  await expect(modelMenu).toBeHidden();
  await expect.poll(async () => (await page.evaluate(id => window.api.agentSession.getModelParameters(id), sessionId))
    ?.controls.find(control => control.descriptor.id === 'reasoning')?.override).toBe('high');
  const final = await page.evaluate(id => window.api.agentSession.historyRange(id), sessionId);
  expect(final?.modelOverride).toMatchObject({ providerId: 'fixture', modelId: 'fixture-alternate' });
  expect(final?.messages ?? []).toEqual([]);
  expect(appCtx.consoleErrors).toEqual([]);
});
