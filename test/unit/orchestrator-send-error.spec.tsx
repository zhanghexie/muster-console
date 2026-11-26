/**
 * chat-surface F-04：调度面 send 的 IPC 异常不得静默吞——catch 里 flashTip（对齐 GUI 面
 * agentSessionSurface 的「发送失败：{{message}}」），随后仍 return false（Composer 保稿）。
 * 红绿：stash src/renderer/src/chatSurface/orchestratorSurface.tsx 后断言红。
 * 运行: npx vitest run test/unit/orchestrator-send-error.spec.tsx
 */
import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';

const flash = vi.hoisted(() => ({ tip: vi.fn() }));
vi.mock('../../src/renderer/src/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/store')>();
  return { ...actual, useUiStore: () => ({ flashTip: flash.tip }) };
});
import { StoreProvider } from '../../src/renderer/src/store';
import { useOrchestratorSurface, getOrchestratorSurface } from '../../src/renderer/src/chatSurface/orchestratorSurface';

const wsId = 'ws-send-f04';
const Harness = (): null => {
  useOrchestratorSurface(wsId);
  return null;
};

describe('调度面发送失败反馈（chat-surface F-04）', () => {
  beforeEach(() => {
    flash.tip.mockClear();
    currentApiMock();
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  });

  it('chat.send IPC 异常 → flashTip「发送失败：…」且 send 返回 false（保稿）', async () => {
    const mock = currentApiMock();
    mock.override('chat.send', async () => { throw new Error('调度链路断连'); });
    render(<StoreProvider><Harness /></StoreProvider>);
    const surface = getOrchestratorSurface(wsId);
    const ok = await surface.actions.send('一条会失败的消息');
    expect(ok).toBe(false);
    await waitFor(() => expect(flash.tip).toHaveBeenCalled());
    expect(flash.tip.mock.calls[0][0]).toContain('发送失败');
    expect(flash.tip.mock.calls[0][0]).toContain('调度链路断连');
  });

  it('受理被拒（accepted:false 带 error）→ flashTip 上浮 error（既有行为不回归）', async () => {
    const mock = currentApiMock();
    mock.override('chat.send', async () => ({ accepted: false, error: '排队已满' }));
    render(<StoreProvider><Harness /></StoreProvider>);
    const surface = getOrchestratorSurface(wsId);
    const ok = await surface.actions.send('另一条消息');
    expect(ok).toBe(false);
    await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('排队已满'));
  });
});
