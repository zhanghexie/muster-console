import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceView } from '../../src/renderer/src/components/ServiceView';
import { PromptTaskPanel } from '../../src/renderer/src/components/PromptTaskPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { PromptTask, WorkspaceInfo } from '../../src/shared/types';

const ws: WorkspaceInfo = { id: 'multi', name: 'multi', openedAt: 1, path: 'E:/a', controlRoot: 'E:/a',
  roots: [{ id: 'a', path: 'E:/a', label: '同名' }, { id: 'b', path: 'D:/b', label: '同名' }],
  defaultRootId: 'a', rootsRevision: 3 };
const other: WorkspaceInfo = { id: 'other', name: 'other', openedAt: 1, path: 'C:/other' };
const base: PromptTask = { id: 'service', name: '巡检', workspaceId: 'multi',
  sourceRoot: { rootId: 'b', path: 'D:/b', cwd: 'D:/b' }, runtime: 'shell', prompt: 'original',
  schedule: { kind: 'daily', time: '09:00' }, enabled: false, createdAt: 1 };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function seed() {
  const api = currentApiMock(); let task = structuredClone(base);
  api.override('workspaces.list', () => Promise.resolve({ workspaces: [ws, other], activeWorkspaceId: 'multi' }));
  api.override('config.get', () => Promise.resolve({ locale: 'zh-CN', workspaces: [ws, other], activeWorkspaceId: 'other', defaultRuntime: 'shell' }));
  api.override('runtimes.list', () => Promise.resolve([{ id: 'shell', label: 'Shell', enabled: true }]));
  api.override('sessions.precheck', async () => ({ dirty: false }));
  api.override('runtimes.availability', async () => ({ runtimes: [{ id: 'shell', label: 'Shell', enabled: true }], acpAgents: [], checkedAt: 1 }));
  api.override('services.get', () => Promise.resolve(structuredClone(task)));
  api.override('services.runs', () => Promise.resolve({ runs: [] }));
  api.override('services.list', () => Promise.resolve({ services: [task] }));
  api.override('services.update', (_id, patch) => {
    const root = ws.roots!.find(r => r.id === patch.rootId)!;
    task = { ...task, ...patch, sourceRoot: { rootId: root.id, path: root.path, cwd: root.path } };
    return Promise.resolve(structuredClone(task));
  });
  return api;
}
const view = (id = 'service') => <StoreProvider><ServiceView serviceId={id} /></StoreProvider>;
async function openTaskEditor() {
  await userEvent.click(screen.getByRole('button', { name: '编辑任务' }));
  await screen.findByRole('dialog', { name: '编辑任务' });
}
async function applyTaskEditor() {
  const button = screen.getByRole('button', { name: '保存' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(button);
}
async function pickRoot(id: 'a' | 'b') {
  await userEvent.click(screen.getByRole('button', { name: '运行位置' }));
  await userEvent.click(screen.getByRole('option', { name: id === 'a' ? 'E:/a' : 'D:/b' }));
}

describe('scheduled service source selection', () => {
  it('edits the task in the new-session dialog while keeping the schedule on the page', async () => {
    const api = seed();
    api.override('sessions.precheck', async () => ({ dirty: false }));
    render(view());
    await userEvent.click(await screen.findByRole('button', { name: '编辑任务' }));
    expect(await screen.findByRole('dialog', { name: '编辑任务' })).toBeTruthy();
    expect(screen.getByLabelText('任务').textContent).toBe('original');
    expect(screen.getByRole('button', { name: '运行位置' }).textContent).toContain('D:/b');
    expect(screen.queryByRole('button', { name: '新建空白' })).toBeNull();
    const task = screen.getByLabelText('任务');
    task.textContent = 'updated task';
    fireEvent.input(task);
    const apply = screen.getByRole('button', { name: '保存' });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(apply);
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({
      prompt: 'updated task', runtime: 'shell', rootId: 'b', schedule: { kind: 'daily', time: '09:00' }
    })));
    expect(api.mockOf('sessions.create')).not.toHaveBeenCalled();
  });
  it('discards task-dialog changes on cancel without creating or updating a task', async () => {
    const api = seed(); render(view());
    await userEvent.click(await screen.findByRole('button', { name: '编辑任务' }));
    await screen.findByRole('dialog', { name: '编辑任务' });
    const task = screen.getByLabelText('任务');
    task.textContent = 'discard me';
    fireEvent.input(task);
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await openTaskEditor();
    expect(screen.getByLabelText('任务').textContent).toBe('original');
    expect(api.mockOf('services.update')).not.toHaveBeenCalled();
    expect(api.mockOf('sessions.create')).not.toHaveBeenCalled();
  });
  it('updates hours and minutes through the task time controls', async () => {
    const api = seed(); render(view());
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '执行小时' }));
    await userEvent.click(screen.getByRole('option', { name: '13' }));
    await userEvent.click(screen.getByRole('button', { name: '执行分钟' }));
    await userEvent.click(screen.getByRole('option', { name: '25' }));
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({
      schedule: { kind: 'daily', time: '13:25' }
    })));
  });
  it('edits the persisted second source and saves its current version', async () => {
    const api = seed(); render(view());
    expect(await screen.findByRole('heading', { name: '巡检' })).toBeTruthy();
    expect(document.querySelector('.task-definition-summary')?.textContent).toBe('巡检编辑任务');
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    await openTaskEditor();
    expect(screen.getByRole('button', { name: '运行位置' }).textContent).toContain('D:/b');
    await applyTaskEditor();
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({ workspaceId: 'multi', rootId: 'b', rootsRevision: 3 })));
  });
  it('retains the edit selection on default changes, then supports explicit retargeting', async () => {
    const api = seed(); render(view());
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await openTaskEditor();
    act(() => api.emit('workspaces:changed', { workspaces: [{ ...ws, defaultRootId: 'b', path: 'D:/b', rootsRevision: 4 }, other], activeWorkspaceId: 'other' }));
    expect(screen.getByRole('button', { name: '运行位置' }).textContent).toContain('D:/b');
    await pickRoot('a'); await applyTaskEditor(); await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({ workspaceId: 'multi', rootId: 'a', rootsRevision: 4 })));
  });
  it('blocks a removed source until manual reselection; failed save keeps the draft', async () => {
    const api = seed(); render(view());
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await openTaskEditor();
    act(() => api.emit('workspaces:changed', { workspaces: [{ ...ws, roots: [ws.roots![0]], rootsRevision: 4 }, other], activeWorkspaceId: 'multi' }));
    expect(getAppTip().textContent).toContain('失效');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    await pickRoot('a'); await applyTaskEditor();
    api.override('services.update', () => Promise.reject(new Error('changed; retry')));
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    expect(await screen.findByText('changed; retry')).toBeTruthy();
    await openTaskEditor();
    expect(screen.getByRole('button', { name: '运行位置' }).textContent).toContain('E:/a');
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect((screen.getByRole('button', { name: '保存（保持停用）' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('locks duplicate saves and ignores an old result after switching service', async () => {
    const api = seed(); const save = deferred<PromptTask>(); api.override('services.update', () => save.promise);
    const rendered = render(view()); await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '保存并启用' }));
    expect((screen.getByRole('button', { name: '编辑任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存并启用' }) as HTMLButtonElement).disabled).toBe(true);
    api.override('services.get', () => Promise.resolve({ ...base, id: 'next', name: '另一服务', sourceRoot: { rootId: 'a', path: 'E:/a', cwd: 'E:/a' } }));
    rendered.rerender(view('next')); await screen.findByRole('heading', { name: '另一服务' });
    await act(async () => save.resolve(base));
    expect(api.mockOf('services.enable')).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '巡检' })).toBeNull();
  });
  it('does not invent a source for an ambiguous legacy service', async () => {
    const api = seed(); api.override('services.get', () => Promise.resolve({ ...base, sourceRoot: undefined }));
    render(view()); await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect((screen.getByRole('button', { name: '保存（保持停用）' }) as HTMLButtonElement).disabled).toBe(true);
    await openTaskEditor(); await pickRoot('b'); await applyTaskEditor(); await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({ rootId: 'b' })));
  });
  it('does not let a pending refresh restore the old source after saving a new one', async () => {
    const api = seed(); render(view()); await screen.findByRole('button', { name: '编辑' });
    const old = deferred<PromptTask>(); let first = true;
    api.override('services.get', () => { if (first) { first = false; return old.promise; } return Promise.resolve(base); });
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await userEvent.click(screen.getByRole('button', { name: '编辑' })); await openTaskEditor(); await pickRoot('a'); await applyTaskEditor();
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await screen.findByRole('button', { name: '编辑' });
    await act(async () => old.resolve(base));
    expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({ rootId: 'a' }));
    api.override('services.get', async () => ({ ...base, sourceRoot: { rootId: 'a', path: 'E:/a', cwd: 'E:/a' } }));
    await openTaskEditor();
    expect(screen.getByRole('button', { name: '运行位置' }).textContent).toContain('E:/a');
  });
  it('panel creation cancels before mutation when workspace changes while config is pending', async () => {
    const api = seed(); const cfg = deferred<any>(); const created = deferred<PromptTask>();
    api.override('config.get', () => Promise.resolve({ workspaces: [ws, other], activeWorkspaceId: 'multi', locale: 'zh-CN' }));
    api.override('services.list', id => Promise.resolve({ services: id === 'multi' ? [base] : [] }));
    const rendered = render(<StoreProvider><PromptTaskPanel /></StoreProvider>);
    await screen.findByText('巡检');
    api.override('config.get', () => cfg.promise); api.override('services.create', () => created.promise);
    await userEvent.click(screen.getByRole('button', { name: '＋ 新建任务' }));
    expect((screen.getByRole('button', { name: '＋ 新建任务' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => api.emit('workspaces:changed', { workspaces: [ws, other], activeWorkspaceId: 'other' }));
    await act(async () => cfg.resolve({ defaultRuntime: 'shell', activeWorkspaceId: 'other' }));
    expect(api.mockOf('services.create')).not.toHaveBeenCalled();
    await act(async () => created.resolve(base));
    expect(screen.queryByRole('heading', { name: '巡检' })).toBeNull();
    expect(api.mockOf('services.list')).toHaveBeenCalledWith('other'); rendered.unmount();
  });
  it('does not create in the old workspace after a forced availability response arrives late', async () => {
    const api = seed(); api.override('config.get', async () => ({ workspaces: [ws, other], activeWorkspaceId: 'multi', locale: 'zh-CN' }));
    api.override('services.list', id => Promise.resolve({ services: id === 'multi' ? [base] : [] }));
    render(<StoreProvider><PromptTaskPanel /></StoreProvider>); await screen.findByText('巡检');
    const pending = deferred<any>(); api.override('runtimes.availability', () => pending.promise);
    await userEvent.click(screen.getByRole('button', { name: '＋ 新建任务' }));
    await waitFor(() => expect(api.mockOf('runtimes.availability')).toHaveBeenLastCalledWith(true));
    act(() => api.emit('workspaces:changed', { workspaces: [ws, other], activeWorkspaceId: 'other' }));
    await act(async () => pending.resolve({ runtimes: [{ id: 'shell', label: 'Shell', enabled: true }], acpAgents: [], checkedAt: 2 }));
    expect(api.mockOf('services.create')).not.toHaveBeenCalled();
    expect(api.mockOf('services.list')).toHaveBeenCalledWith('other');
  });
  it('shows only usable runtime choices while preserving an unavailable existing worker on an inactive save', async () => {
    const api = seed(); const usable = { id: 'usable', label: 'Usable Worker', enabled: true };
    api.override('runtimes.list', async () => [{ id: 'shell', label: 'Shell', enabled: true }, usable]);
    api.override('runtimes.availability', async () => ({ runtimes: [usable], acpAgents: [], checkedAt: 1 }));
    render(view()); await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await openTaskEditor();
    const task = screen.getByLabelText('任务');
    task.textContent = 'updated draft';
    fireEvent.input(task);
    await applyTaskEditor();
    expect((screen.getByRole('button', { name: '保存并启用' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({ runtime: 'shell', prompt: 'updated draft' })));
    expect(api.mockOf('services.enable')).not.toHaveBeenCalled();
  });
  it('rechecks before running and refuses a tool that became unavailable without changing the task', async () => {
    const api = seed(); render(view()); const run = await screen.findByRole('button', { name: '立即执行' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    api.override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 2 }));
    await userEvent.click(run);
    await waitFor(() => expect(api.mockOf('runtimes.availability')).toHaveBeenLastCalledWith(true));
    await screen.findAllByText('所选 Worker 已不可用，请重新选择');
    expect(api.mockOf('services.runNow')).not.toHaveBeenCalled();
    expect(api.mockOf('services.update')).not.toHaveBeenCalled();
    expect(document.querySelector('.task-definition-summary')?.textContent).toBe('巡检编辑任务');
  });
  it('blocks scheduled creation when there are no usable workers and never invents an internal default', async () => {
    const api = seed(); api.override('services.list', async () => ({ services: [] }));
    api.override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 1 }));
    render(<StoreProvider><PromptTaskPanel /></StoreProvider>);
    await screen.findByText('暂无可用 Worker，请在设置中安装或配置');
    for (const button of screen.getAllByRole('button', { name: /新建任务/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button);
    }
    expect(api.mockOf('services.create')).not.toHaveBeenCalled();
  });
  it('creates a scheduled task when the forced probe broadcasts before returning', async () => {
    const api = seed();
    api.override('services.list', async () => ({ services: [] }));
    api.override('services.create', async (input) => ({ ...base, ...input, id: 'new-task' }));
    api.override('runtimes.availability', async (force) => {
      const result = { runtimes: [{ id: 'shell', label: 'Shell', enabled: true }], acpAgents: [], checkedAt: 1 };
      if (force) act(() => api.emit('runtimes:availabilityChanged', {}));
      return result;
    });
    render(<StoreProvider><PromptTaskPanel /></StoreProvider>);
    const create = await screen.findByRole('button', { name: '＋ 新建任务' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(create);
    await waitFor(() => expect(api.mockOf('services.create')).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'shell', workspaceId: 'other' })));
    expect(screen.queryByText('暂无可用 Worker，请在设置中安装或配置')).toBeNull();
  });
  it('keeps unavailable persisted ACP configuration but requires an explicit usable preset to enable', async () => {
    const api = seed(); const acp = { id: 'acp', label: 'ACP', enabled: true, surface: 'chat' };
    api.override('runtimes.list', async () => [acp]);
    api.override('runtimes.availability', async () => ({ runtimes: [acp], acpAgents: [{ id: 'codex', name: 'Codex ACP' }], checkedAt: 1 }));
    api.override('services.get', async () => ({ ...base, runtime: 'acp', piModeId: 'opencode' }));
    render(view()); await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect((screen.getByRole('button', { name: '保存并启用' }) as HTMLButtonElement).disabled).toBe(true);
    await openTaskEditor();
    expect(screen.getByRole('button', { name: '选择 Harness 和模型' })).toBeTruthy();
    await applyTaskEditor();
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));
    await waitFor(() => expect(api.mockOf('services.update')).toHaveBeenCalledWith('service', expect.objectContaining({ runtime: 'acp' })));
    expect(api.mockOf('services.enable')).not.toHaveBeenCalled();
    expect(api.mockOf('agentSession.listAcpAgents')).not.toHaveBeenCalled();
  });

  it('offers only time schedules in the scheduled task editor', async () => {
    const api = seed(); render(view());
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '执行策略' }));
    expect(screen.getByRole('option', { name: '每天' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '每周' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '固定间隔' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /GitLab|事件/ })).toBeNull();
    expect(api.mockOf('webAccess.status')).not.toHaveBeenCalled();
  });


});
