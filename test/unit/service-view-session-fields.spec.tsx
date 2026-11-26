/**
 * 定时任务编辑器对齐新建任务弹窗：无 headless 选项；chat runtime 露出会话态字段。
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceView } from '../../src/renderer/src/components/ServiceView';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { PromptTask } from '../../src/shared/types';

const CURSOR_RT = {
  id: 'pi',
  label: 'Muster Core',
  script: '',
  builtin: true,
  enabled: true,
  surface: 'chat' as const
};

const TASK: PromptTask = {
  id: 'task-1',
  name: '巡检',
  workspaceId: 'ws1',
  sourceRoot: { rootId: 'root-ws1', path: 'E:/project', cwd: 'E:/project' },
  runtime: 'pi',
  piModeId: 'cursor',
  prompt: 'run',
  schedule: { kind: 'daily', time: '09:00' },
  mode: 'terminal',
  enabled: false,
  createdAt: 1
};

function seed(): void {
  const api = currentApiMock();
  api.override('runtimes.list', () => Promise.resolve([CURSOR_RT]));
  api.override('runtimes.availability', async () => ({ runtimes: [CURSOR_RT], acpAgents: [], checkedAt: 1 }));
  api.override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  api.override('services.get', () => Promise.resolve({ ...TASK }));
  api.override('services.runs', () => Promise.resolve({ runs: [] }));
  api.override('workspaces.list', () => Promise.resolve({ workspaces: [{ id: 'ws1', path: 'E:/project' }], activeWorkspaceId: 'ws1' }));
  api.override('config.get', () =>
    Promise.resolve({ llm: { providers: [] }, locale: 'zh-CN', workspaces: [{ id: 'ws1', path: 'E:/project' }], activeWorkspaceId: 'ws1' })
  );
  api.override('agentSession.listAcpModels', () =>
    Promise.resolve({ ok: true, items: [{ id: 'grok-4.6', name: 'Grok 4.6' }] })
  );
  api.override('agentSession.getHarnessModelSelections', () => Promise.resolve({}));
}

describe('ServiceView 去 headless + 会话态字段', () => {
  it('编辑态没有无头选项，有 Runtime 与会话模式', async () => {
    seed();
    render(
      <StoreProvider>
        <ServiceView serviceId="task-1" />
      </StoreProvider>
    );

    await screen.findByRole('heading', { name: '巡检' });
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await userEvent.click(await screen.findByRole('button', { name: '编辑任务' }));
    const editor = await screen.findByRole('dialog', { name: '编辑任务' });

    expect(screen.queryByText('调度 Agent（无头）')).toBeNull();
    expect(screen.queryByLabelText('执行模式')).toBeNull();
    expect(within(editor).getByRole('button', { name: '选择 Harness 和模型' })).toBeTruthy();
    await userEvent.click(within(editor).getByRole('button', { name: '权限模式' }));
    const permissions = screen.getByRole('dialog', { name: '权限模式' });
    const permissionSwitch = within(permissions).getByRole('switch', { name: '配置权限' });
    expect(permissionSwitch).toBeTruthy();
    await userEvent.click(permissionSwitch);
    expect(await within(permissions).findAllByRole('menuitemradio')).not.toHaveLength(0);
  });

  it('保存时强制 mode=terminal 并带上会话态字段', async () => {
    seed();
    const api = currentApiMock();
    api.override('services.update', (_id: unknown, patch: unknown) =>
      Promise.resolve({ ...TASK, ...(patch as object) })
    );

    render(
      <StoreProvider>
        <ServiceView serviceId="task-1" />
      </StoreProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await userEvent.click(await screen.findByRole('button', { name: '编辑任务' }));
    const editor = await screen.findByRole('dialog', { name: '编辑任务' });
    await userEvent.click(within(editor).getByRole('button', { name: '权限模式' }));
    const permissions = screen.getByRole('dialog', { name: '权限模式' });
    await userEvent.click(within(permissions).getByRole('switch', { name: '配置权限' }));
    await userEvent.click(await within(permissions).findByRole('menuitemradio', { name: '计划模式' }));
    const save = within(editor).getByRole('button', { name: '保存' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(save);
    await userEvent.click(screen.getByRole('button', { name: '保存（保持停用）' }));

    await waitFor(() => {
      expect(api.mockOf('services.update')).toHaveBeenCalled();
    });
    const [, patch] = api.mockOf('services.update').mock.calls.at(-1) as [string, Record<string, unknown>];
    // mode 已退役为冗余负载：manager 内部 assertMode 恒 terminal，载荷不再携带
    expect(patch.mode).toBeUndefined();
    expect(patch.runtime).toBe('pi');
    expect(patch.guiMode).toBe('plan');
    expect(patch.thinking).toBeUndefined();
    expect(patch.configurePermissions).toBe(true);
  });
});
