import { renderTask, enterTask } from './helpers/task-editor';
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AgentRuntimeEntry, TaskDelegateResult, WorkspaceInfo } from '../../src/shared/types';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());

const ws: WorkspaceInfo = { id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A', label: 'Same' }, { id: 'b', path: 'D:/B', label: 'Same' }],
  defaultRootId: 'b', controlRoot: 'E:/A', rootsRevision: 2 };
// chat 面（默认 tab）的可用项必须来自 HARNESS_CATALOG 的 runtimeId；
// 只给 CLI 侧的 claude-code 会让 availableChoices 为空，产品判「暂无可用 Harness」并禁用提交。
const runtimes: AgentRuntimeEntry[] = [
  { id: 'pi', label: 'Muster Core', enabled: true, surface: 'chat' } as AgentRuntimeEntry,
  { id: 'claude-code', label: 'Claude Code', enabled: true, surface: 'pty' } as AgentRuntimeEntry
];
const started: TaskDelegateResult = { session: { id: 'new', type: 'terminal', name: 'new', createdAt: 0 }, notified: false };
type Input = Parameters<React.ComponentProps<typeof NewTaskDialog>['onDelegate']>[0];
const props = () => ({ open: true, workspace: ws, runtimes, onClose: vi.fn(), onSessionCreated: vi.fn(),
  onDelegate: vi.fn(async (_input: Input) => started), onBlankSession: vi.fn(async () => {}) });
beforeEach(() => {
  localStorage.clear();
  currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  currentApiMock().override('runtimes.availability', async () => ({ runtimes, acpAgents: [], checkedAt: 1 }));
});
const pick = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: '运行位置' }));
  const option = await screen.findByRole('option', { name });
  await act(async () => fireEvent.click(option));
};
const typeTask = () => enterTask(screen.getByRole('textbox', { name: '任务' }), 'task text');
const submit = () => screen.getByRole('button', { name: '开始任务' });
// 「运行方式」下拉被 Harness picker 触发器取代；当前选中的 Harness 名称显示在这里。
const harnessTrigger = () => screen.getByRole('button', { name: '选择 Harness 和模型' });
const isolationTrigger = () => screen.getByRole('button', { name: '工作区隔离' });

it('CLI 也按默认第二根预检，提交携工作区/根/版本；不是旧 path', async () => {
  const p = props(); renderTask(<NewTaskDialog {...p} />);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.precheck')).toHaveBeenCalledWith('ws', 'b', 2));
  typeTask(); await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false));
  fireEvent.click(submit());
  await waitFor(() => expect(p.onClose).toHaveBeenCalledOnce());
  expect(p.onSessionCreated).toHaveBeenCalledOnce();
  expect(p.onDelegate).toHaveBeenCalledWith(expect.objectContaining({ task: 'task text', source: { workspaceId: 'ws', rootId: 'b', rootsRevision: 2 } }));
});

it.each(['开始任务', '添加代办', '新建空白'])('扩展制作草稿点击%s时携带来源身份和技能', async action => {
  const p = props();
  const extensionSource = { extensionId: 'design', scope: 'global' as const, fingerprint: 'package-version', rootId: 'a',
    workspaceId: ws.id, surfaceId: 'main', skillNames: ['deck'] };
  renderTask(<NewTaskDialog {...p} extensionSource={extensionSource} extensionSkillNames={extensionSource.skillNames}
    initialName="制作演示稿" initialTask="/deck 做一份演示稿" initialSource={{ rootId: 'a', path: 'E:/A' }} />);
  await waitFor(() => expect(submit()).toHaveProperty('disabled', false));
  expect(p.onDelegate).not.toHaveBeenCalled();
  expect(p.onBlankSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: action }));
  if (action === '新建空白') {
    await waitFor(() => expect(p.onBlankSession).toHaveBeenCalledWith('pi', '制作演示稿',
      expect.objectContaining({ extensionSource }), expect.objectContaining({ rootId: 'a' })));
  } else {
    const payload = expect.objectContaining({ advanced: expect.objectContaining({ extensionSource }), task: '/deck 做一份演示稿' });
    if (action === '开始任务') await waitFor(() => expect(p.onDelegate).toHaveBeenCalledWith(payload));
    else await waitFor(() => expect(currentApiMock().mockOf('boardTodos.save')).toHaveBeenCalledWith(payload, undefined));
  }
});

it('根选择按同名根路径区分，空会话成功前保持弹窗并携相同目标', async () => {
  const p = props(); let done!: () => void;
  p.onBlankSession.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
  renderTask(<NewTaskDialog {...p} />); await pick('E:/A');
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  // 现行空会话提交的是 chat 面 Harness catalog 的 runtimeId（pi），且 advanced 恒带 configurePermissions。
  await waitFor(() => expect(p.onBlankSession).toHaveBeenCalledWith('pi', '', { configurePermissions: false }, { workspaceId: 'ws', rootId: 'a', rootsRevision: 2 }));
  expect(p.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '运行位置' }).hasAttribute('disabled')).toBe(true);
  await act(async () => done()); expect(p.onClose).toHaveBeenCalledOnce();
});

it('改默认/排序/名称不重定向草稿，最新版本预检及提交仍取已选根', async () => {
  const p = props(); const view = renderTask(<NewTaskDialog {...p} />);
  view.rerender(<NewTaskDialog {...p} workspace={{ ...ws, rootsRevision: 3, defaultRootId: 'a', roots: [...ws.roots!].reverse().map(r => ({ ...r, label: 'Renamed' })) }} />);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.precheck')).toHaveBeenLastCalledWith('ws', 'b', 3));
  typeTask(); await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false)); fireEvent.click(submit());
  await waitFor(() => expect(p.onDelegate).toHaveBeenCalledOnce());
  expect(p.onDelegate.mock.calls[0][0]).toEqual(expect.objectContaining({ source: { workspaceId: 'ws', rootId: 'b', rootsRevision: 3 } }));
});

it('A→B→A 预检晚返回不能覆盖当前推荐，手改隔离不被覆盖', async () => {
  const pending: Array<(v: { isolate: boolean; dirty: boolean }) => void> = [];
  currentApiMock().override('sessions.precheck', () => new Promise(resolve => { pending.push(resolve); }));
  renderTask(<NewTaskDialog {...props()} workspace={{ ...ws, defaultRootId: 'a' }} />);
  await waitFor(() => expect(pending).toHaveLength(1)); await pick('D:/B');
  await waitFor(() => expect(pending).toHaveLength(2)); await pick('E:/A');
  await waitFor(() => expect(pending).toHaveLength(3));
  // 隔离从旧的 checkbox 换成「工作区隔离」弹层里的 radio；手动切到「隔离运行」。
  fireEvent.click(isolationTrigger());
  const isolation = await screen.findByRole('dialog', { name: '工作区隔离' });
  const isolateRadio = () => within(isolation).getByRole('radio', { name: /隔离运行/ });
  await act(async () => fireEvent.click(isolateRadio())); // Keep the user's manual choice for the current root.
  await act(async () => pending[2]({ isolate: false, dirty: false }));
  expect(isolateRadio().getAttribute('aria-checked')).toBe('true');
  await act(async () => { pending[0]({ isolate: true, dirty: true }); pending[1]({ isolate: true, dirty: true }); });
  expect(isolateRadio().getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByText(/主仓有未提交改动/)).toBeNull();
  expect(within(isolation).getByRole('radiogroup', { name: '工作区隔离' })).toBeTruthy();
});

it('移除或重新定位选中根拒绝提交，须显式重新选择', async () => {
  const p = props(); const view = renderTask(<NewTaskDialog {...p} />); typeTask();
  view.rerender(<NewTaskDialog {...p} workspace={{ ...ws, rootsRevision: 3, roots: [ws.roots![0]] }} />);
  expect(getTipSnapshot()?.text).toMatch(/所选源文件夹已失效/);
  expect(submit().hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '新建空白' }).hasAttribute('disabled')).toBe(true);
  await pick('E:/A');
  await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false)); fireEvent.click(submit());
  await waitFor(() => expect(p.onDelegate).toHaveBeenCalledOnce());
  expect(p.onDelegate.mock.calls[0][0]).toEqual(expect.objectContaining({ source: { workspaceId: 'ws', rootId: 'a', rootsRevision: 3 } }));
});

it('切工作区不移动草稿、忽略旧提交完成；关闭重开才使用新默认', async () => {
  const p = props(); let done!: (r: TaskDelegateResult) => void;
  p.onDelegate.mockImplementation(() => new Promise(resolve => { done = resolve; }));
  const view = renderTask(<NewTaskDialog {...p} />); typeTask(); await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false));
  fireEvent.click(submit());
  await waitFor(() => expect(p.onDelegate).toHaveBeenCalledOnce());
  const other = { ...ws, id: 'other', defaultRootId: 'a' };
  view.rerender(<NewTaskDialog {...p} workspace={other} />);
  expect(getTipSnapshot()?.text).toMatch(/工作区已切换/);
  await act(async () => done(started)); expect(p.onClose).not.toHaveBeenCalled();
  view.rerender(<NewTaskDialog {...p} open={false} workspace={other} />);
  view.rerender(<NewTaskDialog {...p} workspace={other} />);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.precheck')).toHaveBeenLastCalledWith('other', 'a', 2));
});

it('同 ID 路径重定位不能复用旧选择，用户明确重选后才恢复', async () => {
  const p = props(); const instance = renderTask(<NewTaskDialog {...p} />); typeTask();
  instance.rerender(<NewTaskDialog {...p} workspace={{ ...ws, rootsRevision: 3, roots: [ws.roots![0], { ...ws.roots![1], path: 'F:/Moved' }] }} />);
  expect(getTipSnapshot()?.text).toMatch(/所选源文件夹已失效/);
  expect(submit().hasAttribute('disabled')).toBe(true);
  await pick('F:/Moved');
  await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false)); fireEvent.click(submit());
  await waitFor(() => expect(p.onDelegate).toHaveBeenCalledOnce());
  expect(p.onDelegate.mock.calls[0][0]).toEqual(expect.objectContaining({ source: { workspaceId: 'ws', rootId: 'b', rootsRevision: 3 } }));
});

it('预检和空会话失败可重试，创建成功后才通知抽屉收起', async () => {
  const api = currentApiMock(); api.mockOf('sessions.precheck').mockRejectedValueOnce(new Error('offline'));
  const p = props(); p.onBlankSession.mockRejectedValueOnce(new Error('cannot create'));
  renderTask(<NewTaskDialog {...p} />); typeTask();
  await waitFor(() => expect(getTipSnapshot()?.text).toBe('目录预检失败：offline')); expect(submit().hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toBe('cannot create')); expect(p.onClose).not.toHaveBeenCalled();
  expect(p.onSessionCreated).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(p.onSessionCreated).toHaveBeenCalledOnce());
  expect(p.onClose).toHaveBeenCalledOnce();
});

it('排队回执显示位置并禁止重复派活，不宣称已创建会话', async () => {
  const p = props(); p.onDelegate.mockResolvedValueOnce({ queued: true, queuePosition: 3, notified: false });
  renderTask(<NewTaskDialog {...p} />); typeTask(); await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false));
  fireEvent.click(submit()); await screen.findByText('任务已排队（第 3 位），空闲后将在所选目录启动。');
  expect(p.onClose).not.toHaveBeenCalled(); expect(submit().hasAttribute('disabled')).toBe(true);
  expect(p.onSessionCreated).not.toHaveBeenCalled();
  fireEvent.click(submit()); expect(p.onDelegate).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '关闭' })); expect(p.onClose).toHaveBeenCalledOnce();
});

it('关闭后旧预检不影响下次打开，卸载后失败不回调', async () => {
  const api = currentApiMock(); let check!: (v: unknown) => void;
  api.mockOf('sessions.precheck').mockImplementationOnce(() => new Promise(resolve => { check = resolve; }));
  const p = props(); const view = renderTask(<NewTaskDialog {...p} />);
  view.rerender(<NewTaskDialog {...p} open={false} />); view.rerender(<NewTaskDialog {...p} />);
  await waitFor(() => expect(screen.queryByText('正在检查所选目录…')).toBeNull());
  await act(async () => check({ isolate: true, dirty: true }));
  // 旧预检不覆盖下次打开的表单：隔离选择器仍停在「共享检出」（未勾选）。
  expect(isolationTrigger().textContent).toBe('共享检出');
  await waitFor(() => expect(screen.getByRole('button', { name: '新建空白' }).hasAttribute('disabled')).toBe(false));
  let reject!: (e: Error) => void;
  p.onBlankSession.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(p.onBlankSession).toHaveBeenCalledOnce()); view.unmount();
  await act(async () => reject(new Error('late'))); expect(p.onClose).not.toHaveBeenCalled();
});

it('检测中、失败及全不可用均不回落登记的 CLI，重试保留任务草稿', async () => {
  const api = currentApiMock(); let fail!: (error: Error) => void;
  api.override('runtimes.availability', () => new Promise((_resolve, reject) => { fail = reject; }));
  const p = props(); renderTask(<NewTaskDialog {...p} />); typeTask();
  expect(screen.getByText('正在检测 Worker…')).toBeTruthy();
  expect(submit().hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '新建空白' }).hasAttribute('disabled')).toBe(true);
  await act(async () => fail(new Error('offline')));
  expect(getTipSnapshot()?.text).toBe('Worker 检测失败：offline');
  expect(harnessTrigger().textContent).not.toContain('Claude Code');
  api.override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 2 }));
  fireEvent.click(screen.getByRole('button', { name: '重新检测 Worker' }));
  await screen.findByText('暂无可用 Harness，请在设置 → Worker 中安装或配置。', { selector: '[role="status"]' });
  expect((screen.getByRole('textbox', { name: '任务' }) as HTMLElement).textContent).toBe('task text');
  expect(submit().hasAttribute('disabled')).toBe(true);
  expect(p.onDelegate).not.toHaveBeenCalled(); expect(p.onBlankSession).not.toHaveBeenCalled();
});

it('配置事件移除所选 Worker 后选另一个有效项，保留任务并用最新名称', async () => {
  const api = currentApiMock(); const next = { ...runtimes[0], id: 'other', label: 'Other' };
  const p = { ...props(), runtimes: [...runtimes, next] }; const view = renderTask(<NewTaskDialog {...p} />); typeTask();
  await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false));
  api.override('runtimes.availability', async () => ({ runtimes: [next], acpAgents: [], checkedAt: 2 }));
  act(() => api.emit('runtimes:availabilityChanged', {}));
  expect(submit().hasAttribute('disabled')).toBe(true);
  view.rerender(<NewTaskDialog {...p} runtimes={[runtimes[0], { ...next, label: 'Renamed Worker' }]} />);
  // 现行入口：Harness picker 的 tab 里显式重选另一个 Worker，触发器才显示最新名称并提交它。
  api.override('agentSession.listHarnessPickerChoices', async () => ({ choices: [
    { harnessId: 'other', runtimeId: 'other', surface: 'gui', label: 'Renamed Worker', available: true, status: 'available' }
  ], checkedAt: 2 }));
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request));
  fireEvent.click(harnessTrigger());
  await screen.findByRole('tab', { name: 'Renamed Worker' });
  fireEvent.click(screen.getByRole('tab', { name: 'Renamed Worker' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认配置' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '确认配置' }));
  await waitFor(() => expect(harnessTrigger().textContent).toContain('Renamed Worker'));
  await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false)); fireEvent.click(submit());
  await waitFor(() => expect(p.onDelegate).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'other', task: 'task text' })));
});

it('提交前强制检测发现工具失效时不创建，草稿仍可修改', async () => {
  const api = currentApiMock();
  const other = { ...runtimes[0], id: 'other', label: 'Other' } as AgentRuntimeEntry;
  const p = { ...props(), runtimes: [...runtimes, other] };
  renderTask(<NewTaskDialog {...p} />); typeTask();
  await waitFor(() => expect(submit().hasAttribute('disabled')).toBe(false));
  // 提交前强制检测：先让一次探测失败暴露「重新检测 Worker」入口。
  api.override('runtimes.availability', async () => { throw new Error('offline'); });
  act(() => api.emit('runtimes:availabilityChanged', {}));
  await waitFor(() => expect(getTipSnapshot()?.text).toBe('Worker 检测失败：offline'));
  // 强制重检返回「当前 Harness 已失效、另有可用 Worker」的快照 ⇒ 产品提示重新选择。
  api.override('runtimes.availability', async () => ({ runtimes: [other], acpAgents: [], checkedAt: 2 }));
  fireEvent.click(screen.getByRole('button', { name: '重新检测 Worker' }));
  await screen.findByText('所选 Agent 当前不可用，请重新选择或前往设置检查。');
  expect(api.mockOf('runtimes.availability')).toHaveBeenLastCalledWith(true);
  fireEvent.click(submit());
  expect(p.onDelegate).not.toHaveBeenCalled(); expect(p.onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox', { name: '任务' }) as HTMLElement).textContent).toBe('task text');
});

it('ACP 只展示实际可用预设并明确提交预设，不选未安装的默认 OpenCode', async () => {
  const api = currentApiMock(); const acp = { ...runtimes[0], id: 'acp', label: 'ACP', surface: 'chat' as const };
  api.override('runtimes.availability', async () => ({ runtimes: [acp], acpAgents: [{ id: 'codex', name: 'Codex ACP' }], checkedAt: 2 }));
  api.override('agentSession.listAcpAgents', async () => [{ id: 'opencode', name: 'OpenCode', broken: false }]);
  // 现行 ACP 预设在 Harness picker 的 tab 里；choices 只列实际可用的预设。
  api.override('agentSession.listHarnessPickerChoices', async () => ({ choices: [
    { harnessId: 'codex', runtimeId: 'acp', acpPresetId: 'codex', surface: 'gui', label: 'Codex ACP', available: true, status: 'available' }
  ], checkedAt: 2 }));
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request));
  const p = { ...props(), runtimes: [acp] }; renderTask(<NewTaskDialog {...p} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '新建空白' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(harnessTrigger());
  expect(await screen.findByRole('tab', { name: 'Codex ACP' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: /OpenCode|自动/ })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Codex ACP' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认配置' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '确认配置' }));
  fireEvent.click(screen.getByRole('button', { name: '新建空白' }));
  await waitFor(() => expect(p.onBlankSession).toHaveBeenCalledWith('acp', '', { configurePermissions: false, piModeId: 'codex' }, { workspaceId: 'ws', rootId: 'b', rootsRevision: 2 }));
  expect(api.mockOf('agentSession.listAcpAgents')).not.toHaveBeenCalled();
});

it('旧单根补稳定 ID，坏默认根可显式选择，损坏配置不崩溃', async () => {
  const p = props(); const view = renderTask(<NewTaskDialog {...p} workspace={{ id: 'old', name: 'old', path: 'E:/Old', openedAt: 0 }} />);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.precheck')).toHaveBeenLastCalledWith('old', 'root-old', undefined));
  view.rerender(<NewTaskDialog {...p} open={false} />);
  view.rerender(<NewTaskDialog {...p} workspace={{ ...ws, defaultRootId: 'missing' }} />);
  expect(getTipSnapshot()?.text).toMatch(/所选源文件夹已失效/);
  await pick('D:/B'); await waitFor(() => expect(screen.queryByText('正在检查所选目录…')).toBeNull());
  view.rerender(<NewTaskDialog {...p} workspace={{ ...ws, rootsError: 'bad metadata' }} />);
  expect(getTipSnapshot()?.text).toContain('bad metadata');
});

it('长路径菜单在底部使用实际内容高度翻到上方，不能只按单行高度估计', async () => {
  vi.stubGlobal('innerHeight', 844);
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return { top: 720, bottom: 746, left: 12, right: 378, width: 366, height: 26, x: 12, y: 720, toJSON: () => ({}) };
  });
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('task-source-menu') ? 150 : 0;
  });
  try {
    renderTask(<NewTaskDialog {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: '运行位置' }));
    const menu = await screen.findByRole('listbox', { name: '运行位置' });
    await waitFor(() => expect(menu.style.top).toBe('570px'));
  } finally { rect.mockRestore(); height.mockRestore(); vi.unstubAllGlobals(); }
});

it('空白会话创建只显示一个等待图标，失败后移除', async () => {
 let fail!: (e: Error) => void;
 const p = props(); p.onBlankSession.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
 const { container } = renderTask(<NewTaskDialog {...p} />);
 const button = await screen.findByRole('button', { name: '新建空白' });
 await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(button);
 await waitFor(() => expect(p.onBlankSession).toHaveBeenCalled());
 expect(container.querySelectorAll('.brand-loader')).toHaveLength(0); // Dialog is portalled.
 // 等待图标现在渲染在反馈区（处理中…），不再挂在动作按钮行里。
 expect(document.body.querySelectorAll('.new-task-feedback .brand-loader')).toHaveLength(1);
 await act(async () => fail(new Error('create offline')));
 await waitFor(() => expect(getTipSnapshot()?.text).toBe('create offline'));
 expect(document.body.querySelector('.new-task-feedback .brand-loader')).toBeNull();
});
