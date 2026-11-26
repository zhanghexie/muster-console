/**
 * 通知总线：SessionManager 在 deriveBoardStatus 翻转写入点上报（report），
 * 决策走 shared/notifyDecision 纯函数（翻转/45s 账本/免打扰/权限单点裁决），
 * 通过后分发：桌面 toast（NotifyStore，phase:<id> 同键原地更新）+ 事件订阅者
 * （T1.2 手机表面 WS 推送）。
 * 另有 onFlip 原始翻转流（决策前）：T3.3 phase 触发任务等自动化订阅，
 * 不随通知偏好/免打扰/45s 账本静默——那些只管「推给人的通知」，不管「拉起任务」。
 */
import type { BoardStatus } from '../../shared/boardStatus';
import { isOrchestratorSessionId } from '../../shared/runtimeFacts';
import {
  decideNotify,
  isTrustedSource,
  notifyTriggerOf,
  type NotifyDecision,
  type NotifyPrefs,
  type NotifySource,
  type NotifyTrigger
} from '../../shared/notifyDecision';
import { formatNotifyText, type SessionMeta } from '../../shared/types';
import { t } from '../../shared/i18n';
import type { NotifyStore } from './store';

/** 总线事件：决策通过的翻转（send=true）才会发；订阅端按通道自行再收紧（如桌面通知可用性） */
export interface NotifyBusEvent {
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  /** 翻转前后推导态（prev=null 为首评） */
  prev: BoardStatus | null;
  next: BoardStatus;
  source: NotifySource;
  trigger: NotifyTrigger;
  ts: number;
}

/**
 * 原始翻转事件（决策前）：可信源 + 进入触发类 + 非同类重入。供自动化订阅
 * （T3.3 phase 触发源）——不受通知偏好/免打扰/45s 账本影响；ts 即进入该相位的
 * 时刻，是 phase 触发 afterMinutes 停留门槛的计时基准。
 */
export interface NotifyFlipEvent {
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  /** 翻转后的推导态 */
  next: BoardStatus;
  source: NotifySource;
  /** 进入的触发类（与 next 对应） */
  trigger: NotifyTrigger;
  /** 翻转时刻（epoch ms） */
  ts: number;
}

export interface NotifyBusReportInput {
  session: Pick<SessionMeta, 'id' | 'name' | 'hidden'>;
  workspaceId: string;
  prev: BoardStatus | null;
  next: BoardStatus;
  source: NotifySource;
  now?: number;
}

/** 触发类的 toast 文案（与左栏胶囊默认文案同源） */
export function notifyTriggerLabel(trigger: NotifyTrigger): string {
  switch (trigger) {
    case 'needs_you':
      return t('需要你');
    case 'done':
      return t('已完成');
    case 'error':
      return t('出错了');
  }
}

export class NotifyBus {
  private listeners = new Set<(e: NotifyBusEvent) => void>();
  private flipListeners = new Set<(e: NotifyFlipEvent) => void>();
  /** 信号账本：`sessionId\0trigger` → 上次真实发送时间（只记 send，被拦截不续窗） */
  private ledger = new Map<string, number>();

  constructor(
    private notify: NotifyStore,
    private getPrefs: () => NotifyPrefs
  ) {}

  /** 订阅决策通过的翻转事件（手机）。返回退订函数。 */
  on(fn: (e: NotifyBusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 订阅原始翻转事件（决策前；T3.3 phase 触发源等自动化）。返回退订函数。 */
  onFlip(fn: (e: NotifyFlipEvent) => void): () => void {
    this.flipListeners.add(fn);
    return () => {
      this.flipListeners.delete(fn);
    };
  }

  /**
   * 翻转上报入口（SessionManager 各权威写入点调用）。
   * 返回最终决策（测试/观测用）；隐藏会话直接拦下（模板会话不推）。
   */
  report(input: NotifyBusReportInput): NotifyDecision {
    if (input.session.hidden) {
      return { send: false, trigger: null, reason: 'hidden', channels: { toast: false, mobile: false } };
    }
    const now = input.now ?? Date.now();
    const trigger = notifyTriggerOf(input.next);
    // 调度会话 needs_you：左下角气泡已计，不进桌面 toast / 订阅通道 / phase 触发。
    if (trigger === 'needs_you' && isOrchestratorSessionId(input.session.id)) {
      return { send: false, trigger, reason: 'scheduler', channels: { toast: false, mobile: false } };
    }
    // 原始翻转流（决策前）：自动化（phase 触发任务）不随推送偏好/账本去重静默。
    // 口径与 decideNotify 一致：可信源 + 进入触发类 + 非同类重入（首评 prev=null 允许）。
    if (
      trigger !== null &&
      isTrustedSource(input.source) &&
      (input.prev === null || notifyTriggerOf(input.prev) !== trigger)
    ) {
      const flip: NotifyFlipEvent = {
        sessionId: input.session.id,
        sessionName: input.session.name,
        workspaceId: input.workspaceId,
        next: input.next,
        source: input.source,
        trigger,
        ts: now
      };
      for (const fn of this.flipListeners) {
        try {
          fn(flip);
        } catch (e) {
          console.error('[notify-bus] flip listener failed', e);
        }
      }
    }
    const key = trigger ? `${input.session.id}\0${trigger}` : undefined;
    const decision = decideNotify(
      {
        sessionId: input.session.id,
        prev: input.prev,
        next: input.next,
        source: input.source
      },
      {
        lastSentAt: key !== undefined ? this.ledger.get(key) : undefined,
        prefs: this.getPrefs(),
        now
      }
    );
    if (!decision.send || !decision.trigger) return decision;

    if (key !== undefined && decision.ledgerTs !== undefined) {
      this.ledger.set(key, decision.ledgerTs);
    }

    // 桌面 toast：人需要出手/知晓的时刻，不进通知面板（矩阵见 notification-system.md）
    if (decision.channels.toast) {
      const label = notifyTriggerLabel(decision.trigger);
      this.notify.push({
        workspaceId: input.workspaceId,
        sessionId: input.session.id,
        sessionName: input.session.name,
        label,
        text: formatNotifyText(input.session.name, label),
        update: true,
        updateKey: `phase:${input.session.id}`,
        toast: true
      });
    }

    const event: NotifyBusEvent = {
      sessionId: input.session.id,
      sessionName: input.session.name,
      workspaceId: input.workspaceId,
      prev: input.prev,
      next: input.next,
      source: input.source,
      trigger: decision.trigger,
      ts: now
    };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (e) {
        console.error('[notify-bus] listener failed', e);
      }
    }
    return decision;
  }

  /** 会话删除时清账本（条目很少，线性扫描足够） */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const k of this.ledger.keys()) {
      if (k.startsWith(prefix)) this.ledger.delete(k);
    }
  }
}
