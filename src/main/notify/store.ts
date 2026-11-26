import { createHash, randomUUID } from 'node:crypto';
import type { UiBridge } from '../uiBridge';
import type { WorkspaceNotifyItem } from '../../shared/types';
import { resolveDesktopNotifyPayload } from '../capabilities/hosts/desktopNotify';

const MAX_PER_WORKSPACE = 50;
const DEDUP_WINDOW_MS = 800;

export type NotifyPushInput = Omit<WorkspaceNotifyItem, 'id' | 'ts'> & {
  id?: string;
  ts?: number;
  /**
   * 为 true 且提供 updateKey 时：同工作区内替换已有同键通知（移到队首并刷新），不新增。
   * 状态类（lifecycle / liveStatus）应置 true；一次性事件保持 false/缺省。
   */
  update?: boolean;
  /** 弹桌面 toast（唯一通知通道）。只给「人需要出手/知晓」的时刻：needs_you/done、出错、worktree 遗留、Agent 主动通知等。 */
  toast?: boolean;
};

/** 桌面 toast 用的工区展示信息 */
export type NotifyWorkspaceInfo = { name?: string; avatar?: string };

function dedupKey(
  workspaceId: string,
  sessionId: string,
  lifecycle?: string,
  label?: string,
  kind?: string,
  text?: string
): string {
  // F-02：键纳入 kind 与 text 哈希——短窗内同会话同标签的「不同文本」不再被静默吞掉，
  // 只有完全同签名（含内容）的连发才去重。
  const textHash = text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
  return `${workspaceId}\0${sessionId}\0${lifecycle ?? ''}\0${label ?? ''}\0${kind ?? ''}\0${textHash}`;
}

function itemDedupKey(item: WorkspaceNotifyItem): string {
  return dedupKey(item.workspaceId, item.sessionId, item.lifecycle, item.label, item.kind, item.text);
}

/**
 * 通知去重/原地更新的账本层：按工作区记最近条目（内存），供 800ms 短窗去重与
 * `update:true + updateKey` 原地替换；`toast: true` 弹桌面系统通知——应用内
 * 通知面板已移除，系统 toast 是唯一通知出口（见 docs/features/notification-system.md）。
 * 去重键含 kind + text 哈希（F-02）；recentKeys 在新增条目时顺带清理过期项。
 */
export class NotifyStore {
  private byWorkspace = new Map<string, WorkspaceNotifyItem[]>();
  /** 最近一次入队的去重键 → 时间戳 */
  private recentKeys = new Map<string, number>();

  constructor(
    private ui: UiBridge,
    private resolveWorkspace?: (workspaceId: string) => NotifyWorkspaceInfo | undefined
  ) {}

  push(input: NotifyPushInput): WorkspaceNotifyItem {
    const now = input.ts ?? Date.now();
    const updateKey = input.updateKey?.trim() || undefined;
    const { update: _updateFlag, toast = false, ...rest } = input;

    if (input.update && updateKey) {
      const list = this.byWorkspace.get(input.workspaceId) ?? [];
      const idx = list.findIndex((x) => x.updateKey === updateKey);
      if (idx >= 0) {
        const prev = list[idx]!;
        const item: WorkspaceNotifyItem = {
          ...prev,
          workspaceId: rest.workspaceId,
          sessionId: rest.sessionId,
          sessionName: rest.sessionName,
          lifecycle: rest.lifecycle,
          label: rest.label,
          kind: rest.kind,
          text: rest.text,
          updateKey,
          id: prev.id,
          ts: now
        };
        list.splice(idx, 1);
        list.unshift(item);
        this.byWorkspace.set(input.workspaceId, list);
        this.emit(item, toast);
        return item;
      }
    }

    const key = dedupKey(
      input.workspaceId,
      input.sessionId,
      input.lifecycle,
      input.label,
      input.kind,
      input.text
    );
    const lastAt = this.recentKeys.get(key);
    if (lastAt != null && now - lastAt < DEDUP_WINDOW_MS) {
      const existing = this.findRecentByKey(input.workspaceId, key, lastAt);
      if (existing) return existing;
    }

    const item: WorkspaceNotifyItem = {
      workspaceId: rest.workspaceId,
      sessionId: rest.sessionId,
      sessionName: rest.sessionName,
      lifecycle: rest.lifecycle,
      label: rest.label,
      kind: rest.kind,
      text: rest.text,
      updateKey,
      id: input.id ?? randomUUID(),
      ts: now
    };

    const list = this.byWorkspace.get(input.workspaceId) ?? [];
    list.unshift(item);
    if (list.length > MAX_PER_WORKSPACE) list.length = MAX_PER_WORKSPACE;
    this.byWorkspace.set(input.workspaceId, list);
    this.sweepRecentKeys(now);
    this.recentKeys.set(key, now);

    this.emit(item, toast);
    return item;
  }

  /** `toast` 时弹桌面系统通知（点击回跳工作区/会话） */
  private emit(item: WorkspaceNotifyItem, toast: boolean): void {
    if (!toast) return;
    const ws = this.resolveWorkspace?.(item.workspaceId);
    const { title, body, icon } = resolveDesktopNotifyPayload(item.sessionName, item.text, {
      workspaceName: ws?.name,
      avatar: ws?.avatar
    });
    this.ui.notify(title, body, {
      workspaceId: item.workspaceId,
      sessionId: item.sessionId,
      icon
    });
  }

  list(workspaceId: string): WorkspaceNotifyItem[] {
    return [...(this.byWorkspace.get(workspaceId) ?? [])];
  }

  getAll(): Record<string, WorkspaceNotifyItem[]> {
    const res: Record<string, WorkspaceNotifyItem[]> = {};
    for (const [wsId, items] of this.byWorkspace) {
      res[wsId] = [...items];
    }
    return res;
  }

  /** 顺带清理短窗外过期的去重键（F-02 配套：recentKeys 不再只增不清） */
  private sweepRecentKeys(now: number): void {
    for (const [key, ts] of this.recentKeys) {
      if (now - ts >= DEDUP_WINDOW_MS) this.recentKeys.delete(key);
    }
  }

  private findRecentByKey(
    workspaceId: string,
    key: string,
    sinceTs: number
  ): WorkspaceNotifyItem | undefined {
    const list = this.byWorkspace.get(workspaceId);
    if (!list?.length) return undefined;
    for (const item of list) {
      if (item.ts < sinceTs) break;
      if (itemDedupKey(item) === key) return item;
    }
    return undefined;
  }
}
