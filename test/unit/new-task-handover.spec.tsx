import { renderTask, enterTask } from './helpers/task-editor';
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';
import type { AgentRuntimeEntry, WorkspaceInfo } from '../../src/shared/types';

const runtime = { id: 'pi', label: 'Muster Core', enabled: true, surface: 'chat' } as AgentRuntimeEntry;
const workspace = { id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A' }], defaultRootId: 'a', rootsRevision: 1 } as WorkspaceInfo;

beforeEach(() => {
  localStorage.clear();
  currentApiMock().override('agentSession.getHarnessModelSelections', async () => ({}));
  currentApiMock().override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
    { harnessId: 'codex', runtimeId: 'codex', label: 'Codex', surface: 'cli', status: 'available', available: true }
  ] }));
  currentApiMock().override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {}));
  currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: [runtime], acpAgents: [], checkedAt: 1 }));
});

it('隐藏交接背景并提示自动补充，提交时仍保留背景和本次任务', async () => {
  const onDelegate = vi.fn(async () => ({ notified: false, session: { id: 'new', name: 'new', type: 'terminal' as const, createdAt: 0 } }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[runtime]} onClose={() => {}} onDelegate={onDelegate}
    onBlankSession={async () => {}} initialName="原任务 ·交接" lockedTask="请阅读交接文档：E:/handover/history.md" />);
  const name = screen.getByRole('textbox', { name: /会话名称/ }) as HTMLInputElement;
  expect(name.value).toBe('原任务 ·交接');
  fireEvent.change(name, { target: { value: '继续原任务' } });
  expect(screen.queryByRole('textbox', { name: '交接背景' })).toBeNull();
  expect(screen.queryByText(/E:\/handover\/history\.md/)).toBeNull();
  const task = screen.getByRole('textbox', { name: '本次任务' }) as HTMLTextAreaElement;
  expect(task.getAttribute('aria-placeholder')).toBe('输入交接后的任务，交接信息会自动补充');
  enterTask(task, '先检查测试');
  expect(screen.queryByRole('button', { name: '新建空白' })).toBeNull();
  const submit = screen.getByRole('button', { name: '开始任务' });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(onDelegate).toHaveBeenCalledWith(expect.objectContaining({ name: '继续原任务',
    task: '请阅读交接文档：E:/handover/history.md\n\n【本次任务】\n先检查测试', supplement: '先检查测试' })));
});

it('不填写本次任务也能提交完整交接背景', async () => {
  const onDelegate = vi.fn(async () => ({ notified: false, session: { id: 'new', name: 'new', type: 'terminal' as const, createdAt: 0 } }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[runtime]} onClose={() => {}} onDelegate={onDelegate}
    onBlankSession={async () => {}} initialName="交接" lockedTask="必须保留的交接信息" />);
  const submit = screen.getByRole('button', { name: '开始任务' });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(onDelegate).toHaveBeenCalledWith(expect.objectContaining({ task: '必须保留的交接信息', supplement: '' })));
});

it('切换 CLI 时提示交接文档可能需要额外的沙箱读取权限', async () => {
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[runtime]} onClose={() => {}} onDelegate={async () => ({ notified: false })}
    onBlankSession={async () => {}} lockedTask="必须保留的交接信息" />);
  await waitFor(() => expect((screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText(/所选引擎的沙箱可能需要手动允许读取交接文档目录/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认配置' });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  expect(screen.getByText(/所选引擎的沙箱可能需要手动允许读取交接文档目录/)).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '交接背景' })).toBeNull();
  expect((screen.getByRole('textbox', { name: '本次任务' }) as HTMLElement).getAttribute('aria-placeholder')).toBe('输入交接后的任务，交接信息会自动补充');
});

it('仅注册工作目录的 GUI Harness 同样提示沙箱读取限制', async () => {
  const acp = { id: 'acp', label: 'ACP', enabled: true, surface: 'chat' } as AgentRuntimeEntry;
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: [acp], acpAgents: [{ id: 'deepseek', name: 'DeepSeek' }], checkedAt: 1 }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[acp]} onClose={() => {}} onDelegate={async () => ({ notified: false })}
    onBlankSession={async () => {}} lockedTask="必须保留的交接信息" />);
  await waitFor(() => expect((screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText(/所选引擎的沙箱可能需要手动允许读取交接文档目录/)).toBeTruthy();
});

it('普通新建任务仍使用原来的任务提示和空白会话入口', async () => {
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[runtime]} onClose={() => {}} onDelegate={async () => ({ notified: false })}
    onBlankSession={async () => {}} />);
  const input = screen.getByRole('textbox', { name: '任务' }) as HTMLTextAreaElement;
  expect(input.getAttribute('aria-placeholder')).toBe('想让 Agent 做什么？');
  expect(screen.queryByRole('textbox', { name: '本次任务' })).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(false));
});

it('默认 GUI 不受上次 CLI 或全局 CLI 配置影响，显式切换后仍可创建 CLI', async () => {
  const cli = { id: 'codex', label: 'Codex CLI', enabled: true, surface: 'pty' } as AgentRuntimeEntry;
  const entries = [runtime, cli];
  localStorage.setItem('muster:lastTaskRuntime', 'codex');
  currentApiMock().override('config.get', async () => ({ defaultRuntime: 'codex', workspaces: [workspace], activeWorkspaceId: workspace.id }));
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: entries, acpAgents: [], checkedAt: 1 }));
  const blank = vi.fn(async () => {});
  const props = { open: true, workspace, runtimes: entries, onClose: vi.fn(),
    onDelegate: async () => ({ notified: false }), onBlankSession: blank };
  const view = renderTask(<NewTaskDialog {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '选择 Harness 和模型' }).textContent).toContain('GUI'));
  await waitFor(() => expect((screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(blank).toHaveBeenCalledWith('pi', '', { configurePermissions: false }, expect.any(Object)));

  view.rerender(<NewTaskDialog {...props} open={false} />);
  view.rerender(<NewTaskDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认配置' });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect((screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(blank).toHaveBeenLastCalledWith('codex', '', { configurePermissions: false }, expect.any(Object)));
});

it.each([false, true])('只在有可用 Core 预设时在输入框显示模式，并提交所选预设（%s）', async available => {
  const preset = { id: 'review', name: '审阅', description: '', trust: 'user' as const, order: 0, broken: undefined };
  currentApiMock().override('agentSession.listPiModes', async () => [
    { ...preset, id: 'broken', broken: '配置错误' }, ...(available ? [preset] : [])
  ]);
  const delegate = vi.fn(async () => ({ notified: false }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[runtime]} onClose={vi.fn()} onDelegate={delegate}
    onBlankSession={vi.fn()} />);
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: '开始任务' });
  enterTask(screen.getByRole('textbox', { name: '任务' }), '检查修改');
  await waitFor(() => expect(submit.disabled).toBe(false));
  if (available) {
    const mode = await screen.findByRole('button', { name: '引擎模式' });
    expect(mode.closest('.agent-composer-toolbar')).toBeTruthy();
    vi.spyOn(mode, 'getBoundingClientRect').mockReturnValue(new DOMRect(244, 320, 70, 28));
    fireEvent.click(mode);
    const menu = screen.getByRole('listbox', { name: '引擎模式' });
    expect(menu.style.left).toBe('244px');
    expect(menu.style.bottom).toBe(`${window.innerHeight - 320 + 4}px`);
    expect(menu.style.top).toBe('');
    fireEvent.click(screen.getByRole('option', { name: '审阅' }));
  } else {
    expect(screen.queryByRole('button', { name: '引擎模式' })).toBeNull();
  }
  fireEvent.click(submit);
  await waitFor(() => expect(delegate).toHaveBeenCalled());
  expect(delegate.mock.calls[0]).toEqual([expect.objectContaining({
    advanced: available ? expect.objectContaining({ piModeId: 'review' }) : expect.not.objectContaining({ piModeId: expect.anything() })
  })]);
});

it('从输入框的共享权限菜单配置 Core 档位，选择后收起并写入启动草稿', async () => {
  const blank = vi.fn();
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={[runtime]} onClose={vi.fn()} onDelegate={vi.fn()}
    onBlankSession={blank} />);
  const chip = screen.getByRole('button', { name: '权限模式' });
  expect(chip.closest('.agent-composer-toolbar')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: '配置权限' })).toBeNull();
  vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 310, 85, 24));
  fireEvent.click(chip);
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '配置权限' });
  const popup = toggle.closest<HTMLElement>('[data-flyout=permissions]')!;
  expect(popup.style.left).toBe('160px');
  expect(popup.style.bottom).toBe(`${window.innerHeight - 310 + 4}px`);
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  expect(screen.getByRole('menuitemradio', { name: '跟随默认' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('menuitemradio', { name: '计划模式' }));
  expect(chip.textContent).toContain('计划模式');
  expect(chip.getAttribute('aria-expanded')).toBe('false');
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: '新建空白' });
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(blank).toHaveBeenCalledWith('pi', '', { configurePermissions: true, guiMode: 'plan' }, expect.any(Object)));
});
