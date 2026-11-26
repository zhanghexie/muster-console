/**
 * 独立浏览器页标签列表（BrowserTabList）多选：
 * Ctrl/⌘ 点选、右键「关闭选中的 N 个 / 关闭其他 / 关闭右侧」、Esc 清空、普通点击激活。
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserTabInfo } from '../../src/shared/browser';
import { BrowserTabList } from '../../src/renderer/src/components/BrowserTabList';

function makeTab(id: string): BrowserTabInfo {
  return { id, title: `Page ${id}`, url: `https://${id}`, favicon: null, loading: false, canGoBack: false, canGoForward: false };
}

function renderList(tabs: BrowserTabInfo[], handlers: { onActivate?: ReturnType<typeof vi.fn>; onCloseMany?: ReturnType<typeof vi.fn> }): HTMLElement {
  const { container } = render(
    <BrowserTabList
      tabs={tabs}
      activeId={tabs[0]?.id ?? null}
      onActivate={handlers.onActivate ?? vi.fn()}
      onCloseMany={handlers.onCloseMany ?? vi.fn()}
    />
  );
  return container.querySelector<HTMLElement>('.browser-tabbar-list')!;
}

describe('BrowserTabList 多选', () => {
  it('Ctrl+点击切换选区且不激活；普通点击保持激活', () => {
    const onActivate = vi.fn();
    renderList([makeTab('a'), makeTab('b'), makeTab('c')], { onActivate });

    fireEvent.click(screen.getByTitle('https://a'), { ctrlKey: true });
    fireEvent.click(screen.getByTitle('https://b'), { ctrlKey: true });
    expect(screen.getByTitle('https://a').className).toContain('is-multiselected');
    expect(screen.getByTitle('https://b').className).toContain('is-multiselected');
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('https://a'));
    expect(onActivate).toHaveBeenCalledWith('a');
    expect(screen.getByTitle('https://a').className).not.toContain('is-multiselected');
  });

  it('右键选区内 → 关闭选中的 N 个', () => {
    const onCloseMany = vi.fn();
    renderList([makeTab('a'), makeTab('b'), makeTab('c')], { onCloseMany });
    fireEvent.click(screen.getByTitle('https://b'), { ctrlKey: true });
    fireEvent.click(screen.getByTitle('https://c'), { ctrlKey: true });

    fireEvent.contextMenu(screen.getByTitle('https://b'));
    fireEvent.click(screen.getByText('关闭选中的 2 个标签页'));
    expect(onCloseMany).toHaveBeenCalledTimes(1);
    expect(new Set(onCloseMany.mock.calls[0]![0])).toEqual(new Set(['b', 'c']));
  });

  it('右键单行（无选区）→ 关闭其他', () => {
    const onCloseMany = vi.fn();
    renderList([makeTab('a'), makeTab('b'), makeTab('c')], { onCloseMany });

    fireEvent.contextMenu(screen.getByTitle('https://a'));
    fireEvent.click(screen.getByText('关闭其他标签页'));
    expect(onCloseMany).toHaveBeenCalledWith(['b', 'c']);
  });

  it('Shift+→ 扩展范围；Esc 清空选区', () => {
    const list = renderList([makeTab('a'), makeTab('b'), makeTab('c')], {});
    fireEvent.click(screen.getByTitle('https://a'), { ctrlKey: true });

    fireEvent.keyDown(list, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByTitle('https://b').className).toContain('is-multiselected');

    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.getByTitle('https://a').className).not.toContain('is-multiselected');
    expect(screen.getByTitle('https://b').className).not.toContain('is-multiselected');
  });
});
