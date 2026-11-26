import { renderTask } from './helpers/task-editor';
import { getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { HarnessModelPicker } from '../../src/renderer/src/components/HarnessModelPicker';
import { CreateWorkspaceModal } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';
import { resolveModelParameters, type ModelParameterContext } from '../../src/shared/modelParameters';
import type { HarnessPickerRequest, HarnessPickerResult } from '../../src/shared/harnessPicker';
import type { AgentRuntimeEntry, WorkspaceInfo } from '../../src/shared/types';

vi.mock('../../src/renderer/src/avatarAccent', () => ({ extractAvatarAccent: async () => null }));
const workspace: WorkspaceInfo = { id: 'ws', name: 'Workspace', path: 'E:/A', controlRoot: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A', label: 'Unused' }, { id: 'b', path: 'D:/B' }], defaultRootId: 'b', rootsRevision: 2 };
const runtimes = [{ id: 'codex-gui', label: 'Codex', enabled: true, surface: 'chat' }, { id: 'cli', label: 'CLI', enabled: true, surface: 'pty' }] as AgentRuntimeEntry[];
const context: ModelParameterContext = { runtimeId: 'codex-gui', providerId: 'codex-gui', modelId: 'actual-model',
  parameters: [{ id: 'reasoning', semantic: 'reasoning', label: '思考强度', apply: 'next-turn', supportsDefault: true,
    options: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }] }] };
const models = [{ providerId: 'codex-gui', modelId: 'actual-model', label: 'Actual model' }];
const controls = resolveModelParameters(context, []).controls;
const choices = [{ harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui', label: 'Codex', available: true, status: 'available' }];
beforeEach(() => {
  localStorage.clear();
  currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  currentApiMock().override('runtimes.availability', async () => ({ runtimes, acpAgents: [], checkedAt: 1 }));
  currentApiMock().override('agentSession.listCodexModels', async () => ({ ok: true, items: [{ id: 'actual-model', displayName: 'Actual model' }], defaultModelId: 'actual-model', source: 'app-server' }));
  currentApiMock().override('agentSession.describeModelParameters', async target => ({ ...context, runtimeId: target.runtimeId }));
  currentApiMock().override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices }));
  currentApiMock().override('agentSession.readHarnessPickerCatalog', async (request: HarnessPickerRequest) =>
    pickerCatalog(request, { models, controls }));
});
const pick = async (name: string, option: string) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  const menu = await screen.findByRole('listbox', { name });
  expect(menu.classList.contains('c-select-menu')).toBe(true);
  await act(async () => fireEvent.click(within(menu).getByRole('option', { name: option })));
};

it('名称置顶、模式与运行方式同组，重要字段直接显示且全用自有下拉', async () => {
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={async () => {}} />);
  const name = screen.getByRole('textbox', { name: /会话名称/ });
  const task = screen.getByRole('textbox', { name: '任务' });
  expect(name.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const trigger = screen.getByRole('button', { name: '选择 Harness 和模型' });
  expect(trigger.closest('.agent-composer-toolbar')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '会话模式' })).toBeNull();
  expect(screen.queryByRole('button', { name: '会话模型' })).toBeNull();
  expect(document.querySelector('.new-task-dialog select')).toBeNull();
  expect(screen.queryByRole('button', { name: '更多选项' })).toBeNull();
  expect(screen.getByRole('button', { name: '开始任务' }).closest('.agent-composer-toolbar')).toBe(trigger.closest('.agent-composer-toolbar'));
  expect(currentApiMock().mockOf('agentSession.readHarnessPickerCatalog'), '表单态不提前读取 picker 目录').not.toHaveBeenCalled();
  fireEvent.click(trigger);
  await waitFor(() => expect(currentApiMock().mockOf('agentSession.readHarnessPickerCatalog'))
    .toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ workspaceId: 'ws', rootId: 'b', rootsRevision: 2 }) })));
});

it('模型目录刷新事件让已打开的新建任务读取共享缓存', async () => {
  const api = currentApiMock();
  let catalogModels = models;
  api.override('agentSession.readHarnessPickerCatalog', async (request: HarnessPickerRequest) =>
    pickerCatalog(request, { models: catalogModels, controls }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '选择 Harness 和模型' }));
  const picker = await screen.findByRole('dialog', { name: '选择 Harness 和模型' });
  await within(picker).findByRole('option', { name: 'Actual model' });
  expect(within(picker).queryByRole('option', { name: 'Shared model' })).toBeNull();
  catalogModels = [{ providerId: 'codex-gui', modelId: 'shared-model', label: 'Shared model' }];
  act(() => api.emit('agentSession:modelCatalogUpdated', { runtimeId: 'codex-gui', workspaceId: 'ws', rootId: 'b' }));
  expect(await screen.findByRole('option', { name: 'Shared model' })).toBeTruthy();
});

it('选择具体模型后保留选择器，并自动发现思考强度', async () => {
  const api = currentApiMock();
  api.override('agentSession.readHarnessPickerCatalog', async (request: HarnessPickerRequest) =>
    pickerCatalog(request, { models, ...(request.model ? { controls } : {}) }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '选择 Harness 和模型' }));
  const picker = await screen.findByRole('dialog', { name: '选择 Harness 和模型' });
  expect(within(picker).queryByRole('group', { name: '模型参数' })).toBeNull();
  fireEvent.click(await within(picker).findByRole('option', { name: 'Actual model' }));
  expect(screen.getByRole('dialog', { name: '选择 Harness 和模型' })).toBeTruthy();
  expect(await screen.findByRole('group', { name: '模型参数' })).toBeTruthy();
});

it('切换模型时保留参数列，迟到的旧参数不能覆盖新模型', async () => {
  const api = currentApiMock();
  const controlsFor = (value: string) => resolveModelParameters({ runtimeId: 'codex-gui', providerId: 'codex-gui', modelId: 'actual-model',
    parameters: [{ id: 'reasoning', semantic: 'reasoning', label: '思考强度', apply: 'next-turn', supportsDefault: true,
      options: [{ value, label: value }] }] }, []).controls;
  const rows = [{ providerId: 'codex-gui', modelId: 'model-a', label: 'Model A' },
    { providerId: 'codex-gui', modelId: 'model-b', label: 'Model B' }];
  const reads: Array<{ request: HarnessPickerRequest; finish: (value: HarnessPickerResult) => void }> = [];
  api.override('agentSession.readHarnessPickerCatalog', (request: HarnessPickerRequest) => request.model
    ? new Promise(resolve => { reads.push({ request, finish: resolve }); })
    : Promise.resolve(pickerCatalog(request, { models: rows, controls: controlsFor('旧档') })));
  const confirm = vi.fn(() => ({ ok: true }));
  render(<HarnessModelPicker target={{ sessionId: 'preview-session' }} confirmLabel="Confirm" onCancel={vi.fn()} onConfirm={confirm} />);
  const old = await screen.findByRole<HTMLButtonElement>('radio', { name: '旧档' });
  const column = old.closest('[data-picker-column="parameters"]');
  const first = screen.getByRole('option', { name: '跟随引擎默认' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  const second = screen.getByRole('option', { name: 'Model A' });
  expect(document.activeElement).toBe(second);
  expect(old.closest('[data-picker-column="parameters"]')).toBe(column);
  expect(column?.isConnected).toBe(true);
  expect(old.disabled).toBe(true);
  expect(column?.querySelector('[aria-busy="true"]')?.textContent).toContain('读取中…');
  expect(column?.querySelector('[aria-checked="true"]')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '模型参数' }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' }).disabled).toBe(true);
  fireEvent.keyDown(second, { key: 'ArrowDown' });
  const third = screen.getByRole('option', { name: 'Model B' });
  expect(document.activeElement).toBe(third);
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[0].finish(pickerCatalog(reads[0].request, { models: rows, controls: controlsFor('过时档') })));
  expect(screen.queryByRole('radio', { name: '过时档' })).toBeNull();
  fireEvent.keyDown(third, { key: 'ArrowRight' });
  await act(async () => reads[1].finish(pickerCatalog(reads[1].request, { models: rows, controls: controlsFor('新档') })));
  const current = screen.getByRole('radio', { name: '新档' });
  expect(current.closest('[data-picker-column="parameters"]')).toBe(column);
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: '跟随默认' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  fireEvent.keyDown(current, { key: 'Enter' });
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: expect.objectContaining({ modelId: 'model-b' }), parameters: { reasoning: '新档' } }));
});

it('空任务也可按姓名、实际模型、模式和思考强度创建空白；CLI 不携 GUI 字段', async () => {
  const blank = vi.fn(async (..._args: unknown[]) => {});
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={blank} />);
  fireEvent.change(screen.getByRole('textbox', { name: /会话名称/ }), { target: { value: '  Review  ' } });
  fireEvent.click(await screen.findByRole('button', { name: '选择 Harness 和模型' }));
  const picker = await screen.findByRole('dialog', { name: '选择 Harness 和模型' });
  fireEvent.click(await within(picker).findByRole('option', { name: 'Actual model' }));
  const effort = await within(picker).findByRole('radio', { name: '高' });
  await waitFor(() => expect((effort as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(effort);
  const confirm = within(picker).getByRole('button', { name: '确认配置' });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect((screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(blank).toHaveBeenCalledWith('codex-gui', 'Review', {
    configurePermissions: false,
    model: { providerId: 'codex-gui', modelId: 'actual-model' },
    modelParameters: { reasoning: 'high' }
  }, { workspaceId: 'ws', rootId: 'b', rootsRevision: 2 }));
});

it('目录晚返回不能覆盖新来源，模型目录失败显示原因且可跟随默认', async () => {
  const api = currentApiMock();
  const reads: Array<{ request: HarnessPickerRequest; finish: (value: HarnessPickerResult) => void }> = [];
  api.override('agentSession.readHarnessPickerCatalog', (request: HarnessPickerRequest) =>
    'source' in request && request.source.rootId === 'b'
      ? new Promise(resolve => { reads.push({ request, finish: resolve }); })
      : Promise.resolve({ ok: false, error: 'catalog offline' }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={async () => ({ notified: false })} onBlankSession={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '选择 Harness 和模型' }));
  await waitFor(() => expect(reads.length).toBeGreaterThan(0));
  const late = reads[0];
  fireEvent.click(within(await screen.findByRole('dialog', { name: '选择 Harness 和模型' })).getByRole('button', { name: '取消' }));
  await pick('运行位置', 'E:/A');
  fireEvent.click(await screen.findByRole('button', { name: '选择 Harness 和模型' }));
  const picker = await screen.findByRole('dialog', { name: '选择 Harness 和模型' });
  await act(async () => late.finish(pickerCatalog(late.request, { models, controls })));
  await waitFor(() => expect(getTipSnapshot()?.text).toBe('catalog offline'));
  expect(within(picker).queryByRole('option', { name: 'Actual model' })).toBeNull();
  expect((within(picker).getByRole('button', { name: '确认配置' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(picker).getByRole('button', { name: '取消' }));
  expect((await screen.findByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  expect(screen.getByRole('tab', { name: 'CLI' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('button', { name: '会话模式' })).toBeNull();
  expect(screen.queryByRole('button', { name: '会话模型' })).toBeNull();
});

it('工作区首屏简洁，头像与更多设置收起不可聚焦，展开草稿保留且动画可反转', async () => {
  render(<CreateWorkspaceModal mode="edit" initial={workspace} onSave={async () => {}} onClose={() => {}} />);
  const settings = document.getElementById('create-ws-settings')!;
  expect(settings.hasAttribute('inert')).toBe(true); expect(settings.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('button', { name: '已启用' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更换头像' }));
  expect(document.getElementById('create-ws-avatar-options')!.classList.contains('is-open')).toBe(true);
  fireEvent.click(screen.getByRole('option', { name: '新闻' }));
  fireEvent.click(screen.getByRole('button', { name: '更换头像' }));
  expect(document.getElementById('create-ws-avatar-options')!.hasAttribute('inert')).toBe(true);
  expect(screen.getByRole('button', { name: '更换头像' }).querySelector('img')?.getAttribute('src')).toContain('/news.webp');
  fireEvent.click(screen.getByRole('button', { name: '更多设置' }));
  expect(settings.hasAttribute('inert')).toBe(false); expect(settings.classList.contains('is-open')).toBe(true);
  expect(screen.queryByText('代码索引')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更多设置' }));
  fireEvent.click(screen.getByRole('button', { name: '更多设置' }));
  expect(settings.classList.contains('is-open')).toBe(true);
  expect(document.querySelector('input[aria-label="文件夹显示名称"]')).toBeNull();
});
