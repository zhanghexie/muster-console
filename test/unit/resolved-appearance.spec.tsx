import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { builtinTheme } from '../../src/shared/theme';
import { applyTheme, getResolvedAppearance, getStoredTheme, setWorkspaceAppearance, subscribeAppearance, terminalTheme } from '../../src/renderer/src/theme';

const neutral = { workspaceId: null, accent: '#8e8e96', enabled: false };

it.each([false, true])('浅色输入框保留主题轻投影，深色维持现状（工作区色 %s）', enabled => {
  setWorkspaceAppearance({ ...neutral, enabled });
  const light = builtinTheme('light')!;
  applyTheme(light);
  expect(getResolvedAppearance().cssVars['--shadow-input']).toBe(light.colors['shadow-input']);
  expect(document.documentElement.style.getPropertyValue('--shadow-input')).not.toBe('none');
  applyTheme(builtinTheme('dark')!);
  expect(getResolvedAppearance().cssVars['--shadow-input']).toBe('none');
});
beforeEach(() => { localStorage.clear(); setWorkspaceAppearance(neutral); applyTheme(builtinTheme('dark')!); });
afterEach(() => { setWorkspaceAppearance(neutral); applyTheme(builtinTheme('dark')!); localStorage.clear(); });

it('publishes CSS and xterm from the same revision when only the workspace color changes', () => {
  const snapshots: ReturnType<typeof getResolvedAppearance>[] = [];
  const stop = subscribeAppearance(snapshot => {
    expect(document.documentElement.style.getPropertyValue('--surface-canvas')).toBe(snapshot.surfaces.canvas);
    expect(document.documentElement.dataset.appearanceRevision).toBe(String(snapshot.revision));
    expect(terminalTheme().background).toBe(snapshot.surfaces.canvas);
    snapshots.push(snapshot);
  });
  try {
    setWorkspaceAppearance({ workspaceId: 'a', accent: '#8b7bff', enabled: true });
    const first = getResolvedAppearance();
    setWorkspaceAppearance({ workspaceId: 'b', accent: '#2fc4b2', enabled: true });
    const next = getResolvedAppearance();
    expect(next.revision).toBe(first.revision + 1);
    expect(next.surfaces.canvas).not.toBe(first.surfaces.canvas);
    expect(next.cssVars['--identity-surface']).toBe(first.cssVars['--identity-surface']);
    expect(next.cm.background).toBe(next.terminal.background);
    expect(snapshots).toHaveLength(2);
    setWorkspaceAppearance({ workspaceId: 'b', accent: '#2fc4b2', enabled: true });
    expect(snapshots).toHaveLength(2);
  } finally { stop(); }
});

it('theme previews update the shared palette without persisting unsaved seeds', () => {
  const stored = builtinTheme('dark')!;
  applyTheme(stored);
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  applyTheme(builtinTheme('light')!, { persist: false });
  expect(getResolvedAppearance().appearance).toBe('light');
  expect(document.documentElement.style.colorScheme).toBe('light');
  expect(getResolvedAppearance().cm.dark).toBe(false);
  expect(getStoredTheme().appearance).toBe('dark');
  expect(getStoredTheme().colors).toEqual(stored.colors);
  expect(setItem).not.toHaveBeenCalled();
  setItem.mockRestore();
});

it('unsubscribes mounted consumers without leaking callbacks across workspace changes', () => {
  const listener = vi.fn(); const stop = subscribeAppearance(listener);
  stop(); setWorkspaceAppearance({ workspaceId: 'a', accent: '#5aa7ff', enabled: true });
  expect(listener).not.toHaveBeenCalled();
});

it('工作区切换但配色输入不变时是 no-op 发布：不 bump revision、不通知订阅方（工作区切换卡顿回归守卫）', () => {
  const listener = vi.fn();
  const stop = subscribeAppearance(listener);
  try {
    setWorkspaceAppearance({ workspaceId: 'ws-a', accent: '#8b7bff', enabled: false });
    const first = getResolvedAppearance();
    const revisionBefore = document.documentElement.dataset.appearanceRevision;
    expect(listener).toHaveBeenCalledTimes(1);
    // 换工作区 id，accent/enabled 与主题全同 → 解析结果逐值相等 → 跳过发布
    setWorkspaceAppearance({ workspaceId: 'ws-b', accent: '#8b7bff', enabled: false });
    expect(listener).toHaveBeenCalledTimes(1); // 不再通知（CodeMirror/xterm 不重配）
    expect(getResolvedAppearance()).toBe(first); // 快照对象不换引用
    expect(document.documentElement.dataset.appearanceRevision).toBe(revisionBefore);
    // 真实配色变化仍正常发布
    setWorkspaceAppearance({ workspaceId: 'ws-c', accent: '#2fc4b2', enabled: false });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getResolvedAppearance().revision).toBe(first.revision + 1);
  } finally { stop(); }
});
