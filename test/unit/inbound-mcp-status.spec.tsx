import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InboundMcpStatus } from '../../src/renderer/src/components/settings/InboundMcpStatus';
import { currentApiMock } from './helpers/api-mock';
import type { InboundMcpSetupStatus } from '../../src/shared/inboundMcp';

const ok: InboundMcpSetupStatus = { ok: true, engines: [{ id: 'claude', label: 'Claude Code', path: '/home/test/.claude.json', state: 'configured' }] };
const failed: InboundMcpSetupStatus = { ok: false, engines: [{ ...ok.engines[0]!, state: 'error', error: '配置文件无法写入，请检查权限' }] };

describe('CLI automatic setup status', () => {
  it('keeps unsupported and waiting declarations visible and never calls them configured', async () => {
    const api = currentApiMock(); api.override('inboundMcp.status', () => ({ ok: true, engines: [
      { id: 'unknown', label: 'Unknown Harness', path: '', state: 'unsupported', detail: 'No declaration' },
      { id: 'workspace', label: 'Workspace Harness', path: '', state: 'pending-workspace' },
      ok.engines[0]!
    ] }));
    render(<InboundMcpStatus/>); await screen.findByText('部分接入未声明');
    expect(screen.getByRole('status').textContent).toContain('Unknown Harness');
    expect(screen.getByRole('status').textContent).toContain('等待工作区');
    expect(screen.queryByText('已配置')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByText('查看 Harness 接入方式'));
    await screen.findByText('配置文件已配置');
  });
  it('labels native/session-only declarations as adapter integration rather than configured or connected', async () => {
    const api = currentApiMock(); api.override('inboundMcp.status', () => ({ ok: true, engines: [
      { id: 'native', label: 'Native Harness', path: '', state: 'native' },
      { id: 'session', label: 'Session Harness', path: '', state: 'session' }
    ] }));
    render(<InboundMcpStatus/>); await screen.findByText('由适配器接入');
    expect(screen.queryByText('已配置')).toBeNull(); expect(screen.queryByText('已连接')).toBeNull();
    fireEvent.click(screen.getByText('查看 Harness 接入方式'));
    await screen.findByText('原生工具接入'); await screen.findByText('会话适配器接入');
  });

  it('reads actual status on mount without asking for installation or claiming connected', async () => {
    const api = currentApiMock(); api.override('inboundMcp.status', () => ok);
    render(<InboundMcpStatus/>);
    await screen.findByText('已配置');
    expect(api.mockOf('inboundMcp.install').mock.calls).toHaveLength(0);
    expect(screen.queryByText('已连接')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each(['C:\\Users\\test\\.cursor\\mcp.json', '/Users/test/.claude.json', '/home/test/.config/opencode.json'])('shows a selectable configuration path and reveals %s', async path => {
    const api = currentApiMock();
    api.override('inboundMcp.status', () => ({ ok: true, engines: [
      { id: 'fixture', label: 'Fixture CLI', path, state: 'configured' },
      { id: 'native', label: 'Native', path: '', state: 'native' }
    ] }));
    api.override('shell.revealPath', async () => ({ ok: true }));
    render(<InboundMcpStatus/>); await screen.findByText('已配置');
    fireEvent.click(screen.getByText('查看 Harness 接入方式'));
    const field = screen.getByRole('textbox', { name: 'Fixture CLI · 配置文件' }) as HTMLInputElement;
    expect(field.readOnly).toBe(true); expect(field.value).toBe(path);
    fireEvent.click(screen.getByRole('button', { name: '打开Fixture CLI · 配置文件的位置' }));
    await waitFor(() => expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith(path));
    expect(screen.queryByRole('textbox', { name: 'Native · 配置文件' })).toBeNull();
  });
  it('shows engine/path/reason, blocks duplicate retries and clears warning only after success', async () => {
    const api = currentApiMock(); api.override('inboundMcp.status', () => failed);
    let resolve!: (value: InboundMcpSetupStatus) => void;
    api.override('inboundMcp.install', () => new Promise<InboundMcpSetupStatus>(done => { resolve = done; }));
    render(<InboundMcpStatus/>);
    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toContain('Claude Code');
    expect((within(warning).getByRole('textbox', { name: 'Claude Code · 配置文件' }) as HTMLInputElement).value).toBe('/home/test/.claude.json');
    expect(warning.textContent).toContain('检查权限');
    fireEvent.click(screen.getByRole('button', { name: '重试配置' }));
    const retry = screen.getByRole('button', { name: '正在配置…' });
    expect(retry.hasAttribute('disabled')).toBe(true); fireEvent.click(retry);
    expect(api.mockOf('inboundMcp.install').mock.calls).toHaveLength(1);
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => resolve(ok));
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText('已配置')).toBeTruthy();
  });
  it('reports status IPC and retry failures without fake success', async () => {
    const api = currentApiMock(); api.override('inboundMcp.status', () => Promise.reject(new Error('IPC unavailable')));
    api.override('inboundMcp.install', () => Promise.reject(new Error('permission denied')));
    render(<InboundMcpStatus/>); await screen.findByText('IPC unavailable');
    fireEvent.click(screen.getByRole('button', { name: '重试配置' }));
    await screen.findByText('permission denied'); expect(screen.queryByText('已配置')).toBeNull();
    expect(screen.getByRole('button', { name: '重试配置' }).hasAttribute('disabled')).toBe(false);
  });
  it('ignores stale checks after a retry and refreshes when setup changes', async () => {
    const api = currentApiMock(); let old!: (value: InboundMcpSetupStatus) => void;
    api.override('inboundMcp.status', () => ok); api.override('inboundMcp.install', () => ok);
    const view = render(<InboundMcpStatus/>); await screen.findByText('已配置');
    api.override('inboundMcp.status', () => new Promise<InboundMcpSetupStatus>(resolve => { old = resolve; }));
    fireEvent(window, new Event('focus'));
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新检查' }).hasAttribute('disabled')).toBe(false));
    await act(async () => old(failed)); expect(screen.queryByRole('alert')).toBeNull();
    api.override('inboundMcp.status', () => failed);
    act(() => api.emit('inboundMcp:changed', failed)); await screen.findByRole('alert');
    view.unmount();
    const count = api.mockOf('inboundMcp.status').mock.calls.length;
    act(() => api.emit('inboundMcp:changed', ok)); expect(api.mockOf('inboundMcp.status').mock.calls.length).toBe(count);
  });
});
