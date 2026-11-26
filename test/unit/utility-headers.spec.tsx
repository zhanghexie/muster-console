import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PromptTaskPanel } from '../../src/renderer/src/components/PromptTaskPanel';
import { UsageStatsPanel } from '../../src/renderer/src/components/UsageStatsPanel';
import { KnowledgeCenter } from '../../src/renderer/src/components/KnowledgeCenter';
import { KnowledgePanel } from '../../src/renderer/src/components/KnowledgePanel';
import { ExtensionsManager } from '../../src/renderer/src/panels/ExtensionsManager';
import { StoreProvider } from '../../src/renderer/src/store';
import { emptyUsageDay, usageDayKey } from '../../src/shared/usageStats';
import { currentApiMock } from './helpers/api-mock';

// Old callers supplied onClose; keep this regression sensitive to the former button.
const legacyProps = { onClose: vi.fn() };
const withLegacyClose = (component: React.ComponentType<any>) => React.createElement(component, legacyProps);
const workspace = { id: 'ws', name: '项目', path: 'E:/demo', openedAt: 1 };
const memory = { records: [], active: 0, pending: 0, history: 0, startedAt: 1, profileInjectionChars: 0 };
afterEach(() => vi.unstubAllGlobals());

function seed() {
  const api = currentApiMock();
  const today = usageDayKey(Date.now());
  const day = emptyUsageDay();
  api.override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws' }));
  api.override('config.get', async () => ({ locale: 'zh-CN', workspaces: [workspace], activeWorkspaceId: 'ws', defaultRuntime: 'shell' }));
  api.override('runtimes.list', async () => [{ id: 'shell', label: 'Shell', enabled: true }]);
  api.override('runtimes.availability', async () => ({ runtimes: [{ id: 'shell', label: 'Shell', enabled: true }], acpAgents: [], checkedAt: 1 }));
  api.override('services.list', async () => ({ services: [] }));
  api.override('services.create', async () => ({ id: 'new', workspaceId: 'ws' }));
  api.override('usage.summary', async () => ({ generatedAt: Date.now(), todayKey: today, fromKey: today, toKey: today,
    rangeDays: [{ date: today, day }], rangeTotal: day, prevTotal: emptyUsageDay(), llmCalls: [], llmCallsTotal: 0, llmByExt: [], toolFailures: [] }));
  api.override('knowledge.list', async () => memory);
  api.override('memoryCurator.inspect', async () => ({ items: [], total: 0, offset: 0, limit: 30 }));
  api.override('memoryCurator.state', async () => ({ workspaceId: 'ws', pending: 0, failed: 0, running: false, paused: false, messages: [], updatedAt: 1 }));
  return api;
}

function expectSimpleHeader(name: string) {
  const header = screen.getByRole('heading', { name, level: 1 }).closest('header')!;
  expect(within(header).queryByText('实用功能')).toBeNull();
  expect(within(header).queryByRole('button', { name: '返回终端' })).toBeNull();
  return within(header);
}

it('keeps task creation available without a return button', async () => {
  const api = seed();
  render(<StoreProvider>{withLegacyClose(PromptTaskPanel)}</StoreProvider>);
  const header = expectSimpleHeader('定时任务');
  const create = header.getByRole('button', { name: '＋ 新建任务' });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  await waitFor(() => expect(api.mockOf('services.create')).toHaveBeenCalledOnce());
});

it('still navigates from a task run to its session', async () => {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  try {
    const api = seed();
    const task = { id: 'task', name: '巡检', workspaceId: 'ws', runtime: 'shell', prompt: 'Check', enabled: false, createdAt: 1, schedule: { kind: 'daily', time: '09:00' } };
    api.override('services.list', async () => ({ services: [task] }));
    api.override('services.get', async () => task);
    api.override('services.runs', async () => ({ runs: [{ id: 'run', taskId: 'task', mode: 'terminal', status: 'ok', startedAt: 1, sessionId: 'session' }] }));
    const navigate = vi.fn();
    render(<StoreProvider><PromptTaskPanel onNavigateToSession={navigate} /></StoreProvider>);
    fireEvent.click(await screen.findByRole('option', { name: /巡检/ }));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /会话 ↗/ }));
    await waitFor(() => expect(api.mockOf('sessions.select')).toHaveBeenCalledWith('session'));
    expect(navigate).toHaveBeenCalledOnce();
  } finally {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('keeps statistics refresh available without a return button', async () => {
  const api = seed();
  render(<StoreProvider>{withLegacyClose(UsageStatsPanel)}</StoreProvider>);
  const header = expectSimpleHeader('使用统计');
  await waitFor(() => expect(api.mockOf('usage.summary')).toHaveBeenCalledTimes(1));
  fireEvent.click(header.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(api.mockOf('usage.summary')).toHaveBeenCalledTimes(2));
});

it('keeps the memory tabs usable without a return button', async () => {
  seed();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  render(<StoreProvider>{withLegacyClose(KnowledgeCenter)}</StoreProvider>);
  await screen.findByRole('heading', { name: '记忆中心', level: 1 });
  expectSimpleHeader('记忆中心');
  const tab = screen.getByRole('tab', { name: '长期知识' });
  fireEvent.click(tab);
  expect(tab.getAttribute('aria-selected')).toBe('true');
  await screen.findByText('目前没有匹配的知识');
});

it('removes the return button from the standalone memory view too', async () => {
  const api = seed();
  const Component = KnowledgePanel as React.ComponentType<any>;
  render(<Component api={api.api.knowledge} workspaceKey="ws" {...legacyProps} />);
  expect(screen.queryByRole('button', { name: '返回终端' })).toBeNull();
  await screen.findByText('目前没有匹配的知识');
  fireEvent.click(screen.getByRole('button', { name: '任务历史' }));
  expect(screen.getByRole('button', { name: '任务历史' }).getAttribute('aria-pressed')).toBe('true');
});

it('uses the same simple heading for extension management', () => {
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目" listing={{ global: [], project: [], problems: [], issues: [] }} setEnabled={async () => {}} />);
  expectSimpleHeader('扩展管理');
  fireEvent.click(screen.getByRole('tab', { name: /项目扩展/ }));
  expect(screen.getByRole('tab', { name: /项目扩展/ }).getAttribute('aria-selected')).toBe('true');
});
