import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HARNESS_CATALOG } from '../../src/shared/harnessCatalog';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';
import { createApiMock } from './helpers/api-mock';

const state = vi.hoisted(() => ({
  sessions: [] as SessionMeta[],
  workspaces: [] as WorkspaceInfo[],
  setChatWorkspaceId: vi.fn()
}));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ visibleSessions: state.sessions, activeId: null, displayActiveId: null }),
  useRuntimesStore: () => ({ runtimes: [] }),
  useWorkspaceStore: () => ({ workspaces: state.workspaces, activeWorkspaceId: 'ws' }),
  useChatStore: () => ({ setChatWorkspaceId: state.setChatWorkspaceId }),
  useUiStore: () => ({ flashTip: vi.fn() })
}));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({
  useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {}, KeyChordHint: () => null
}));
vi.mock('../../src/renderer/src/sessionJump', () => ({ jumpToSession: vi.fn() }));
vi.mock('../../src/renderer/src/centerSplitStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/renderer/src/centerSplitStore')>(),
  centerSplitTryFill: () => false, centerSplitIncoming: () => null
}));
vi.mock('../../src/renderer/src/extensionWorkbench', () => ({
  useExtensionWorkbenchNavigation: () => ({ identity: null, nodes: [], error: null, saving: false }),
  saveExtensionNavigation: vi.fn()
}));
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';

function session(id: string, runtime?: string, piModeId?: string): SessionMeta {
  return { id, name: id, type: 'terminal', launchKind: 'agent', runtime, piModeId,
    workspaceId: 'ws', createdAt: 1, status: 'idle', lifecycle: 'idle' };
}

beforeEach(() => {
  localStorage.clear();
  state.setChatWorkspaceId.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0,
    defaultRootId: 'a', controlRoot: 'E:/A', rootsRevision: 0, roots: [] }];
  Element.prototype.scrollIntoView = vi.fn();
  window.api = createApiMock().api;
});

it('shows the matching GUI, ACP and CLI harness in the status slot for each catalog entry', async () => {
  const cases = HARNESS_CATALOG.flatMap(entry => [
    ...(entry.runtimeId ? [{ session: session(`gui-${entry.id}`, entry.runtimeId, entry.acpPresetId), name: entry.name }] : []),
    ...(entry.cliRuntimeId ? [{ session: session(`cli-${entry.id}`, entry.cliRuntimeId), name: entry.name }] : [])
  ]);
  state.sessions = cases.map(item => item.session);
  const view = render(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelectorAll('[data-session-row]').length).toBe(cases.length));
  let branded = 0;
  for (const { session: item, name } of cases) {
    const row = view.container.querySelector(`[data-session-row="${item.id}"]`)!;
    const time = row.querySelector('.session-reltime')!;
    const icon = row.querySelector('.session-harness-icon')!;
    expect(icon, item.id).toBeTruthy();
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe(name);
    expect(icon.getAttribute('title')).toBe(name);
    const brand = icon.querySelector('img, svg, span[style*="mask"]');
    // qwen-code / qwen-cli 尚无品牌资源，HarnessIcon 走首字母兜底；仍必须有可见字形。
    expect(brand ?? (icon.textContent ?? '').trim(), `${item.id}: known brand has a mark`).toBeTruthy();
    if (brand && !item.id.includes('qwen')) branded++;
    expect(row.querySelector('.session-state-slot')?.contains(icon), item.id).toBe(true);
    expect(icon.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  const icon = view.container.querySelector('[data-session-row="gui-codex"] .session-harness-icon')!;
  fireEvent.click(icon);
  expect(state.setChatWorkspaceId).toHaveBeenCalledWith(null);
  // 防止首字母兜底被静默推广到所有品牌：非 qwen 条目至少仍有一个真实品牌节点。
  expect(branded, '非 qwen 条目至少有一个真实品牌节点').toBeGreaterThan(0);
});

it('带子代理的会话在状态槽保留图标和折叠箭头，点击箭头不选中会话', async () => {
  state.sessions = [session('parent', 'codex-gui'), { ...session('child', 'pi'), parentSessionId: 'parent' }];
  const view = render(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelector('[data-session-row="child"]')).toBeTruthy());
  const row = view.container.querySelector('[data-session-row="parent"]')!;
  const slot = row.querySelector('.session-state-slot')!;
  expect(slot.querySelector('.session-harness-icon')?.getAttribute('aria-label')).toBe('Codex');
  fireEvent.click(slot.querySelector('.session-tree-twisty')!);
  await waitFor(() => expect(view.container.querySelector('[data-session-row="child"]')).toBeNull());
  expect(state.setChatWorkspaceId).not.toHaveBeenCalled();
});

it('does not invent a brand for legacy ACP, missing-runtime, or shell sessions', async () => {
  state.sessions = [session('legacy-acp', 'acp'), session('unknown', 'custom-engine'), session('missing'),
    { ...session('shell'), launchKind: 'shell' },
    { ...session('pi-mode', 'pi', 'creator') }];
  const view = render(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelectorAll('[data-session-row]').length).toBe(5));
  const icon = (id: string) => view.container.querySelector(`[data-session-row="${id}"] .session-harness-icon`);
  expect(icon('legacy-acp')?.getAttribute('aria-label')).toBe('ACP');
  expect(icon('unknown')?.getAttribute('aria-label')).toBe('custom-engine');
  expect(icon('pi-mode')?.getAttribute('aria-label')).toBe('Muster Core');
  expect(icon('missing')).toBeNull();
  expect(icon('shell')).toBeNull();
});

it('keeps the memory utility glyph path intact instead of clipping its left stroke', async () => {
  state.sessions = [];
  const view = render(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  await waitFor(() => expect(view.getByText('记忆整理')).toBeTruthy());
  const tile = view.getByText('记忆整理').closest('[role="listitem"]');
  if (!tile) throw new Error('memory utility tile is missing');
  const path = tile.querySelector('svg path')?.getAttribute('d') ?? '';
  expect(path).toContain('13.5');
  expect(path).not.toContain('Extension');
});

it('悬浮会话行后详情卡沿用相同的 ACP Harness 身份', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  state.sessions = [session('hover-kimi', 'acp', 'kimi')];
  const view = render(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  const row = view.container.querySelector('[data-session-row="hover-kimi"]')!;
  fireEvent.mouseEnter(row, { buttons: 0 });
  const details = await screen.findByRole('dialog', { name: '会话详情' });
  expect(within(details).getByText('Kimi Code')).toBeTruthy();
  expect(details.querySelector('img.session-details-harness-icon')).toBeTruthy();
});
