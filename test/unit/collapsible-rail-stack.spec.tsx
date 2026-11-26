import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { it, expect, vi, describe, beforeEach, afterEach } from 'vitest';
import { CollapsibleRailStack } from '../../src/renderer/src/components/CollapsibleRailStack';
import { MOTION } from '../../src/renderer/src/components/motion';

const items = ['first', 'current', 'last'].map(id => <button key={id} data-id={id}>{id}</button>);
it('折叠保留当前项并禁用其他项；展开保持顺序和同一 DOM', () => {
  const view = render(<CollapsibleRailStack collapsed={false} activeKey="current" className="session-list">{items}</CollapsibleRailStack>);
  const original = view.container.querySelector('[data-id="current"]');
  view.rerender(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{items}</CollapsibleRailStack>);
  expect(view.container.querySelector('.is-preview [data-id]')?.getAttribute('data-id')).toBe('current');
  expect(view.container.querySelectorAll('.rail-stack-item[inert]').length).toBe(2);
  expect(view.container.querySelector('.rail-stack')?.getAttribute('data-mp-stage')).toBe('out');
  view.rerender(<CollapsibleRailStack collapsed={false} activeKey="current" className="session-list">{items}</CollapsibleRailStack>);
  expect(view.container.querySelector('[data-id="current"]')).toBe(original);
  expect([...view.container.querySelectorAll('[data-id]')].map(el => el.getAttribute('data-id'))).toEqual(['first', 'current', 'last']);
  expect(view.container.querySelectorAll('[inert]').length).toBe(0);
});
it('折叠中反向展开取消退场，原列表不重挂、不被旧计时器收走', () => {
  vi.useFakeTimers();
  try {
    const view = render(<CollapsibleRailStack collapsed={false} className="session-list">{items}</CollapsibleRailStack>);
    const original = view.container.querySelector('[data-id="last"]');
    view.rerender(<CollapsibleRailStack collapsed className="session-list">{items}</CollapsibleRailStack>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs / 2));
    view.rerender(<CollapsibleRailStack collapsed={false} className="session-list">{items}</CollapsibleRailStack>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + MOTION.microMs));
    expect(view.container.querySelector('.rail-stack')?.getAttribute('data-mp-stage')).toBe('in');
    expect(view.container.querySelector('[data-id="last"]')).toBe(original);
  } finally { vi.useRealTimers(); }
});
it('没有当前项时留第一项；移除当前项后自动回退，单项和空列表不画后排', () => {
  const view = render(<CollapsibleRailStack collapsed activeKey="missing" className="session-list">{items}</CollapsibleRailStack>);
  expect(view.container.querySelector('.is-preview [data-id]')?.getAttribute('data-id')).toBe('first');
  view.rerender(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{items}</CollapsibleRailStack>);
  expect(view.container.querySelector('.is-preview [data-id]')?.getAttribute('data-id')).toBe('current');
  view.rerender(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{items[2]}</CollapsibleRailStack>);
  expect(view.container.querySelector('.is-preview [data-id]')?.getAttribute('data-id')).toBe('last');
  expect(view.container.querySelector('.has-rest')).toBeNull();
  view.rerender(<CollapsibleRailStack collapsed className="session-list" />);
  expect(view.container.querySelector('.has-rest')).toBeNull();
});
it('磁贴选择使用自身选中态；折叠时不调用完整列表的键盘导航', () => {
  const navigate = vi.fn();
  const view = render(<CollapsibleRailStack collapsed className="utility-feature-list" tabIndex={0} onKeyDown={navigate}>
    <button key="a">A</button><button key="b" aria-pressed>B</button>
  </CollapsibleRailStack>);
  expect(view.container.querySelector('.is-preview button')?.textContent).toBe('B');
  fireEvent.keyDown(view.container.querySelector('.rail-stack-layout')!, { key: 'ArrowDown' });
  expect(navigate).not.toHaveBeenCalled();
});

describe('rail layout invalidation', () => {
  type Metric = { left?: number; top?: number; width?: number; height?: number };
  const positions = new Map<string, Metric>();
  const reads = vi.fn();
  let fullHeight = 120;
  const observers: Array<{ targets: Set<Element>; disconnected: boolean; fireFor: (target: Element) => void; fireRaw: () => void }> = [];
  beforeEach(() => {
    positions.clear(); reads.mockClear(); observers.length = 0; fullHeight = 120;
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      disconnected = false;
      constructor(private callback: () => void) { observers.push(this); }
      observe(target: Element): void { this.targets.add(target); }
      disconnect(): void { this.disconnected = true; this.targets.clear(); }
      fireFor(target: Element): void { if (this.targets.has(target)) this.callback(); }
      fireRaw(): void { this.callback(); }
    });
    for (const [property, field] of [['offsetLeft', 'left'], ['offsetTop', 'top'], ['offsetWidth', 'width'], ['offsetHeight', 'height']] as const) {
      vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement): number {
        reads(property);
        if (this.classList.contains('rail-stack-layout')) return field === 'height' ? fullHeight : 120;
        const override = positions.get(this.dataset.stackKey ?? '')?.[field];
        if (override != null) return override;
        if (field === 'height') return 36;
        if (field === 'width') return 120;
        return field === 'top' ? [...(this.parentElement?.children ?? [])].indexOf(this) * 40 : 0;
      });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const freshItems = (order = ['first', 'current', 'last'], pressed?: string, suffix = '') => order.map(id =>
    <button key={id} data-id={id} aria-pressed={pressed === id}>{id}{suffix}</button>);
  const preview = (container: HTMLElement) => container.querySelector('.is-preview button')?.getAttribute('data-id');

  it('等价 children clone 与无几何变化的正文更新不再同步读取 offset', () => {
    const view = render(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{freshItems()}</CollapsibleRailStack>);
    expect(reads).toHaveBeenCalled();
    reads.mockClear();
    const observer = observers[0];
    view.rerender(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{freshItems()}</CollapsibleRailStack>);
    expect(reads).not.toHaveBeenCalled(); // 恢复 [children] 无条件 measure 即红
    view.rerender(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{freshItems(undefined, undefined, ' updated')}</CollapsibleRailStack>);
    expect(reads).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('current updated');
    expect(observers).toHaveLength(1);
    expect(observers[0]).toBe(observer);
  });

  it('工作区过场期间暂停几何读取，过场结束后补一次测量', () => {
    const view = render(<CollapsibleRailStack paused collapsed activeKey="current" className="session-list">{freshItems()}</CollapsibleRailStack>);
    expect(reads).not.toHaveBeenCalled();
    reads.mockClear();
    view.rerender(<CollapsibleRailStack paused={false} collapsed activeKey="current" className="session-list">{freshItems()}</CollapsibleRailStack>);
    expect(reads).toHaveBeenCalled();
  });

  it('有效 active、fallback 属性和 key 顺序变化仍在当前布局提交更新', () => {
    const view = render(<CollapsibleRailStack collapsed activeKey="current" className="session-list">{freshItems()}</CollapsibleRailStack>);
    reads.mockClear();
    view.rerender(<CollapsibleRailStack collapsed activeKey="last" className="session-list">{freshItems()}</CollapsibleRailStack>);
    expect(reads).toHaveBeenCalled();
    expect(preview(view.container)).toBe('last');
    reads.mockClear();
    view.rerender(<CollapsibleRailStack collapsed activeKey="missing" className="session-list">{freshItems(undefined, 'current')}</CollapsibleRailStack>);
    expect(preview(view.container)).toBe('current');
    expect(reads).toHaveBeenCalled();
    reads.mockClear();
    view.rerender(<CollapsibleRailStack collapsed activeKey="missing" className="session-list">{freshItems(['last', 'first', 'current'], 'current')}</CollapsibleRailStack>);
    expect(reads).toHaveBeenCalled();
    expect(view.container.querySelector('.rail-stack')?.getAttribute('data-preview-index')).toBe('2');
    expect((view.container.querySelector('[data-stack-key="current"]') as HTMLElement).style.getPropertyValue('--rail-shift-y')).toBe('-80px');
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);
  });

  it('同一 RO 观察 body 与直系行，body 高不变时行尺寸和多列位置仍更新', () => {
    fullHeight = 80;
    positions.set('current', { left: 130, top: 0 });
    positions.set('last', { left: 0, top: 44 });
    const view = render(<CollapsibleRailStack collapsed activeKey="current" className="utility-favorites-grid">{freshItems()}</CollapsibleRailStack>);
    const body = view.container.querySelector('.rail-stack-layout')!;
    const current = view.container.querySelector('[data-stack-key="current"]') as HTMLElement;
    const observer = observers[0];
    expect(observer.targets.size).toBe(4);
    expect(observer.targets.has(body)).toBe(true);
    expect(observer.targets.has(current)).toBe(true);
    expect(current.style.getPropertyValue('--rail-shift-x')).toBe('-130px');
    positions.set('current', { left: 0, top: 50, width: 124, height: 40 });
    reads.mockClear();
    act(() => observer.fireFor(current)); // 字体/行内容/网格重排；body 总高仍为 80
    expect(reads).toHaveBeenCalled();
    const rail = view.container.querySelector('.rail-stack') as HTMLElement;
    expect(rail.style.getPropertyValue('--rail-full')).toBe('80px');
    expect(rail.style.getPropertyValue('--rail-preview-w')).toBe('124px');
    expect(rail.style.getPropertyValue('--rail-preview-h')).toBe('40px');
    expect(current.style.getPropertyValue('--rail-shift-x')).toBe('0px');
    expect(current.style.getPropertyValue('--rail-shift-y')).toBe('-50px');
    view.unmount();
    expect(observer.disconnected).toBe(true);
    reads.mockClear();
    act(() => observer.fireRaw());
    expect(reads).not.toHaveBeenCalled();
  });
});
