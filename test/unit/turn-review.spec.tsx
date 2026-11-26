import React, { useMemo, useReducer } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TurnReviewPanel } from '../../src/renderer/src/panels/TurnReviewPanel';
import { RightWorkspaceContext, type RightWorkspaceBridge } from '../../src/renderer/src/rightWorkspace';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace, type RightContent } from '../../src/shared/rightWorkspace';
import type { TurnReviewEntry } from '../../src/shared/turnChanges';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting, t } from '../../src/shared/i18n';
import { turnChangeDisplayText } from '../../src/renderer/src/turnChangeDisplay';

vi.mock('../../src/renderer/src/panels/FileDiffView', () => ({ FileDiffView: ({ diffText }: { diffText: string }) => <pre>{diffText}</pre> }));
const owner = { kind: 'gui' as const, id: 's' };
const entries: TurnReviewEntry[] = ['new', 'old'].map((id, i) => ({ target: { ...owner, messageId: id }, label: `${id} prompt`, createdAt: 100 + i, summary: { id, state: 'ready', warnings: [], files: ['a.ts', 'b.ts'].map(path => ({ path, kind: 'modified', added: 2, removed: 1, revertible: true })) } }));
function Review({ initial = { kind: 'review', owner, messageId: 'new', filePath: 'b.ts' }, active = true }: { initial?: Extract<RightContent, { kind: 'review' }>; active?: boolean }) {
  const [model, dispatch] = useReducer(reduceRightWorkspace, initialRightWorkspace('ws', 's'), s => reduceRightWorkspace(s, { type: 'open', content: initial }));
  const current = activeRightTab(model);
  const bridge = useMemo<RightWorkspaceBridge>(() => ({ model, current, dispatch, toolbar: null, location: null, resourceHosts: { files: null, git: null, browser: null }, registerFile() {}, open: content => dispatch({ type: 'open', content }) }), [model, current]);
  return <RightWorkspaceContext.Provider value={bridge}><TurnReviewPanel content={current!.content as typeof initial} active={active}/></RightWorkspaceContext.Provider>;
}
beforeEach(() => {
  currentApiMock().mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries });
  currentApiMock().mockOf('turnChanges.diff').mockImplementation(async (target, file) => ({ ok: true, diff: `${target.messageId}:${file}` }));
});
it('shows oversized file changes and switches back to a full diff', async () => {
  const entry = entries[0];
  const files: TurnReviewEntry['summary']['files'] = [entry.summary.files[0], { path: 'b.ts', kind: 'added', added: null, removed: null, diffOmitted: true, revertible: false }];
  currentApiMock().mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [{ ...entry, summary: { ...entry.summary, files } }] });
  render(<Review/>);
  await screen.findByText('超出审阅大小上限，仅记录文件变化。');
  expect(within(screen.getByRole('navigation')).getByRole('button', { name: /b.ts.*新增/ })).toBeTruthy();
  expect(currentApiMock().mockOf('turnChanges.diff')).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /a.ts/ }));
  await screen.findByText('new:a.ts');
});
it('opens the requested file and switches files and turns', async () => {
  render(<Review/>); await screen.findByText('new:b.ts');
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /a.ts/ }));
  await screen.findByText('new:a.ts');
  fireEvent.click(screen.getByRole('button', { name: '选择审阅轮次' }));
  fireEvent.click(screen.getByRole('option', { name: /old prompt/ }));
  await screen.findByText('old:a.ts');
  expect(currentApiMock().mockOf('turnChanges.list')).toHaveBeenCalledWith(owner);
  expect(currentApiMock().mockOf('turnChanges.diff')).toHaveBeenLastCalledWith({ ...owner, messageId: 'old' }, 'a.ts');
});
it.each(['session', 'workspace'] as const)('inherits %s scope when navigating inside a review', async scope => {
  const content: Extract<RightContent, { kind: 'review' }> = { kind: 'review', owner, messageId: 'new', filePath: 'b.ts', repoPath: 'E:/repo' };
  const model = reduceRightWorkspace(initialRightWorkspace('ws', 's'), { type: 'open', content, scope });
  const current = activeRightTab(model)!;
  const toolbar = document.createElement('div'); document.body.appendChild(toolbar);
  const open = vi.fn();
  const bridge: RightWorkspaceBridge = { model, current, open, dispatch: vi.fn(), toolbar, location: null, resourceHosts: { files: null, git: null, browser: null }, registerFile() {} };
  const view = render(<RightWorkspaceContext.Provider value={bridge}><TurnReviewPanel content={current.content as typeof content} active/></RightWorkspaceContext.Provider>);
  await screen.findByText('new:b.ts');
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /a.ts/ }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review', filePath: 'a.ts' }), 'keep', scope);
  fireEvent.click(within(toolbar).getByRole('button', { name: '工作区' }));
  expect(open).toHaveBeenCalledWith({ kind: 'git', repoPath: 'E:/repo' }, 'keep', scope);
  view.unmount(); toolbar.remove();
});
it('keeps missing messages explicit instead of showing a different turn', async () => {
  render(<Review initial={{ kind: 'review', owner, messageId: 'missing' }}/>);
  await screen.findByText('本轮改动快照不可用'); expect(currentApiMock().mockOf('turnChanges.diff')).not.toHaveBeenCalled();
});
it('shows undo conflicts without removing the snapshot diff', async () => {
  const api = currentApiMock();
  api.mockOf('turnChanges.revert').mockResolvedValue({ ok: false, restored: ['b.ts'], conflicts: [{ path: 'a.ts', reason: '后续人工修改已保留' }], summary: { ...entries[0].summary, files: entries[0].summary.files.map(f => f.path === 'b.ts' ? { ...f, reverted: true, revertible: false } : f) } });
  render(<Review/>); await screen.findByText('new:b.ts');
  fireEvent.click(screen.getByRole('button', { name: '回退本轮' })); await screen.findByText(/后续人工修改已保留/);
  expect(screen.getAllByText('已回退').length).toBeGreaterThan(0); expect(screen.getByText('new:b.ts')).toBeTruthy();
});
it('ignores in-flight loads after hiding a review and stops subscriptions', async () => {
  let resolve!: (value: unknown) => void;
  const api = currentApiMock(); api.mockOf('turnChanges.list').mockReturnValue(new Promise(r => { resolve = r; }));
  const { rerender } = render(<Review/>); rerender(<Review active={false}/>);
  await act(async () => resolve({ ok: true, entries })); expect(api.mockOf('turnChanges.diff')).not.toHaveBeenCalled();
  await act(async () => api.emit('agentSession:event', { kind: 'sync', sessionId: 's', messages: [] }));
  expect(api.mockOf('turnChanges.list')).toHaveBeenCalledTimes(1);
});
it('loads a snapshot when host collection finishes', async () => {
  const api = currentApiMock(); api.mockOf('turnChanges.list').mockResolvedValueOnce({ ok: true, entries: [{ ...entries[0], summary: { ...entries[0].summary, state: 'collecting', files: [] } }] });
  render(<Review/>); await screen.findByText('正在记录本轮改动…');
  await act(async () => api.emit('agentSession:event', { kind: 'sync', sessionId: 's', messages: [] }));
  await waitFor(() => expect(screen.getByText('new:b.ts')).toBeTruthy());
});
it.each([
  { reason: '其他会话同时修改了该文件', concurrentEdits: undefined },
  { reason: '文件在工具完成后发生变化，已保留当前内容', concurrentEdits: [{ path: 'b.ts', otherOwner: 'gui:peer', otherLabel: '同时编辑的会话' }] }
])('defers collision details in review until revert ($reason)', async ({ reason, concurrentEdits }) => {
  const api = currentApiMock();
  const entry = entries[0];
  const files = [{ ...entry.summary.files[1], revertible: false, reason }];
  api.mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [{ ...entry, summary: { ...entry.summary, files, concurrentEdits } }] });
  api.mockOf('turnChanges.revert').mockResolvedValue({ ok: false, restored: [], conflicts: [
    { path: 'b.ts', reason: '其他会话同时修改了该文件，已保留当前内容' }
  ] });
  render(<Review/>);
  await screen.findByText('new:b.ts');
  expect(screen.queryByText(reason)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '回退本轮' }));
  expect(api.mockOf('turnChanges.revert')).toHaveBeenCalledWith(entry.target);
  expect((await screen.findByRole('alert')).textContent).toContain('b.ts：其他会话同时修改了该文件，已保留当前内容');
});
it('shows coverage diagnostics for an empty review without claiming no edits happened', async () => {
  const warning = '部分工具没有可靠的写前通知，其改动可能未记录';
  currentApiMock().mockOf('turnChanges.list').mockResolvedValue({ok:true,entries:[{...entries[0],summary:{...entries[0].summary,files:[],warnings:[warning]}}]});
  render(<Review/>);
  await screen.findByText(warning);
  expect(screen.getByText('本轮没有捕获到文件改动')).toBeTruthy();
  expect(screen.getByText('仅包含已捕获的工具改动，其他变化可能未记录。')).toBeTruthy();
  expect(currentApiMock().mockOf('turnChanges.diff')).not.toHaveBeenCalled();
});

it('labels observed and provider-reported diffs and disables unsafe revert', async () => {
  const files = [
    { path:'a.ts', kind:'modified' as const, added:1, removed:1, revertible:false, origin:'provider-diff' as const, reason:'引擎提供的差异仅供审阅，不能自动回退' },
    { path:'b.ts', kind:'modified' as const, added:1, removed:1, revertible:false, origin:'observed-tool' as const, reason:'工具事件的写前时机无法确认，仅供审阅' }
  ];
  currentApiMock().mockOf('turnChanges.list').mockResolvedValue({ok:true,entries:[{...entries[0],summary:{...entries[0].summary,files}}]});
  render(<Review/>);
  await screen.findByText('事件观察');
  expect(screen.getByText('工具事件的写前时机无法确认，仅供审阅')).toBeTruthy();
  expect((screen.getByRole('button',{name:'回退本轮'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button',{name:/a.ts/}));
  await screen.findByText('引擎报告');
  expect(screen.getByText('引擎提供的差异仅供审阅，不能自动回退')).toBeTruthy();
});

it('translates known persisted warnings while preserving paths, nested errors and unknown text', async () => {
  const warnings = ['子模块目录未覆盖，不会自动回退：E:/项目/代码', '文件基线准备失败：权限错误 E:/目录', '用户自定义诊断'];
  const snapshot = { ...entries[0], summary: { ...entries[0].summary, warnings } };
  currentApiMock().mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [snapshot] });
  currentApiMock().mockOf('turnChanges.revert').mockResolvedValue({ ok: false, restored: [],
    error: '文件回退结果已列出，快照状态保存失败：磁盘异常',
    conflicts: [{ path: '项目/a.ts', reason: '文件已不在当前可写范围' }] });
  render(<Review/>);
  await screen.findByText(warnings[0]);
  try {
    act(() => { applyLocaleSetting('en'); });
    await screen.findByText('The submodule directory is not covered and will not be reverted automatically: E:/项目/代码');
    expect(screen.getByText('File baseline preparation failed: 权限错误 E:/目录')).toBeTruthy();
    expect(screen.getByText('用户自定义诊断')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this turn' }));
    await screen.findByText('File revert results are listed, but the snapshot state could not be saved: 磁盘异常');
    expect(screen.getByText('项目/a.ts：The file is no longer in the current writable scope')).toBeTruthy();
    expect(snapshot.summary.warnings).toEqual(warnings);
    act(() => { applyLocaleSetting('zh-CN'); });
    await screen.findByText(warnings[0]);
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});

it('translates legacy baseline warnings in the interrupted-turn guard without changing their Chinese form', () => {
  const warning = '文件基线仍在后台校验，Shell 变化可能未完整覆盖；已确认的工具文件仍按原文核对';
  try {
    applyLocaleSetting('en');
    expect(turnChangeDisplayText(warning, t)).toBe('The file baseline is still being checked in the background. Shell changes may be incomplete; confirmed tool files are still checked against their original contents.');
    applyLocaleSetting('zh-CN');
    expect(turnChangeDisplayText(warning, t)).toBe(warning);
  } finally { applyLocaleSetting('zh-CN'); }
});

it('translates nested host snapshot diagnostics while retaining file paths and unknown details', () => {
  try {
    applyLocaleSetting('en');
    expect(turnChangeDisplayText('改动快照失败：Error: 文件在快照读取期间发生变化：E:/项目/文件.ts', t))
      .toBe('Could not capture the change snapshot: The file changed while the snapshot was being read: E:/项目/文件.ts');
    expect(turnChangeDisplayText('改动快照失败：Error: 用户原始错误', t))
      .toBe('Could not capture the change snapshot: Error: 用户原始错误');
    expect(turnChangeDisplayText('改动快照失败：标准', t)).toBe('Could not capture the change snapshot: 标准');
    expect(turnChangeDisplayText('上次改动采集中断，没有可用的回退快照', t))
      .toBe('The previous capture was interrupted; no undo snapshot is available');
    applyLocaleSetting('zh-CN');
    expect(turnChangeDisplayText('改动快照失败：Error: 文件在快照读取期间发生变化：E:/项目/文件.ts', t))
      .toBe('改动快照失败：Error: 文件在快照读取期间发生变化：E:/项目/文件.ts');
  } finally { applyLocaleSetting('zh-CN'); }
});

it.each(['collecting','finalizing','error'] as const)('keeps %s snapshots out of Diff and presents their actual state', async phase => {
  currentApiMock().mockOf('turnChanges.list').mockResolvedValue({ok:true,entries:[{...entries[0],summary:{...entries[0].summary,state:phase==='error'?'error':'collecting',finalizing:phase==='finalizing',warnings:phase==='error'?['保存失败']:[]}}]});
  render(<Review/>);
  await screen.findByText(phase==='error'?'保存失败':phase==='collecting'?'正在记录本轮改动…':'正在校验并保存本轮改动…');
  expect(currentApiMock().mockOf('turnChanges.diff')).not.toHaveBeenCalled();
  expect((screen.getByRole('button',{name:'回退本轮'}) as HTMLButtonElement).disabled).toBe(true);
});
