/**
 * 手机表面服务端推送（T1.2）组件测试：
 * 1. useSessionStatusPush：shim 订阅 → 回调转发；isViewingSession 过滤（正在看的
 *    会话静默）；重渲染后回调经 ref 取最新（订阅只建一次）。
 * 2. MobileToast：纯提示无交互元素；带动作时点击触发 run（needs_you 深链出口）。
 * webApiShim 以模块 mock 隔离（真模块顶层装 shim 会碰 WebSocket）。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionStatusPush } from '../../src/shared/webPush';

/* ── webApiShim 模块 mock：捕获订阅者，暴露手动推帧口 ── */
type PushListener = (p: SessionStatusPush) => void;
const listeners = new Set<PushListener>();
vi.mock('../../src/renderer/src/webApiShim', () => ({
  subscribeSessionStatusPush: (fn: PushListener) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }
}));

import { useSessionStatusPush } from '../../src/renderer/src/mobile/useSessionStatusPush';
import { MobileToast } from '../../src/renderer/src/mobile/MobileToast';

function frame(partial?: Partial<SessionStatusPush>): SessionStatusPush {
  return {
    type: 'session-status',
    sessionId: 'sess-1',
    phase: 'needs_you',
    label: '修登录 bug · 需要你',
    ...partial
  };
}

/** 推一帧到当前全部订阅者 */
function emit(p: SessionStatusPush): void {
  for (const fn of listeners) fn(p);
}

beforeEach(() => {
  listeners.clear();
});

describe('useSessionStatusPush', () => {
  it('订阅 shim 推送并转发给 onPush', () => {
    const onPush = vi.fn();
    renderHook(() => useSessionStatusPush({ onPush }));
    emit(frame());
    expect(onPush).toHaveBeenCalledTimes(1);
    expect(onPush).toHaveBeenCalledWith(frame());
  });

  it('isViewingSession 命中时静默跳过（正在看的会话由页面自身呈现）', () => {
    const onPush = vi.fn();
    const isViewingSession = vi.fn((id: string) => id === 'sess-viewing');
    renderHook(() => useSessionStatusPush({ onPush, isViewingSession }));
    emit(frame({ sessionId: 'sess-viewing' }));
    emit(frame({ sessionId: 'sess-other' }));
    expect(onPush).toHaveBeenCalledTimes(1);
    expect(onPush).toHaveBeenCalledWith(frame({ sessionId: 'sess-other' }));
    expect(isViewingSession).toHaveBeenCalledTimes(2);
  });

  it('重渲染换回调后经 ref 生效，订阅不重建', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useSessionStatusPush({ onPush: cb }), {
      initialProps: { cb: first }
    });
    emit(frame({ label: 'a' }));
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ cb: second });
    emit(frame({ label: 'b' }));
    expect(first).toHaveBeenCalledTimes(1); // 旧回调不再收
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(frame({ label: 'b' }));
  });

  it('卸载后退订', () => {
    const onPush = vi.fn();
    const { unmount } = renderHook(() => useSessionStatusPush({ onPush }));
    unmount();
    emit(frame());
    expect(onPush).not.toHaveBeenCalled();
  });
});

describe('MobileToast', () => {
  it('纯提示：文本渲染，无按钮不可点', () => {
    render(<MobileToast text="修登录 bug · 已完成" />);
    const el = screen.getByRole('status');
    expect(el.textContent).toBe('修登录 bug · 已完成');
    expect(el.tagName).toBe('DIV');
    expect(el.className).not.toContain('action');
  });

  it('带动作：点击整条触发 run（needs_you 深链出口）', async () => {
    const run = vi.fn();
    render(<MobileToast text="修登录 bug · 需要你" action={{ label: '查看', run }} />);
    // 带动作的可点条目保持原生 button 语义（读屏播报可点击），不再用 role="status" 覆盖
    const el = screen.getByRole('button', { name: '修登录 bug · 需要你查看' });
    expect(el.tagName).toBe('BUTTON');
    expect(el.className).toContain('action');
    expect(screen.getByText('查看')).toBeTruthy();
    await userEvent.click(el);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
