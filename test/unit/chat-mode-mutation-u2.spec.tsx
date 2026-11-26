import {overrideGuiHistory} from './helpers/gui-history-range';
/**
 * 模式切换乱序回滚回归（U2，2026-10-02 修复）：旧失败/旧成功晚到、两次失败、
 * A→B→A、与 history 交叉、切会话——展示与最新有效设置一致，错误提示不丢。
 *
 * 修复机制（agentSessionSurface.setMode）：乐观更新 + 串行请求队列（按发出顺序在主进程
 * 落定）；失败只回滚仍属于最新请求的乐观态，回滚目标是 confirmedMode（最后一次被
 * 主进程确认的值）；epoch 失配（切会话/重挂）回调整体作废。
 *
 * 还原修复即红：恢复无条件 `this.mode = prev` 回滚（去掉 modeReq/confirmedMode/epoch
 * 校验），「不覆盖新成功」「两次失败回正确基准」断言转红。
 * 运行: npx vitest run test/unit/chat-mode-mutation-u2.spec.tsx
 */
import React from 'react';
import { render, waitFor, act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { currentApiMock } from './helpers/api-mock';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage, GuiWorkerHistory } from '../../src/shared/guiWorker';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

type ModeReply = { ok: boolean; error?: string };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function guiMsg(m: Partial<GuiChatMessage> & { id: string }): GuiChatMessage {
  return { role: 'assistant', parts: [{ kind: 'text', text: '' }], ts: 1, ...m } as GuiChatMessage;
}

/**
 * setMode 应答控制：串行队列实现下同一时刻至多一个在途请求；latest() 取最新发出的
 * 应答门。调 latest() 前先 await tick() 让队列推进发出 IPC。
 */
function mockSetModeQueue(): { latest: () => { resolve: (v: ModeReply) => void } } {
  const mock = currentApiMock();
  const queue: Array<{ resolve: (v: ModeReply) => void }> = [];
  mock.override('agentSession.setMode', () => {
    const d = deferred<ModeReply>();
    queue.push(d);
    return d.promise;
  });
  return {
    latest: () => {
      if (queue.length === 0) throw new Error('setMode 尚未发出（串行队列未推进）');
      return queue[queue.length - 1];
    }
  };
}

function SessionHarness(props: {
  sessionId: string;
  surfaceRef: { current: ChatSurface | null };
}): null {
  const surface = useAgentSessionSurface({ sessionId: props.sessionId, visible: true, runtimeId: 'pi' });
  props.surfaceRef.current = surface;
  return null;
}

function ViewHarness(props: { sessionId: string; surfaceRef: { current: ChatSurface | null } }): React.ReactNode {
  const surface = useAgentSessionSurface({ sessionId: props.sessionId, visible: true, runtimeId: 'pi' });
  props.surfaceRef.current = surface;
  return <ChatSurfaceView surface={surface} workspaceId={props.sessionId} />;
}

type Harness = (p: { sessionId: string; surfaceRef: { current: ChatSurface | null } }) => React.ReactNode;

function mountHarness(harness: Harness, id: string) {
  const surfaceRef: { current: ChatSurface | null } = { current: null };
  const utils = render(
    <StoreProvider>
      {React.createElement(harness, { sessionId: id, surfaceRef })}
    </StoreProvider>
  );
  return { surfaceRef, ...utils };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 读取 uiSlice 并在其上安装 flashTip spy（memoized slice 同一对象；deps 经 ref
 *  每次渲染刷新，后续 flashTip 调用都会命中 spy） */
function FlashProbe({ spyRef }: { spyRef: { current: ReturnType<typeof vi.fn> | null } }): null {
  const ui = useUiStore();
  React.useLayoutEffect(() => {
    spyRef.current = vi.fn();
    vi.spyOn(ui, 'flashTip').mockImplementation(spyRef.current);
  }, [ui]);
  return null;
}

async function chipLabel(): Promise<string> {
  const el = await waitFor(() => {
    const node = document.querySelector('.agent-mode-chip-label');
    if (!node?.textContent) throw new Error('mode chip 未渲染');
    return node;
  });
  return nodeLabel(el);
}

function nodeLabel(el: Element): string {
  const parent = el.closest('.agent-mode-chip');
  return (parent?.textContent ?? el.textContent ?? '').trim();
}

describe('GUI 会话 store：模式切换乱序回滚（U2）', () => {
  beforeEach(() => {
    overrideGuiHistory(currentApiMock(), async () => ({
      messages: [guiMsg({ id: 'm0' })],
      mode: 'auto',
      busy: false
    } satisfies GuiWorkerHistory));
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    if (typeof document.execCommand !== 'function') document.execCommand = () => false;
  });

  it('第一请求失败、第二请求成功：最终展示最新成功选择（旧失败不回滚新成功）', async () => {
    const q = mockSetModeQueue();
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-stale-fail');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('default');
      await tick();
      void surfaceRef.current!.actions.setMode?.('plan');
    });
    // 乐观：立即显示最新点击
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    // 请求1（default）失败——已被更新的点击取代，不得回滚
    await act(async () => {
      q.latest().resolve({ ok: false, error: 'first request failed' });
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    // 请求2（plan）成功
    await act(async () => {
      await tick();
      q.latest().resolve({ ok: true });
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    unmount();
  });

  it('两次失败：回滚到最后确认值（初始 auto），错误提示保留', async () => {
    const q = mockSetModeQueue();
    const spyRef: { current: ReturnType<typeof vi.fn> | null } = { current: null };
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const { unmount } = render(
      <StoreProvider>
        <FlashProbe spyRef={spyRef} />
        {React.createElement(SessionHarness, { sessionId: 'u2-double-fail', surfaceRef })}
      </StoreProvider>
    );
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('default');
      await tick();
      void surfaceRef.current!.actions.setMode?.('plan');
    });
    await act(async () => {
      q.latest().resolve({ ok: false, error: 'fail-1' });
      await tick();
    });
    // 第一次失败已被更新的点击取代：不回滚（仍显示 plan）
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    await act(async () => {
      await tick();
      q.latest().resolve({ ok: false, error: 'fail-2' });
      await tick();
    });
    // 最新请求失败 ⇒ 回滚到 confirmedMode（history 的 auto）。
    // 错误提示保留（deps.flashTip 调用链）在 test/chat-mode-setmode-tips.mjs 断言
    expect(surfaceRef.current!.getSnapshot().mode).toBe('auto');
    unmount();
  });

  it('A→B→A：重复值序列按版本身份处理，最终等于最新有效请求', async () => {
    const q = mockSetModeQueue();
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-aba');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('default'); // A→B
      await tick();
      void surfaceRef.current!.actions.setMode?.('auto'); // B→A
    });
    await act(async () => {
      q.latest().resolve({ ok: false, error: 'nope' }); // default 失败（被取代，不回滚）
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('auto');
    await act(async () => {
      await tick();
      q.latest().resolve({ ok: true }); // auto 成功
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('auto');
    unmount();
  });

  it('旧成功晚到链：default 成功后 plan 失败 ⇒ 回到 default（最新成功值，而非更早的 auto）', async () => {
    const q = mockSetModeQueue();
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-stale-success');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('default');
      await tick();
      void surfaceRef.current!.actions.setMode?.('plan');
    });
    await act(async () => {
      q.latest().resolve({ ok: true }); // default 成功
      await tick();
    });
    await act(async () => {
      await tick();
      q.latest().resolve({ ok: false, error: 'plan rejected' }); // plan 失败
      await tick();
    });
    // 回滚目标是最后一次成功确认的 default
    expect(surfaceRef.current!.getSnapshot().mode).toBe('default');
    unmount();
  });

  it('与 history 交叉：乐观切换在途时迟到的旧快照不改写 mode', async () => {
    const gate = deferred<GuiWorkerHistory>();
    const mock = currentApiMock();
    overrideGuiHistory(mock, () => gate.promise);
    const q = mockSetModeQueue();
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-history-cross');
    // 初始 history 挂起；用户先乐观切到 plan
    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('plan');
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    // 旧快照（mode=auto，拍摄于切换前）迟到
    await act(async () => {
      gate.resolve({ messages: [guiMsg({ id: 'm0' })], mode: 'auto', busy: false });
      await tick();
    });
    // modeClock 已被乐观切换推动 ⇒ 快照的 mode 不应用
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    // 请求成功收口
    await act(async () => {
      q.latest().resolve({ ok: true });
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    unmount();
  });

  it('切会话（dispose）后旧回调失效：不改状态、不提示', async () => {
    const q = mockSetModeQueue();
    const spyRef: { current: ReturnType<typeof vi.fn> | null } = { current: null };
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const { unmount } = render(
      <StoreProvider>
        <FlashProbe spyRef={spyRef} />
        {React.createElement(SessionHarness, { sessionId: 'u2-switch-away', surfaceRef })}
      </StoreProvider>
    );
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));
    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('plan');
    });
    unmount();
    await act(async () => {
      q.latest().resolve({ ok: false, error: 'late failure' });
      await tick();
    });
    // 已切换走：失败不提示（store 已 dispose，epoch 失配早退；
    // 同链路在 test/chat-mode-setmode-tips.mjs 有直接断言）
    expect(spyRef.current).not.toHaveBeenCalledWith('late failure');
  });

  it('队列生命周期绑定（r1-4）：dispose 后排队中的 setMode 不再发 IPC、不回写', async () => {
    const q = mockSetModeQueue();
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-queue-epoch');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));
    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('default'); // 在途
      await tick();
      void surfaceRef.current!.actions.setMode?.('plan'); // 排队
    });
    unmount(); // 换代
    await act(async () => {
      q.latest().resolve({ ok: true }); // 第一笔结算，队列推进——旧 plan 不得发出
      await tick();
      await tick();
    });
    // 只发过一次 IPC（plan 未发）；死 store 状态不被触碰（mode 维持 dispose 前乐观值）
    const calls = currentApiMock().mockOf('agentSession.setMode');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
  });

  it('setModel 队列同型（r1-4）：dispose 后排队中的 setModel 不再发 IPC', async () => {
    const mock = currentApiMock();
    const gates: Array<{ resolve: (v: { ok: boolean }) => void }> = [];
    mock.override('agentSession.setModel', () => {
      let resolve!: (v: { ok: boolean }) => void;
      const promise = new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      });
      gates.push({ resolve });
      return promise;
    });
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-model-queue-epoch');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));
    surfaceRef.current!.actions.setModel?.({ providerId: 'p', modelId: 'm1' }); // 在途
    await tick();
    surfaceRef.current!.actions.setModel?.({ providerId: 'p', modelId: 'm2' }); // 排队
    unmount();
    await act(async () => {
      gates[0].resolve({ ok: true });
      await tick();
      await tick();
    });
    expect(currentApiMock().mockOf('agentSession.setModel')).toHaveBeenCalledTimes(1);
  });

  it('成功确认推 modeClock（r2-③）：成功后旧快照后到不把 plan→auto、confirmedMode 不退回', async () => {
    const q = mockSetModeQueue();
    const mock = currentApiMock();
    const gate = deferred<GuiWorkerHistory>();
    const base = { messages: [guiMsg({ id: 'm0' })], mode: 'auto', busy: false };
    overrideGuiHistory(mock, () => gate.promise);
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-confirm-clock');
    // 初始 history（mode=auto）落定 confirmedMode 基准
    gate.resolve(base as GuiWorkerHistory);
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // 乐观切 plan（在途）；随后 resync（capture 于成功确认之前，mode 段含旧 auto）
    const resyncGate = deferred<GuiWorkerHistory>();
    overrideGuiHistory(mock, () => resyncGate.promise);
    await act(async () => {
      void surfaceRef.current!.actions.setMode?.('plan');
      await tick();
    });
    mock.emit('agentSession:event', {
      sessionId: 'u2-confirm-clock',
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    // 成功确认先到：confirmedMode=plan + modeClock 无条件推进（即使值未变）
    await act(async () => {
      q.latest().resolve({ ok: true });
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');

    // 旧快照后到（mode=auto，capture 于确认前）：mode 段因确认推时钟而作废
    await act(async () => {
      resyncGate.resolve({ ...base, mode: 'auto' } as GuiWorkerHistory);
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().mode).toBe('plan');
    unmount();
  });

  it('setModel 主变更即时应用（r2-④ 泛化迁移）：参数重拉窗口内旧 resync 不回退 override，旧 era 参数推送不污染新模型', async () => {
    const mock = currentApiMock();
    mock.override('config.get', async () => ({
      llm: {
        providers: [
          { id: 'p', enabled: true, models: [{ id: 'A', name: 'Model A' }, { id: 'B', name: 'Model B' }] }
        ],
        activeProviderId: 'p',
        activeModelId: 'A'
      }
    }));
    const gates: Array<{ resolve: (v: { ok: boolean }) => void }> = [];
    mock.override('agentSession.setModel', () => {
      let resolve!: (v: { ok: boolean }) => void;
      const promise = new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      });
      gates.push({ resolve });
      return promise;
    });
    // 参数面板重拉（泛化体系下 setModel 成功 → refreshModelInfo →
    // loadModelParameters）：初始装载即时返回（旧模型 era），setModel 后的重拉挂起
    // ——对应旧用例的 thinking 跟拉窗口（r2-④ 的 await 窗口语义迁移到参数域）。
    type ParamSnap = { controls: Array<{ id: string; value: string }>; providerId?: string; modelId?: string };
    const paramGates: Array<{ promise: Promise<ParamSnap>; resolve: (v: ParamSnap) => void }> = [];
    mock.override('agentSession.getModelParameters', () => {
      const gate = deferred<ParamSnap>();
      paramGates.push(gate);
      if (paramGates.length === 1) {
        gate.resolve({ controls: [], providerId: 'p', modelId: 'A' });
      }
      return gate.promise;
    });
    // 主 getHistory 即时返回（携带 legacy 思考字段——泛化下应被忽略）；resync 挂起
    const resyncGate = deferred<GuiWorkerHistory>();
    let call = 0;
    overrideGuiHistory(mock, () => {
      const idx = call++;
      if (idx === 0)
        return Promise.resolve({
          messages: [guiMsg({ id: 'm0' })],
          mode: 'auto',
          busy: false,
          modelOverride: { providerId: 'p', modelId: 'A' },
          thinkingLevel: 'medium',
          thinkingConfigured: true
        } as GuiWorkerHistory);
      return resyncGate.promise; // setModel 在途期间发出的旧 resync
    });
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-model-window');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // setModel(B) IPC 在途；期间 desync 触发旧 resync（capture 于模型变更落定之前）
    surfaceRef.current!.actions.setModel?.({ providerId: 'p', modelId: 'B' });
    await waitFor(() => expect(gates.length).toBe(1));
    mock.emit('agentSession:event', {
      sessionId: 'u2-model-window',
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() => expect(call).toBe(2)); // 初始(1)+旧 resync(2)；参数重拉尚未返回

    // setModel 响应 ok：主变更立即应用并推 modelClock（不等参数重拉）。
    // 重拉索引在 resolve 前记录：runSetModel 成功后同步 refreshModelInfo→
    // loadModelParameters，重拉是此后新增的第一个 gate
    const pullIndex = paramGates.length;
    await act(async () => {
      gates[0].resolve({ ok: true });
      await tick();
    });
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().status?.modelPinned).toBe(true));
    // 参数重拉已发出（重拉窗口；不假设绝对索引——cursor 目录装载等也会发参数请求）
    await waitFor(() => expect(paramGates.length).toBeGreaterThan(pullIndex));

    // 旧 resync 响应（旧模型 era 的完整字段：override A + legacy 思考字段）
    await act(async () => {
      resyncGate.resolve({
        messages: [guiMsg({ id: 'm0' })],
        mode: 'auto',
        busy: false,
        modelOverride: { providerId: 'p', modelId: 'A' },
        thinkingLevel: 'medium',
        thinkingConfigured: true
      } as GuiWorkerHistory);
      await tick();
    });
    // 不回退成 default/unpinned；legacy 思考字段被泛化体系忽略（thinking 恒 null）
    const status = surfaceRef.current!.getSnapshot().status;
    expect(status?.modelPinned).toBe(true);
    expect(status?.modelId).toBe('B');
    expect(status?.thinking).toBeNull();

    // 旧 era parameters 推送（身份 A）迟到到达：身份硬判丢弃，不污染新模型 B 的参数面板
    await act(async () => {
      mock.emit('agentSession:event', {
        sessionId: 'u2-model-window',
        kind: 'parameters',
        controls: [{ id: 'reasoning', value: 'old-era' }],
        providerId: 'p',
        modelId: 'A'
      });
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().status?.modelParameters).toEqual([]);

    // 参数重拉返回（新模型 B 的参数快照）：正常应用
    await act(async () => {
      paramGates[pullIndex].resolve({
        controls: [{ id: 'reasoning', value: 'b-value' }],
        providerId: 'p',
        modelId: 'B'
      });
      await tick();
      await tick();
    });
    const final = surfaceRef.current!.getSnapshot().status;
    expect(final?.modelId).toBe('B');
    expect(final?.modelParameters).toEqual([{ id: 'reasoning', value: 'b-value' }]);
    unmount();
  });

  it('参数推送身份缺失（旧版 host）或跟随默认模型：不判代，照常应用', async () => {
    const mock = currentApiMock();
    mock.override('config.get', async () => ({
      llm: {
        providers: [
          { id: 'p', enabled: true, models: [{ id: 'A', name: 'Model A' }] }
        ],
        activeProviderId: 'p',
        activeModelId: 'A'
      }
    }));
    const gate = deferred<GuiWorkerHistory>();
    overrideGuiHistory(mock, () => gate.promise);
    const { surfaceRef, unmount } = mountHarness(SessionHarness, 'u2-param-noidentity');
    gate.resolve({
      messages: [guiMsg({ id: 'm0' })],
      mode: 'auto',
      busy: false
    } satisfies GuiWorkerHistory);
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // 无身份字段（向后兼容旧 host 推送）且会话未显式固定模型：照常应用
    await act(async () => {
      mock.emit('agentSession:event', {
        sessionId: 'u2-param-noidentity',
        kind: 'parameters',
        controls: [{ id: 'reasoning', value: 'default-era' }]
      });
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().status?.modelParameters).toEqual([
      { id: 'reasoning', value: 'default-era' }
    ]);
    unmount();
  });

  it('真实 chip 交互：点菜单切档乐观显示最新点击，失败回落到确认值', async () => {
    const q = mockSetModeQueue();
    const user = userEvent.setup();
    // 现行「权限模式」菜单把档位单选项放在「配置权限」开关之后；开关持久化走该 IPC。
    currentApiMock().override('sessions.setConfigurePermissions', async () => ({ ok: true }));
    const { surfaceRef, unmount } = mountHarness(ViewHarness, 'u2-real-chip');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    const chip = await screen.findByRole('button', { name: '权限模式' });
    expect(await chipLabel()).toContain('完全访问');
    // 打开菜单后先开启「配置权限」开关，档位 menuitemradio 才会渲染，再点「计划」。
    await user.click(chip);
    await user.click(await screen.findByRole('switch', { name: '配置权限' }));
    const item = await screen.findByRole('menuitemradio', { name: /计划/ });
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    await user.click(item);
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().mode).toBe('plan'));
    // chip 标签乐观显示「计划」
    await waitFor(async () => {
      expect(await chipLabel()).toContain('计划');
    });

    // 请求失败 ⇒ chip 回落到确认值 auto（自动）
    await act(async () => {
      q.latest().resolve({ ok: false, error: 'rejected' });
      await tick();
    });
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().mode).toBe('auto'));
    await waitFor(async () => {
      expect(await chipLabel()).not.toContain('计划');
    });
    unmount();
  });
});
