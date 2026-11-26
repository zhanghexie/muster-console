import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { SplitContentPicker } from '../../src/renderer/src/components/SplitContentPicker';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

vi.mock('../../src/renderer/src/components/NewTaskDialog', () => ({
  NewTaskDialog: (props: any) => props.open ? <div>
    <button onClick={() => props.onBlankSession('gui', '新会话', {}, { workspaceId: 'ws' }, { isolate: false })}>创建空白</button>
    <button onClick={() => props.onDelegate({ task: '任务', runtime: 'gui', name: '', isolate: false, advanced: {}, source: { workspaceId: 'ws' } })}>创建任务</button>
  </div> : null
}));
const workspace = { id: 'ws', name: '当前工作区', path: 'E:/test', rootsRevision: 3 } as WorkspaceInfo;
const row = { id: 'new', name: '新会话', workspaceId: 'ws', type: 'terminal' } as SessionMeta;
function props() {
  return { choices: [{ kind: 'session', sessionId: 'old' }, { kind: 'utility', sel: 'tasks' }] as any,
    sessions: [], workspace, runtimes: [], labelFor: (ref: any) => ref.kind === 'session' ? 'Alpha 会话' : '定时任务',
    onSelect: vi.fn(), testIdPrefix: 'fill' };
}
beforeEach(() => currentApiMock().override('shell.listProfiles', async () => [{ id: 'powershell', label: 'PowerShell' }]));
it('普通新建终端按钮打开独立Shell面板，支持焦点循环、Escape和背景取消', async () => {
  render(<SplitContentPicker {...props()} />);
  const trigger = screen.getByRole('button', { name: '新建终端' });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  expect(trigger.className).toBe(screen.getByRole('button', { name: '新建会话' }).className);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '选择 Shell' });
  const profile = screen.getByRole('button', { name: 'PowerShell' });
  expect(document.activeElement).toBe(profile);
  fireEvent.keyDown(profile, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByRole('dialog', { name: '选择 Shell' }).parentElement!);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(currentApiMock().mockOf('sessions.create')).not.toHaveBeenCalled();
});
it('搜索忽略大小写和首尾空白，空结果仍保留新建入口', async () => {
  const p = props(); render(<SplitContentPicker {...p} />);
  await waitFor(() => expect((screen.getByRole('button', { name: '新建终端' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' ALPHA ' } });
  expect(screen.getByTestId('fill-old')).toBeTruthy(); expect(screen.queryByTestId('fill-tasks')).toBeNull();
  fireEvent.click(screen.getByTestId('fill-old')); expect(p.onSelect).toHaveBeenCalledWith(p.choices[0]);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(screen.getByText('没有匹配的内容')).toBeTruthy(); expect(screen.getByText('新建会话')).toBeTruthy();
});
it('创建终端固定工作区，不抢主选中，等待列表推送后填充', async () => {
  const p = props(); currentApiMock().override('sessions.create', async () => row);
  const view = render(<SplitContentPicker {...p} />);
  await waitFor(() => expect((screen.getByRole('button', { name: '新建终端' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
  fireEvent.click(screen.getByRole('button', { name: 'PowerShell' }));
  await waitFor(() => expect(currentApiMock().mockOf('sessions.create')).toHaveBeenCalledWith({ workspaceId: 'ws', rootsRevision: 3, shellProfileId: 'powershell', activate: false }));
  expect(p.onSelect).not.toHaveBeenCalled();
  view.rerender(<SplitContentPicker {...p} sessions={[row]} />);
  await waitFor(() => expect(p.onSelect).toHaveBeenCalledWith({ kind: 'session', sessionId: 'new' }));
});
it.each(['创建空白', '创建任务'])('%s复用会话创建配置，关闭自动选择', async action => {
  const p = props(); currentApiMock().override('sessions.create', async () => row);
  currentApiMock().override('sessions.delegate', async () => ({ session: row }));
  const view = render(<SplitContentPicker {...p} />);
  await waitFor(() => expect((screen.getByRole('button', { name: '新建终端' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText('新建会话'));
  await act(async () => fireEvent.click(screen.getByText(action)));
  expect(currentApiMock().mockOf(action === '创建空白' ? 'sessions.create' : 'sessions.delegate')).toHaveBeenCalledWith(expect.objectContaining(action === '创建空白' ? { activate: false, runtime: 'gui', workspaceId: 'ws' } : { select: false, runtime: 'gui', workspaceId: 'ws' }));
  view.rerender(<SplitContentPicker {...p} sessions={[row]} />);
  await waitFor(() => expect(p.onSelect).toHaveBeenCalledWith({ kind: 'session', sessionId: 'new' }));
});
it('创建失败展示错误，不填充；卸载后迟到的成功也不填充', async () => {
  const p = props(); currentApiMock().override('sessions.create', async () => { throw new Error('创建失败'); });
  const view = render(<SplitContentPicker {...p} />);
  await waitFor(() => expect((screen.getByRole('button', { name: '新建终端' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
  fireEvent.click(screen.getByRole('button', { name: 'PowerShell' }));
  expect((await screen.findAllByRole('alert'))[0].textContent).toContain('创建失败');
  let resolve!: (value: SessionMeta) => void;
  currentApiMock().override('sessions.create', () => new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
  fireEvent.click(screen.getByRole('button', { name: 'PowerShell' }));
  view.unmount(); await act(async () => resolve(row)); expect(p.onSelect).not.toHaveBeenCalled();
});
