/**
 * 统一排队面板·跨泳道搬移预检（可靠性专项 F-01/F-03 回归）：
 * - F-01：auto→manual 搬移先摘主进程排队副本再入清单，而 addTosendItem 对普通条目
 *   截 2000 字、清单满 20 裁最旧——超长/满员必须提示并保留原位（不摘副本
 *   onCancelQueued、不截断入列、不删无关旧条目），否则发出的是截断正文或旧条目被静默删除。
 * - F-03：忙时自动队列满 8 条（主进程满载只通知弃置、chat:send 仍回 accepted），
 *   manual→auto 必须在面板预检拦下：条目退回手动清单并桌面通知「队列已满，条目已退回清单」；
 *   空闲时即便快照显示 8 条（重启恢复态，主进程空闲直发不查上限）不得拦截。
 * 运行: npx vitest run test/unit/queue-send-panel-move-guards.spec.tsx
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import {
  AUTO_LANE_MAX_ITEMS,
  QueueSendPanel
} from '../../src/renderer/src/components/QueueSendPanel';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { useTosendQueue } from '../../src/renderer/src/components/agentComposer/useTosendQueue';
import { StoreProvider } from '../../src/renderer/src/store';
import {
  serializeTosendList,
  TOSEND_MAX_CHARS,
  TOSEND_MAX_ITEMS,
  type TosendItem
} from '../../src/shared/composerTools';
import { currentApiMock } from './helpers/api-mock';

// ── F-01：useTosendQueue.handlePanelMoveLane 预检（hook 级）──

type HookProps = Parameters<typeof useTosendQueue>[0];
let hookApi: ReturnType<typeof useTosendQueue> | null = null;
function HookHarness(props: HookProps): null {
  hookApi = useTosendQueue(props);
  return null;
}

function manualItem(i: number): TosendItem {
  return { id: `m${i}`, text: `手动条目${i}`, ts: i + 1 };
}

function mountHook(manual: TosendItem[], overrides: Partial<HookProps> = {}): HookProps {
  localStorage.setItem('muster.tosend.v1:f01-ws', serializeTosendList(manual));
  const props: HookProps = {
    draftBucket: 'f01-ws',
    editableRef: { current: null },
    onSend: vi.fn(async () => true),
    onCancelQueued: vi.fn(),
    ...overrides
  };
  render(<HookHarness {...props} />);
  return props;
}

describe('跨泳道搬移预检 F-01（auto→manual 超长/满员不静默截断）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    hookApi = null;
  });

  it('超长（>2000 字）条目：提示并保留原位——不摘排队副本、不入截断文本', async () => {
    const props = mountHook([]);
    const long = '超'.repeat(TOSEND_MAX_CHARS + 1);
    await act(async () => {
      await hookApi!.handlePanelMoveLane({ id: 'q1', text: long }, 'auto', 'manual');
    });
    expect(props.onCancelQueued).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
      text: `内容超过 ${TOSEND_MAX_CHARS} 字上限，已保留在自动队列`
    });
    expect(hookApi!.tosend.length).toBe(0);
  });

  it('恰好 2000 字不拦截：摘副本并全文入手动清单', async () => {
    const props = mountHook([]);
    const exact = '满'.repeat(TOSEND_MAX_CHARS);
    await act(async () => {
      await hookApi!.handlePanelMoveLane({ id: 'q1', text: exact }, 'auto', 'manual');
    });
    expect(props.onCancelQueued).toHaveBeenCalledWith('q1');
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
    expect(hookApi!.tosend.length).toBe(1);
    expect(hookApi!.tosend[0]!.text.length).toBe(TOSEND_MAX_CHARS);
  });

  it('清单满 20 条：提示并保留原位——不摘副本、最旧手动条目不被裁掉', async () => {
    const full = Array.from({ length: TOSEND_MAX_ITEMS }, (_, i) => manualItem(i));
    const props = mountHook(full);
    await act(async () => {
      await hookApi!.handlePanelMoveLane({ id: 'q1', text: '再来一条' }, 'auto', 'manual');
    });
    expect(props.onCancelQueued).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
      text: `手动确认清单已满（${TOSEND_MAX_ITEMS} 条），已保留在自动队列`
    });
    expect(hookApi!.tosend.length).toBe(TOSEND_MAX_ITEMS);
    expect(hookApi!.tosend[0]!.id).toBe('m0');
  });

  it('清单 19 条时可搬入（补足 20，最旧仍在）', async () => {
    const nineteen = Array.from({ length: TOSEND_MAX_ITEMS - 1 }, (_, i) => manualItem(i));
    const props = mountHook(nineteen);
    await act(async () => {
      await hookApi!.handlePanelMoveLane({ id: 'q1', text: '新搬入的条目' }, 'auto', 'manual');
    });
    expect(props.onCancelQueued).toHaveBeenCalledWith('q1');
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
    expect(hookApi!.tosend.length).toBe(TOSEND_MAX_ITEMS);
    expect(hookApi!.tosend[0]!.id).toBe('m0');
  });
});

describe('不支持插话时的人工兜底', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); hookApi = null; });

  it('unsupported 结果先询问兜底，取消时保留原条目', async () => {
    const fallback = vi.fn(async () => 'failed' as const);
    const props = mountHook([], {
      onSendNow: vi.fn(async () => 'unsupported' as const),
      onSendNowFallback: fallback
    });
    await act(async () => {
      await hookApi!.handlePanelSendNow({ id: 'q1', text: '插话内容' }, 'manual');
    });
    expect(fallback).toHaveBeenCalledWith('插话内容');
    expect(hookApi!.tosend).toHaveLength(0);
    expect(props.onCancelQueued).not.toHaveBeenCalled();
  });

  it('兜底成功后不再发送“已加入排队末尾”提示', async () => {
    const fallback = vi.fn(async () => 'sent' as const);
    const props = mountHook([], {
      onSendNow: vi.fn(async () => 'unsupported' as const),
      onSendNowFallback: fallback
    });
    await act(async () => {
      await hookApi!.handlePanelSendNow({ id: 'q1', text: '插话内容' }, 'auto');
    });
    expect(fallback).toHaveBeenCalledWith('插话内容');
    expect(props.onCancelQueued).toHaveBeenCalledWith('q1');
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: '当前回合不接受插话，已加入排队末尾' })
    );
  });
});

// ── F-03：QueueSendPanel 忙时队满预检（manual→auto 退回不丢，面板级）──

function autoItemsOf(n: number): Array<{ id: string; text: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `自动${i}` }));
}

function panelProps(overrides: Record<string, unknown> = {}) {
  return {
    autoItems: autoItemsOf(AUTO_LANE_MAX_ITEMS),
    manualItems: [{ id: 'm1', text: '待退回条目' }],
    busy: true,
    onSendNow: vi.fn(),
    onEditToDraft: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onMoveLane: vi.fn(),
    ...overrides
  };
}

/** 合成 dataTransfer：须带 files/types——drop/dragover 会冒泡到输入壳的
 *  路径落放守卫（dataTransferHasPaths 读 types、图片守卫读 files）。 */
const DT = { files: [], types: [], effectAllowed: 'move', dropEffect: 'move' };

function dragManualRowToAutoLane(): void {
  const rows = screen.getAllByRole('listitem');
  const row = rows[rows.length - 1]!; // 最后一条 = 手动泳道行
  fireEvent.mouseDown(within(row).getByRole('button', { name: '拖动调整顺序' }));
  fireEvent.dragStart(row, { dataTransfer: DT });
  const autoLane = document.querySelector('.agent-composer-qslane.is-auto')!;
  fireEvent.dragOver(autoLane, { dataTransfer: DT });
  fireEvent.drop(autoLane, { dataTransfer: DT });
}

describe('跨泳道搬移预检 F-03（忙时队满退回手动清单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('忙时自动队列满 8：拖拽搬入被拦，条目留在手动清单并通知', () => {
    const props = panelProps();
    render(<QueueSendPanel {...(props as React.ComponentProps<typeof QueueSendPanel>)} />);
    dragManualRowToAutoLane();
    expect(props.onMoveLane).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
      text: '队列已满，条目已退回清单'
    });
    expect(screen.getByText('待退回条目')).toBeTruthy();
  });

  it('忙时自动队列满 8：菜单「加入自动队列」同样被拦', () => {
    const props = panelProps();
    render(<QueueSendPanel {...(props as React.ComponentProps<typeof QueueSendPanel>)} />);
    const rows = screen.getAllByRole('listitem');
    fireEvent.click(within(rows[rows.length - 1]!).getByRole('button', { name: '消息操作' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '加入自动队列' }));
    expect(props.onMoveLane).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
      text: '队列已满，条目已退回清单'
    });
  });

  it('忙时队列 7 条不拦截，正常发起搬移', () => {
    const props = panelProps({ autoItems: autoItemsOf(AUTO_LANE_MAX_ITEMS - 1) });
    render(<QueueSendPanel {...(props as React.ComponentProps<typeof QueueSendPanel>)} />);
    dragManualRowToAutoLane();
    expect(props.onMoveLane).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1' }),
      'manual',
      'auto'
    );
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
  });

  it('空闲时即便快照显示 8 条（重启恢复态）也不拦截：空闲直发不查队列上限', () => {
    const props = panelProps({ busy: false });
    render(<QueueSendPanel {...(props as React.ComponentProps<typeof QueueSendPanel>)} />);
    dragManualRowToAutoLane();
    expect(props.onMoveLane).toHaveBeenCalledTimes(1);
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
  });
});

// ── 装配回归：AgentComposer 真实接线（busy 下传 + 菜单路径）──

describe('跨泳道搬移预检 · 真实 Composer 装配', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Element.prototype.scrollIntoView ??= () => {};
    document.execCommand ??= () => false;
  });

  it('F-01 接线：超长排队条目经菜单「转为手动确认」被拦，副本不被摘除', async () => {
    const onCancelQueued = vi.fn();
    const onSend = vi.fn(async () => true);
    await act(async () => {
      render(
        <StoreProvider>
          <AgentComposer
            workspaceId="wire-f01-ws"
            surfaceKind="gui-session"
            busy={true}
            queuedItems={[{ id: 'q1', text: '超'.repeat(TOSEND_MAX_CHARS + 1) }]}
            onCancelQueued={onCancelQueued}
            onSend={onSend}
            onClear={async () => {}}
          />
        </StoreProvider>
      );
    });
    fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: '消息操作' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '转为手动确认' }));
    expect(onCancelQueued).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
      text: `内容超过 ${TOSEND_MAX_CHARS} 字上限，已保留在自动队列`
    });
    // 条目保留在自动泳道原位
    expect(screen.getAllByRole('listitem').length).toBe(1);
  });

  it('F-03 接线：忙时自动队列满 8，拖入手动条目不发起发送、条目退回清单', async () => {
    const onSend = vi.fn(async () => true);
    await act(async () => {
      render(
        <StoreProvider>
          <AgentComposer
            workspaceId="wire-f03-ws"
            surfaceKind="gui-session"
            busy={true}
            queuedItems={autoItemsOf(AUTO_LANE_MAX_ITEMS)}
            onSend={onSend}
            onClear={async () => {}}
          />
        </StoreProvider>
      );
    });
    // 手动清单放一条：输入草稿 + 「留待确认」
    const editor = screen.getByRole('textbox');
    editor.textContent = '要退回的条目';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: '留待确认' }));
    dragManualRowToAutoLane();
    expect(onSend).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
      text: '队列已满，条目已退回清单'
    });
    expect(screen.getByText('要退回的条目')).toBeTruthy();
  });
});
