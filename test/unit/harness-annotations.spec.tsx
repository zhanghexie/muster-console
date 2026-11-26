/**
 * Harness 透明模式组件测试（pi-trajectory-plan v3 §8 B2' 验收 + 用户返修轮）：
 * - 默认关 = 现状零变化：无 harness-on 容器类、无任何标注、宿主静默插话不可见；
 * - 开启：插话线（send/host 都渲染为线）、注入卡（代际首次生效/变动回合才出）、
 *   计量 chips + 详情抽屉（assistant 回合后）；
 * - 注入卡新策略：会话首回合必出卡；同代后续回合不重复；代际变化出变动卡
 *   （逐段 新增/更新/移除 + 引擎系统提示词/工具目录）；工具目录/引擎提示词段可展开；
 * - 纯函数：resolveInjectionCards 代际卡片解析 / formatTokens / formatDurationMs。
 * 运行: npx vitest run test/unit/harness-annotations.spec.tsx
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage, GuiInjectionSnapshot } from '../../src/shared/guiWorker';
import {
  formatDurationMs,
  formatTokens,
  resolveInjectionCards
} from '../../src/renderer/src/chatSurface/harnessAnnotations';

const INJECTIONS: readonly GuiInjectionSnapshot[] = [
  {
    at: 1000,
    segments: [{ source: '政策层（材料化）', chars: 8, hash: 'aaaa1111', text: '注入基底内容' }]
  },
  {
    at: 5000,
    segments: [{ source: '政策层（材料化）', chars: 10, hash: 'bbbb2222', text: '换代后的基底' }],
    enginePrompt: { chars: 42, hash: 'eeee4444', text: '引擎系统提示词全文' },
    tools: [
      { name: 'read', source: 'native', description: '读文件', params: ['path: string*'] },
      { name: 'bgtasks.shell', source: 'host', description: '后台跑命令' }
    ]
  }
];

function msg(partial: Partial<GuiChatMessage> & { id: string; role: 'user' | 'assistant' }): GuiChatMessage {
  return {
    parts: [{ kind: 'text', text: `${partial.id} 的正文` }],
    ts: 6000,
    ...partial
  } as GuiChatMessage;
}

const MESSAGES: readonly GuiChatMessage[] = [
  msg({ id: 'u1', role: 'user', ts: 1500, engineInputRef: 'submitted-u1' }),
  msg({
    id: 'a1',
    role: 'assistant',
    ts: 2000,
    harness: {
      usage: { inputTokens: 46211, outputTokens: 1204, reasoningTokens: 3100 },
      model: 'glm-5',
      durationMs: 28700,
      calls: [
        {
          usage: { inputTokens: 46211, outputTokens: 1204, reasoningTokens: 3100 },
          ttftMs: 1800,
          durationMs: 9400,
          model: 'glm-5'
        },
        {
          usage: { inputTokens: 52884, outputTokens: 962 },
          ttftMs: 2100,
          durationMs: 8100,
          retry: 1,
          model: 'glm-5'
        }
      ]
    }
  }),
  msg({ id: 'u2', role: 'user', ts: 6200, steering: 'send', parts: [{ kind: 'text', text: '别改 MountCamera，先看约束' }] }),
  msg({ id: 'u3', role: 'user', ts: 6300, steering: 'host', parts: [{ kind: 'text', text: '【后台任务】定时器到点' }] }),
  msg({ id: 'a2', role: 'assistant', ts: 6400, parts: [{ kind: 'text', text: '按新指令的回复' }] }),
  // 第 2 代注入窗口里的普通用户回合（u2 是插话，不生成注入卡；u4 命中换代 → 变动卡）
  msg({ id: 'u4', role: 'user', ts: 7000 })
];

const SENT_TEXT = '<muster-host>\n  Keep the whitespace.\n</muster-host>\n\nu1 的正文';

function makeSurface() {
  let harnessOn = false;
  const engineInput = vi.fn(async () => SENT_TEXT);
  let harnessSnap = { on: false, injections: INJECTIONS, engineInput };
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const l of listeners) l();
  };
  // 快照引用稳定（useSyncExternalStore 契约）：开/关各一份缓存对象
  const snapOff = {
    messages: MESSAGES.filter((m) => m.steering !== 'host'),
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null,
    preset: null
  };
  const snapOn = {
    ...snapOff,
    messages: MESSAGES
  };
  const surface: ChatSurface = {
    sessionId: 'harness-1',
    caps: {
      surfaceKind: 'gui-session',
      draftKey: 'agent-session:harness-1',
      images: false,
      manualCompact: false
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => (harnessOn ? snapOn : snapOff),
    actions: {
      send: async () => true,
      stop: () => undefined,
      clear: async () => undefined,
      retry: () => undefined,
      cancelQueued: () => undefined,
      setHarnessOn: (on: boolean) => {
        harnessOn = on;
        harnessSnap = { on, injections: INJECTIONS, engineInput };
        notify();
      }
    },
    harness: {
      subscribe: (l) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      get: () => harnessSnap
    }
  };
  return { surface, engineInput, isOn: () => harnessOn };
}

const surfaceFixture = makeSurface();

vi.mock('../../src/renderer/src/chatSurface/agentSessionSurface', () => ({
  useAgentSessionSurface: () => surfaceFixture.surface
}));

vi.mock('../../src/renderer/src/chatSurface/useSessionNotes', () => ({
  useSessionNotes: () => undefined
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

import { AgentChatView, type AgentPaneControl } from '../../src/renderer/src/agentChat/AgentChatView';

// 用例间复位开关态（surface 是模块级共享实例）
beforeEach(() => {
  surfaceFixture.surface.actions.setHarnessOn?.(false);
  surfaceFixture.engineInput.mockClear();
});

async function renderWithStore(view: React.ReactNode): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => { result = render(<StoreProvider>{view}</StoreProvider>); });
  return result;
}
function renderView(): Promise<ReturnType<typeof render>> {
  return renderWithStore(<AgentChatView sessionId="harness-1" visible runtimeId="pi" runtimeLabel="Pi" />);
}
describe('Harness 透明模式', () => {
  it('中央compactHeader隐藏顶栏、注册实际Pi控制且切换后刷新状态，卸载释放控制', async () => {
    const onPaneControl = vi.fn<(id: string, control: AgentPaneControl | null) => void>();
    const view = await renderWithStore(<AgentChatView sessionId="harness-1" visible runtimeId="pi"
      runtimeLabel="Pi" compactHeader onPaneControl={onPaneControl} />);
    expect(view.container.querySelector('.agent-chat-topbar')).toBeNull();
    expect(screen.queryByRole('button', { name: '开启' })).toBeNull();
    expect(onPaneControl).toHaveBeenLastCalledWith('harness-1', expect.objectContaining({ on: false, toggle: expect.any(Function) }));
    act(() => onPaneControl.mock.calls.at(-1)![1]!.toggle());
    expect(surfaceFixture.isOn()).toBe(true);
    expect(view.container.querySelector('.agent-chat-view')!.classList.contains('harness-on')).toBe(true);
    expect(onPaneControl).toHaveBeenLastCalledWith('harness-1', expect.objectContaining({ on: true }));
    act(() => onPaneControl.mock.calls.at(-1)![1]!.toggle());
    expect(surfaceFixture.isOn()).toBe(false);
    expect(onPaneControl).toHaveBeenLastCalledWith('harness-1', expect.objectContaining({ on: false }));
    view.unmount(); expect(onPaneControl).toHaveBeenLastCalledWith('harness-1', null);
  });

  it('Qwen 通过中栏菜单打开原文时省略同一行的注入卡，关掉时恢复用户气泡', async () => {
    const onPaneControl = vi.fn<(id: string, control: AgentPaneControl | null) => void>();
    const view = await renderWithStore(<AgentChatView sessionId="harness-1" visible runtimeId="acp"
      runtimeLabel="Qwen" compactHeader onPaneControl={onPaneControl} />);
    expect(view.container.querySelector('.agent-chat-topbar')).toBeNull();
    expect(screen.getByText('u1 的正文')).toBeTruthy();
    expect(surfaceFixture.engineInput).not.toHaveBeenCalled();
    expect(onPaneControl).toHaveBeenLastCalledWith('harness-1', expect.objectContaining({ on: false }));
    act(() => onPaneControl.mock.calls.at(-1)![1]!.toggle());
    const raw = await screen.findByLabelText('发送给 Harness 的完整文本');
    expect(raw.textContent).toBe(SENT_TEXT);
    expect(raw.querySelector('muster-host')).toBeNull();
    expect(raw.closest('[data-mid="u1"]')?.querySelector('.harness-inject')).toBeNull();
    expect(surfaceFixture.engineInput).toHaveBeenCalledExactlyOnceWith('u1', 'submitted-u1');
    expect(screen.getByText('u4 的正文')).toBeTruthy();
    expect(view.container.querySelector('[data-mid="u4"] .harness-inject')).not.toBeNull();
    act(() => onPaneControl.mock.calls.at(-1)![1]!.toggle());
    expect(screen.queryByLabelText('发送给 Harness 的完整文本')).toBeNull();
    expect(screen.getByText('u1 的正文')).toBeTruthy();
  });

  it('默认关 = 现状零变化：无容器类/标注，宿主静默插话不可见', async () => {
    const { container } = await renderView();
    expect(container.querySelector('.agent-chat-view')!.classList.contains('harness-on')).toBe(false);
    expect(container.querySelector('.harness-steer')).toBeNull();
    expect(container.querySelector('.harness-inject')).toBeNull();
    expect(container.querySelector('.harness-drawer')).toBeNull();
    expect(container.querySelector('.harness-chip')).toBeNull();
    // 宿主静默插话（steering:'host'）关闭态被滤掉——现状里它完全不可见
    expect(screen.queryByText('【后台任务】定时器到点')).toBeNull();
    // 用户插话（steering:'send'）关闭态渲染为普通用户气泡（与现状一致）
    expect(screen.getByText('别改 MountCamera，先看约束')).toBeTruthy();
    // assistant 正文照常渲染
    expect(screen.getByText('按新指令的回复')).toBeTruthy();
  });

  it('开关切换：容器挂 harness-on（分段胶囊选中态跟随），三类标注出现', async () => {
    const { container } = await renderView();
    const onBtn = screen.getByRole('button', { name: '开启' });
    const offBtn = screen.getByRole('button', { name: '关闭' });
    expect(onBtn.classList.contains('is-active-enabled')).toBe(false);
    expect(offBtn.classList.contains('is-active-disabled')).toBe(true);
    fireEvent.click(onBtn);
    expect(container.querySelector('.agent-chat-view')!.classList.contains('harness-on')).toBe(true);
    expect(onBtn.classList.contains('is-active-enabled')).toBe(true);
    expect(offBtn.classList.contains('is-active-disabled')).toBe(false);

    // 插话线：send 与 host 都渲染为线（不再是用户气泡）
    const steers = container.querySelectorAll('.harness-steer');
    expect(steers.length).toBe(2);
    expect(container.querySelector('.harness-steer .h-steer-text')!.textContent).toBe(
      '别改 MountCamera，先看约束'
    );

    // u1 有发送原文，u4 的换代快照仍在原位置展示。
    expect(container.querySelectorAll('.harness-inject')).toHaveLength(1);
    const changeCard = container.querySelector('[data-mid="u4"] .harness-inject')!;
    expect(changeCard.textContent).toContain('注入变动');
    expect(changeCard.textContent).toContain('更新');
    fireEvent.click(changeCard.querySelector('summary')!);
    expect(changeCard.querySelector('pre')!.textContent).toBe('换代后的基底');
    // 换代卡带引擎真身：系统提示词段 + 工具目录
    expect(changeCard.textContent).toContain('引擎系统提示词全文');
    expect(changeCard.textContent).toContain('read');
    expect(changeCard.textContent).toContain('bgtasks.shell');

    // 计量 chips（挂在带 harness 的 assistant hoverbar）
    const chips = container.querySelectorAll('.harness-chip');
    expect(chips.length).toBeGreaterThanOrEqual(4);
    expect(chips[0]!.textContent).toContain('46.2k');

    // 详情抽屉：仅带 harness 的 assistant（a1）有
    const drawers = container.querySelectorAll('.harness-drawer');
    expect(drawers.length).toBe(1);
    // 再点「关闭」：标注全部消失
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(container.querySelector('.harness-steer')).toBeNull();
    expect(container.querySelector('.harness-inject')).toBeNull();
    expect(container.querySelector('.harness-drawer')).toBeNull();
  });

  it('注入卡与抽屉的展开交互（AnimatedDetails 接管开合；变动卡展开可见工具参数）', async () => {
    const { container } = await renderView();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开启' })); });
    const changeCard = container.querySelector<HTMLDetailsElement>('[data-mid="u4"] .harness-inject details')!;
    expect(changeCard.open).toBe(false);
    fireEvent.click(changeCard.querySelector('summary')!);
    expect(changeCard.open).toBe(true);
    const tool = changeCard.querySelector('.h-tool') as HTMLDetailsElement;
    expect(tool).toBeTruthy();
    expect(tool.open).toBe(false);
    fireEvent.click(tool.querySelector('summary')!);
    expect(tool.open).toBe(true);
    expect(tool.textContent).toContain('path: string*');

    const drawer = container.querySelector('.harness-drawer details') as HTMLDetailsElement;
    expect(drawer.open).toBe(false);
    fireEvent.click(drawer.querySelector('summary')!);
    expect(drawer.open).toBe(true);
    // 表格行：两次模型调用逐行列出（含 retry=1 的行）
    const rows = drawer.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[1]!.textContent).toContain('glm-5');
    expect(drawer.querySelector('.h-note')!.textContent).toContain('46.2k');
  });
});

describe('harness 纯函数', () => {
  it('resolveInjectionCards：首回合出卡、同代不重复、换代出变动卡', () => {
    const messages = [
      { id: 'u1', role: 'user', ts: 1500 },
      { id: 'u2', role: 'user', ts: 3000 },
      { id: 'u3', role: 'user', ts: 7000 }
    ];
    const cards = resolveInjectionCards(messages, INJECTIONS);
    // u1：第一代首次生效（at ≤ ts 命中第 1 代）
    expect(cards.size).toBe(2);
    expect(cards.get('u1')!.snapshot.segments[0]!.hash).toBe('aaaa1111');
    expect(cards.get('u1')!.change).toBeUndefined();
    // u2：同一代 → 不出卡（重复显示已废弃）
    expect(cards.has('u2')).toBe(false);
    // u3：换代 → 变动卡（同源不同 hash = 更新；引擎真身新增也计入）
    const change = cards.get('u3')!.change!;
    expect(change.updated).toEqual(['政策层（材料化）']);
    expect(change.added).toEqual([]);
    expect(change.removed).toEqual([]);
    expect(change.enginePromptChanged).toBe(true);
    expect(change.toolsChanged).toBe(true);
  });

  it('resolveInjectionCards：早于第一代 at 的回合回落第一代（首连时序差兼容）', () => {
    const messages = [{ id: 'u0', role: 'user', ts: 500 }];
    const cards = resolveInjectionCards(messages, INJECTIONS);
    expect(cards.size).toBe(1);
    expect(cards.get('u0')!.snapshot.segments[0]!.hash).toBe('aaaa1111');
    expect(cards.get('u0')!.change).toBeUndefined();
  });

  it('resolveInjectionCards：插话消息不出卡；无信封回空 Map', () => {
    const messages = [
      { id: 's1', role: 'user', ts: 1500, steering: 'send' },
      { id: 'u1', role: 'user', ts: 1500 }
    ];
    expect(resolveInjectionCards(messages, INJECTIONS).has('s1')).toBe(false);
    expect(resolveInjectionCards(messages, INJECTIONS).has('u1')).toBe(true);
    expect(resolveInjectionCards(messages, undefined).size).toBe(0);
  });

  it('formatTokens / formatDurationMs 缩写', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(46211)).toBe('46.2k');
    expect(formatDurationMs(480)).toBe('480ms');
    expect(formatDurationMs(28700)).toBe('28.7s');
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});

it('opens an older message snapshot in place without rendering a history panel above the transcript', async () => {
  const load=vi.fn().mockResolvedValue({ok:true,snapshot:{at:1000,segments:[{source:'lazy',chars:11,hash:'h',text:'loaded via shell'}]}});
  const get=vi.spyOn(surfaceFixture.surface.harness!, 'get').mockReturnValue({on:true,
    injections:[{kind:'summary',at:1000,segments:[{source:'lazy',chars:11,hash:'h'}],toolCount:0,toolsFingerprint:'',details:{key:'detail'}}],
    injectionDetails:load});
  try {
    const view=await renderView();
    await act(async()=>fireEvent.click(screen.getByText('本次发送 · 注入 1 段')));
    expect(await screen.findByText('loaded via shell')).toBeTruthy();expect(load).toHaveBeenCalledWith({key:'detail'});
    expect(screen.queryByText(/注入与压缩记录/)).toBeNull();
    view.unmount();
  } finally {get.mockRestore();}
});
