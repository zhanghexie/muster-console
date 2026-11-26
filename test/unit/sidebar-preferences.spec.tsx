import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSidebarWidth, sidebarCollapsedKey, useGlobalSidebarWidth, useWorkspaceSidebarCollapsed, type SidebarSection } from '../../src/renderer/src/sidebarPreferences';

beforeEach(() => { localStorage.clear(); });
it.each<SidebarSection>(['utilities', 'sessions', 'terminals', 'workspaces'])('%s 按工作区记住状态，切区不写错归属，重挂载仍恢复', section => {
  const hook = renderHook(({ id }) => useWorkspaceSidebarCollapsed(id, section), { initialProps: { id: 'A' } });
  act(() => hook.result.current[1](true));
  hook.rerender({ id: 'B' });
  expect(hook.result.current[0]).toBe(false);
  act(() => hook.result.current[1](false));
  hook.rerender({ id: 'A' });
  expect(hook.result.current[0]).toBe(true);
  expect(localStorage.getItem(sidebarCollapsedKey('A', section))).toBe('1');
  expect(localStorage.getItem(sidebarCollapsedKey('B', section))).toBe('0');
  hook.unmount();
  const restored = renderHook(() => useWorkspaceSidebarCollapsed('A', section));
  expect(restored.result.current[0]).toBe(true);
});
it('同工作区的四组互不覆盖；旧工作区栈偏好作为首次默认值', () => {
  localStorage.setItem('muster.wsStackCollapsed.v1', '1');
  const utilities = renderHook(() => useWorkspaceSidebarCollapsed('A', 'utilities'));
  const workspaces = renderHook(() => useWorkspaceSidebarCollapsed('A', 'workspaces'));
  expect(utilities.result.current[0]).toBe(false);
  expect(workspaces.result.current[0]).toBe(true);
  act(() => workspaces.result.current[1](false));
  act(() => utilities.result.current[1](true));
  expect(workspaces.result.current[0]).toBe(false);
  expect(utilities.result.current[0]).toBe(true);
});
it('无工作区不落盘，存储不可写时仍保留本次会话的各区状态', () => {
  const hook = renderHook(({ id }: { id: string | null }) => useWorkspaceSidebarCollapsed(id, 'sessions'), { initialProps: { id: null as string | null } });
  act(() => hook.result.current[1](true));
  expect(localStorage.length).toBe(0);
  hook.rerender({ id: 'storage-blocked-A' });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  try {
    act(() => hook.result.current[1](true));
    hook.rerender({ id: 'storage-blocked-B' });
    expect(hook.result.current[0]).toBe(false);
    hook.rerender({ id: 'storage-blocked-A' });
    expect(hook.result.current[0]).toBe(true);
  } finally { write.mockRestore(); }
});
it('全局宽度只迁移首个就绪工作区，切区配置不再覆盖；拖动结束才存', () => {
  const hook = renderHook(({ legacy, ready }) => useGlobalSidebarWidth(legacy, ready), { initialProps: { legacy: 280, ready: false } });
  expect(hook.result.current.width).toBeNull();
  hook.rerender({ legacy: 280, ready: true });
  expect(hook.result.current.width).toBe(280);
  hook.rerender({ legacy: 410, ready: true });
  expect(hook.result.current.width).toBe(280);
  act(() => hook.result.current.setWidth(330));
  expect(loadSidebarWidth()).toBe(280);
  act(() => hook.result.current.commit(330));
  expect(loadSidebarWidth()).toBe(330);
  hook.unmount();
  const restored = renderHook(() => useGlobalSidebarWidth(200, true));
  expect(restored.result.current.width).toBe(330);
});
it('首次没有旧宽度时保持自适应，之后切区不补迁移；启动期手动拖宽优先', () => {
  const hook = renderHook(({ legacy }: { legacy: number | undefined }) => useGlobalSidebarWidth(legacy, true), { initialProps: { legacy: undefined as number | undefined } });
  hook.rerender({ legacy: 400 });
  expect(hook.result.current.width).toBeNull();
  const dragging = renderHook(({ ready }) => useGlobalSidebarWidth(450, ready), { initialProps: { ready: false } });
  act(() => dragging.result.current.setWidth(310));
  dragging.rerender({ ready: true });
  expect(dragging.result.current.width).toBe(310);
  act(() => dragging.result.current.commit(310));
  expect(loadSidebarWidth()).toBe(310);
});
it('坏宽度回默认；App 的切区水合、专注快照和松手均不再写工作区宽度', () => {
  localStorage.setItem('muster.leftColumnWidth.v1', 'NaN');
  expect(loadSidebarWidth()).toBeNull();
  const app = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8');
  expect(app).toMatch(/useGlobalSidebarWidth\(\s*cfg\.leftColumnWidth, wsFileReady && wsFileWorkspaceId === activeWorkspaceId/);
  expect(app).toContain('commitLeftColW(leftWRef.current)');
  expect(app).not.toMatch(/leftColumnWidth:\s*(?:snap\.|leftWRef\.)/);
  expect(app).not.toContain('setLeftColW(snap.leftColW)');
  expect(app).not.toContain('setLeftColW(Math.round(cfg.leftColumnWidth))');
});
