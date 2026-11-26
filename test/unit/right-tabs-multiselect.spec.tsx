/**
 * 右工作面内容标签栏多选：Ctrl/⌘ 点选、右键「关闭选中的 N 个」
 * （显式选中关闭不受固定保护限制）、普通点击保持切换行为。
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RightTab, ResourcePanel } from '../../src/shared/rightWorkspace';
import { RightWorkspaceToolbar } from '../../src/renderer/src/components/RightWorkspaceToolbar';
import { applyLocaleSetting } from '../../src/shared/i18n';

function makeTab(id: string, title: string, pinned = false): RightTab {
  return {
    id,
    workspaceId: 'ws',
    sessionId: 's',
    scope: 'workspace',
    pinned,
    preview: false,
    content: { kind: 'web', browserId: id, url: `https://${id}`, title }
  };
}

function renderToolbar(tabs: RightTab[], handlers: { onSelect?: ReturnType<typeof vi.fn>; onClose?: ReturnType<typeof vi.fn> }): void {
  render(
    <RightWorkspaceToolbar
      tabs={tabs}
      current={tabs[0]}
      panel={'files' as ResourcePanel}
      collapsed={false}
      backDepth={0}
      forwardDepth={0}
      onHistory={() => {}}
      onSelect={handlers.onSelect ?? vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
      onAction={() => {}}
      onMove={() => {}}
      onResource={() => {}}
      onCollapse={() => {}}
    />
  );
}

describe('右工作面标签栏多选', () => {
  it('审阅标签随语言切换而实际路径保持原样', () => {
    const review = { ...makeTab('review', 'unused'), content: { kind: 'review', owner: { kind: 'gui', id: 's' }, filePath: '审阅' } } as RightTab;
    renderToolbar([review], {});
    try {
      act(() => { applyLocaleSetting('en'); });
      const tab = screen.getByRole('tab', { name: /Review/ });
      expect(tab.getAttribute('title')).toBe('审阅');
      expect(tab.textContent).toContain('Review');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('Ctrl+点击切换选区且不切当前标签', () => {
    const onSelect = vi.fn();
    renderToolbar([makeTab('t1', 'A'), makeTab('t2', 'B'), makeTab('t3', 'C')], { onSelect });

    fireEvent.click(screen.getByTitle('https://t1'), { ctrlKey: true });
    fireEvent.click(screen.getByTitle('https://t2'), { ctrlKey: true });
    expect(screen.getByTitle('https://t1').className).toContain('is-multiselected');
    expect(screen.getByTitle('https://t2').className).toContain('is-multiselected');
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('https://t1'));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('Shift+←→ 扩展范围', () => {
    renderToolbar([makeTab('t1', 'A'), makeTab('t2', 'B'), makeTab('t3', 'C')], {});
    fireEvent.click(screen.getByTitle('https://t1'), { ctrlKey: true });

    const strip = document.querySelector<HTMLElement>('.right-tab-strip')!;
    fireEvent.keyDown(strip, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByTitle('https://t2').className).toContain('is-multiselected');
    expect(screen.getByTitle('https://t3').className).not.toContain('is-multiselected');
  });

  it('右键选区内 → 关闭选中的 N 个（固定标签也在显式选中内关闭）', () => {
    const onClose = vi.fn();
    renderToolbar(
      [makeTab('t1', 'A'), makeTab('t2', 'B', true), makeTab('t3', 'C')],
      { onClose }
    );
    fireEvent.click(screen.getByTitle('https://t1'), { ctrlKey: true });
    fireEvent.click(screen.getByTitle('https://t2'), { ctrlKey: true });

    fireEvent.contextMenu(screen.getByTitle('https://t1'));
    fireEvent.click(screen.getByText('关闭选中的 2 个标签页'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(new Set(onClose.mock.calls[0]![0])).toEqual(new Set(['t1', 't2']));
  });

  it('右键选区外 → 菜单无「关闭选中」项（维持单行语义）', () => {
    renderToolbar([makeTab('t1', 'A'), makeTab('t2', 'B')], {});
    fireEvent.contextMenu(screen.getByTitle('https://t1'));
    expect(screen.queryByText(/关闭选中的/)).toBeNull();
    expect(screen.getByText('关闭标签页')).toBeTruthy();
  });
});
