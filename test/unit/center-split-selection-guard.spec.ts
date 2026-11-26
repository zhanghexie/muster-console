import { describe, expect, it } from 'vitest';
import { createCenterSplitSelectionGuard } from '../../src/renderer/src/centerSplitSelectionGuard';

describe('分屏异步选择收板的归属', () => {
  const a = { workspaceId: 'a', utilityRevision: 0 };

  it('仅当前请求可处理自己的 reveal 和 Promise 收板兜底', () => {
    const guard = createCenterSplitSelectionGuard();
    const request = guard.begin('terminal-b', a);
    expect(guard.shouldHandleReveal('terminal-b', a)).toBe(true);
    expect(guard.isCurrent(request, a)).toBe(true);
    guard.finish(request);
    expect(guard.shouldHandleReveal('external-c', a)).toBe(true);
  });

  it('同工作区主动切到另一工具后，旧 reveal 与 Promise 均不能清掉新工具', () => {
    const guard = createCenterSplitSelectionGuard();
    const request = guard.begin('terminal-b', a);
    const changed = { ...a, utilityRevision: 1 };
    guard.invalidate();
    expect(guard.shouldHandleReveal('terminal-b', changed)).toBe(false);
    expect(guard.isCurrent(request, changed)).toBe(false);
    expect(guard.shouldHandleReveal('external-c', changed)).toBe(true);
  });

  it('跨工作区迟到的请求不会收起新工作区工具', () => {
    const guard = createCenterSplitSelectionGuard();
    const request = guard.begin('terminal-b', a);
    const b = { ...a, workspaceId: 'b' };
    expect(guard.shouldHandleReveal('terminal-b', b)).toBe(false);
    expect(guard.isCurrent(request, b)).toBe(false);
  });

  it('连续 bridge 请求到达顺序相反时只让最新请求收板', () => {
    const guard = createCenterSplitSelectionGuard();
    const first = guard.begin('terminal-b', a);
    const latest = guard.begin('terminal-c', a);
    expect(guard.shouldHandleReveal('terminal-b', a)).toBe(false);
    expect(guard.isCurrent(first, a)).toBe(false);
    expect(guard.shouldHandleReveal('terminal-c', a)).toBe(true);
    expect(guard.isCurrent(latest, a)).toBe(true);
  });
});
