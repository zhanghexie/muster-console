import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryOverview, type MemoryOverviewLive } from '../../src/renderer/src/components/MemoryOverview';

const live: MemoryOverviewLive = {
  stats: { curated: 9, profileChars: 0, profileMax: 800, pending: 6, intents: 1, recycle: 102, lastConsolAt: null },
  backlog: 7, processing: { failed: 2, suspended: 1, running: false, paused: false },
  feed: { items: [], todayActivations: 234, kindCounts24h: {}, kindCounts7d: {} }
};

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));

test('every graph route stays outside every card interior', () => {
  const { container } = render(<MemoryOverview center={null} pending={6} live={live} onSelectTab={() => {}} />);
  const cards = [...container.querySelectorAll('foreignObject')].map(el => ({
    id: el.querySelector('[data-testid]')?.getAttribute('data-testid'),
    x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')),
    w: Number(el.getAttribute('width')), h: Number(el.getAttribute('height'))
  }));
  // Sample straight segments and quadratic corners from the rendered path, not a copied layout.
  for (const path of container.querySelectorAll('.mflow-edge')) {
    const points: Array<[number, number]> = [];
    let cursor: [number, number] = [0, 0];
    for (const command of path.getAttribute('d')!.matchAll(/([MLQ])([^MLQ]+)/g)) {
      const values = command[2].trim().split(/\s+/).map(Number);
      const end: [number, number] = command[1] === 'Q' ? [values[2], values[3]] : [values[0], values[1]];
      if (command[1] !== 'M') for (let step = 0; step <= 64; step++) {
        const t = step / 64, u = 1 - t;
        points.push(command[1] === 'Q'
          ? [u * u * cursor[0] + 2 * u * t * values[0] + t * t * end[0], u * u * cursor[1] + 2 * u * t * values[1] + t * t * end[1]]
          : [u * cursor[0] + t * end[0], u * cursor[1] + t * end[1]]);
      }
      cursor = end;
    }
    for (const [x, y] of points) {
      for (const card of cards) {
        const inside = x > card.x + 1 && x < card.x + card.w - 1 && y > card.y + 1 && y < card.y + card.h - 1;
        expect(inside, `${path.id} crosses ${card.id} at ${x},${y}`).toBe(false);
      }
    }
  }
});

test('a missing daily aggregate never masquerades as the count in a partial event feed', () => {
  render(<MemoryOverview center={null} pending={6} live={{ ...live, feed: {
    items: [{ id: 1, ts: Date.now(), kind: 'auto_admitted', namespace: 'worker', stagingId: null, chunkId: null,
      approvalId: null, entryRef: null, summary: '自动保存', summaryArgs: null }], kindCounts24h: {auto_admitted: 500}, kindCounts7d: {}
  } }} onSelectTab={() => {}} />);
  expect(within(screen.getByTestId('overview-node-n-consolidation')).queryByText(/今日/)).toBeNull();
});

test('queue, failures and daily unique activations use their own totals, never legacy pending or feed length', () => {
  const select = vi.fn();
  const view = render(<MemoryOverview center={null} pending={6} live={live} onSelectTab={select} />);
  expect(within(screen.getByTestId('overview-node-n-staging')).getByText('积压 7')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-approval')).getByText('失败 2')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-approval')).getByText('知识暂停 1 条 · 失败可重试')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-consolidation')).getByText('今日生效 234')).toBeTruthy();
  expect(within(screen.getByTestId('overview-node-n-consolidation')).getByText('待处理 7 个候选')).toBeTruthy();
  fireEvent.keyDown(screen.getByTestId('overview-node-n-curated'), { key: 'Enter' });
  expect(select).toHaveBeenCalledWith('entries');
  view.rerender(<MemoryOverview center={null} pending={6} live={{ ...live, processing: { ...live.processing!, paused: true } }} onSelectTab={select} />);
  expect(screen.getByText('记忆整理已暂停')).toBeTruthy();
  view.rerender(<MemoryOverview center={null} pending={6} live={{ ...live, processing: { ...live.processing!, running: true } }} onSelectTab={select} />);
  expect(screen.getByText('正在整理记忆')).toBeTruthy();
});

test('explicit requests share the candidate route, reminders and comparison have separate routes', () => {
  const { container } = render(<MemoryOverview center={null} pending={6} live={live} onSelectTab={() => {}} />);
  expect(screen.getByText('外部输入 · 有用发现 / 明确记住')).toBeTruthy();
  expect(container.querySelector('#e-direct-1')).toBeNull();
  expect(container.querySelector('#e-compare')).toBeTruthy();
  expect(container.querySelector('.mflow-gate-hit')).toBeNull();
  expect(container.textContent).not.toContain('开场注入 · 检索 · 触发词');
});
