/**
 * 工作流胶囊 + 面板（dynamic-workflow）：
 * - 无工作流无 run 时胶囊不出现；有问用户的待答问题时胶囊高亮「待你答复」
 * - workflow:changed 推送（同工作区）触发重拉
 * - 问用户：点选项 / 多选 + 自填 → workflow.answer 原样回写；问调度的问题只展示、无作答控件
 * - 取消：二次确认，可勾选同时关闭派出的会话，关不掉的逐个报出
 * - 工作流清单：未信任有触发时提示未生效，信任 / 撤销信任走对应 IPC
 * - 「运行 / 列表」两个标签：默认落点、点击与方向键切换
 * - 停用 / 启用触发（workflow.setTriggers）、删除二次确认（workflow.delete）与失败行内报出
 * - 运行历史：清空（二次确认）/ 单条删除走 workflow.clearRuns；只剩历史时胶囊仍出现
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowArea } from '../../src/renderer/src/agentChat/WorkflowArea';
import type { WorkflowOverview, WorkflowRunView, WorkflowOverviewItem } from '../../src/shared/workflow';
import { currentApiMock } from './helpers/api-mock';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());

const WS = 'ws-a';

function run(over: Partial<WorkflowRunView>): WorkflowRunView {
  return {
    runId: 'r1',
    name: 'cross-review-merge',
    status: 'waiting',
    delegates: '1/6',
    activeMinutes: 3,
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    log: [{ ts: Date.now(), text: '启动' }],
    ...over
  };
}

function def(over: Partial<WorkflowOverviewItem>): WorkflowOverviewItem {
  return { name: 'nightly-test-fix', fingerprint: 'fp', trust: 'never', description: '夜间测试', ...over };
}

function setOverview(ov: Partial<WorkflowOverview>): void {
  currentApiMock().override('workflow.overview', () => Promise.resolve({ workflows: [], active: [], recent: [], ...ov }));
}

function renderArea() {
  return render(
    <div className="chat-input-shell">
      <WorkflowArea workspaceId={WS} />
    </div>
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /工作流/ }));
  return screen.findByRole('dialog', { name: '工作流' });
}

describe('工作流胶囊', () => {
  it('没有工作流也没有 run 时不出现', async () => {
    setOverview({});
    renderArea();
    await waitFor(() => expect(currentApiMock().mockOf('workflow.overview')).toHaveBeenCalledWith(WS));
    expect(screen.queryByRole('button', { name: /工作流/ })).toBeNull();
  });

  it('有问用户的待答问题时高亮「待你答复」；同工作区推送才重拉', async () => {
    setOverview({ active: [run({ pendingAsk: { askId: 'a1', to: 'human', question: '合入吗？', options: ['合入', '暂不'] } })] });
    renderArea();
    const capsule = await screen.findByRole('button', { name: /工作流待你答复/ });
    expect(capsule.className).toMatch(/\bhas-ask\b/);
    const overview = currentApiMock().mockOf('workflow.overview');
    const before = overview.mock.calls.length;
    currentApiMock().emit('workflow:changed', { workspaceId: 'other' });
    expect(overview.mock.calls.length).toBe(before);
    currentApiMock().emit('workflow:changed', { workspaceId: WS });
    await waitFor(() => expect(overview.mock.calls.length).toBe(before + 1));
  });
});

describe('工作流面板', () => {
  it('问用户：点选项原样回写', async () => {
    const user = userEvent.setup();
    setOverview({ active: [run({ pendingAsk: { askId: 'a1', to: 'human', question: '合入吗？', options: ['合入', '暂不'] } })] });
    renderArea();
    const dialog = await openPanel(user);
    expect(within(dialog).getByText('合入吗？')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '合入' }));
    expect(currentApiMock().mockOf('workflow.answer')).toHaveBeenCalledWith(WS, 'r1', 'a1', '合入');
  });

  it('问用户多选：勾选 + 自填一起提交为数组', async () => {
    const user = userEvent.setup();
    setOverview({
      active: [run({ pendingAsk: { askId: 'a2', to: 'human', question: '做哪些？', options: ['A', 'B'], multi: true } })]
    });
    renderArea();
    const dialog = await openPanel(user);
    const submit = within(dialog).getByRole('button', { name: '提交' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: 'B' }));
    await user.type(within(dialog).getByRole('textbox', { name: '答复' }), 'C');
    await user.click(submit);
    expect(currentApiMock().mockOf('workflow.answer')).toHaveBeenCalledWith(WS, 'r1', 'a2', ['B', 'C']);
  });

  it('问调度的问题只展示，没有作答控件', async () => {
    const user = userEvent.setup();
    setOverview({ active: [run({ pendingAsk: { askId: 'a3', to: 'scheduler', question: '评审通过了吗？', options: ['通过', '打回'] } })] });
    renderArea();
    const dialog = await openPanel(user);
    expect(within(dialog).getByText('等调度判断')).toBeTruthy();
    expect(within(dialog).getByText('评审通过了吗？')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '通过' })).toBeNull();
    expect(within(dialog).queryByRole('textbox', { name: '答复' })).toBeNull();
  });

  it('取消：二次确认，勾选后连同派出的会话一起关闭，失败逐个报出', async () => {
    const user = userEvent.setup();
    setOverview({
      active: [
        run({ status: 'running', sessions: ['s1'] }),
        run({ runId: 'r2', name: 'child', parentRunId: 'r1', status: 'running', sessions: ['s2'] })
      ]
    });
    currentApiMock().override('workflow.cancel', () =>
      Promise.resolve({ runId: 'r1', status: 'cancelled', closed: ['s1'], failed: [{ sessionId: 's2', error: '会话已占用' }] })
    );
    renderArea();
    const dialog = await openPanel(user);
    expect(within(dialog).getByText(/子工作流 child/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '取消运行' }));
    expect(currentApiMock().mockOf('workflow.cancel')).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('checkbox', { name: '同时关闭派出的 2 个会话' }));
    await user.click(within(dialog).getByRole('button', { name: '确认取消' }));
    expect(currentApiMock().mockOf('workflow.cancel')).toHaveBeenCalledWith(WS, 'r1', true);
    await waitFor(() => expect(getTipSnapshot()?.text).toMatch(/1 个会话没关掉：会话已占用/));
  });

  it('工作流清单：未信任的触发提示未生效，信任 / 撤销信任走 IPC', async () => {
    const user = userEvent.setup();
    setOverview({
      workflows: [
        def({ schedule: '每天 02:00' }),
        def({ name: 'cross-review-merge', trust: 'trusted', args: ['task', 'reviewer?'], description: '互审' })
      ]
    });
    renderArea();
    const dialog = await openPanel(user);
    const nightly = dialog.querySelector('[data-workflow="nightly-test-fix"]') as HTMLElement;
    expect(within(nightly).getByText('定时：每天 02:00')).toBeTruthy();
    expect(within(nightly).getByText(/触发未生效/)).toBeTruthy();
    await user.click(within(nightly).getByRole('button', { name: '信任' }));
    expect(currentApiMock().mockOf('workflow.trust')).toHaveBeenCalledWith(WS, 'nightly-test-fix');

    const review = dialog.querySelector('[data-workflow="cross-review-merge"]') as HTMLElement;
    expect(within(review).queryByText(/触发未生效/)).toBeNull();
    expect(within(review).queryByRole('button', { name: '停用触发' })).toBeNull();
    await user.click(within(review).getByRole('button', { name: '撤销信任' }));
    expect(currentApiMock().mockOf('workflow.revokeTrust')).toHaveBeenCalledWith(WS, 'cross-review-merge');
  });

  it('两个标签：有运行中的 run 落「运行」，点「列表」或方向键切换', async () => {
    const user = userEvent.setup();
    setOverview({ active: [run({ status: 'running' })], workflows: [def({})] });
    renderArea();
    const dialog = await openPanel(user);
    const runsTab = within(dialog).getByRole('tab', { name: /运行/ });
    const listTab = within(dialog).getByRole('tab', { name: /列表/ });
    expect(runsTab.getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByRole('button', { name: '取消运行' })).toBeTruthy();
    expect(dialog.querySelector('[data-workflow]')).toBeNull();

    await user.click(listTab);
    expect(listTab.getAttribute('aria-selected')).toBe('true');
    expect(dialog.querySelector('[data-workflow="nightly-test-fix"]')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '取消运行' })).toBeNull();

    listTab.focus();
    await user.keyboard('{ArrowLeft}');
    expect(runsTab.getAttribute('aria-selected')).toBe('true');
  });

  it('没有运行中的 run 时落「列表」', async () => {
    const user = userEvent.setup();
    setOverview({ workflows: [def({})] });
    renderArea();
    const dialog = await openPanel(user);
    expect(within(dialog).getByRole('tab', { name: /列表/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('停用 / 启用触发走 workflow.setTriggers；停用时提示已停用', async () => {
    const user = userEvent.setup();
    setOverview({
      workflows: [
        def({ trust: 'trusted', schedule: '每天 02:00', nextDueAt: Date.now() + 3600_000 }),
        def({ name: 'paused', trust: 'trusted', on: 'task_flip → blocked', cooldownMin: 10, triggersDisabled: true })
      ]
    });
    renderArea();
    const dialog = await openPanel(user);
    const nightly = dialog.querySelector('[data-workflow="nightly-test-fix"]') as HTMLElement;
    await user.click(within(nightly).getByRole('button', { name: '停用触发' }));
    expect(currentApiMock().mockOf('workflow.setTriggers')).toHaveBeenCalledWith(WS, 'nightly-test-fix', false);

    const paused = dialog.querySelector('[data-workflow="paused"]') as HTMLElement;
    expect(within(paused).getByText(/触发已停用/)).toBeTruthy();
    expect(within(paused).queryByText(/触发未生效/)).toBeNull();
    await user.click(within(paused).getByRole('button', { name: '启用触发' }));
    expect(currentApiMock().mockOf('workflow.setTriggers')).toHaveBeenCalledWith(WS, 'paused', true);
  });

  it('清空历史：二次确认后走 workflow.clearRuns（全部）', async () => {
    const user = userEvent.setup();
    setOverview({ recent: [run({ status: 'completed', endedAt: Date.now() })] });
    renderArea();
    const dialog = await openPanel(user);
    await user.click(within(dialog).getByRole('tab', { name: /运行/ }));
    await user.click(within(dialog).getByRole('button', { name: '清空历史' }));
    expect(currentApiMock().mockOf('workflow.clearRuns')).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog', { name: '清空历史' })).getByRole('button', { name: '确认清空' }));
    expect(currentApiMock().mockOf('workflow.clearRuns')).toHaveBeenCalledWith(WS);
  });

  it('单条运行记录：展开后可删除', async () => {
    const user = userEvent.setup();
    setOverview({ recent: [run({ runId: 'r9', status: 'failed', error: '炸了', endedAt: Date.now() })] });
    renderArea();
    const dialog = await openPanel(user);
    await user.click(within(dialog).getByRole('tab', { name: /运行/ }));
    await user.click(within(dialog).getByRole('button', { name: /cross-review-merge/ }));
    expect(getTipSnapshot()).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: '查看详情' }));
    expect(getTipSnapshot()?.text).toBe('炸了');
    await user.click(within(dialog).getByRole('button', { name: '删除记录' }));
    expect(currentApiMock().mockOf('workflow.clearRuns')).toHaveBeenCalledWith(WS, ['r9']);
  });

  it('旧 preload 缺接口时弹出重启 tip', async () => {
    const user = userEvent.setup();
    setOverview({ workflows: [def({ trust: 'trusted', schedule: '每天 02:00' })] });
    currentApiMock().override('workflow.setTriggers', () => {
      throw new TypeError('window.api.workflow.setTriggers is not a function');
    });
    renderArea();
    const dialog = await openPanel(user);
    const row = dialog.querySelector('[data-workflow="nightly-test-fix"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '停用触发' }));
    await waitFor(() => expect(getTipSnapshot()?.text).toMatch(/请完全重启应用/));
    expect((within(row).getByRole('button', { name: '停用触发' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('删除：二次确认后走 workflow.delete，失败原因通过 tip 显示', async () => {
    const user = userEvent.setup();
    setOverview({ workflows: [def({})] });
    currentApiMock().override('workflow.delete', () => Promise.reject(new Error('工作流 nightly-test-fix 还有运行中的 run，先取消再删除')));
    renderArea();
    const dialog = await openPanel(user);
    const row = dialog.querySelector('[data-workflow="nightly-test-fix"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '删除' }));
    expect(currentApiMock().mockOf('workflow.delete')).not.toHaveBeenCalled();
    const confirmation = await screen.findByRole('dialog', { name: '确认删除' });
    expect(within(confirmation).getByText(/目录将移到回收站/)).toBeTruthy();
    expect(row.contains(confirmation)).toBe(false);
    await user.click(within(confirmation).getByRole('button', { name: '取消' }));
    expect(within(row).queryByRole('button', { name: '确认删除' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: '删除' }));
    await user.click(within(await screen.findByRole('dialog', { name: '确认删除' })).getByRole('button', { name: '确认删除' }));
    expect(currentApiMock().mockOf('workflow.delete')).toHaveBeenCalledWith(WS, 'nightly-test-fix');
    await waitFor(() => expect(getTipSnapshot()?.text).toMatch(/先取消再删除/));
  });
});
