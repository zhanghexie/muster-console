import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RightWorkspaceToolbar } from '../../src/renderer/src/components/RightWorkspaceToolbar';
import type { RightTab } from '../../src/shared/rightWorkspace';

const readStyle = (name: string) => readFileSync(resolve(process.cwd(), `src/renderer/src/styles/${name}.css`), 'utf8').replace(/\r\n/g, '\n');
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  expect(body, selector).toBeDefined();
  return body!;
}

describe('局部导航反馈的动画和交互契约', () => {
  it('2×12px 焦点竖条始终生成，原位中心收放，拖放水平线仍即时且不受缩放污染', () => {
    const left = readStyle('left');
    const navigation = readStyle('extension-navigation');
    const inactive = [rule(left, '.left-panel .session-item::after,\n.left-panel .utility-feature-item::after'), rule(navigation, '.ext-nav-row::before')];
    const active = [rule(left, '.left-panel .session-item.is-pane-focused::after,\n.left-panel .utility-feature-item.is-pane-focused::after'), rule(navigation, '.ext-nav-row.is-pane-focused:not([data-drop])::before')];
    for (const body of inactive) {
      expect(body).toMatch(/content:\s*''/);
      expect(body).toMatch(/width:\s*2px/);
      expect(body).toMatch(/height:\s*12px/);
      expect(body).toMatch(/transform-origin:\s*center/);
      expect(body).toMatch(/transform:\s*scaleY\(0\.25\)/);
      expect(body).toMatch(/opacity:\s*0/);
      expect(body).toContain('transform var(--dur-micro) var(--ease-exit)');
      expect(body).toContain('opacity var(--dur-micro) var(--ease-exit)');
    }
    for (const body of active) {
      expect(body).toMatch(/transform:\s*scaleY\(1\)/);
      expect(body).toMatch(/opacity:\s*1/);
      expect(body).toContain('transition-duration: var(--dur-menu)');
      expect(body).toContain('transition-timing-function: var(--ease-standard)');
      expect(body).not.toMatch(/content:|width:|height:|display:/);
    }
    const drop = rule(navigation, ".ext-nav-row[data-drop='before']::before, .ext-nav-row[data-drop='after']::after");
    expect(drop).toMatch(/width:\s*auto/);
    expect(drop).toMatch(/transform:\s*none/);
    expect(drop).toMatch(/opacity:\s*1/);
    expect(drop).toMatch(/transition:\s*none/);
  });

  it('关闭/更多入口仅透明度变动，微press只缩图标，底片宽度不参与过渡', () => {
    const left = readStyle('left'), right = readStyle('right-workspace'), settings = readStyle('settings');
    expect(rule(left, '.session-close,\n.session-action')).toContain('opacity var(--dur-micro) var(--ease-hover)');
    expect(rule(left, '.session-row-tools')).toContain('width: 32px');
    expect(rule(right, '.right-tab-close').replace(/\s+/g, ' ')).toMatch(/width:\s*18px; height:\s*18px/);
    expect(right).toContain('.right-tab-close { transition: opacity var(--dur-micro) var(--ease-hover); }');
    expect(right).toContain('.right-forward { transform: rotate(180deg); }');
    expect(right).toContain('.right-icon:active:not(:disabled) > .right-forward { transform: rotate(180deg) scale(0.9); }');
    expect(right).toContain('.right-tab-close:active:not(:disabled) > svg,');
    expect(left).toContain('.session-action:active:not(:disabled) > svg,');
    const plate = rule(settings, '.s-seg-selection');
    expect(plate).toContain('transform var(--dur-menu) var(--ease-standard)');
    expect(plate).toMatch(/pointer-events:\s*none/);
    expect(plate).not.toMatch(/transition:[^;]*(?:width|left|all)/);
    const handoff = rule(settings, '.s-seg[data-seg-ready] button.is-on,\n.s-seg[data-seg-ready] button.is-on:hover:not(:disabled)');
    expect(handoff).toMatch(/background:\s*transparent/);
    expect(handoff).toMatch(/transition-property:\s*color/);
  });

  it('右侧标签快速切换保留关闭按钮和标题；关闭不冒泡选择，键盘导航和禁用保持', () => {
    const tabs: RightTab[] = ['a', 'b'].map(id => ({ id, workspaceId: 'w', sessionId: 's', scope: 'workspace' as const, pinned: false, preview: false,
      content: { kind: 'file', path: `E:/project/${id}.txt` } }));
    const select = vi.fn(), close = vi.fn(), history = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState(tabs[0]);
      return <RightWorkspaceToolbar tabs={tabs} current={current} panel="files" collapsed={false} backDepth={0} forwardDepth={0}
        onSelect={id => { select(id); setCurrent(tabs.find(tab => tab.id === id)!); }} onClose={close} onHistory={history}
        onAction={() => {}} onMove={() => {}} onResource={() => {}} onCollapse={() => {}}/>;
    }
    const view = render(<Harness/>);
    const tablist = screen.getByRole('tablist', { name: '内容标签页' });
    const rows = within(tablist).getAllByRole('tab');
    const buttons = rows.map(row => within(row).getByRole('button'));
    for (const index of [1, 0, 1, 0]) {
      fireEvent.click(rows[index]);
      expect(rows[index].getAttribute('aria-selected')).toBe('true');
      expect(rows.map(row => within(row).getByRole('button'))).toEqual(buttons);
      expect(rows.map(row => row.title)).toEqual(['E:/project/a.txt', 'E:/project/b.txt']);
    }
    select.mockClear();
    fireEvent.click(buttons[1]);
    expect(close).toHaveBeenCalledWith(['b']);
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(rows[0], { key: 'ArrowRight' });
    expect(select).toHaveBeenCalledWith('b');
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(history).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll('.right-tab-close')).toHaveLength(2);
  });
});
