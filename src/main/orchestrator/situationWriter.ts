/**
 * SITUATION.md 态势快照写入器（R-12 + R-11）：采集各数据源 → 纯拼装 → 落盘。
 *
 * - 采集全部 try/catch 容错：缺哪段省略哪段（taskStore/会话表/delegate 队列/
 *   调度收件箱/事件队列深度，单源失败不拖垮其余）。
 * - 更新时机（夜批决议）：任务翻转 / 调度相位翻转 / 事件 flush 后经
 *   OrchestratorEventPump 的 onSituationChange 缝转来；收信/已读回执落盘后
 *   同样触发刷新。**30s 节流**合并重写
 *   （trailing：窗口内多次信号只触发一次写）。
 * - fail-open：写失败只记日志，绝不影响事件泵/调度回合。
 * - 冷启动（R-11 随解）：orchestrator 注入前直接调 writeSchedulerSituationNow
 *   现采现写，保证新对话首轮拿到的是当前态势而非过期快照。
 */
import {
  buildSchedulerSituationMarkdown,
  type SchedulerSituationData,
  type SchedulerSituationWsRow
} from '../../shared/schedulerMemory';
import { writeSchedulerSituation } from '../metaAgent/schedulerMemoryStore';
import { listDelegateQueue } from '../tasks/delegateQueue';
import { onAgentMessagesChanged, readAgentMessageLedger } from '../metaAgent/messageStore';
import { isHostNotification } from '../../shared/hostNotification';
import { getOrchestratorEventPump } from './events';
import { isNeedsYouPeekSession } from '../../shared/boardReview';
import { controlRootFor, requireWorkspace } from '../workspacePaths';
import type { AppContext } from '../context';

/** 节流窗（决议：30s） */
export const SITUATION_REFRESH_THROTTLE_MS = 30_000;

/** 单工作区 needs_you 名单（看板「需要你」口径，与黄点数字同源过滤） */
function needsYouNamesOf(ctx: AppContext, wsId: string, now: number): string[] {
  return ctx.sessions
    .listByWorkspace(wsId)
    .filter((s) => isNeedsYouPeekSession(s, now))
    .map((s) => s.name || s.id);
}

/** 各数据源容错采集（单源失败 → 对应字段 undefined，拼装时省略该段） */
export function collectSchedulerSituationData(ctx: AppContext, wsId: string): SchedulerSituationData {
  const now = Date.now();
  const data: SchedulerSituationData = { generatedAt: now };


  let workspaces: Array<{ id: string; name: string }> = [];
  try {
    workspaces = ctx.config
      .get()
      .workspaces.map((w) => ({ id: w.id, name: w.name?.trim() || w.id }));
  } catch (err) {
    console.error('[scheduler-situation] 工作区配置读取失败（快照省略概况节）', err);
  }
  if (workspaces.length > 0) {
    const rows: SchedulerSituationWsRow[] = [];
    for (const w of workspaces) {
      const row: SchedulerSituationWsRow = { name: w.name };
      try {
        row.needsYouNames = needsYouNamesOf(ctx, w.id, now);
      } catch (err) {
        console.error('[scheduler-situation] needs_you 名单读取失败（该区省略该段）', w.id, err);
      }
      try {
        row.delegateQueued = listDelegateQueue(w.id).length;
      } catch (err) {
        console.error('[scheduler-situation] delegate 队列读取失败（该区省略该段）', w.id, err);
      }
      try {
        const wsRoot = resolveSchedulerWorkspaceRoot(ctx, w.id);
        row.outboxUnread = wsRoot
          ? readAgentMessageLedger(wsRoot, w.id).messages.filter(message =>
              !message.read && !isHostNotification(message) &&
              (message.to === `orchestrator:${w.id}` || message.to === 'scheduler')).length
          : 0;
      } catch (err) {
        console.error('[scheduler-situation] 调度未读来信读取失败（该区省略该段）', w.id, err);
      }
      try {
        row.eventQueueDepth = getOrchestratorEventPump()?.peek(w.id).length ?? 0;
      } catch (err) {
        console.error('[scheduler-situation] 事件队列深度读取失败（该区省略该段）', w.id, err);
      }
      rows.push(row);
    }
    data.workspaces = rows;
  }

  return data;
}

/** 固定管理根（解析不到返回 undefined，不回落到其它工作区） */
export function resolveSchedulerWorkspaceRoot(ctx: AppContext, wsId: string): string | undefined {
  try {
    return controlRootFor(requireWorkspace(ctx.config.get(), wsId));
  } catch {
    return undefined;
  }
}

/** 现采现写（同步；注入前调用保证冷启动新鲜）。fail-open：失败只记日志。 */
export function writeSchedulerSituationNow(ctx: AppContext, wsId: string): { ok: boolean } {
  try {
    const root = resolveSchedulerWorkspaceRoot(ctx, wsId);
    if (!root) return { ok: false };
    writeSchedulerSituation(root, buildSchedulerSituationMarkdown(collectSchedulerSituationData(ctx, wsId)));
    return { ok: true };
  } catch (err) {
    console.error('[scheduler-situation] 快照写入失败（fail-open，忽略）', wsId, err);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// 30s 节流器（模块内 per-workspace；重启清零无妨——下次信号再排）
// ---------------------------------------------------------------------------

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
interface SituationRefreshOptions {
  delayMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * 信号入口：事件泵变化或收信/已读落盘后调用。窗口内多次信号合并为一次 trailing 写；
 * timer unref（挂起的快照刷新不吊住进程退出）。
 */
export function noteSchedulerSituationChanged(
  workspaceId: string,
  opts?: SituationRefreshOptions
): void {
  const ws = workspaceId?.trim();
  if (!ws) return;
  if (pendingTimers.has(ws)) return; // 已有待触发的写：信号合并
  const st: NonNullable<SituationRefreshOptions['setTimeoutFn']> = opts?.setTimeoutFn ?? setTimeout;
  const timer = st(
    () => {
      pendingTimers.delete(ws);
      const ctx = boundCtx;
      if (!ctx) return; // 未装配（测试/极早期）：跳过，下次装配后信号再触发
      writeSchedulerSituationNow(ctx, ws);
    },
    opts?.delayMs ?? SITUATION_REFRESH_THROTTLE_MS
  );
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  pendingTimers.set(ws, timer);
}

/** 进程内 ctx 装配（index 启动时注入；事件缝回调无参传不了 ctx） */
let boundCtx: AppContext | null = null;
let unbindMailboxChanges: (() => void) | undefined;

export function bindSchedulerSituationContext(ctx: AppContext | null, opts?: SituationRefreshOptions): void {
  unbindMailboxChanges?.();
  unbindMailboxChanges = undefined;
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  boundCtx = ctx;
  if (ctx) {
    unbindMailboxChanges = onAgentMessagesChanged(() => {
      // 每份快照都含所有工作区概况，任一区已读变化都需要更新各份快照。
      for (const workspace of ctx.config.get().workspaces) {
        noteSchedulerSituationChanged(workspace.id, opts);
      }
    });
  }
}

/** 测试辅助：清空节流器挂起态（不 cancel 已排定时器，测试自行用注入时钟） */
export function resetSchedulerSituationThrottleForTests(): void {
  pendingTimers.clear();
}
