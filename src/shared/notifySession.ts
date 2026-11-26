/**
 * 工作区通知里的 sessionId 不一定对应真实会话。
 * 合成 id 只用来分组/去重；点通知只切工作区，不要 sessions.select。
 *
 * 合成形态全表（NotifyStore.push 的 sessionId 实际取值，2026-10-25 全量盘点；
 * 新增合成 id 形态时本表与测试 test/notify-session.mjs 的 SYNTHETIC_IDS 同步加）：
 * - notify:<workspaceId>           ui.notify 找不到会话时的占位（capabilities/hosts/misc.ts；
 *                                  integrate 宿主兜底 executor.ts 同形）
 * - notify:composer:<workspaceId>  输入区失败提示 IPC notify:toast（ipc/sessions.ts）
 * - extension:<extensionId>        extension 扩展运行通知（extensions/extensionAppAdapter.ts）
 * - task:<taskId>                  定时任务（tasks/manager.ts）
 * - orchestrator:<workspaceId>     调度 Agent 全家（orchestrator/planModes、turnExecution、
 *                                  sendPipeline、compaction；capabilities/hosts/subscriptionPolicy）
 * - updater:app                    应用自动更新（updater/index.ts）
 * - shell:env                      Git Bash 缺失提示（index.ts）
 * - extension:startup              启动期扩展错误（index.ts）
 * - app-instance:<instanceId>      本机多实例提醒（index.ts）
 * - renderer-error:<label>         渲染层未捕获错误（ipc/app.ts）
 * - delegate-queue:<queueId>       派活队列投递失败（tasks/delegateQueue.ts，resource.sessionId 缺省时）
 * - app / memory（裸词，无冒号）   .muster 初始化成功/失败（metaAgent/ensureForApp.ts）、
 *                                  记忆初始化失败（memory/curatorBindings.ts）
 *
 * 边界：worktree:<id> / worktree-close:<id> / integrate-auto:<sid> / integrate-fail:<sid> /
 * phase:<sid> / lifecycle:<sid> 等是 updateKey 家族
 * （见 docs/features/notification-system.md「updateKey 家族」），不是 sessionId 形态——
 * 这些通知的 sessionId 是真实会话 id，点击应 select；会话已删时由 ipc.ts 的
 * sessions.get 存在性检查兜底只切工作区。真实会话 id 一律 randomUUID（UUID），
 * 与上述字面形态无碰撞面。
 */
const SYNTHETIC_PREFIX = /^(notify|ext|task|orchestrator|updater|shell|extension|app-instance|renderer-error|delegate-queue|app|memory)(:|$)/;

export function isSyntheticNotifySessionId(sessionId: string | undefined | null): boolean {
  const sid = sessionId?.trim() ?? '';
  return sid.length > 0 && SYNTHETIC_PREFIX.test(sid);
}

/** 点通知时是否应 sessions.select 该 id */
export function shouldSelectNotifySession(
  sessionId: string | undefined | null
): sessionId is string {
  const sid = sessionId?.trim() ?? '';
  return sid.length > 0 && !SYNTHETIC_PREFIX.test(sid);
}
