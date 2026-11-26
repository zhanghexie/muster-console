/**
 * 看板保留状态与会话入口；不显示专属快捷操作。
 */
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setBoardFilterPanelIds, setBoardFilterWorkspaceIds, setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { retainNeedsRead } from '../../src/renderer/src/panels/needsReadStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(partial: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'name'>): SessionMeta {
  return {
    type: 'terminal',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 },
    ...partial
  };
}

function seed(sessions: SessionMeta[]): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () =>
    Promise.resolve({ sessions, activeId: sessions[0]?.id ?? null })
  );
}

beforeEach(() => {
  retainNeedsRead([]);
  setFilterActiveWorkspace(false);
  setBoardFilterWorkspaceIds(null);
  setBoardFilterPanelIds(null);
  setFreeViewMode('status');
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      })) as typeof window.matchMedia;
  }
});

describe('看板待验收（P12/R4）', () => {
  it('静默任务显示等待输出状态，不能归入空闲', async () => {
    seed([sess({ id: 'quiet', name: '静默长命令', phase: undefined, lifecycle: 'quiet' })]);
    setFilterActiveWorkspace(true);
    render(<StoreProvider><BoardPanel /></StoreProvider>);
    const title = await screen.findByRole('button', { name: '静默长命令' });
    const card = title.closest('.board-card')!;
    expect(card.querySelector('.session-rail-status')?.textContent).toBe('等待输出');
    expect(card.querySelector('.session-rail-status')?.textContent).not.toBe('空闲');
  });
  it('审批/问题/无信号/退出点击卡片进入会话', async () => {
    const user = userEvent.setup();
    seed([
      sess({ id: 'review', name: '真实交付' }),
      sess({ id: 'approval', name: '等待授权', activity: { kind: 'blocked', ts: Date.now() } }),
      sess({ id: 'question', name: '需要回答', activity: { kind: 'waiting_input', ts: Date.now() } }),
      sess({ id: 'signal', name: '没有信号', phase: undefined, lifecycle: 'starting' }),
      sess({ id: 'exit', name: '异常退出', lifecycle: 'exited', status: 'exited' })
    ]);
    render(<StoreProvider><BoardPanel /></StoreProvider>);
    await screen.findByRole('button', { name: '需要回答' });
    for (const label of ['打开审批', '通过', '打回', '搁置', '查看会话', '继续对话', '更多']) expect(screen.queryByRole('button', { name: label })).toBeNull();
    await user.click(screen.getByRole('button', { name: '需要回答' }));
    expect(currentApiMock().mockOf('sessions.select')).toHaveBeenCalledWith('question');
  });
  it('需要你列排除归档但包含未闭环退出', async () => {
    seed([
      sess({ id: 's-live', name: '等验收活的' }),
      sess({ id: 's-arch', name: '已归档还挂 needs_you', archived: true }),
      sess({ id: 's-exit', name: '进程已退出', lifecycle: 'exited', status: 'exited' })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findByText('等验收活的', { selector: '.board-grid .board-card-name' });
    const col = document.querySelector('.board-column[data-zone="needsYou"]');
    expect(col?.textContent).toContain('等验收活的');
    expect(col?.textContent).not.toContain('已归档还挂 needs_you');
    expect(col?.textContent).toContain('进程已退出');
    for (const label of ['通过', '打回', '搁置']) expect(screen.queryByRole('button', { name: label })).toBeNull();
    expect(screen.queryByRole('button', { name: '标记完成并归档' })).toBeNull();
  });

  it('卡片不再出现标记已处理；右键菜单仍可走 sessions.markProcessed', async () => {
    const user = userEvent.setup();
    seed([sess({ id: 's-proc', name: '待处理会话' })]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findByRole('button', { name: '待处理会话' });
    expect(screen.queryByRole('button', { name: '标记完成并归档' })).toBeNull();
    const card = document.querySelector('.board-card');
    expect(card).toBeTruthy();
    await user.pointer({ keys: '[MouseRight]', target: card! });
    await user.click(await screen.findByRole('menuitemcheckbox', { name: '标记完成并归档' }));
    expect(currentApiMock().mockOf('sessions.markProcessed')).toHaveBeenCalledWith('s-proc');
  });

});

const cardBase = {
  sessionId: 's1',
  name: '卡',
  runtimeLabel: 'pi',
  relTimeTs: Date.now(),
  isActive: false,
  onSelect: () => {},
  onContextMenu: () => {}
};

describe('BoardCard 待验收行', () => {
  it('待验收状态不重复展示默认等验收胶囊', () => {
    const { container } = render(<BoardCard {...cardBase} status="waiting" liveLabel="等验收" reviewable />);
    expect(container.querySelector('.session-rail-status')?.textContent).toBe('待验收');
    expect(container.querySelector('.board-card-capsule')).toBeNull();
  });
  it('状态 label 不冒充测试证据，标题可用键盘打开，说明有完整 title', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<BoardCard {...cardBase} status="blocked" liveLabel="等待 API key" reviewSessionId="s1" reviewItem={cardBase.name} reviewSummary="完整说明" onSelect={onSelect} />);
    expect(container.textContent).not.toContain('测试证据');
    expect(container.querySelectorAll('.board-card-name')).toHaveLength(1);
    expect(screen.getByTitle('完整说明')).toBeTruthy();
    screen.getByRole('button', { name: cardBase.name }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('s1');
  });
  it('普通 memo 卡片的相对更新时间持续刷新', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const { container, unmount } = render(<BoardCard {...cardBase} relTimeTs={Date.now() - 120_000} status="working" />);
      expect(container.querySelector('.session-reltime')?.textContent).toBe('2m');
      act(() => vi.advanceTimersByTime(65_000));
      expect(container.querySelector('.session-reltime')?.textContent).toBe('3m');
      unmount();
    } finally { vi.useRealTimers(); }
  });
  it('只展示有内容的条目、说明和风险，不重复标识与分支', () => {
    const { container } = render(
      <BoardCard
        {...cardBase}
        status="waiting"
        reviewSessionId="aaaaaaaa"
        reviewItem="t-12"
        reviewSummary="vitest 绿"
        reviewRisks="脏主仓"
      />
    );
    const block = container.querySelector('.board-card-review');
    expect(block?.textContent).not.toContain('aaaaaaaa');
    expect(block?.textContent).toContain('t-12');
    expect(block?.textContent).not.toContain('ao/aaaaaaaa');
    expect(block?.textContent).not.toContain('测试证据');
    expect(block?.textContent).toContain('说明');
    expect(block?.textContent).toContain('vitest 绿');
    expect(block?.textContent).toContain('脏主仓');
  });
});

describe('BoardCard 标题行', () => {
  it('待验收、已完成和归档均不出现看板专属快捷操作', () => {
    for (const status of ['waiting', 'done', 'exited'] as const) {
      const view = render(<BoardCard {...cardBase} status={status} reviewable onArchive={() => {}} />);
      expect(view.container.querySelector('.board-card-toolbar, .board-card-actions, .board-card-more-btn')).toBeNull();
      expect(view.container.querySelector('.session-archive-btn')).toBeTruthy();
      view.unmount();
    }
  });
});

describe('看板卡片动作区（BoardPanel 接线）', () => {
  it('已完成与进行中卡片都不显示额外动作', async () => {
    seed([
      sess({
        id: 's-done',
        name: '用户已完成',
        phase: { value: 'done', source: 'user', ts: 1 }
      }),
      sess({
        id: 's-work',
        name: '干活中',
        phase: { value: 'idle', source: 'model', ts: 1 },
        lifecycle: 'working'
      })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findByRole('button', { name: '用户已完成' });
    const doneCol = document.querySelector('.board-column[data-zone="done"]');
    expect(doneCol?.textContent).toContain('用户已完成');
    expect(doneCol?.querySelector('.board-card-actions')).toBeNull();
    expect(doneCol?.querySelector('.session-archive-btn')).toBeTruthy();
    const workCol = document.querySelector('.board-column[data-zone="working"]');
    expect(workCol?.textContent).toContain('干活中');
    expect(workCol?.querySelector('.board-card-actions')).toBeNull();
    expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull();
    expect(screen.queryByRole('button', { name: '标记完成并归档' })).toBeNull();
  });

  it('归档卡片沿用会话行的恢复按钮，右键仍有取消归档与删除', async () => {
    const user = userEvent.setup();
    seed([
      sess({
        id: 's-arch',
        name: '归档会话',
        archived: true,
        lifecycle: 'exited',
        status: 'exited'
      })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await user.click(await screen.findByRole('button', { name: '过滤' }));
    const filter = await screen.findByRole('dialog', { name: '过滤' });
    const filterRows = within(filter);
    for (const label of ['代办', '进行中', '需要你', '已完成']) {
      await user.click(filterRows.getByRole('checkbox', { name: label }));
    }
    await screen.findByText('归档会话');
    const archCol = document.querySelector('.board-column[data-zone="archived"]');
    expect(archCol?.querySelector('.session-archive-btn')?.getAttribute('aria-label')).toBe('取消归档');
    expect(archCol?.querySelector('.board-card-actions')).toBeNull();
    const card = archCol?.querySelector('.board-card');
    expect(card).toBeTruthy();
    await user.pointer({ keys: '[MouseRight]', target: card! });
    expect(await screen.findByRole('menuitemcheckbox', { name: '取消归档' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: '永久删除' })).toBeTruthy();
    expect(screen.queryByRole('menuitemcheckbox', { name: '标记完成' })).toBeNull();
  });

  it('需要你列右键仍有标记完成 / 归档 / 标记已处理', async () => {
    const user = userEvent.setup();
    seed([sess({ id: 's-need', name: '等验收会话' })]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findByRole('button', { name: '等验收会话' });
    const card = document.querySelector('.board-column[data-zone="needsYou"] .board-card');
    expect(card).toBeTruthy();
    await user.pointer({ keys: '[MouseRight]', target: card! });
    expect(await screen.findByRole('menuitemcheckbox', { name: '标记完成' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: '归档' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: '标记完成并归档' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: '验收并归档' })).toBeTruthy();
  });

  it('确认验收并合入后，按正常验收路径提交', async () => {
    const user = userEvent.setup();
    seed([sess({ id: 'merge', name: '隔离交付', worktreePath: 'E:/task', worktreeBranch: 'ao/task' })]);
    render(<StoreProvider><BoardPanel /></StoreProvider>);
    await screen.findByRole('button', { name: '隔离交付' });
    const card = document.querySelector('.board-column[data-zone="needsYou"] .board-card');
    await user.pointer({ keys: '[MouseRight]', target: card! });
    await user.click(await screen.findByRole('menuitemcheckbox', { name: '验收并合入' }));
    const dialog = await screen.findByRole('dialog', { name: '验收「隔离交付」' });
    expect(within(dialog).getByText(/ao\/task/)).toBeTruthy();
    expect(currentApiMock().mockOf('sessions.review')).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '验收并合入' }));
    expect(currentApiMock().mockOf('sessions.review')).toHaveBeenCalledWith({ sessionId: 'merge', decision: 'passed' });
  });
});
