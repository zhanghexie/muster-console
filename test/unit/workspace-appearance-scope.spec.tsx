import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ id: 'one', version: 1, accent: '#b7667e', enabled: true, publish: vi.fn() }));
vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ activeWorkspaceId: scope.id, workspaces: [] }) }));
vi.mock('../../src/renderer/src/useWorkspaceAccents', () => ({ useWorkspaceAccentVersion: () => scope.version }));
vi.mock('../../src/shared/workspaceAccent', () => ({ workspaceAccent: () => scope.accent, workspaceAccentEnabled: () => scope.enabled }));
vi.mock('../../src/renderer/src/theme', () => ({ setWorkspaceAppearance: scope.publish }));
import { useWorkspaceAppearance } from '../../src/renderer/src/useWorkspaceAppearance';
beforeEach(() => { scope.id = 'one'; scope.version = 1; scope.accent = '#b7667e'; scope.enabled = true; scope.publish.mockClear(); });
it('publishes workspace switches and accent toggles through the common pre-paint appearance hook', () => {
  const view = renderHook(() => useWorkspaceAppearance());
  expect(scope.publish).toHaveBeenLastCalledWith({ workspaceId: 'one', accent: '#b7667e', enabled: true });
  scope.id = 'two'; scope.accent = '#4d9bbf'; scope.version++; view.rerender();
  expect(scope.publish).toHaveBeenLastCalledWith({ workspaceId: 'two', accent: '#4d9bbf', enabled: true });
  scope.enabled = false; scope.version++; view.rerender();
  expect(scope.publish).toHaveBeenLastCalledWith({ workspaceId: 'two', accent: '#4d9bbf', enabled: false });
});
