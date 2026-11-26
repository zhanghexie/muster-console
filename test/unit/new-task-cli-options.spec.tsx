import { renderTask, enterTask } from './helpers/task-editor';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { ServiceView } from '../../src/renderer/src/components/ServiceView';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting, t } from '../../src/shared/i18n';
import { CLI_LAUNCH_ERROR_KEYS, CLI_LAUNCH_ERROR_FRAMES, localizeCliLaunchError } from '../../src/shared/cliLaunchError';
import { normalizeCliLaunchOptions } from '../../src/shared/cliLaunchOptions';
import type { AgentRuntimeEntry, WorkspaceInfo } from '../../src/shared/types';
import type { PromptTask } from '../../src/shared/types';
import type { HarnessPickerChoice } from '../../src/shared/harnessPicker';
import { resolveModelParameters } from '../../src/shared/modelParameters';
import { pickerCatalog } from './helpers/picker-catalog';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());

const runtimes = [{ id: 'codex', label: 'Codex', enabled: true, surface: 'pty' }] as AgentRuntimeEntry[];
const workspace = { id: 'ws', name: 'Workspace', path: 'E:/A', controlRoot: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A' }], defaultRootId: 'a', rootsRevision: 1 } as WorkspaceInfo;
const codexChoice: HarnessPickerChoice = { harnessId: 'codex', runtimeId: 'codex', surface: 'cli', label: 'Codex', available: true, status: 'available' };
const setPickerChoices = (choices: HarnessPickerChoice[]) => currentApiMock().override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices }));
const makeEfforts = (levels: Array<{ value: string; label: string }>) => resolveModelParameters({ runtimeId: 'codex', providerId: 'codex', modelId: 'fixture', parameters: [
  { id: 'reasoning', semantic: 'reasoning', label: '思考强度', apply: 'next-turn', supportsDefault: true, options: levels }
] }, []).controls;

beforeEach(() => {
  localStorage.clear();
  const api = currentApiMock();
  api.override('agentSession.getHarnessModelSelections', async () => ({}));
  api.override('agentSession.listCodexModels', async () => ({ ok: true, items: [{ id: 'gpt-test', displayName: 'Test model' }] }));
  api.override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  api.override('runtimes.availability', async () => ({ runtimes, acpAgents: [], checkedAt: 1 }));
  api.override('git.listRepoLocations', async () => ({ workspaceId: 'ws', rootsRevision: 1, repos: [], issues: [], issueCount: 0 }));
  setPickerChoices([codexChoice]);
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, { models: [
    { providerId: 'codex-gui', modelId: 'gpt-test', label: 'Test model', nativeLaunchModel: 'gpt-test' }
  ], controls: makeEfforts([{ value: 'high', label: 'high' }]) }));
});

async function confirmPicker() {
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '确认配置' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

async function pick(name: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name }));
  const list = await screen.findByRole('listbox', { name });
  fireEvent.click(within(list).getByRole('option', { name: item }));
}

it.each(['task', 'blank'])('CLI 选项传递给 %s 创建入口', async entry => {
  const onDelegate = vi.fn(async () => ({ notified: false, session: { id: 'id', name: 'x', type: 'terminal' as const, createdAt: 0 } }));
  const onBlankSession = vi.fn(async () => {});
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={onDelegate} onBlankSession={onBlankSession} />);
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Test model' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'high' }));
  await confirmPicker();
  fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
  expect(screen.getByRole('switch', { name: '配置权限' }).getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByRole('button', { name: '启动权限' })).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: '配置权限' }));
  expect(screen.queryByRole('button', { name: '引擎模式' })).toBeNull();
  await pick('启动权限', 'on-request');
  const expected = { model: 'gpt-test', permission: 'on-request', reasoning: 'high' };
  if (entry === 'task') {
    enterTask(screen.getByRole('textbox', { name: '任务' }), 'do work');
    await waitFor(() => expect((screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '开始任务' }));
    await waitFor(() => expect(onDelegate).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'codex', advanced: { configurePermissions: true, cliLaunchOptions: expected } })));
  } else {
    await waitFor(() => expect((screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
    await waitFor(() => expect(onBlankSession).toHaveBeenCalledWith('codex', '', { configurePermissions: true, cliLaunchOptions: expected }, expect.any(Object)));
  }
});

it('关闭配置权限时创建 CLI 不再发送隐藏的手动权限和沙箱限制', async () => {
  const blank = vi.fn(async () => {});
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}}
    onDelegate={async () => ({ notified: false })} onBlankSession={blank} />);
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Test model' }));
  await confirmPicker();
  fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
  const toggle = screen.getByRole('switch', { name: '配置权限' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByRole('button', { name: '启动权限' })).toBeNull();
  fireEvent.click(toggle);
  await pick('启动权限', 'on-request');
  await pick('沙箱', 'read-only');
  fireEvent.click(toggle);
  expect(screen.queryByRole('button', { name: '启动权限' })).toBeNull();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '新建空白' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(blank).toHaveBeenCalledWith('codex', '', {
    configurePermissions: false, cliLaunchOptions: { model: 'gpt-test' }
  }, expect.any(Object)));
});

it.each([true, false])('定时 CLI 编辑保留启动参数，并保存配置权限=%s', async enabled => {
  const api = currentApiMock();
  const task: PromptTask = { id: 'scheduled-cli', name: 'CLI review', prompt: 'review work', workspaceId: workspace.id,
    sourceRoot: { rootId: 'a', path: workspace.path, cwd: workspace.path }, runtime: 'codex',
    schedule: { kind: 'daily', time: '09:00' }, enabled: false, createdAt: 1, configurePermissions: true,
    cliLaunchOptions: { model: 'gpt-test', permission: 'on-request', mode: 'read-only' } };
  api.override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
  api.override('config.get', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' }));
  api.override('runtimes.list', async () => runtimes);
  api.override('services.get', async () => task);
  api.override('services.runs', async () => ({ runs: [] }));
  api.override('services.update', async (_id, patch) => ({ ...task, ...patch }));
  render(<StoreProvider><ServiceView serviceId={task.id} /></StoreProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '编辑任务' }));
  await screen.findByRole('dialog', { name: '编辑任务' });
  fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
  expect(screen.getByRole('switch', { name: '配置权限' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: '启动权限' }).textContent).toContain('on-request');
  expect(screen.getByRole('button', { name: '沙箱' }).textContent).toContain('read-only');
  await waitFor(() => expect(screen.getByRole('button', { name: '选择 Harness 和模型' }).textContent).toContain('Test model'));
  if (enabled) await pick('启动权限', 'untrusted');
  else fireEvent.click(screen.getByRole('switch', { name: '配置权限' }));
  const apply = screen.getByRole<HTMLButtonElement>('button', { name: '保存' });
  await waitFor(() => expect(apply.disabled).toBe(false));
  fireEvent.click(apply);
  fireEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
  await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith(task.id, expect.objectContaining({
    configurePermissions: enabled, cliLaunchOptions: enabled
      ? { model: 'gpt-test', permission: 'untrusted', mode: 'read-only' }
      : { model: 'gpt-test' }
  })));
});

it('Codex CLI 换模型后仅显示该模型支持的档位并清除旧档', async () => {
  const row = (id: string, value: string) => ({ id, displayName: id, parameters: [{
    id: 'reasoning', semantic: 'reasoning', label: '思考强度', apply: 'next-turn', supportsDefault: true,
    options: [{ value, label: value }]
  }] });
  currentApiMock().override('agentSession.listCodexModels', async () => ({
    ok: true, items: [row('high-model', 'high'), row('low-model', 'low')]
  }));
  currentApiMock().override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, { models: ['high-model', 'low-model'].map(modelId =>
    ({ providerId: 'codex-gui', modelId, label: modelId, nativeLaunchModel: modelId })), controls: makeEfforts(
      request.model?.modelId === 'high-model' ? [{ value: 'high', label: 'high' }] : [{ value: 'low', label: 'low' }]) }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}}
    onDelegate={async () => ({ notified: false })} onBlankSession={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.click(await screen.findByRole('option', { name: 'high-model' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'high' }));
  await confirmPicker();
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(await screen.findByRole('option', { name: 'low-model' }));
  await confirmPicker();
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  expect(await screen.findByRole('radio', { name: 'low' })).toBeTruthy();
  expect(screen.queryByRole('radio', { name: 'high' })).toBeNull();
  expect(screen.queryByRole('radio', { name: 'xhigh' })).toBeNull();
});

it('模型 ID 非法时不能创建，切换 CLI 后不带入旧引擎配置', async () => {
  const entries = [...runtimes, { id: 'gemini', label: 'Gemini', enabled: true, surface: 'pty' } as AgentRuntimeEntry];
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: entries, acpAgents: [], checkedAt: 1 }));
  setPickerChoices([codexChoice, { ...codexChoice, harnessId: 'gemini', runtimeId: 'gemini', label: 'Gemini' }]);
  const blank = vi.fn(async () => {});
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={entries} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={blank} />);
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.change(await screen.findByRole('textbox', { name: '模型 ID' }), { target: { value: 'bad & value' } });
  expect(getTipSnapshot()?.text).toContain('模型 ID 无效');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认配置' }).disabled).toBe(true);
  try {
    await act(async () => { applyLocaleSetting('en'); });
    expect(getTipSnapshot()?.text).toBe('Invalid CLI model ID, or this engine does not support specifying a model at launch.');
  } finally { await act(async () => { applyLocaleSetting('zh-CN'); }); }
  fireEvent.click(screen.getByRole('tab', { name: 'Gemini' }));
  expect((await screen.findByRole<HTMLInputElement>('textbox', { name: '模型 ID' })).value).toBe('');
  await confirmPicker();
  await waitFor(() => expect((screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(blank).toHaveBeenCalledWith('gemini', '', { configurePermissions: false }, expect.any(Object)));
});

it('localizes known CLI errors at the display boundary without changing validation or unknown details', () => {
  applyLocaleSetting('en');
  try {
    for (const key of CLI_LAUNCH_ERROR_KEYS) expect(t(key)).not.toBe(key);
    for (const item of CLI_LAUNCH_ERROR_FRAMES) expect(localizeCliLaunchError(`${item.prefix}example${item.suffix}`)).toContain('example');
    expect(() => normalizeCliLaunchOptions('codex', { model: 'bad value' })).toThrow('CLI 模型 ID 无效或该引擎暂不支持启动时指定模型');
    expect(localizeCliLaunchError("Error invoking remote method 'tasks:delegate': Error: CLI 启动参数 --model 缺少值")).toBe('The CLI launch argument --model is missing a value.');
    expect(localizeCliLaunchError('Error: 第三方原始错误')).toBe('Error: 第三方原始错误');
  } finally { applyLocaleSetting('zh-CN'); }
});

it('updates the model catalog error in the new-task dialog without changing the returned error', async () => {
  const entries = [{ id: 'acp', label: 'ACP', enabled: true, surface: 'chat' },
    { id: 'kimi-cli', label: 'Kimi Code CLI', enabled: true, surface: 'pty' }] as AgentRuntimeEntry[];
  const api = currentApiMock();
  const failure = { ok: false as const, error: 'ACP 模型目录 超时' };
  api.override('runtimes.availability', async () => ({ runtimes: entries, acpAgents: [{ id: 'kimi', name: 'Kimi Code' }], checkedAt: 1 }));
  api.override('agentSession.listAcpModels', async () => failure);
  const view = renderTask(<NewTaskDialog open workspace={workspace} runtimes={entries} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={async () => {}} />);
  try {
    expect((await screen.findAllByText(failure.error)).length).toBeGreaterThan(0);
    act(() => { applyLocaleSetting('en'); });
    expect(screen.getAllByText('ACP model catalog timed out.').length).toBeGreaterThan(0);
    expect(failure.error).toBe('ACP 模型目录 超时');
  } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
});

it('Kimi CLI 复用 GUI 的模型和模型相关思考强度，并把选择传给任务', async () => {
  const entries = [{ id: 'acp', label: 'ACP', enabled: true, surface: 'chat' },
    { id: 'kimi-cli', label: 'Kimi Code CLI', enabled: true, surface: 'pty' }] as AgentRuntimeEntry[];
  const api = currentApiMock();
  api.override('runtimes.availability', async () => ({ runtimes: entries, acpAgents: [{ id: 'kimi', name: 'Kimi Code' }], checkedAt: 1 }));
  api.override('agentSession.listAcpModels', async () => ({ ok: true, items: [
    { id: 'zhipu/glm-5.3', name: 'GLM-5.3' }, { id: 'zhipu/glm-flash', name: 'GLM-5.3-Flash' }
  ] }));
  api.override('agentSession.describeModelParameters', async ({ modelId }: { modelId?: string }) => ({ runtimeId: 'acp', providerId: 'acp:kimi', modelId: modelId ?? '',
    parameters: [{ id: 'reasoning', semantic: 'reasoning', label: '思考强度', apply: 'reconnect', supportsDefault: true, defaultValue: 'high',
      options: [{ value: 'low', label: 'Thinking Low' }, { value: 'high', label: 'Thinking High' }] }] }));
  setPickerChoices([
    { harnessId: 'kimi', surface: 'gui', runtimeId: 'acp', acpPresetId: 'kimi', label: 'Kimi Code', available: true, status: 'available' },
    { harnessId: 'kimi', surface: 'cli', runtimeId: 'kimi-cli', label: 'Kimi Code CLI', available: true, status: 'available' }
  ]);
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, { models: [
    { providerId: 'acp', modelId: 'zhipu/glm-5.3', label: 'GLM-5.3', nativeLaunchModel: 'zhipu/glm-5.3' },
    { providerId: 'acp', modelId: 'zhipu/glm-flash', label: 'GLM-5.3-Flash', nativeLaunchModel: 'zhipu/glm-flash' }
  ], controls: makeEfforts([{ value: 'low', label: 'Thinking Low' }, { value: 'high', label: 'Thinking High' }]), canRefresh: true }));
  const delegate = vi.fn(async () => ({ notified: false, session: { id: 'id', name: 'x', type: 'terminal' as const, createdAt: 0 } }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={entries} onClose={() => {}} onDelegate={delegate} onBlankSession={async () => {}} />);
  await waitFor(() => expect(api.mockOf('agentSession.listAcpModels')).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'kimi', refresh: false })));
  await waitFor(() => expect((screen.getByRole('button', { name: '选择 Harness 和模型' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  expect(await screen.findByRole('option', { name: 'GLM-5.3' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('dialog', { name: '选择 Harness 和模型' })).getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.click(await screen.findByRole('option', { name: 'GLM-5.3' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'Thinking Low' }));
  expect(api.mockOf('agentSession.listAcpModels')).not.toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  fireEvent.click(screen.getByRole('button', { name: '刷新模型目录' }));
  await waitFor(() => expect(api.mockOf('agentSession.readHarnessPickerCatalog')).toHaveBeenCalledWith(expect.objectContaining({ model: { providerId: 'acp', modelId: 'zhipu/glm-5.3' }, refresh: true })));
  await confirmPicker();
  expect(screen.getByRole('button', { name: '引擎模式' }).closest('.agent-composer-toolbar')).toBeTruthy();
  await pick('引擎模式', '计划');
  expect(await screen.findByText('设置思考强度时，Kimi 会准备并接续会话，MCP 和会话钩子会额外启动一次。')).toBeTruthy();
  expect(screen.getByText('此 CLI 未提供可靠的免审批参数，终端内仍可能要求确认。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
  expect(screen.getByRole('switch', { name: '配置权限' }).getAttribute('aria-checked')).toBe('false');
  enterTask(screen.getByRole('textbox', { name: '任务' }), 'do work');
  await waitFor(() => expect((screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '开始任务' }));
  await waitFor(() => expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'kimi-cli',
    advanced: { configurePermissions: false, cliLaunchOptions: { model: 'zhipu/glm-5.3', reasoning: 'low', mode: 'plan' } } })));
});
