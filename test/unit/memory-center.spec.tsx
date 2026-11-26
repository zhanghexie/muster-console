/**
 * 记忆总览（MemoryOverview）组件级测试。
 *
 * X4-F06（reliability/X4-IPC面完整性，2026-10-25）拆分：MemoryPanel/MemoryCenterTabs
 * 死组件树（生产零 import、memoryCenter 15 个无注册通道独占消费）已删除，原 spec
 * 中依托死树的 hub/页签/审批/画像/回收站用例随之移除；本文件保留**活组件**
 * MemoryOverview 的直渲染用例（画布适配/手势/事件流/脉冲）与 activeFlowEdges
 * 纯函数用例。log/recycle/events/stagingList 四通道 preload 暴露按 X4-F01/D10
 * 裁定保留，事件轮询链在这些 override 下照常可测。
 * window.api 走 helpers/api-mock。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryOverview,
  PULSE_WINDOW_MS,
  activeFlowEdges
} from '../../src/renderer/src/components/MemoryOverview';
import {
  resetMemoryCenterRouteForTest,
  useMemoryCenterRoute
} from '../../src/renderer/src/memoryCenterRoute';
import { currentApiMock } from './helpers/api-mock';

const WORKER_ENTRY = {
  id: '2026-09-01 10:00:00-s1-abc',
  namespace: 'worker' as const,
  ts: '2026-09-01 10:00:00',
  sessionId: 's1',
  tags: ['decision'],
  links: [],
  text: '数据库统一 PostgreSQL，弃 MySQL。',
  raw: '<!-- 2026-09-01 10:00:00 [s1] --> #decision 数据库统一 PostgreSQL，弃 MySQL。',
  unparsed: false,
  trigger: [],
  importance: null,
  repoKey: null,
  origin: null,
  ageDays: 20,
  recall: { injected30d: 12, hits30d: 5, lastRecalledAt: Date.now() - 86_400_000 },
  provenance: { kind: 'session' as const, sessionId: 's1' },
  supersedes: null
};

const INTENTS = {
  items: [
    {
      id: 5,
      description: '每当 auth 任务的 PR 合并就提醒跑冒烟',
      keywords: ['auth', '冒烟'],
      eventPredicates: [{ kind: 'pr_merged' as const, branchIncludes: 'auth' }],
      state: 'fired' as const,
      fireCount: 1,
      fireBudget: 3,
      cooldownRemainMs: 3600_000,
      expiry: 1790000000000,
      lastFiredAt: 1758400000000,
      createdAt: 1758300000000,
      createdBy: 'intent-tool:scheduler'
    }
  ]
};

const LOG_ITEM = {
  id: 7
};

const STAGING = {
  items: [],
  recovery: [],
  pendingCount: 2
};

const NOW = Date.now();
/** M3 条目 1B 事件流 fixture（服务端同序：新→旧）。近 5 分钟窗口内的 kind 集合
 * {staged, promoted, intent_fired} 决定脉冲边 e-note/e-auto/e-fire；粒子数 = 1+1+2 = 4。 */
const EVENTS = {
  items: [
    {
      id: 91,
      kind: 'auto_admitted',
      ts: NOW - 60_000,
      namespace: 'worker',
      stagingId: 3,
      approvalId: null,
      chunkId: null,
      entryRef: WORKER_ENTRY.id,
      summary: '一条记忆通过巩固晋升入库（候选 #{{stagingId}}）',
      summaryArgs: { stagingId: 3 }
    },
    {
      id: 90,
      kind: 'staged',
      ts: NOW - 120_000,
      namespace: 'worker',
      stagingId: 11,
      approvalId: null,
      chunkId: null,
      entryRef: 'staging:11',
      summary: '新记忆候选入池：{{text}}',
      summaryArgs: { text: '#lesson 先跑冒烟再合入。' }
    },
    {
      id: 89,
      kind: 'intent_fired',
      ts: NOW - 240_000,
      namespace: null,
      stagingId: null,
      approvalId: null,
      chunkId: null,
      entryRef: 'intent:5',
      summary: '前瞻意图触发：{{description}}',
      summaryArgs: { description: '跑冒烟' }
    },
    {
      id: 88,
      kind: 'approval_queued',
      ts: NOW - 2 * 86_400_000,
      namespace: 'worker',
      stagingId: 9,
      approvalId: 7,
      chunkId: null,
      entryRef: 'approval:7',
      summary: '记忆晋升待审：{{count}} 项操作等你把关',
      summaryArgs: { count: 2 }
    },
    {
      id: 87,
      kind: 'direct_write',
      ts: NOW - 3 * 86_400_000,
      namespace: 'worker',
      stagingId: null,
      approvalId: null,
      chunkId: null,
      entryRef: null,
      summary: '你让 Agent 记住了一条：{{text}}',
      summaryArgs: { text: '日报要带回归结果。' }
    }
  ],
  todayActivations: 234,
  kindCounts24h: { staged: 3, auto_admitted: 2, intent_fired: 4, intent_cancelled: 1 },
  kindCounts7d: { staged: 5, auto_admitted: 3, intent_fired: 6, intent_cancelled: 2 }
};

function installDefaults(): void {
  currentApiMock().override('config.get', () => Promise.resolve({ workspaces: [], activeWorkspaceId: 'ws-1', locale: 'zh-CN' }));
  const m = currentApiMock();
  m.override('memoryCenter.log', () => Promise.resolve({ items: [LOG_ITEM] }));
  m.override('memoryCenter.recycle', () => Promise.resolve({ preimages: [] }));
  m.override('memoryCenter.intents', () => Promise.resolve(INTENTS));
  m.override('memoryCenter.stagingList', () => Promise.resolve(STAGING));
  m.override('memoryCenter.events', () => Promise.resolve(EVENTS));
}

/** 路由探针：feed 行点击走 requestMemoryCenterTab（模块级 store），经 hook 读回断言 */
function RouteProbe(): React.JSX.Element {
  const route = useMemoryCenterRoute();
  return <div data-testid="route-probe">{route ? `${route.tab}␞${route.entryId ?? ''}` : ''}</div>;
}

// jsdom 未实现 scrollIntoView（跨页签条目定位的滚动步骤用；仓库既有惯例同款 stub）
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  resetMemoryCenterRouteForTest();
  installDefaults();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});

describe('总览画布适配与动态收起', () => {
  it('按宽高完整适配，允许继续缩小，自动收起后可手动展开并保持选择', async () => {
    const original = globalThis.ResizeObserver;
    const callbacks = new Set<() => void>();
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { callbacks.add(callback); }
      observe() {} unobserve() {} disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const user = userEvent.setup();
      const { container } = render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
      const root = await screen.findByTestId('memory-overview');
      const card = container.querySelector('.memory-overview-card')!;
      const svg = container.querySelector('.memory-overview-svg') as SVGElement;
      let width = 780;
      let height = 600;
      Object.defineProperties(root, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
      Object.defineProperties(card, { clientWidth: { get: () => width - 32 }, clientHeight: { get: () => height - 80 } });
      act(() => callbacks.forEach(cb => cb()));
      expect(parseFloat(svg.style.width)).toBeLessThan(width - 32);
      expect(parseFloat(svg.style.height)).toBeLessThan(height - 80);
      const fitWidth = parseFloat(svg.style.width);
      const toggle = screen.getByRole('button', { name: '展开最近动态' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      await waitFor(() => expect(screen.queryByTestId('overview-feed')).toBeNull());
      await user.click(screen.getByRole('button', { name: '缩小总览图' }));
      expect(parseFloat(svg.style.width)).toBeLessThan(fitWidth);
      await user.click(screen.getByRole('button', { name: '适应画布' }));
      expect(parseFloat(svg.style.width)).toBeCloseTo(fitWidth);
      width = 1200;
      height = 400;
      act(() => callbacks.forEach(cb => cb()));
      expect(screen.getByRole('button', { name: '展开最近动态' })).toBeTruthy();
      height = 700;
      act(() => callbacks.forEach(cb => cb()));
      expect(screen.getByRole('button', { name: '收起最近动态' })).toBeTruthy();
      width = 780;
      act(() => callbacks.forEach(cb => cb()));
      await user.click(screen.getByRole('button', { name: '展开最近动态' }));
      expect(screen.getByRole('button', { name: '收起最近动态' }).getAttribute('aria-expanded')).toBe('true');
      height = 400;
      width = 1200;
      act(() => callbacks.forEach(cb => cb()));
      expect(screen.getByRole('button', { name: '收起最近动态' }).getAttribute('aria-expanded')).toBe('true');
      expect(parseFloat(svg.style.height)).toBeLessThan(320);
      await user.click(screen.getByRole('button', { name: '收起最近动态' }));
      await waitFor(() => expect(screen.queryByTestId('overview-feed')).toBeNull());
      expect(screen.getByRole('button', { name: '展开最近动态' })).toBeTruthy();
    } finally { globalThis.ResizeObserver = original; }
  });

  it('鼠标框选放大、右键平移、空白双击复位；节点点击和取消手势互不干扰', async () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit) {
        super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse';
      }
    });
    const onSelect = vi.fn();
    const { container } = render(<MemoryOverview center={null} pending={0} onSelectTab={onSelect} />);
    const card = container.querySelector('.memory-overview-card') as HTMLDivElement;
    const svg = container.querySelector('.memory-overview-svg') as SVGElement;
    Object.defineProperties(card, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 } as DOMRect);
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1090, height: 700, right: 1090, bottom: 700 } as DOMRect);
    card.setPointerCapture = vi.fn(); card.hasPointerCapture = () => true; card.releasePointerCapture = vi.fn();
    card.scrollTo = vi.fn((leftOrOptions?: number | ScrollToOptions, top?: number) => {
      if (typeof leftOrOptions === 'number') {
        card.scrollLeft = leftOrOptions;
        card.scrollTop = top ?? 0;
      } else {
        card.scrollLeft = leftOrOptions?.left ?? card.scrollLeft;
        card.scrollTop = leftOrOptions?.top ?? card.scrollTop;
      }
    });
    const pointer = (button: number, x: number, y: number) => ({ button, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' });
    const node = screen.getByTestId('overview-node-n-staging');
    fireEvent.pointerDown(node, pointer(0, 100, 100));
    fireEvent.pointerMove(node, pointer(0, 250, 200));
    expect(screen.queryByTestId('overview-selection')).toBeNull();
    fireEvent.click(node);
    expect(onSelect).toHaveBeenCalledWith('index');
    onSelect.mockClear();
    fireEvent.pointerDown(svg, pointer(0, 100, 100));
    fireEvent.pointerMove(card, pointer(0, 300, 250));
    expect(screen.getByTestId('overview-selection').style.width).toBe('200px');
    fireEvent.pointerUp(card, pointer(0, 300, 250));
    expect(parseFloat(svg.style.width)).toBe(2180);
    expect(screen.queryByTestId('overview-selection')).toBeNull();
    fireEvent.click(node); // Release click after drag cannot activate the underlying node.
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.doubleClick(node);
    expect(parseFloat(svg.style.width)).toBe(2180);
    card.scrollLeft = 100; card.scrollTop = 100;
    fireEvent.pointerDown(node, pointer(2, 300, 250));
    fireEvent.pointerMove(card, pointer(2, 350, 280));
    expect(card.scrollLeft).toBe(50); expect(card.scrollTop).toBe(70);
    fireEvent.pointerUp(card, pointer(2, 350, 280));
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(card, menu); expect(menu.defaultPrevented).toBe(true);
    fireEvent.doubleClick(svg);
    expect(parseFloat(svg.style.width)).toBe(1090);
    expect(card.scrollLeft).toBe(0); expect(card.scrollTop).toBe(0);
    fireEvent.pointerDown(svg, pointer(0, 100, 100));
    fireEvent.pointerMove(card, pointer(0, 350, 250));
    fireEvent.pointerCancel(card, pointer(0, 350, 250));
    expect(screen.queryByTestId('overview-selection')).toBeNull();
    expect(parseFloat(svg.style.width)).toBe(1090);
    fireEvent.click(node); expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(svg, pointer(0, 120, 100));
    fireEvent.pointerMove(card, pointer(0, 122, 102));
    fireEvent.pointerUp(card, pointer(0, 122, 102));
    expect(parseFloat(svg.style.width)).toBe(1090);
    await act(async () => {});
  });

  it('操作说明沿用全局画布问号：点击开合、Esc 恢复焦点、外部点击关闭，不触发画布手势', async () => {
    const user = userEvent.setup();
    const { container } = render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
    await screen.findByTestId('memory-overview');
    const button = screen.getByRole('button', { name: '操作说明' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('note').textContent).toBe('空白左键拖动框选放大 · 按住右键拖动平移 · 双击空白自适应 · 点击节点查看详情');
    expect(screen.queryByTestId('overview-selection')).toBeNull();
    expect(container.querySelector('.memory-overview-card')?.contains(button)).toBe(false);
    await user.keyboard('{Escape}');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(container.querySelector('.memory-overview-svg')!);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await user.click(button);
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
  });

  it('未取得有效尺寸时保留动态入口', async () => {
    const { container } = render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
    await screen.findByTestId('memory-overview');
    // Initial zero-sized jsdom layout leaves the wide-screen feed available.
    expect(screen.getByRole('button', { name: '收起最近动态' })).toBeTruthy();
    expect(container.querySelector('.memory-overview-stage')).toBeTruthy();
  });
});

describe('总览 1B：事件流 / 边流量 / 真信号脉冲（活体脑图）', () => {
  it('activeFlowEdges 纯函数：近 5 分钟窗口内的映射 kind 才挂边；出窗/未来事件与注入边不挂', () => {
    const now = 1_000_000_000_000;
    const edges = activeFlowEdges(
      [
        { kind: 'staged', ts: now - PULSE_WINDOW_MS }, // 恰在窗口边界 → 挂
        { kind: 'promoted', ts: now - PULSE_WINDOW_MS - 1 }, // 出窗 → 不挂
        { kind: 'intent_fired', ts: now - 1_000 }, // 挂 e-fire
        { kind: 'intent_cancelled', ts: now + 1 } // 未来事件 → 不挂
      ],
      now
    );
    expect(edges.has('e-note')).toBe(true);
    expect(edges.has('e-fire')).toBe(true);
    expect(edges.has('e-auto')).toBe(false);
    // 注入不落账（条目 1A 定稿）：无 kind 映射的边永不挂粒子
    expect(edges.has('e-inject')).toBe(false);
    expect(edges.has('e-inject-ustub')).toBe(false);
  });

  it('事件流右栏：标题+24h 头计数+时间/色点/人话句；无实体行不可点', async () => {
    render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
    const feed = await screen.findByTestId('overview-feed');
    expect(within(feed).getByText('最近动态')).toBeTruthy();
    // 24h 头计数 = kindCounts24h 求和（3+2+4+1）
    expect(within(feed).getByText('近 24h 10 条')).toBeTruthy();
    // 人话句 t(summary, summaryArgs)
    expect(within(feed).getByText('一条记忆通过巩固晋升入库（候选 #3）')).toBeTruthy();
    expect(within(feed).getByText('新记忆候选入池：#lesson 先跑冒烟再合入。')).toBeTruthy();
    // 有实体 → button 可点；无实体（direct_write entryRef=null）→ 静态 div
    expect(within(feed).getByTestId('feed-row-90').tagName).toBe('BUTTON');
    expect(within(feed).getByTestId('feed-row-87').tagName).toBe('DIV');
  });

  it('事件流渲染上限 50 条：拉到 55 条只渲染前 50', async () => {
    const m = currentApiMock();
    m.override('memoryCenter.events', () =>
      Promise.resolve({
        items: Array.from({ length: 55 }, (_, i) => ({
          id: 2000 + i,
          kind: 'staged',
          ts: Date.now() - i * 60_000,
          namespace: null,
          stagingId: null,
          approvalId: null,
          chunkId: null,
          entryRef: null,
          summary: '新记忆候选入池：{{text}}',
          summaryArgs: { text: `第 ${i} 条` }
        })),
        kindCounts24h: {},
        kindCounts7d: {}
      })
    );
    render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
    const feed = await screen.findByTestId('overview-feed');
    await waitFor(() => {
      expect(feed.querySelectorAll('.mflow-row').length).toBe(50);
    });
  });

  it('事件流实体跳路由：staged 行→索引状态页签；promoted 行→条目总览并带条目定位', async () => {
    const user = userEvent.setup();
    render(
      <>
        <RouteProbe />
        <MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />
      </>
    );
    const feed = await screen.findByTestId('overview-feed');

    await user.click(within(feed).getByTestId('feed-row-90'));
    expect(screen.getByTestId('route-probe').textContent).toBe('index␞');

    await user.click(within(screen.getByTestId('overview-feed')).getByTestId('feed-row-91'));
    await waitFor(() => {
      const probe = screen.getByTestId('route-probe').textContent ?? '';
      expect(probe.startsWith('entries␞')).toBe(true);
      expect(probe.split('␞')[1]).toBe(WORKER_ENTRY.id);
    });
  });

  it('节点活徽标 + 边流量芯片 + 脉冲门控：有事件流动、静默静止（粒子数断言，不依赖 rAF 时序）', async () => {
    // 日期只冻结 Date，异步等待仍用真实定时器；午夜执行时事件不会意外变成“昨天”。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(EVENTS.items[0].ts));
    try {
      const { container, unmount } = render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
      await screen.findByTestId('overview-feed');
      // 活徽标来自积压和后端完整的当地日历日去重数，展示窗口只有一条保存事件。
      expect(await screen.findByText('积压 2')).toBeTruthy();
      expect(screen.getByText('今日生效 234')).toBeTruthy();
      // 边流量芯片：近 24h kind 计数直出（e-note←staged 3 / e-auto←promoted 2 / e-fire←intent 4+1=5）
      const chipText = (edge: string): string =>
        container.querySelector(`[data-testid="overview-edgecount-${edge}"] > text`)?.textContent ?? '';
      expect(chipText('e-note')).toBe('3');
      expect(chipText('e-auto')).toBe('2');
      expect(chipText('e-fire')).toBe('4');
      expect(container.querySelector('[data-testid="overview-edgecount-e-inject"]')).toBeNull();
      // hover 展示近 7 日（复审补 1B：kindCounts7d 与 24h 同源）
      expect(container.querySelector('[data-testid="overview-edgecount-e-note"] title')?.textContent).toBe(
        '近 24 小时 3 次 · 近 7 日 5 次 · 候选入池'
      );
      // 脉冲门控：近 5 分钟有事件的边挂粒子（e-note 1 + e-auto 1 + e-fire 2 = 4），静默边不挂
      await waitFor(() => {
        expect(container.querySelectorAll('#mflow-particles circle').length).toBe(4);
      });

      // 静默期：事件全部出 5 分钟窗 → 粒子清零（静止），24h 芯片口径不受影响
      unmount();
      const m = currentApiMock();
      m.override('memoryCenter.events', () =>
        Promise.resolve({
          items: EVENTS.items.map((ev) => ({ ...ev, ts: Date.now() - 2 * 3_600_000 })),
          kindCounts24h: EVENTS.kindCounts24h,
          kindCounts7d: EVENTS.kindCounts7d
        })
      );
      const second = render(<MemoryOverview center={null} pending={0} onSelectTab={vi.fn()} />);
      const feed2 = await screen.findByTestId('overview-feed');
      // 先等事件行真的渲染出来（数据已到、effect 已跑），再断言粒子数为 0
      await waitFor(() => {
        expect(feed2.querySelectorAll('.mflow-row').length).toBe(5);
      });
      expect(second.container.querySelectorAll('#mflow-particles circle').length).toBe(0);
      expect(
        second.container.querySelector('[data-testid="overview-edgecount-e-note"] > text')?.textContent
      ).toBe('3');
    } finally {
      vi.useRealTimers();
    }
  });
});
