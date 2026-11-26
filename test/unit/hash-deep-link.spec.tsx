/**
 * useHashDeepLink（会话 hash 深链）hook 级单测：
 * 1. 挂载即命中（冷启动带 hash 打开）；2. 回归——会话表异步到位后必须重试（无重试 effect 该用例转红）；
 * 3. 同一 hash 去重不重复跳转；4. hashchange 后续变化命中；5. 无效 hash 不触发。
 */
import React, { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHashDeepLink } from '../../src/renderer/src/mobile/useHashDeepLink';

const SESSIONS = [
  { id: 's1', workspaceId: 'ws1' },
  { id: 's2', workspaceId: 'ws2' }
];

function Harness({
  sessions,
  onHit
}: {
  sessions: ReadonlyArray<{ id: string; workspaceId?: string }>;
  onHit: (workspaceId: string, sessionId: string) => void;
}): null {
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useHashDeepLink({ sessionsRef, sessions, onHit });
  return null;
}

function renderAt(sessions: ReadonlyArray<{ id: string; workspaceId?: string }>, onHit: (ws: string, sid: string) => void) {
  render(<Harness sessions={sessions} onHit={onHit} />);
  expect(screen.queryByText('any')).toBeNull(); // 渲染无 UI 输出，仅断言无异常
}

describe('useHashDeepLink 会话深链', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('挂载即命中：冷启动 hash 已存在 → 直落目标会话', () => {
    window.location.hash = '#/session/s1';
    const onHit = vi.fn();
    renderAt(SESSIONS, onHit);
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(onHit).toHaveBeenCalledWith('ws1', 's1');
  });

  it('回归：挂载时会话表为空 → 数据到位后重试命中（深链冷启动不丢）', () => {
    window.location.hash = '#/session/s2';
    const onHit = vi.fn();
    const { rerender } = render(<Harness sessions={[]} onHit={onHit} />);
    expect(onHit).not.toHaveBeenCalled();
    // 会话表异步到位（store 拉取后 rerender）
    rerender(<Harness sessions={SESSIONS} onHit={onHit} />);
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(onHit).toHaveBeenCalledWith('ws2', 's2');
  });

  it('同一 hash 去重：会话表更新重放 apply 不重复跳转', () => {
    window.location.hash = '#/session/s1';
    const onHit = vi.fn();
    const { rerender } = render(<Harness sessions={SESSIONS} onHit={onHit} />);
    expect(onHit).toHaveBeenCalledTimes(1);
    rerender(<Harness sessions={[...SESSIONS]} onHit={onHit} />);
    rerender(<Harness sessions={[...SESSIONS]} onHit={onHit} />);
    expect(onHit).toHaveBeenCalledTimes(1);
  });

  it('hashchange：挂载后 hash 变化命中新会话', async () => {
    window.location.hash = '#/session/s1';
    const onHit = vi.fn();
    renderAt(SESSIONS, onHit);
    await act(async () => {
      window.location.hash = '#/session/s2';
    });
    // jsdom 的 hashchange 异步派发
    await waitFor(() => expect(onHit).toHaveBeenCalledTimes(2));
    expect(onHit).toHaveBeenLastCalledWith('ws2', 's2');
  });

  it('无效 hash / 会话不在表内：不触发', () => {
    window.location.hash = '#/workspace-only';
    const onHit = vi.fn();
    renderAt(SESSIONS, onHit);
    act(() => {
      window.location.hash = '#/session/missing';
    });
    expect(onHit).not.toHaveBeenCalled();
  });
});
