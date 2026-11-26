import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';
import type { HarnessPickerRequest } from '../../src/shared/harnessPicker';
import type { AgentRuntimeEntry, WorkspaceInfo } from '../../src/shared/types';

const workspace: WorkspaceInfo = { id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A' }], defaultRootId: 'a', rootsRevision: 1 };
const runtimes = [
  { id: 'pi', label: 'Muster Core', enabled: true, surface: 'chat' },
  { id: 'acp', label: 'ACP', enabled: true, surface: 'chat' }
] as AgentRuntimeEntry[];
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const api = currentApiMock();
  api.override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws' }));
  api.override('config.get', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws', defaultRuntime: 'pi', locale: 'zh-CN' }));
  api.override('agentSession.getHarnessModelSelections', async () => ({}));
  api.override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  api.override('runtimes.availability', async () => ({ runtimes, acpAgents: [{ id: 'deepseek', name: 'DeepSeek' }], checkedAt: 1 }));
  api.override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
    { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui', label: 'Muster Core', available: true, status: 'available' },
    { harnessId: 'deepseek', runtimeId: 'acp', surface: 'gui', acpPresetId: 'deepseek', label: 'DeepSeek', available: true, status: 'available' }
  ] }));
  api.override('agentSession.readHarnessPickerCatalog', async (request: HarnessPickerRequest) =>
    pickerCatalog(request, { models: [{ providerId: 'acp', modelId: 'deepseek-chat', label: 'DeepSeek Chat' }] }));
});
afterEach(() => { HTMLElement.prototype.scrollIntoView = originalScrollIntoView; vi.unstubAllGlobals(); });

async function renderHandover() {
  const onCloseBoard = vi.fn();
  const onDelegate = vi.fn(async () => ({ notified: false, session: { id: 'new', name: 'new', type: 'terminal' as const, createdAt: 0 } }));
  render(<StoreProvider>
    <GlobalBoard open onClose={onCloseBoard} onOpen={() => {}} />
    <NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={() => {}} onDelegate={onDelegate}
      onBlankSession={async () => {}} lockedTask="请阅读交接文档：E:/handover/history.md" />
  </StoreProvider>);
  await waitFor(() => expect((screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement).disabled).toBe(false));
  return { onCloseBoard, onDelegate };
}

it('选择交接任务的 Harness 和模型不会收起全局看板，仍可提交', async () => {
  const { onCloseBoard, onDelegate } = await renderHandover();
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  const picker = await screen.findByRole('dialog', { name: '选择 Harness 和模型' });
  const tab = await within(picker).findByRole('tab', { name: 'DeepSeek' });
  fireEvent.pointerDown(tab, { button: 0 });
  fireEvent.click(tab);
  expect(onCloseBoard).not.toHaveBeenCalled();
  const model = within(await within(picker).findByRole('listbox', { name: '模型' })).getAllByRole('option')[0];
  fireEvent.pointerDown(model, { button: 0 });
  fireEvent.click(model);
  expect(onCloseBoard).not.toHaveBeenCalled();
  const confirm = within(picker).getByRole('button', { name: '确认配置' });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  const start = await screen.findByRole('button', { name: '开始任务' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(onDelegate).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'acp',
    task: expect.stringContaining('E:/handover/history.md') })));
});

it('选择交接任务权限不会收起全局看板', async () => {
  const { onCloseBoard } = await renderHandover();
  fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
  const permissions = screen.getByRole('dialog', { name: '权限模式' });
  fireEvent.click(within(permissions).getByRole('switch', { name: '配置权限' }));
  const option = (await within(permissions).findAllByRole('menuitemradio'))[0];
  fireEvent.pointerDown(option, { button: 0 });
  fireEvent.click(option);
  expect(onCloseBoard).not.toHaveBeenCalled();
});

it('选择交接任务的隔离方式不会收起全局看板', async () => {
  const { onCloseBoard } = await renderHandover();
  fireEvent.click(screen.getByRole('button', { name: '工作区隔离' }));
  const option = await screen.findByRole('radio', { name: '共享检出' });
  fireEvent.pointerDown(option, { button: 0 });
  fireEvent.click(option);
  expect(onCloseBoard).not.toHaveBeenCalled();
});
