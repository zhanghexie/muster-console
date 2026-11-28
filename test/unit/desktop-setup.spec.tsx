import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppConfig } from '../../src/shared/types';
import type { DesktopSetupStatus } from '../../src/shared/desktopSetup';
import { DesktopSetupNotice } from '../../src/renderer/src/components/DesktopSetupCard';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import { currentApiMock } from './helpers/api-mock';

const missing: DesktopSetupStatus = { macApp: 'electron', issues: [
  { code: 'permission_required', permissions: ['screenRecording', 'accessibility'] }
] };
const granted: DesktopSetupStatus = { macApp: 'electron', issues: [] };

describe('电脑操作授权引导', () => {
  it('首次打开设置入口就检查权限，按缺项打开设置，并通过重新检测更新结果', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    const status = api.mockOf('desktopSetup.status');
    status.mockResolvedValueOnce(missing)
      .mockResolvedValueOnce({ macApp: 'electron', issues: [{ code: 'permission_required', permissions: ['accessibility'] }] })
      .mockResolvedValueOnce(granted);
    const openSettings = api.mockOf('desktopSetup.openSettings').mockResolvedValue({ ok: true });
    render(<GeneralPane cfg={{} as AppConfig} set={() => {}} />);
    const section = within(screen.getByRole('region', { name: '电脑操作' }));
    const trigger = section.getByRole('button', { name: '检查电脑操作状态' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(status).toHaveBeenCalledTimes(0);
    await user.click(trigger);
    const article = await section.findByRole('article', { name: '电脑操作状态' });
    const card = within(article);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(article.id);
    await card.findByText('缺少 macOS 授权', { selector: 'strong' });
    expect(status).toHaveBeenCalledTimes(1);
    expect(card.getAllByRole('listitem')).toHaveLength(2);
    expect(card.getByText(/当前运行的 Electron\.app/)).toBeTruthy();
    expect(card.getByText(/完全退出并重新打开当前应用/)).toBeTruthy();
    await user.click(card.getByRole('button', { name: '打开屏幕录制设置' }));
    await user.click(card.getByRole('button', { name: '打开辅助功能设置' }));
    expect(openSettings.mock.calls).toEqual([['screenRecording'], ['accessibility']]);

    const recheck = card.getByRole('button', { name: '重新检测' });
    await user.click(recheck);
    await waitFor(() => expect(card.queryByRole('button', { name: '打开屏幕录制设置' })).toBeNull());
    expect(card.getByRole('button', { name: '打开辅助功能设置' })).toBeTruthy();
    expect(document.activeElement).toBe(recheck);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(card.getByRole('status').textContent).toMatch(/当前进程已检测到/));
    expect(card.queryByRole('list')).toBeNull();
    expect(status).toHaveBeenCalledTimes(3);
    await user.click(section.getByRole('button', { name: '收起检查结果' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(article.inert).toBe(true);
    expect(article.getAttribute('data-mp-stage')).toBe('out');
    await waitFor(() => expect(article.isConnected).toBe(false));
  });

  it('收到工具缺权事件立即显示安装版目标，深链失败时提供手动路径', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    api.mockOf('desktopSetup.openSettings').mockResolvedValue({ ok: false, code: 'open_failed' });
    render(<DesktopSetupNotice />);
    act(() => api.emit('ui:desktopSetup', { ...missing, macApp: 'muster' }));
    const card = within(await screen.findByRole('article', { name: '电脑操作状态' }));
    expect(await card.findByText(/请为 Muster Console\.app 勾选权限/)).toBeTruthy();
    expect(card.getByText(/刚覆盖安装了临时签名版本/)).toBeTruthy();
    expect(api.mockOf('desktopSetup.status')).toHaveBeenCalledTimes(0);
    await user.click(card.getByRole('button', { name: '打开辅助功能设置' }));
    await waitFor(() => expect(card.getByRole('status').textContent).toMatch(/请手动进入「系统设置 → 隐私与安全性」/));
    await user.click(card.getByRole('button', { name: '关闭电脑操作提示' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: '电脑操作状态' })).toBeNull());
  });

  it('只在用户点击后请求系统授权，并允许定位当前应用', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    const request = api.mockOf('desktopSetup.requestPermission')
      .mockResolvedValueOnce({ ok: true, granted: false })
      .mockResolvedValueOnce({ ok: false, code: 'request_failed' });
    const reveal = api.mockOf('desktopSetup.revealApp').mockResolvedValue({ ok: true });
    render(<DesktopSetupNotice />);
    act(() => api.emit('ui:desktopSetup', missing));
    const card = within(await screen.findByRole('article', { name: '电脑操作状态' }));
    expect(request).not.toHaveBeenCalled();
    const accessibility = card.getByRole('button', { name: '请求辅助功能授权' });
    accessibility.focus();
    await user.keyboard('{Enter}');
    expect(request.mock.calls).toEqual([['accessibility']]);
    await waitFor(() => expect(card.getByRole('status').textContent).toMatch(/已向 macOS 请求授权/));
    expect(document.activeElement).toBe(accessibility);
    await user.click(card.getByRole('button', { name: '请求屏幕录制授权' }));
    expect(request.mock.calls).toEqual([['accessibility'], ['screenRecording']]);
    await waitFor(() => expect(card.getByRole('status').textContent).toMatch(/无法发起系统授权请求/));
    await user.click(card.getByRole('button', { name: '在 Finder 中显示当前应用' }));
    expect(reveal.mock.calls).toEqual([[]]);
  });

  it('区分驱动缺权与安全输入，并只提供对应的恢复操作', async () => {
    const api = currentApiMock();
    render(<DesktopSetupNotice />);
    act(() => api.emit('ui:desktopSetup', { macApp: 'muster', issues: [
      { code: 'permission_required', source: 'driver', permissions: ['accessibility'] }
    ] }));
    const card = within(await screen.findByRole('article', { name: '电脑操作状态' }));
    expect(card.getByRole('status').textContent).toBe('桌面驱动未检测到 macOS 授权');
    expect(card.getByRole('button', { name: '打开辅助功能设置' })).toBeTruthy();
    expect(card.queryByRole('button', { name: '请求辅助功能授权' })).toBeNull();
    act(() => api.emit('ui:desktopSetup', { macApp: 'muster', issues: [{ code: 'secure_input_active' }] }));
    expect(card.getByRole('status').textContent).toBe('macOS 安全输入正在使用');
    expect(card.getByText(/关闭正在接收安全输入的窗口/)).toBeTruthy();
    expect(card.queryByRole('button', { name: '打开辅助功能设置' })).toBeNull();
  });

  it.each([
    ['capability_unsupported', '桌面后端不可用'], ['dependency_missing', '缺少桌面驱动'],
    ['permission_check_failed', '无法检测 macOS 授权']
  ])('用 %s 展示对应成因', async (code, title) => {
    const api = currentApiMock();
    render(<DesktopSetupNotice />);
    act(() => api.emit('ui:desktopSetup', { issues: [{ code, detail: 'Test detail' }] }));
    const card = within(await screen.findByRole('article', { name: '电脑操作状态' }));
    expect(await card.findByText(title, { selector: 'strong' })).toBeTruthy();
    expect(card.queryByRole('button', { name: /打开.+设置/ })).toBeNull();
  });

  it('保留最新工具错误，拒绝迟到的检测结果覆盖后来的失败', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    let finish!: (status: DesktopSetupStatus) => void;
    api.mockOf('desktopSetup.status').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<DesktopSetupNotice />);
    act(() => api.emit('ui:desktopSetup', missing));
    await user.click(await screen.findByRole('button', { name: '重新检测' }));
    const checking = screen.getByRole('button', { name: '检测中…' });
    expect(checking.getAttribute('aria-disabled')).toBe('true');
    await user.click(checking);
    expect(api.mockOf('desktopSetup.status')).toHaveBeenCalledTimes(1);
    act(() => api.emit('ui:desktopSetup', { macApp: 'electron', issues: [{ code: 'permission_check_failed' }] }));
    await act(async () => finish(granted));
    expect(screen.getByRole('status').textContent).toBe('无法检测 macOS 授权');
    expect(screen.queryByRole('button', { name: '打开屏幕录制设置' })).toBeNull();
  });

  it('检测 IPC 失败时显示读取错误，并允许重试', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    api.mockOf('desktopSetup.status').mockRejectedValueOnce(new Error('IPC closed')).mockResolvedValueOnce(granted);
    render(<DesktopSetupNotice />);
    act(() => api.emit('ui:desktopSetup', missing));
    await user.click(await screen.findByRole('button', { name: '重新检测' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('无法读取电脑操作状态，请重新检测。'));
    expect(screen.queryByRole('button', { name: '打开屏幕录制设置' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '重新检测' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/当前进程已检测到/));
  });
});
