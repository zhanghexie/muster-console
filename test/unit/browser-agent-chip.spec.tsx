/**
 * 浏览器页 Agent 操作状态：由地址栏下方常驻条带改为地址栏右端内嵌胶囊——
 * - 空闲时不渲染（不再有空占位条带）；
 * - browser:agentState active → 胶囊出现在地址栏容器内并显示动作名，地址栏让出右侧内边距；
 * - 转空闲 → 播退场（stage=out，退场期间保留最后动作名）后卸载。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function renderPage(): void {
  currentApiMock().override('browser.restore', () => Promise.resolve({ tabs: [], activeId: null }));
  render(
    <StoreProvider>
      <BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} />
    </StoreProvider>
  );
}

describe('BrowserPage Agent 操作胶囊', () => {
  it('标签栏折叠钮用统一面板图标（IconPanelToggle top 形态，与文件/仓库/右栏同源）', async () => {
    await act(async () => renderPage());
    const btn = screen.getByTitle('收起标签栏') as HTMLButtonElement;
    const icon = btn.querySelector('svg.icon-panel-toggle')!;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('data-placement')).toBe('top');
    // 标签栏默认展开：open=true（˄，点击折叠）
    expect(icon.getAttribute('data-open')).toBe('true');
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(screen.getByTitle('展开标签栏').querySelector('svg.icon-panel-toggle')?.getAttribute('data-open')).toBe('false');
  });

  it('空闲不渲染；操作中嵌在地址栏右端；空闲后退场卸载', async () => {
    await act(async () => renderPage());
    const addr = await screen.findByRole('textbox', { name: '地址栏' });
    expect(document.querySelector('.browser-agent-chip')).toBeNull();
    expect(document.querySelector('.browser-agent-bar')).toBeNull();

    act(() => currentApiMock().emit('browser:agentState', { active: true, action: 'click', tabId: 't1' }));
    const chip = await screen.findByRole('status');
    expect(chip.textContent).toContain('click');
    expect(chip.closest('.browser-addr-wrap')).toBe(addr.parentElement);
    expect(addr.className).toContain('has-agent');

    act(() => currentApiMock().emit('browser:agentState', { active: false, action: null, tabId: null }));
    await waitFor(() => expect(chip.getAttribute('data-mp-stage')).toBe('out'));
    expect(chip.textContent).toContain('click');
    await waitFor(() => expect(document.querySelector('.browser-agent-chip')).toBeNull(), {
      timeout: MOTION.menuMs + 500
    });
    expect(addr.className).not.toContain('has-agent');
  });
});
