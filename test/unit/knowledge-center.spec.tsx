import React from 'react';
import { render, screen, act, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeCenter } from '../../src/renderer/src/components/KnowledgeCenter';
import { MemoryCenterBadge } from '../../src/renderer/src/components/MemoryCenterBadge';
import { requestMemoryCenterTab, resetMemoryCenterRouteForTest } from '../../src/renderer/src/memoryCenterRoute';
import { currentApiMock } from './helpers/api-mock';
import { activeFlowEdges } from '../../src/renderer/src/components/MemoryOverview';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());
let workspace = 'a';
const requestAgentPanel = vi.fn();
vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ activeWorkspaceId: workspace }), useUiStore: () => ({ requestAgentPanel }) }));
vi.mock('../../src/renderer/src/components/MemoryIntentTab', () => ({ IntentTab: () => <div>提醒夹具</div> }));
beforeEach(() => { workspace = 'a'; resetMemoryCenterRouteForTest(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  currentApiMock().mockOf('memoryCurator.inspect').mockResolvedValue({items:[],total:0,offset:0,limit:30});
  currentApiMock().mockOf('memoryCurator.state').mockResolvedValue({workspaceId:'a',pending:0,failed:0,running:false,paused:false,messages:[],updatedAt:1});
});
const empty = { records: [], active: 0, pending: 0, history: 0, startedAt: 1, profileInjectionChars: 0 };
const record = { schema: 1, id: 'memory-a', namespace: 'worker', kind: 'stable_constraint', status: 'active', summary: '工作区约束', revision: 2, applicability: [], evidence: [], history: [], createdAt: 1, updatedAt: 1 };
test('shows isolated projection failures without hiding the memory center', async () => {
  currentApiMock().mockOf('knowledge.list').mockResolvedValue({ ...empty, integrityIssues: [{ id: 'broken-id', reason: 'missing' }] });
  render(<KnowledgeCenter />);
  fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
  expect(getTipSnapshot()?.text).toContain('broken-id');
  expect(screen.getByRole('tab', { name: '长期知识' })).toBeTruthy();
});
function currentPanel(): HTMLElement {
  const tab = screen.getAllByRole('tab').find(element => element.getAttribute('aria-selected') === 'true')!;
  return document.getElementById(tab.getAttribute('aria-controls')!)!;
}

test('five linked tabs retain views, navigate by keyboard and capture workspace identity', async () => {
  const mock = currentApiMock(); mock.mockOf('knowledge.list').mockResolvedValue(empty);
  const user = userEvent.setup(), view = render(<KnowledgeCenter />);
  await waitFor(() => expect(mock.mockOf('knowledge.list')).toHaveBeenCalledWith('a'));
  expect(screen.getAllByRole('tab').map(element => element.textContent)).toEqual(['总览', '长期知识', '任务历史', '主动提醒', '整理记录']);
  for (const tab of screen.getAllByRole('tab')) {
    const panel = document.getElementById(tab.getAttribute('aria-controls')!);
    expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
  }
  const overview = screen.getByTestId('memory-overview');
  await user.click(screen.getByTestId('overview-node-n-curated'));
  expect(screen.getByRole('tab', { name: '长期知识' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('tab', { name: '长期知识' }), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: '任务历史' }));
  expect(await within(currentPanel()).findByText('没有匹配的任务历史')).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: '主动提醒' })); expect(within(currentPanel()).getByText('提醒夹具')).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: '总览' })); expect(screen.getByTestId('memory-overview')).toBe(overview);
  expect(mock.mockOf('memoryCenter.recycle')).not.toHaveBeenCalled(); expect(mock.mockOf('memoryCenter.events')).not.toHaveBeenCalled();
  workspace = 'b'; view.rerender(<KnowledgeCenter />); await waitFor(() => expect(mock.mockOf('knowledge.list')).toHaveBeenCalledWith('b'));
});

test('old review and approval routes redirect to entries; profile is a scope filter', async () => {
  const mock = currentApiMock(); mock.mockOf('knowledge.list').mockResolvedValue({ ...empty, active: 2, records: [record, { ...record, id: 'profile', namespace: 'profile', kind: 'user_preference', summary: '偏好中文' }] });
  render(<KnowledgeCenter />);
  for (const tab of ['review', 'approvals'] as const) {
    act(() => requestMemoryCenterTab(tab));
    await waitFor(() => expect(screen.getByRole('tab', { name: '长期知识' }).getAttribute('aria-selected')).toBe('true'));
    expect(within(currentPanel()).queryByRole('button', { name: /确认生效|标记需复核|确认取代|恢复到待确认/ })).toBeNull();
  }
  act(() => requestMemoryCenterTab('profile'));
  await within(currentPanel()).findByRole('heading', { name: '偏好中文' });
  expect(within(currentPanel()).queryByRole('heading', { name: '工作区约束' })).toBeNull();
  expect(screen.queryByRole('tab', { name: '用户画像' })).toBeNull();
  expect(mock.mockOf('memoryCenter.approvals')).not.toHaveBeenCalled();
});

test('profile budget shows actual injected characters, not the stored profile total', async () => {
  currentApiMock().mockOf('knowledge.list').mockResolvedValue({ ...empty, profileInjectionChars: 123, records: [{ ...record, namespace: 'profile', summary: '甲'.repeat(1000) }] });
  render(<KnowledgeCenter />);
  expect(await within(screen.getByTestId('overview-node-n-usermd')).findByText('123 / 2400')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-usermd')).queryByText('1.0K / 2400')).toBeNull();
});

test('overview draws real automatic events without approval or cancellation pulses', () => {
  const now = Date.now();
  const edges = activeFlowEdges([
    {kind:'auto_admitted',ts:now}, {kind:'evidence_linked',ts:now}, {kind:'conflict_suspended',ts:now},
    {kind:'user_deleted',ts:now}, {kind:'approval_queued',ts:now}, {kind:'approval_decided',ts:now}, {kind:'intent_cancelled',ts:now}
  ],now);
  expect([...edges].sort()).toEqual(['e-auto','e-review']);
  expect(activeFlowEdges([{kind:'evidence_linked',ts:now}],now).has('e-cand')).toBe(false);
  expect(edges.has('e-compare')).toBe(false); // Reading existing knowledge has no invented ledger pulse.
  expect(edges.has('e-approve')).toBe(false);expect(edges.has('e-fire')).toBe(false);
});

test('overview status uses curator runtime instead of old pending knowledge', async () => {
  currentApiMock().mockOf('knowledge.list').mockResolvedValue({ ...empty, pending: 6,
    records: [{ ...record, status: 'needs_revalidation' }],
    processing: { pending: 7, failed: 2, running: true, paused: false, errors: [] },
    activity: { items: [], todayActivations: 250, kindCounts24h: {}, kindCounts7d: {} }
  });
  render(<KnowledgeCenter />);
  expect(await within(screen.getByTestId('overview-node-n-staging')).findByText('积压 7')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-approval')).getByText('失败 2')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-approval')).getByText('知识暂停 1 条 · 失败可重试')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-consolidation')).getByText('今日生效 250')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-consolidation')).getByText('正在整理记忆')).toBeTruthy();
});

test('approval badges never poll, even with pending system work', () => {
  const mock = currentApiMock(); mock.mockOf('memoryCenter.badge').mockResolvedValue({ pending: 9 });
  const view = render(<MemoryCenterBadge />);
  expect(view.container.textContent).toBe(''); expect(mock.mockOf('memoryCenter.badge')).not.toHaveBeenCalled();
});

test('memory agent opens its real conversation, candidate opens the actual queued records', async () => {
  const mock=currentApiMock(); mock.mockOf('knowledge.list').mockResolvedValue(empty);
  const user=userEvent.setup(); render(<KnowledgeCenter />);
  await user.click(screen.getByTestId('overview-node-n-consolidation'));
  expect(requestAgentPanel).toHaveBeenCalledWith('a','memory');
  expect(mock.mockOf('memoryCurator.inspect')).not.toHaveBeenCalled();
  expect(screen.getByRole('tab',{name:'总览'}).getAttribute('aria-selected')).toBe('true');
  await user.click(screen.getByTestId('overview-node-n-staging'));
  await waitFor(()=>expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenCalledWith('a',{state:'queued',visibility:'visible',offset:0,limit:30}));
  expect(screen.getByRole('tab',{name:'整理记录'}).getAttribute('aria-selected')).toBe('true');
  await user.click(screen.getByRole('tab',{name:'总览'}));
  await user.click(screen.getByTestId('overview-node-n-approval'));
  await waitFor(()=>expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenCalledWith('a',{state:'attention',visibility:'visible',offset:0,limit:30}));
});

test('no workspace sends no IPC; an old overview response cannot replace a newer list', async () => {
  const mock = currentApiMock(), user = userEvent.setup(); workspace = '';
  const view = render(<KnowledgeCenter />); expect(mock.mockOf('knowledge.list')).not.toHaveBeenCalled();
  let resolveOld!: (value: unknown) => void;
  mock.mockOf('knowledge.list').mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ ...empty, active: 2 });
  workspace = 'a'; view.rerender(<KnowledgeCenter />);
  await user.click(screen.getByRole('tab', { name: '长期知识' }));
  await screen.findByText('2 条长期知识 · 自动整理');
  await act(async () => resolveOld({ ...empty, active: 99 }));
  expect(screen.queryByText('99 条长期知识 · 自动整理')).toBeNull();
});
