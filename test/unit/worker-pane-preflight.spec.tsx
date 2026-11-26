/** Settings display cached discovery evidence, with explicit refresh and no inference claims. */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig, AgentRuntimeEntry } from '../../src/shared/types';

const entries: AgentRuntimeEntry[] = [
  { id: 'gemini', label: 'Gemini', script: 'gemini.mjs', builtin: true, enabled: true, surface: 'pty', updatedAt: 1 },
  { id: 'claude', label: 'Claude', script: '', builtin: true, enabled: true, surface: 'chat', updatedAt: 1 }
];
const snapshot = {
  checkedAt: 1, runtimes: [entries[1]], acpAgents: [],
  runtimePreflights: {
    gemini: { id: 'gemini', surface: 'pty', status: 'not_installed', ok: false, checkedAt: 1,
      problems: [{ code: 'cli_missing', message: '依赖的 CLI 未安装或不在 PATH 中', fix: 'npm install -g @google/gemini-cli' }] },
    claude: { id: 'claude', surface: 'chat', status: 'available', ok: true, checkedAt: 1, problems: [] }
  }
};
beforeEach(() => {
  const api = currentApiMock();
  api.override('runtimes.list', async () => entries);
  api.override('runtimes.availability', async () => snapshot);
  api.override('agentSession.getHarnessModelSelections', async () => ({}));
  api.override('workerRouting.read', async ({ layer }: { layer: string }) => ({
    layer, origin: layer, version: '0', config: { revision: 0, tiers: [] }, members: []
  }));
});
const renderPane = () => render(<WorkerPane cfg={{ defaultRuntime: 'claude', workspace: '/fixture', workspaces: [] } as unknown as AppConfig} set={() => {}}/>);
describe('Agent discovery evidence', () => {
  it('reads the snapshot and distinguishes found programs from missing programs without claiming login', async () => {
    renderPane();
    expect((await screen.findByRole('button', { name: '配置 Claude Code' })).textContent).toContain('已发现');
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    expect(screen.getByRole('button', { name: '配置 Gemini CLI' }).textContent).toContain('未安装');
    expect(screen.getByTitle('程序或配置已找到')).toBeTruthy();
    expect(currentApiMock().mockOf('runtimes.availability')).toHaveBeenCalledWith(false);
    expect(currentApiMock().mockOf('runtimes.preflight')).not.toHaveBeenCalled();
  });
  it('keeps missing products configurable, shows the repair command and explicitly refreshes detection', async () => {
    renderPane();
    await screen.findByRole('button', { name: '配置 Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await userEvent.click(screen.getByRole('button', { name: '配置 Gemini CLI' }));
    const detail = screen.getByRole('region', { name: 'Gemini CLI 设置' });
    expect(within(detail).getByText('npm install -g @google/gemini-cli')).toBeTruthy();
    expect(within(detail).getByRole('link', { name: '安装指南' }).getAttribute('href')).toBe('https://github.com/google-gemini/gemini-cli');
    await userEvent.click(within(detail).getByRole('button', { name: '重新检测本机' }));
    await waitFor(() => expect(currentApiMock().mockOf('runtimes.availability')).toHaveBeenLastCalledWith(true));
  });
  it('hides installation actions for a discovered chat program while keeping global refresh available', async () => {
    currentApiMock().override('runtimes.availability', async () => ({ ...snapshot,
      runtimePreflights: { ...snapshot.runtimePreflights, claude: { ...snapshot.runtimePreflights.claude, executable: '/home/me/bin/claude' } }
    }));
    renderPane();
    await userEvent.click(await screen.findByRole('button', { name: '配置 Claude Code' }));
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    const detail = screen.getByRole('region', { name: 'Claude Code 设置' });
    expect(within(detail).getByRole('textbox', { name: '聊天程序位置' })).toBeTruthy();
    expect(within(detail).queryByRole('link', { name: '安装指南' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: '重新检测本机' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentSession.refreshHarnessModelCatalogs')).toHaveBeenCalledOnce());
  });
  it('places global refresh in the top toolbar and disables it until detection finishes', async () => {
    let finishRefresh!: (value: typeof snapshot) => void;
    currentApiMock().override('runtimes.availability', () => new Promise<typeof snapshot>(resolve => { finishRefresh = resolve; }));
    const { container } = renderPane();
    const refresh = (await screen.findByRole('button', { name: '刷新' })) as HTMLButtonElement;
    expect(container.querySelector('.worker-refresh')?.contains(refresh)).toBe(true);
    expect(within(screen.getByRole('navigation', { name: 'Worker 列表' })).queryByRole('button', { name: '刷新' })).toBeNull();
    expect(refresh.disabled).toBe(true);
    await act(async () => { finishRefresh(snapshot); });
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentSession.refreshHarnessModelCatalogs')).toHaveBeenCalledOnce());
    expect(await screen.findByRole('dialog', { name: '模型目录刷新' })).toBeTruthy();
  });
  it('checks the terminal separately and removes its installation actions only after discovery', async () => {
    const terminal: AgentRuntimeEntry = { id: 'claude-code', label: 'Claude Code CLI', script: 'claude-code.mjs', builtin: true, enabled: true, surface: 'pty', updatedAt: 1 };
    let terminalFound = false;
    currentApiMock().override('runtimes.list', async () => [...entries, terminal]);
    currentApiMock().override('runtimes.availability', async (force?: boolean) => {
      if (force) terminalFound = true;
      return { ...snapshot, cliPrograms: { 'claude-code': { command: 'claude', status: terminalFound ? 'found' : 'not_found' } },
        runtimePreflights: { ...snapshot.runtimePreflights, 'claude-code': { id: 'claude-code', surface: 'pty', status: terminalFound ? 'available' : 'not_installed', ok: terminalFound, checkedAt: 1, problems: [] } } };
    });
    renderPane();
    await userEvent.click(await screen.findByRole('button', { name: '配置 Claude Code' }));
    await userEvent.click(screen.getByRole('tab', { name: '原生终端' }));
    const detail = screen.getByRole('region', { name: 'Claude Code 设置' });
    expect(within(detail).getByRole('link', { name: '安装指南' })).toBeTruthy();
    await userEvent.click(within(detail).getByRole('button', { name: '重新检测本机' }));
    await waitFor(() => expect(within(detail).queryByRole('link', { name: '安装指南' })).toBeNull());
    expect(within(detail).queryByRole('button', { name: '重新检测本机' })).toBeNull();
  });
  it('keeps configuration problems visible when a discovered program still needs setup', async () => {
    currentApiMock().override('runtimes.availability', async () => ({ ...snapshot, runtimePreflights: { ...snapshot.runtimePreflights,
      claude: { ...snapshot.runtimePreflights.claude, status: 'not_configured', ok: false, executable: '/home/me/bin/claude', problems: [{ code: 'config_missing', message: '需要配置服务' }] }
    } }));
    renderPane();
    await userEvent.click(await screen.findByRole('button', { name: '配置 Claude Code' }));
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    const detail = screen.getByRole('region', { name: 'Claude Code 设置' });
    expect(within(screen.getByRole('tabpanel', { name: '工作台聊天' })).getByText('需要配置服务')).toBeTruthy();
    expect(within(detail).queryByRole('link', { name: '安装指南' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: '重新检测本机' })).toBeNull();
  });
  it('retains custom repair links while leaving credential-bearing hints as plain text', async () => {
    currentApiMock().override('runtimes.availability', async () => ({ ...snapshot,
      runtimePreflights: { ...snapshot.runtimePreflights, gemini: { ...snapshot.runtimePreflights.gemini, problems: [
        { code: 'cli_missing', message: 'Install helper', fixHint: 'https://example.test/setup' },
        { code: 'config_missing', message: 'Unsafe helper', fixHint: 'https://example.test/setup?token=hidden' }
      ] } } }));
    renderPane();
    await screen.findByRole('button', { name: '配置 Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await userEvent.click(screen.getByRole('button', { name: '配置 Gemini CLI' }));
    expect(screen.getByRole('link', { name: '安装或配置指南' }).getAttribute('href')).toBe('https://example.test/setup');
    expect(screen.getByText('https://example.test/setup?token=hidden').tagName).toBe('SPAN');
  });
});
