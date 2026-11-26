/**
 * 收口/收尾提醒缝（R-09/R-19，仿 taskEvents）：sessionAgentTask（经 delegateQueue 被
 * events 依赖）、git 采纳 IPC、PR 轮询都不能直接 import orchestrator/events（成环），
 * 由 index 装配把监听器接到泵的入队口（kind=settle_warn，工作区级信号，复用泵的
 * 合并窗口/忙 hold/决策门语义）。
 *
 * 防重报（模块内、进程内，不持久化——重启后重报一次可接受）：
 * - 带 key 的提醒：同 key 连续只发一次，状态消失由调用方 clearSettleWarnKey 清键
 *   （如收口成功后同任务再次失败会重新提醒）；
 * - 不带 key 的提醒（如每次部分采纳都是独立动作）：不去重，靠泵同窗口 key 覆盖合并。
 */
export interface SettleNotifyInput {
  workspaceId: string;
  detail: string;
  sessionId?: string;
  sessionName?: string;
  /** 防重报键（如 settle-failed:<ws>:<task>）；缺省不去重 */
  key?: string;
}

/** 泵入队事件（含去重后的 extraKey；不带 key 的用序号铺开避免互相覆盖） */
export interface SettleNotifyEvent extends SettleNotifyInput {
  extraKey: string;
}

type SettleListener = (e: SettleNotifyEvent) => void;

let listener: SettleListener | null = null;
const firedKeys = new Set<string>();
let nonceSeq = 0;

export function setSettleNotifyListener(fn: SettleListener | null): void {
  listener = fn;
}

/** R-09 收口失败防重报键（收口成功后由调用方清除） */
export function settleFailedKey(workspaceId: string, taskId: string): string {
  return `settle-failed:${workspaceId}:${taskId}`;
}

/** 发提醒；返回是否真正下发（被去重吞掉返回 false） */
export function notifySettleWarn(e: SettleNotifyInput): boolean {
  const ws = e.workspaceId?.trim();
  if (!ws) return false;
  if (e.key) {
    if (firedKeys.has(e.key)) return false;
    firedKeys.add(e.key);
  }
  const extraKey = e.key ?? `settle-${++nonceSeq}`;
  try {
    listener?.({ ...e, workspaceId: ws, extraKey });
  } catch (err) {
    console.error('[settle-notify] listener failed', err);
  }
  return true;
}

/** 清防重报键：失败状态消失（收口成功/任务翻转走）后，再失败可重新提醒 */
export function clearSettleWarnKey(key: string): void {
  firedKeys.delete(key);
}

/** 测试辅助：清模块内去重态 */
export function resetSettleNotifyForTest(): void {
  firedKeys.clear();
  nonceSeq = 0;
}

// ---------------------------------------------------------------------------
// R-19 部分采纳：worktree 会话反查（按隔离树/分支），提醒调度人工核对收口。
// 只提醒不自动收口——人工/调度核对后结（保守，避免误结）。
// ---------------------------------------------------------------------------

/** 会话侧最小面（测试可注入；生产传 ctx.sessions） */
export interface SettleSessionLike {
  id: string;
  name: string;
  workspaceId?: string;
  worktreePath?: string;
}

export function notifyAdoptAppliedForWorktree(
  sessions: { list(): readonly SettleSessionLike[] },
  worktreePath: string
): void {
  const wt = worktreePath?.trim();
  if (!wt) return;
  let session: SettleSessionLike | undefined;
  try {
    session = sessions.list().find((s) => s.worktreePath === wt);
  } catch (err) {
    console.error('[settle-notify] adopt 会话反查失败', err);
    return;
  }
  const wsId = session?.workspaceId?.trim();
  // 反查不到会话/工作区：泵无法路由，跳过（采纳结果本身已回 UI，不静默丢失用户反馈）
  if (!session || !wsId) return;
  notifySettleWarn({
    workspaceId: wsId,
    sessionId: session.id,
    sessionName: session.name,
    detail: `部分采纳已应用到主仓，会话 ${session.name} 请人工核对收口`
  });
}
