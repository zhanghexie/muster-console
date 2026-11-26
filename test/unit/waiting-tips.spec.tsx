import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import { currentApiMock } from './helpers/api-mock';
import { pickNextWaitingTip, refreshWaitingTips, setWaitingTipsEnabled, waitingTipKey } from '../../src/renderer/src/waitingTips';
import type { AppConfig, ChatMessage } from '../../src/shared/types';

const tips = [{ 'zh-CN': '查看会话历史', en: 'View history' }, { 'zh-CN': '查找消息', en: 'Find messages' }];
const msg: ChatMessage = { id: 'waiting', role: 'assistant', content: '', createdAt: 1 };
afterEach(() => { setWaitingTipsEnabled(true); vi.useRealTimers(); });

describe('waiting tips', () => {
  it('keeps the full tip catalog available through its dialog when display is disabled', async () => {
    currentApiMock().override('config.waitingTips', async () => ({ ok: true, path: '/tips.json', tips }));
    const set = vi.fn();
    render(<GeneralPane cfg={{ showWaitingTips: false } as AppConfig} set={set} />);
    expect(screen.queryByText('查看会话历史')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看全部提示' }));
    await waitFor(() => expect(screen.getByText('查看会话历史')).toBeTruthy());
    expect(screen.getByText('查找消息')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '功能提示文件' }) as HTMLInputElement).value).toBe('/tips.json');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    const toggle = screen.getByRole('checkbox', { name: '等待时显示功能提示' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ showWaitingTips: true });
  });
  it('shows tips only while streaming, rotates, responds to disabling and reloads updates', async () => {
    currentApiMock().override('config.waitingTips', async () => ({ ok: true, path: '/tips.json', tips }));
    await act(async () => { await refreshWaitingTips(); });
    vi.useFakeTimers();
    const view = render(<ChatMessageView message={msg} streaming />);
    await act(async () => {});
    expect(view.container.querySelector('.waiting-tip-text')).toBeTruthy();
    expect(view.container.querySelector('.waiting-tip-label')?.textContent).toBe('Tips');
    expect(view.container.querySelector('.waiting-tip')?.getAttribute('aria-label')).toContain('Tips');
    const initial = view.container.querySelector('.waiting-tip-text')!.textContent;
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(view.container.querySelector('.waiting-tip-text')!.textContent).not.toBe(initial);
    act(() => setWaitingTipsEnabled(false));
    expect(view.container.querySelector('.waiting-tip-text')).toBeNull();
    expect(view.container.querySelector('.waiting-tip-label')).toBeNull();
    expect(view.container.querySelectorAll('.waiting-activity-dot')).toHaveLength(3);
    expect(view.container.querySelector('.waiting-tip-working')?.textContent).toBe('努力工作中');
    act(() => setWaitingTipsEnabled(true));
    currentApiMock().override('config.waitingTips', async () => ({ ok: true, path: '/tips.json', tips: [{ 'zh-CN': '新提示', en: 'New tip' }] }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(view.container.querySelector('.waiting-tip-text')?.textContent).toBe('新提示');
    view.rerender(<ChatMessageView message={{ ...msg, parts: [{ kind: 'text', text: '回复' }] }} streaming />);
    expect(view.container.querySelector('.waiting-tip')).toBeNull();
    expect(view.container.textContent).not.toContain('新提示');
  });
  it('chooses randomly without repeating the previous tip, including successive waiting rows', () => {
    const entries = [...tips, { 'zh-CN': '分叉会话', en: 'Fork session' }];
    const random = vi.spyOn(Math, 'random');
    try {
      random.mockReturnValue(0);
      const first = pickNextWaitingTip(entries, null)!;
      const second = pickNextWaitingTip(entries, waitingTipKey(first))!;
      expect(waitingTipKey(second)).not.toBe(waitingTipKey(first));
      const nextRow = pickNextWaitingTip(entries, null)!;
      expect(waitingTipKey(nextRow)).not.toBe(waitingTipKey(second));
      random.mockReturnValue(.99);
      const lastChoice = pickNextWaitingTip(entries, waitingTipKey(first))!;
      expect(lastChoice).toBe(entries[2]);
      expect(pickNextWaitingTip([entries[0]], waitingTipKey(entries[0]))).toBe(entries[0]);
      expect(pickNextWaitingTip([], null)).toBeNull();
    } finally { random.mockRestore(); }
  });
  it('shows a file error in settings instead of presenting it as success', async () => {
    currentApiMock().override('config.waitingTips', async () => ({ ok: false, path: '/tips.json', error: 'invalid JSON' }));
    const bash = { id: 'bash', label: 'bash', command: '/usr/bin/bash', args: ['-l'] };
    currentApiMock().override('shell.getInfo', async () => ({
      platform: 'linux', profiles: [bash], bgShellProfile: bash, bgShellMode: 'auto',
      gitBashPath: null, manualGitBashPath: '', manualGitBashPathExists: false
    }));
    await act(async () => { await refreshWaitingTips(); });
    render(<GeneralPane cfg={{} as AppConfig} set={vi.fn()} />);
    expect(getAppTip().textContent).toContain('invalid JSON');
    await screen.findByRole('textbox', { name: '后台命令 Shell' });
  });
});
