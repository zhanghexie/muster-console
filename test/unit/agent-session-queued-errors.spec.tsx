import {overrideGuiHistory} from './helpers/gui-history-range';
/**
 * X4-F04（渲染层）：agentSessionSurface 排队三动作（cancelQueued/editQueued/reorderQueued）
 * 必须消费 {ok,error?} 合同——未就绪/异常 flashTip 上浮；良性 {ok:false}（无 error）不提示。
 * 红绿：stash src/renderer/src/chatSurface/agentSessionSurface.tsx 后断言红（裸 void 无反馈）。
 * 运行: npx vitest run test/unit/agent-session-queued-errors.spec.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from '@testing-library/react';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';
import type { ChatSurface } from '../../src/shared/chatSurface';

const flash = vi.hoisted(() => ({ tip: vi.fn() }));
vi.mock('../../src/renderer/src/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/store')>();
  return { ...actual, useUiActionsStore: () => ({ flashTip: flash.tip }) };
});
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';

const Harness = (props: { surfaceRef: { current: ChatSurface | null }; visible?: boolean; runtimeId?: string }): null => {
  const surface = useAgentSessionSurface({ sessionId: 'sess-f04', visible: props.visible ?? true, runtimeId: props.runtimeId ?? 'pi' });
  props.surfaceRef.current = surface;
  return null;
};

function mount() {
  const surfaceRef: { current: ChatSurface | null } = { current: null };
  render(<StoreProvider><Harness surfaceRef={surfaceRef} /></StoreProvider>);
  return surfaceRef;
}

describe('agentSessionSurface 排队动作失败反馈（X4-F04）', () => {
  beforeEach(() => {
    flash.tip.mockClear();
    currentApiMock();
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  });

  it('localizes a host model validation failure in the toast without changing the response', async () => {
    const result = { ok: false, error: '引擎配置在模型校验期间变化，请重试' };
    overrideGuiHistory(currentApiMock(), async () => ({ messages: [], mode: 'default', busy: false }));
    currentApiMock().override('agentSession.setModel', async () => result);
    const ref = mount();
    try {
      act(() => { applyLocaleSetting('en'); ref.current!.actions.setModel?.({ providerId: 'p', modelId: 'm' }); });
      await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('The engine configuration changed during model validation. Try again.'));
      expect(result.error).toBe('引擎配置在模型校验期间变化，请重试');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });

  it.each([['pi', 'agentSession.listPiModes', 'Standard'], ['acp', 'agentSession.listAcpAgents', 'Auto']] as const)(
    '隐藏会话的 %s 回落模式也使用当前语言', async (runtimeId, method, expected) => {
      const mock = currentApiMock(); mock.override(method, async () => []);
      const ref: { current: ChatSurface | null } = { current: null };
      act(() => { applyLocaleSetting('en'); });
      const view = render(<StoreProvider><Harness surfaceRef={ref} visible={false} runtimeId={runtimeId}/></StoreProvider>);
      try {
        let roster: Awaited<ReturnType<NonNullable<ChatSurface['actions']['loadPresetRoster']>>>;
        await act(async () => { roster = await ref.current!.actions.loadPresetRoster!(); });
        expect(roster![0]?.name).toBe(expected);
      }
      finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
    }
  );

  it('分叉失败只翻译宿主提示，不更改返回值', async () => {
    const mock = currentApiMock(), result = { ok: false, error: '会话正在接收消息，请稍后再分叉' };
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.fork', async () => result);
    const ref = mount();
    try {
      act(() => { applyLocaleSetting('en'); });
      ref.current!.actions.fork?.('m1');
      await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('The session is receiving a message. Wait before forking.'));
      expect(result.error).toBe('会话正在接收消息，请稍后再分叉');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });

  it('translates the fork-owned native-session suffix even when the cause is external', async () => {
    const mock = currentApiMock(), result = { ok: false, error: '外部引擎错误（已创建原生会话 native-1）' };
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.fork', async () => result);
    const ref = mount();
    try {
      act(() => { applyLocaleSetting('en'); });
      ref.current!.actions.fork?.('m1');
      await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('外部引擎错误 (Native session native-1 was created)'));
      expect(result.error).toBe('外部引擎错误（已创建原生会话 native-1）');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });

  it('清空会话失败保留原始错误并向界面返回翻译', async () => {
    const mock = currentApiMock(), original = new Error('会话正在清空，请稍后再试');
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.clear', async () => { throw original; });
    const ref = mount();
    try {
      act(() => { applyLocaleSetting('en'); });
      await act(async () => { await expect(ref.current!.actions.clear?.()).rejects.toThrow('The session is being cleared. Try again shortly.'); });
      expect(original.message).toBe('会话正在清空，请稍后再试');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });

  it('撤回排队失败（宿主未就绪 {ok:false,error}）→ flashTip 上浮 error 文案', async () => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.cancelQueued', async () => ({ ok: false, error: 'GUI 会话宿主未就绪' }));
    const ref = mount();
    ref.current!.actions.cancelQueued('m1');
    await waitFor(() => expect(mock.mockOf('agentSession.cancelQueued')).toHaveBeenCalled());
    await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('GUI 会话宿主未就绪'));
  });

  it('撤回排队 IPC 异常（reject）→ flashTip 上浮异常信息', async () => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.cancelQueued', async () => { throw new Error('IPC 断连'); });
    const ref = mount();
    ref.current!.actions.cancelQueued('m2');
    await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('IPC 断连'));
  });

  it('良性 {ok:false}（消息已不在队，无 error）→ 不弹提示（靠 busy 推送收敛）', async () => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.cancelQueued', async () => ({ ok: false }));
    const ref = mount();
    ref.current!.actions.cancelQueued('m3');
    await waitFor(() => expect(mock.mockOf('agentSession.cancelQueued')).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 30));
    expect(flash.tip).not.toHaveBeenCalled();
  });

  it('改写排队失败（未就绪）与重排失败（IPC 异常）→ flashTip 上浮', async () => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => ({ messages: [], mode: 'default', busy: false }));
    mock.override('agentSession.editQueued', async () => ({ ok: false, error: 'GUI 会话宿主未就绪' }));
    mock.override('agentSession.reorderQueued', async () => { throw new Error('重排断连'); });
    const ref = mount();
    ref.current!.actions.editQueued?.('m4', '新文本');
    ref.current!.actions.reorderQueued?.(['m4']);
    await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('GUI 会话宿主未就绪'));
    await waitFor(() => expect(flash.tip).toHaveBeenCalledWith('重排断连'));
  });
});
