import {overrideGuiHistory} from './helpers/gui-history-range';
/**
 * 聊天状态竞态回归（U1，2026-10-02 修复）：迟到 history/resync 不得覆盖已应用的新消息
 * 与 busy/mode 状态；初始历史不缺失；delta 不丢 token、不重复追加。
 *
 * 修复机制（agentSessionSurface.tsx）：
 * - 生命周期 epoch（dispose/重挂作废在途回调）+ clearSeq（clear 作废在途快照）
 *   + syncSeq（全量 sync 应用后快照整体作废）；
 * - 分类时钟（msg/busy/mode/meta）：部分被动过 ⇒ 合并应用（同 id 保本地、快照独有按
 *   ts 插回），全部未动 ⇒ 整表应用；
 * - history 单飞：并发 resync 串行化，desync 兜底不被静默吞掉。
 *
 * 还原修复即红：去掉 applyHistory 的 syncSeq/clearSeq/epoch 校验或 mergeGuiHistory，
 * 下列「不覆盖 / 不复活 / 不丢 token」断言转红。
 * 运行: npx vitest run test/unit/chat-state-race-u1.spec.tsx
 */
import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function guiMsg(m: Partial<GuiChatMessage> & { id: string }): GuiChatMessage {
  return {
    role: 'assistant',
    parts: [{ kind: 'text', text: '' }],
    ts: 1,
    ...m
  } as GuiChatMessage;
}

function hist(messages: GuiChatMessage[], extra: Partial<GuiWorkerHistory> = {}): GuiWorkerHistory {
  return { messages, mode: 'default', busy: false, ...extra };
}

function SessionHarness(props: {
  sessionId: string;
  surfaceRef: { current: ChatSurface | null };
  visible?: boolean;
}): null {
  const surface = useAgentSessionSurface({
    sessionId: props.sessionId,
    visible: props.visible ?? true,
    runtimeId: 'pi'
  });
  props.surfaceRef.current = surface;
  return null;
}

function mountHarness(id: string): { surfaceRef: { current: ChatSurface | null }; unmount: () => void } {
  const surfaceRef: { current: ChatSurface | null } = { current: null };
  const { unmount } = render(
    <StoreProvider>
      <SessionHarness sessionId={id} surfaceRef={surfaceRef} />
    </StoreProvider>
  );
  return { surfaceRef, unmount };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('GUI 会话 store：迟到 history 竞态（U1）', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('deferred history → 先应用 sync 新消息 → 旧历史返回：消息保新，mode/preset 等其余字段仍可靠装载（r1-1）', async () => {
    const mock = currentApiMock();
    const gate = deferred<GuiWorkerHistory>();
    overrideGuiHistory(mock, () => gate.promise);
    const { surfaceRef } = mountHarness('u1-sync-first');

    // 在途期间：实时 sync 推送新消息 + busy 翻真（均为更新的权威状态）
    mock.emit('agentSession:event', {
      sessionId: 'u1-sync-first',
      kind: 'sync',
      messages: [guiMsg({ id: 'new', parts: [{ kind: 'text', text: '新消息' }], ts: 20 })]
    });
    mock.emit('agentSession:event', { sessionId: 'u1-sync-first', kind: 'busy', busy: true });
    expect(surfaceRef.current!.getSnapshot().busy).toBe(true);

    // 旧历史迟到：不含 new；但 mode/piModeId 是快照独有信息（sync 合同不含它们）
    gate.resolve(
      hist([guiMsg({ id: 'old', ts: 10 })], { busy: false, mode: 'plan', piModeId: 'creator' })
    );
    await tick();

    const snap = surfaceRef.current!.getSnapshot();
    // sync 只覆盖消息：消息段保持本地（不回退、不复活），其余字段从快照装载
    expect(snap.messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['new']);
    expect(snap.busy).toBe(true); // busy 推送更新（busyClock 动过）⇒ 保本地
    expect(snap.mode).toBe('plan'); // modeClock 未动 ⇒ 快照值可靠装载
    expect(snap.preset?.id).toBe('creator'); // piModeId 同理（metaClock 未动）
  });

  it('初始历史不因丢弃而缺失：sync 先到时本地即持有完整权威列表', async () => {
    const mock = currentApiMock();
    const gate = deferred<GuiWorkerHistory>();
    overrideGuiHistory(mock, () => gate.promise);
    const { surfaceRef } = mountHarness('u1-initial-not-lost');
    const pushed = [
      guiMsg({ id: 'a', ts: 1, parts: [{ kind: 'text', text: '问' }] }),
      guiMsg({ id: 'b', ts: 2, parts: [{ kind: 'text', text: '答' }] })
    ];
    mock.emit('agentSession:event', { sessionId: 'u1-initial-not-lost', kind: 'sync', messages: pushed });
    gate.resolve(hist([guiMsg({ id: 'stale-only', ts: 0 })]));
    await tick();
    expect(surfaceRef.current!.getSnapshot().messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['a', 'b']);
  });

  it('合并路径：本地 delta 领先时旧快照返回——同 id 保本地增量、快照独有消息按 ts 插回、未动时钟取快照值', async () => {
    const mock = currentApiMock();
    const gate = deferred<GuiWorkerHistory>();
    const first = hist([guiMsg({ id: 'm1', ts: 20, parts: [{ kind: 'text', text: '本地' }] })]);
    let call = 0;
    overrideGuiHistory(mock, () => (call++ === 0 ? Promise.resolve(first) : gate.promise));
    const { surfaceRef } = mountHarness('u1-merge-part');
    const id = 'u1-merge-part';
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // desync（未知消息 part）触发 resync（第 2 次请求，挂起在 gate）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    // 本地继续吃 delta（此时钟推动 ⇒ 第 2 次请求走合并分支）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'delta',
      messageId: 'm1',
      partIndex: 0,
      deltaKind: 'text',
      delta: '+'
    });
    await new Promise((r) => setTimeout(r, 80));
    expect((surfaceRef.current!.getSnapshot().messages[0] as GuiChatMessage).parts[0]).toEqual({
      kind: 'text',
      text: '本地+'
    });

    // 旧快照：m1 只有「本地」（无 +），另带本地缺失的 m0（ts 更早）与 busy=true、mode=plan
    gate.resolve(
      hist(
        [
          guiMsg({ id: 'm0', ts: 10, parts: [{ kind: 'text', text: '补齐' }] }),
          guiMsg({ id: 'm1', ts: 20, parts: [{ kind: 'text', text: '本地' }] })
        ],
        { busy: true, mode: 'plan' }
      )
    );
    await tick();

    const snap = surfaceRef.current!.getSnapshot();
    // 快照独有 m0 插在 m1 之前（ts 更小）；m1 保留本地增量版本（不丢 token、不重复追加）
    expect(snap.messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['m0', 'm1']);
    expect((snap.messages[1] as GuiChatMessage).parts[0]).toEqual({ kind: 'text', text: '本地+' });
    // busy/mode 时钟未被推动 ⇒ 取快照值
    expect(snap.busy).toBe(true);
    expect(snap.mode).toBe('plan');
  });

  it('两次 resync 乱序（单飞串行）：desync 兜底不被吞掉，收敛到最新权威列表', async () => {
    const mock = currentApiMock();
    // 依次返回：初始 → 兜底1 → 兜底2
    const responses: GuiWorkerHistory[] = [
      hist([guiMsg({ id: 'a', ts: 1, parts: [{ kind: 'text', text: 'A' }] })]),
      hist([
        guiMsg({ id: 'a', ts: 1, parts: [{ kind: 'text', text: 'A' }] }),
        guiMsg({ id: 'b', ts: 2, parts: [{ kind: 'text', text: 'B' }] })
      ]),
      hist([
        guiMsg({ id: 'a', ts: 1, parts: [{ kind: 'text', text: 'A' }] }),
        guiMsg({ id: 'b', ts: 2, parts: [{ kind: 'text', text: 'B' }] }),
        guiMsg({ id: 'c', ts: 3, parts: [{ kind: 'text', text: 'C' }] })
      ])
    ];
    let call = 0;
    overrideGuiHistory(mock, () => Promise.resolve(responses[call++]));
    const { surfaceRef } = mountHarness('u1-resync-chain');
    const id = 'u1-resync-chain';
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // desync：未知消息的 part 落定 → 触发 resync（单飞第 2 次请求）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(2));
    // 再来一次 desync（第 3 次请求，串行排队后发出）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost2',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() =>
      expect(surfaceRef.current!.getSnapshot().messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['a', 'b', 'c'])
    );
    // 无重复追加
    expect(surfaceRef.current!.getSnapshot().messages.length).toBe(3);
  });

  it('clear 之后在途 resync 快照：不回写清前内容（clearSeq 单独把关，还原即红，r1-7）', async () => {
    const mock = currentApiMock();
    // 初始历史立即返回；resync 请求（第 2 次）挂起
    const first = hist([guiMsg({ id: 'gone', ts: 1, parts: [{ kind: 'text', text: '本地现行内容' }] })]);
    const gate = deferred<GuiWorkerHistory>();
    let call = 0;
    overrideGuiHistory(mock, () =>
      call++ === 0 ? Promise.resolve(first) : gate.promise
    );
    mock.override('agentSession.clear', async () => ({ ok: true }));
    const { surfaceRef } = mountHarness('u1-clear');
    const id = 'u1-clear';
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // desync 触发 resync（第 2 次请求，capture 于 clear 之前；不发 sync 推送——
    // clearSeq 是唯一防线，去掉该校验时本用例必须转红）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() => expect(call).toBe(2));
    const clearDone = surfaceRef.current!.actions.clear();
    await clearDone;
    // 迟到快照（clear 前拍摄，同 id 不同内容）返回：clearSeq 失配 ⇒ 整体作废，不回写
    gate.resolve(
      hist([guiMsg({ id: 'gone', ts: 1, parts: [{ kind: 'text', text: 'CLEAR 前的旧内容' }] })])
    );
    await tick();
    const msgs = surfaceRef.current!.getSnapshot().messages as GuiChatMessage[];
    expect(msgs.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['本地现行内容']);
    // 主进程清空后的权威 sync 推送落地 ⇒ 彻底清空（本地现行内容也被整表替换掉）
    mock.emit('agentSession:event', { sessionId: id, kind: 'sync', messages: [] });
    await tick();
    expect(surfaceRef.current!.getSnapshot().messages).toEqual([]);
  });

  it('切会话/StrictMode 重挂：dispose 后旧回调作废，重挂只吃新请求', async () => {
    const mock = currentApiMock();
    const gates: Array<{ promise: Promise<GuiWorkerHistory>; resolve: (v: GuiWorkerHistory) => void }> = [];
    overrideGuiHistory(mock, () => {
      const g = deferred<GuiWorkerHistory>();
      gates.push(g);
      return g.promise;
    });
    const { surfaceRef, unmount } = mountHarness('u1-remount');

    // 第一生命周期请求挂起；卸载（切会话/StrictMode 清理）
    unmount();
    // 旧响应迟到——不得写入（epoch 已换代）
    gates[0].resolve(hist([guiMsg({ id: 'stale', ts: 1 })]));
    await tick();
    expect(surfaceRef.current!.getSnapshot().messages).toEqual([]);

    // 重挂（visible 重新为 true → 新生命周期 + 新请求）
    const remount = mountHarness('u1-remount');
    await waitFor(() => expect(gates.length).toBe(2));
    gates[1].resolve(hist([guiMsg({ id: 'fresh', ts: 2 })]));
    await waitFor(() =>
      expect(remount.surfaceRef.current!.getSnapshot().messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['fresh'])
    );
    remount.unmount();
  });

  it('旧请求悬挂时重挂：新生命周期立即发新请求，不被旧单飞卡住（r1-2）', async () => {
    const mock = currentApiMock();
    const gates: Array<{ promise: Promise<GuiWorkerHistory>; resolve: (v: GuiWorkerHistory) => void }> = [];
    overrideGuiHistory(mock, () => {
      const g = deferred<GuiWorkerHistory>();
      gates.push(g);
      return g.promise;
    });
    // 同一组件实例上的 visible 真→假→真：同一个 store 的 dispose/attach 换代路径
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const utils = render(
      <StoreProvider>
        <SessionHarness sessionId="u1-remount-pending" surfaceRef={surfaceRef} visible={true} />
      </StoreProvider>
    );
    await waitFor(() => expect(gates.length).toBe(1));

    // visible=false（卸载效应）但【不】放行旧请求（模拟 IPC 悬挂）；
    // visible 重新为 true 必须立即发出新生命周期的请求，不等旧请求结算
    await act(async () => {
      utils.rerender(
        <StoreProvider>
          <SessionHarness sessionId="u1-remount-pending" surfaceRef={surfaceRef} visible={false} />
        </StoreProvider>
      );
      await tick();
    });
    await act(async () => {
      utils.rerender(
        <StoreProvider>
          <SessionHarness sessionId="u1-remount-pending" surfaceRef={surfaceRef} visible={true} />
        </StoreProvider>
      );
    });
    await waitFor(() => expect(gates.length).toBe(2)); // 新请求已发出，不等旧请求结算
    gates[1].resolve(hist([guiMsg({ id: 'fresh', ts: 2 })]));
    await waitFor(() =>
      expect(surfaceRef.current!.getSnapshot().messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['fresh'])
    );
    // 旧请求此刻才返回：作废，不影响新生命周期的状态
    gates[0].resolve(hist([guiMsg({ id: 'stale', ts: 1 })]));
    await tick();
    expect(surfaceRef.current!.getSnapshot().messages.map((m: unknown) => (m as { id: string }).id)).toEqual(['fresh']);
    utils.unmount();
  });

  it('逐消息时钟（r1-3）：本地未被推送更新过的消息取快照权威版，流式中消息保本地增量', async () => {
    const mock = currentApiMock();
    // 初始：A（本地将吃 delta）+ B（本地落后，快照有 v2）
    const first = hist([
      guiMsg({ id: 'A', ts: 1, parts: [{ kind: 'text', text: '前缀' }] }),
      guiMsg({ id: 'B', ts: 2, parts: [{ kind: 'text', text: '旧版' }] })
    ]);
    const gate = deferred<GuiWorkerHistory>();
    let call = 0;
    overrideGuiHistory(mock, () =>
      call++ === 0 ? Promise.resolve(first) : gate.promise
    );
    const { surfaceRef } = mountHarness('u1-permsg');
    const id = 'u1-permsg';
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(2));

    // 先 desync 触发 resync（第 2 次请求发出），再让 A 吃 delta（在途交错：
    // 快照在主进程序列化后、主进程继续流式生成 delta——本地领先是真实形态）；B 不动（本地落后）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() => expect(call).toBe(2));
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'delta',
      messageId: 'A',
      partIndex: 0,
      deltaKind: 'text',
      delta: '+增量'
    });
    await new Promise((r) => setTimeout(r, 80));

    // resync 快照：A 仍是前缀（快照旧于本地增量）、B 已是 v2（快照新于本地）、C 为快照独有
    gate.resolve(
      hist([
        guiMsg({ id: 'A', ts: 1, parts: [{ kind: 'text', text: '前缀' }] }),
        guiMsg({ id: 'B', ts: 2, parts: [{ kind: 'text', text: '权威新版' }] }),
        guiMsg({ id: 'C', ts: 3, parts: [{ kind: 'text', text: '补齐' }] })
      ])
    );
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(3));
    const msgs = surfaceRef.current!.getSnapshot().messages as GuiChatMessage[];
    const textOf = (m: GuiChatMessage): string => (m.parts[0] as { text: string }).text;
    expect(msgs.map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect(textOf(msgs[0])).toBe('前缀+增量'); // touched 领先 ⇒ 保本地增量（不丢 token）
    expect(textOf(msgs[1])).toBe('权威新版'); // 未被推送更新过 ⇒ 取快照权威版（resync 补齐落地）
    expect(textOf(msgs[2])).toBe('补齐'); // 快照独有按 ts 插回
  });

  it('history 落 modelOverride 后重算 modelInfo（r1-5：config 先回默认、history 后回 override）', async () => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => ({
      messages: [guiMsg({ id: 'm0' })],
      mode: 'auto',
      busy: false,
      modelOverride: { providerId: 'prov-a', modelId: 'model-b' }
    } satisfies GuiWorkerHistory));
    const cfg = {
      llm: {
        providers: [
          {
            id: 'prov-a',
            enabled: true,
            models: [
              { id: 'model-a', name: 'Model A' },
              { id: 'model-b', name: 'Model B' }
            ]
          }
        ],
        activeProviderId: 'prov-a',
        activeModelId: 'model-a'
      }
    };
    // history 挂闸：config 先回（无 override 视角算出默认模型），history 后回 override
    mock.override('config.get', async () => cfg);
    const gate = deferred<GuiWorkerHistory>();
    overrideGuiHistory(mock, () => gate.promise);
    const { surfaceRef, unmount } = mountHarness('u1-override');
    // 等 attach 的首次 config 计算落地（此时 sessionModel=null ⇒ modelInfo=默认 model-a）
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().status?.modelId).toBe('model-a'));
    // history 迟到携带 override：修复后 override 变化触发 modelInfo 重算
    gate.resolve({
      messages: [guiMsg({ id: 'm0' })],
      mode: 'auto',
      busy: false,
      modelOverride: { providerId: 'prov-a', modelId: 'model-b' }
    } satisfies GuiWorkerHistory);
    await waitFor(() => {
      const status = surfaceRef.current!.getSnapshot().status;
      expect(status?.modelPinned).toBe(true);
      expect(status?.modelId).toBe('model-b');
      expect(status?.modelLabel).toBe('Model B');
    });
    unmount();
  });

  it('元数据细分装载（r2-①）：context 推送先到不殄及 preset/model 装载；legacy 思考字段由泛化参数体系取代', async () => {
    const mock = currentApiMock();
    const gate = deferred<GuiWorkerHistory>();
    overrideGuiHistory(mock, () => gate.promise);
    const { surfaceRef } = mountHarness('u1-meta-split');
    const id = 'u1-meta-split';

    // 在途期间：Host 开连接后立即推 context 用量（生产时序）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'context',
      usage: { tokens: 111, contextWindow: 999 }
    });
    // 初次 history 迟到：preset/模型覆盖由它携带；thinkingLevel/thinkingConfigured
    // 为 legacy 透传字段——泛化参数体系下渲染层不再消费（思考档改由
    // 参数面板 modelParameters 承载），断言其被忽略而非装载
    gate.resolve({
      messages: [guiMsg({ id: 'm0' })],
      mode: 'auto',
      busy: false,
      piModeId: 'creator',
      modelOverride: { providerId: 'prov-a', modelId: 'model-b' },
      thinkingLevel: 'high',
      thinkingConfigured: true,
      usage: { tokens: 1, contextWindow: 2 }
    } satisfies GuiWorkerHistory);
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().preset?.id).toBe('creator'));
    const snap = surfaceRef.current!.getSnapshot();
    // 各细分域独立装载：preset/model 不因 context 推送被跳过
    expect(snap.status?.modelPinned).toBe(true);
    expect(snap.status?.modelId).toBe('model-b');
    // 泛化迁移：legacy 思考字段不进快照（思考域已由参数面板取代）；
    // 参数通道（独立 getModelParameters/推送）也不受 history 迟到影响
    expect(snap.status?.thinking).toBeNull();
    expect(snap.status?.modelParameters).toEqual([]);
    // usage 域被更新的推送占据（usageClock 动过 ⇒ 保本地）
    expect(snap.status?.usage?.tokens).toBe(111);
  });

  it('compaction/engine-meta 推送推时钟（r2-②）：迟到 history 不删新标记/不回退新值', async () => {
    const mock = currentApiMock();
    const first = hist([guiMsg({ id: 'm0' })]);
    const gate = deferred<GuiWorkerHistory>();
    let call = 0;
    overrideGuiHistory(mock, () =>
      call++ === 0 ? Promise.resolve(first) : gate.promise
    );
    const { surfaceRef } = mountHarness('u1-compact-engine');
    const id = 'u1-compact-engine';
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // desync 触发 resync（第 2 次请求在途）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() => expect(call).toBe(2));
    // 推送新状态：running 压缩标记 + 新 slashCommands/engineMode
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'compaction',
      markerId: 'mk-running',
      status: 'running',
      at: Date.now()
    });
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'engine-meta',
      slashCommands: [{ name: 'new-cmd' }],
      engineMode: { modeId: 'plan-x', name: 'Plan X' }
    });
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().compactions?.length).toBe(1));

    // 迟到旧快照：compactions 空 + 旧 commands/engineMode
    gate.resolve({
      ...first,
      compactions: [],
      slashCommands: [{ name: 'old-cmd' }],
      engineMode: { modeId: 'old-mode' }
    } satisfies GuiWorkerHistory);
    await tick();
    const snap = surfaceRef.current!.getSnapshot();
    // 本地新标记/新值保留，不被旧快照回退
    expect(snap.compactions?.length).toBe(1);
    expect(snap.compactions?.[0]).toMatchObject({ id: 'mk-running', status: 'running' });
    expect(snap.engineSlashCommands?.map((c: { name: string }) => c.name)).toEqual(['new-cmd']);
    expect(snap.engineModeLabel).toBe('Plan X');
  });

  it('本地领先消息的缺失尾 parts 仍从快照补齐（r2-⑤：预期 parts=3）', async () => {
    const mock = currentApiMock();
    const first = hist([guiMsg({ id: 'm1', ts: 1, parts: [{ kind: 'text', text: '前缀' }] })]);
    const gate = deferred<GuiWorkerHistory>();
    let call = 0;
    overrideGuiHistory(mock, () =>
      call++ === 0 ? Promise.resolve(first) : gate.promise
    );
    const { surfaceRef } = mountHarness('u1-parts-backfill');
    const id = 'u1-parts-backfill';
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().messages.length).toBe(1));

    // resync 在途 → m1 吃 delta（touched 领先）
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    await waitFor(() => expect(call).toBe(2));
    mock.emit('agentSession:event', {
      sessionId: id,
      kind: 'delta',
      messageId: 'm1',
      partIndex: 0,
      deltaKind: 'text',
      delta: '+增量'
    });
    await new Promise((r) => setTimeout(r, 80));

    // 快照：m1 有 3 个 parts（本地只见过第 0 个；后两个是 desync 期间落定的）
    gate.resolve(
      hist([
        {
          ...guiMsg({ id: 'm1', ts: 1 }),
          parts: [
            { kind: 'text', text: '前缀' },
            { kind: 'tool', tool: { id: 't1', name: 'x', input: {}, output: '{}', status: 'ok' } },
            { kind: 'text', text: '收尾' }
          ]
        }
      ])
    );
    await tick();
    const m = surfaceRef.current!.getSnapshot().messages[0] as GuiChatMessage;
    // 第 0 part 保本地增量；缺失的尾 parts（tool/收尾）补齐，不重复不丢失
    expect(m.parts.length).toBe(3);
    expect((m.parts[0] as { text: string }).text).toBe('前缀+增量');
    expect(m.parts[1]?.kind).toBe('tool');
    expect((m.parts[2] as { text: string }).text).toBe('收尾');
  });

  it('同 id 快照不剥离 params（r2-⑥）：effort 等参数选择经 resync 保留', async () => {
    const mock = currentApiMock();
    const withOverride = (params?: Array<{ id: string; value: string }>): GuiWorkerHistory =>
      ({
        messages: [guiMsg({ id: 'm0' })],
        mode: 'auto',
        busy: false,
        modelOverride: { providerId: 'prov-a', modelId: 'model-b', ...(params ? { params } : {}) }
      }) as GuiWorkerHistory; // 合同类型不带 params（运行时透传，见 r2-⑥ 注释）
    overrideGuiHistory(mock, async () => withOverride());
    const gates: Array<{ resolve: (v: { ok: boolean }) => void }> = [];
    mock.override('agentSession.setModel', () => {
      let resolve!: (v: { ok: boolean }) => void;
      const promise = new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      });
      gates.push({ resolve });
      return promise;
    });
    const { surfaceRef } = mountHarness('u1-params-keep');
    await waitFor(() => expect(surfaceRef.current!.getSnapshot().status?.modelPinned).toBe(true));

    // 用户设置同模型 + effort=high
    surfaceRef.current!.actions.setModel?.({
      providerId: 'prov-a',
      modelId: 'model-b',
      params: [{ id: 'effort', value: 'high' }]
    });
    await waitFor(() => expect(gates.length).toBe(1));
    await act(async () => {
      gates[0].resolve({ ok: true });
      await tick();
      await tick();
    });
    expect(surfaceRef.current!.getSnapshot().status?.modelParams).toEqual([
      { id: 'effort', value: 'high' }
    ]);

    // resync 一（字段缺失形态）：同 id 快照不带 params——不得剥离本地选择（防御性兼容）
    const gate = deferred<GuiWorkerHistory>();
    const gate2 = deferred<GuiWorkerHistory>();
    let resyncCall = 0;
    overrideGuiHistory(mock, () => (resyncCall++ === 0 ? gate.promise : gate2.promise));
    mock.emit('agentSession:event', {
      sessionId: 'u1-params-keep',
      kind: 'part',
      messageId: 'ghost',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    gate.resolve(withOverride());
    await tick();
    let status = surfaceRef.current!.getSnapshot().status;
    expect(status?.modelPinned).toBe(true);
    expect(status?.modelParams).toEqual([{ id: 'effort', value: 'high' }]);

    // resync 二（生产形态，r3-②）：同 id 快照携带权威新 params（effort=low 覆盖 high）
    mock.emit('agentSession:event', {
      sessionId: 'u1-params-keep',
      kind: 'part',
      messageId: 'ghost2',
      partIndex: 0,
      part: { kind: 'text', text: '?' }
    });
    gate2.resolve(withOverride([{ id: 'effort', value: 'low' }]));
    await tick();
    status = surfaceRef.current!.getSnapshot().status;
    expect(status?.modelParams).toEqual([{ id: 'effort', value: 'low' }]);
  });
});

it.each([true, false])('历史请求成功=%s 后停止加载，与模型 busy 独立', async ok => {
 let finish!: (v: GuiWorkerHistory) => void; let fail!: (e: Error) => void;
 overrideGuiHistory(currentApiMock(), () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
 const { surfaceRef } = mountHarness(`history-loading-${ok}`);
 expect(surfaceRef.current!.getSnapshot().historyLoading).toBe(true);
 await act(async () => ok ? finish(hist([], { busy: true })) : fail(new Error('history offline')));
 await waitFor(() => expect(surfaceRef.current!.getSnapshot().historyLoading).toBe(false));
 if (ok) expect(surfaceRef.current!.getSnapshot().busy).toBe(true);
 else expect(surfaceRef.current!.getSnapshot().historyError).toContain('history offline');
});
