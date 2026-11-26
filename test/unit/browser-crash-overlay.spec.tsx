/**
 * 崩溃错误态（任务 A）：达上限（crashed）的激活标签显示错误卡并支持手动重试；
 * 恢复（crashed 移除）后错误卡退场；非崩溃/非激活标签不显示。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';
import { StoreProvider } from '../../src/renderer/src/store';

function tabPayload(tabIds: string[], activeId: string, crashedIds: string[] = []) {
  return {
    tabs: tabIds.map((id) => ({
      id,
      title: `t-${id}`,
      url: `https://example.com/${id}`,
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      ...(crashedIds.includes(id) ? { crashed: true } : {})
    })),
    activeId,
    nav: { back: false, forward: false }
  };
}

describe('BrowserPage 崩溃错误态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('crashed 激活标签显示错误卡；点重试调用 browser.retryCrash；恢复后退场', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1', 'bt2'], 'bt1', ['bt1'])));
    const { rerender } = render(
      <StoreProvider>
        <BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('.browser-crash-overlay')).toBeTruthy();
    });
    // 错误卡内容与角色
    expect(document.querySelector('.browser-crash-overlay')?.getAttribute('role')).toBe('alert');
    expect(document.querySelector('.browser-crash-overlay')?.textContent).toContain('页面已崩溃');

    // 重试按钮 → 主进程 retryCrash
    const btn = document.querySelector('.browser-crash-overlay button');
    expect(btn).toBeTruthy();
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(mock.mockOf('browser.retryCrash')).toHaveBeenCalledWith({ id: 'bt1' });
    });

    // 恢复（payload 不再 crashed）→ 错误卡卸载
    act(() => {
      mock.emit('browser:tabs', tabPayload(['bt1', 'bt2'], 'bt1'));
    });
    await waitFor(() => {
      expect(document.querySelector('.browser-crash-overlay')).toBeNull();
    });
    rerender(
      <StoreProvider>
        <BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} />
      </StoreProvider>
    );
    expect(document.querySelector('.browser-crash-overlay')).toBeNull();
  });

  it('非激活标签 crashed 不显示错误卡（只覆盖当前工作面）', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1', 'bt2'], 'bt1', ['bt2'])));
    render(
      <StoreProvider>
        <BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('webview')).toBeTruthy();
    });
    expect(document.querySelector('.browser-crash-overlay')).toBeNull();
  });
});
