import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import { currentApiMock } from './helpers/api-mock';
import type { AgentRuntimeEntry, AppConfig } from '../../src/shared/types';
import type { UsageSnapshot } from '../../src/shared/capabilityUsage';

const cfg = { defaultRuntime: 'alpha', workspaces: [{ id: 'w', name: 'Project', path: '/fixture' }] } as AppConfig;
const runtime = (id: string, surface: 'pty' | 'chat', enabled = true): AgentRuntimeEntry => ({ id, label: id === 'alpha' ? 'Alpha' : id === 'beta' ? 'Beta' : 'Chat', surface, script: `${id}.mjs`, enabled, builtin: false, updatedAt: 1 });
const state = { enabled: true, globalEnabled: true, harnessEnabled: true, workspaceEnabled: true };
const usage: UsageSnapshot = { revision: 0, resources: [], runtimes: [], categories: { skill: state, mcp: state } };
let list: AgentRuntimeEntry[], width: number;
beforeEach(() => {
  width = 800; list = [runtime('alpha', 'pty'), runtime('beta', 'pty', false), runtime('chat', 'chat')];
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('worker-pane') ? { width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON() {} } : original.call(this);
  });
  const api = currentApiMock();
  api.override('runtimes.availability', async () => ({ checkedAt: 1, runtimes: list, acpAgents: [], runtimePreflights: {} }));
  api.override('agentSession.getHarnessModelSelections', async () => ({}));
  api.override('runtimes.list', async () => [...list]);
  api.override('agentSession.refreshHarnessModelCatalogs', async () => ({ ok: true, workspace: 'Project', rows: [] }));
  api.override('runtimes.preflight', async () => ({ ok: true, results: list.map(entry => ({ id: entry.id, surface: entry.surface, status: entry.enabled ? 'available' : 'disabled', ok: entry.enabled, problems: [], checkedAt: 1 })) }));
  api.override('capabilityManagement.usageList', async () => usage);
  api.override('shell.getInfo', async () => ({ platform: 'linux', profiles: [], bgShellMode: 'auto', manualGitBashPath: '', manualGitBashPathExists: false }));
  api.override('agentSession.claudeStatus', async () => null);
});
afterEach(() => vi.restoreAllMocks());
const select = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `配置 ${name}` }));
  await userEvent.click(screen.getByRole('tab', { name: name === 'Chat' ? '工作台聊天' : '原生终端' }));
};

describe('Worker settings with built-in products only', () => {
  it('omits custom runtimes and registration controls', async () => {
    render(<WorkerPane cfg={cfg} set={() => {}}/>);
    await screen.findByRole('button', { name: '默认与通用' });
    expect(screen.queryByRole('button', { name: '配置 Alpha' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加自定义' })).toBeNull();
    expect(screen.queryByRole('button', { name: '注册新 runtime' })).toBeNull();
  });
  it('keeps refresh reachable while the narrow layout shows a detail', async () => {
    width = 600;
    render(<WorkerPane cfg={cfg} set={() => {}}/>);
    await userEvent.click(await screen.findByRole('button', { name: '配置 Muster Core' }));
    expect(document.querySelector('.worker-list')?.getAttribute('aria-hidden')).toBe('true');
    const frame = document.querySelector('.worker-pane')!;
    const engines = screen.getByRole('heading', { name: '引擎配置', level: 2 });
    const routing = screen.getByRole('heading', { name: '自动派活' });
    expect(engines.closest('section')?.nextElementSibling).toBe(routing.closest('section'));
    expect(screen.queryByText('连接你熟悉的引擎，选择适合的工作方式。')).toBeNull();
    expect(frame.contains(routing)).toBe(false);
    expect(frame.compareDocumentPosition(routing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentSession.refreshHarnessModelCatalogs')).toHaveBeenCalledWith(expect.any(String)));
  });
});
