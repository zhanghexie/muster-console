import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadVirtualScreenPage, saveVirtualScreenPage, virtualScreenPageKey } from '../../src/renderer/src/virtualScreenPagePreference';
import { visualHDock } from '../../src/shared/workspaceUiPersist';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('reads legacy preferences until a workspace has a valid local page', () => {
  expect(loadVirtualScreenPage('a', 'git')).toBe('git');
  expect(localStorage.getItem(virtualScreenPageKey('a'))).toBeNull();
  expect(loadVirtualScreenPage('a', 'terminal')).toBe('terminal');
  expect(loadVirtualScreenPage(null, undefined)).toBe('terminal');
  localStorage.setItem(virtualScreenPageKey('a'), 'invalid');
  expect(loadVirtualScreenPage('a', 'git')).toBe('git');
});

it('persists only the last side per workspace and keeps the preference under visual clamping', () => {
  const workspace = 'project:/a';
  const key = virtualScreenPageKey(workspace);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  expect(saveVirtualScreenPage(workspace, 'git')).toBe(true);
  expect(localStorage.getItem(key)).toBe('right');
  expect(saveVirtualScreenPage(workspace, 'git')).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  expect(saveVirtualScreenPage(workspace, 'terminal')).toBe(true);
  expect(saveVirtualScreenPage('project:/b', 'git')).toBe(true);
  expect(localStorage.getItem(key)).toBe('left');
  expect(loadVirtualScreenPage(workspace, 'git')).toBe('terminal');
  const stored = loadVirtualScreenPage('project:/b', 'terminal');
  expect(visualHDock({ stored, hVirtualScreen: true, focusMode: true })).toBe('terminal');
  expect(visualHDock({ stored, hVirtualScreen: false, focusMode: false })).toBe('terminal');
  expect(visualHDock({ stored, hVirtualScreen: true, focusMode: false })).toBe('git');
  expect(localStorage.getItem(virtualScreenPageKey('project:/b'))).toBe('right');
});

it('keeps the latest page in memory if storage rejects a write and retries on the next choice', () => {
  const workspace = 'storage-denied';
  expect(saveVirtualScreenPage(workspace, 'terminal')).toBe(true);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  expect(saveVirtualScreenPage(workspace, 'git')).toBe(false);
  expect(loadVirtualScreenPage(workspace, 'terminal')).toBe('git');
  expect(loadVirtualScreenPage('different', 'terminal')).toBe('terminal');
  write.mockRestore();
  expect(saveVirtualScreenPage(workspace, 'git')).toBe(true);
  expect(localStorage.getItem(virtualScreenPageKey(workspace))).toBe('right');
});
