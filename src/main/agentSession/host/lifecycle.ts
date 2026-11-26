import {archiveOperationFor,archiveSessionIds} from './archiveOwnership';
import {assertNoColdFork} from './forkLock';
import { historyNewestFirst } from './historyRead';
/**
 * AgentSessionHost 会话生命周期：打开（历史恢复/计划卡重水合）、查询面、
 * 关闭（含引擎侧落盘清理与孤儿清扫）与退出前同步收口。
 */
import { isChatRuntimeId } from '../../../shared/agentRuntimeCapabilities';
import { sanitizeRestoredMessages, guiMessageText } from '../../../shared/guiWorker';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { t } from '../../../shared/i18n';
import type { SessionMeta } from '../../../shared/types';
import { ModeController } from '../../agent/providers/modeExtension';
import type { HostCore, SessionEntry } from './internal';
import { initialGuiWorkerMode } from './internal';
import { applyInjectQueueChange, cancelStreamingPersist, persistEntry, push } from './base';
import { rejectSubagentApprovalsFor, resolveUserQuestionInternal } from './approvals';
import { disposeNodeReplSession } from '../tools/nodeRepl';
import { skillTurnBook } from '../../agent/skillInject';
import { endWorkspaceContext } from './workspaceContext';
import { turnTabLedger } from '../../browser/turnShots';
import {getMemoryService,resolveMemoryWorkspaceRoot} from '../../memory/runtime';
import { retireConnection, retirePendingConnection, retirementBarrier, drainRetirements, assertMaterializationReady, retireSessionWriter, hasMaterializationRetirement } from './retirement';
import { GuiSessionDataCleanupError } from '../cleanupError';
import { guiReplyLine } from '../../../shared/boardReplyPreview';

const shutdowns = new WeakMap<HostCore, Promise<void>>();

/** A visible chat surface owns no complete transcript or provider resources. */
export function open(host: HostCore, session: SessionMeta): void {
  if(shutdowns.has(host))throw new Error('GUI session host is shutting down');
  if(!isChatRuntimeId(session.runtime??''))return;
  if(session.archived)throw new Error(t('GUI 会话未打开: {{id}}',{id:session.id}));
  if(archiveOperationFor(host,session.id))throw new Error(t('会话正在归档，请等待资源清理完成'));
  if(isOpen(host,session.id))return;
  host.openedSessionIds.add(session.id);
  host.ctx.sessions.setQueuedInjects?.(session.id,0);
  host.ctx.sessions.applyActivitySignal(session.id,'idle','gui-open');
}

/** Explicit execution boundary. Never expose a half-restored entry. */
export function materializeForExecution(host:HostCore,sessionId:string):SessionEntry {
  if(shutdowns.has(host))throw new Error('GUI session host is shutting down');
  assertMaterializationReady(host,sessionId);
  const existing=host.entries.get(sessionId);
  if(existing)return existing;
  assertNoColdFork(host,sessionId);
  if(!host.openedSessionIds?.has(sessionId))throw new Error(t('GUI 会话未打开: {{id}}',{id:sessionId}));
  const session=host.ctx.sessions.get(sessionId);
  if(!session||!isChatRuntimeId(session.runtime??''))throw new Error(t('GUI 会话未打开: {{id}}',{id:sessionId}));
  try {
  // Establish the cutover before a new workspace's first user message is timestamped.
  try{const root=resolveMemoryWorkspaceRoot(host.ctx,session.workspaceId,session.workspaceId?undefined:session.cwd);if(root)getMemoryService()?.knowledge(root,'worker');}
  catch(error){console.warn('[knowledge] session initialization failed',error);}
  // Cursor 的入口不提供 auto：未指定时使用界面可见的默认档，保留显式设置。
  const mode = initialGuiWorkerMode(session);
  host.store.retain(session.id);
  const snapshot = host.store.loadSnapshot(session.id);
  if (snapshot.messages.length) {
    host.ctx.sessions.setBoardReplyPreview?.(session.id, guiReplyLine(snapshot.messages));
  }
  let pendingFork: ReturnType<typeof host.store.loadPendingFork> = null;
  let forkPendingError: string | undefined;
  let forkResumeGuard = false;
  try {
    pendingFork = host.store.loadPendingFork(session.id);
    if (pendingFork?.state === 'clearing') {
      forkPendingError = '上次清空会话未确认完成，已停止续写；请检查本地历史并重新清空';
    }
    if (pendingFork?.state === 'delivered') {
      const token = pendingFork.resumeToken || session.runtimeResumeToken;
      if (pendingFork.resumeToken && session.runtimeResumeToken && pendingFork.resumeToken !== session.runtimeResumeToken) {
        forkPendingError = '分叉会话的恢复标识不一致，已停止自动续写；请检查原生历史后新建会话';
      } else if (!token) {
        forkPendingError = '分叉上下文已投递，但没有可恢复的引擎会话标识；请检查原生历史后新建会话';
      } else {
        // This marker outlives the debounced session registry. Reconstruct the
        // token from it when the app stopped before the registry write.
        host.store.savePendingFork(session.id, { state: 'delivered', seed: null, transcript: null, resumeToken: token, delivery: pendingFork.delivery });
        host.ctx.sessions.updateRuntimeHandle(session.id, { externalSessionId: token, runtimeResumeToken: token });
        if (host.ctx.sessions.get(session.id)?.runtimeResumeToken !== token) throw new Error('分叉会话的原生标识恢复失败');
        forkResumeGuard = pendingFork.delivery !== 'seed';
        pendingFork = null;
      }
    }
  } catch (error) {
    forkPendingError = (error as Error).message;
  }
  const restored: SessionEntry = {
    sessionId: session.id,
    runtimeId: session.runtime!,
    cwd: session.cwd ?? '',
    workspaceId: session.workspaceId,
    worktreePath: session.worktreePath,
    mode,
    thinkingLevel: session.thinkingLevel ?? null,
    planExecuting: false,
    planApprovedFeedback: null,
    planAllowedPrompts: [],
    modeController: new ModeController(mode === 'auto' || mode === 'standard' || mode === 'accept-edits' || mode === 'auto-review' ? 'default' : mode),
    planMessageId: null,
    connectionModelKey: null,
    // 恢复消毒：落盘快照里的排队标记/挂起审批/挂起提问是上次运行的进行时状态，
    // 队列与应答通道已不存在——不剥离就是「可点但无效」的僵尸控件
    messages: sanitizeRestoredMessages(snapshot.messages),
    busy: false,
    abortRequested: false,
    queue: [],
    injections: snapshot.injections,
    injectionUpdates: new Map(),
    compactions: snapshot.compactions,
    compactionSeq: 0,
    openCompaction: null,
    lastClosedCompaction: null,
    lastSteeredTexts: [],
    connection: null,
    connecting: null,
    activeApproval: null,
    activeUserQuestion: null,
    assistant: null,
    toolset: null,
    slashCommands: [],
    engineMode: null,
    forkSeed: pendingFork?.seed ?? null,
    forkTranscript: null,
    forkTranscriptSource: pendingFork?.transcript ?? null,
    ...(forkPendingError ? { forkPendingError } : {}),
    ...(forkResumeGuard ? { forkResumeGuard: true } : {}),
    ...(pendingFork ? { forkDeliveryState: pendingFork.state === 'pending' ? 'pending' as const : 'unknown' as const } : {}),
    clearing: false,
    closed: false,
    turnRetryAttempt: 0,
    turnRetryTimer: null,
    lastTurnInput: null,
    lastSentPayload: null,
    lastUsage: snapshot.lastUsage,
    skipUsagePersistUntilTurn: !!pendingFork?.seed
  };
  // 计划卡重水合：planMessageId 与控制器步骤都是内存态，落盘的只有消息——恢复时
  // 取最后一张 pending 卡兜底（执行/放弃/进度要靠它），并把它标为唯一 active，
  // 其余 pending 卡转「已更新」只读（与运行期挂新卡的语义一致）。
  // 持久化过的「执行中」卡一律降级回待确认：planExecuting 不落盘，执行态本就不恢复
  {
    for (const m of restored.messages) {
      if (m.plan?.status === 'executing') m.plan = { ...m.plan, status: 'pending' };
    }
    let activePlanMsg: GuiChatMessage | null = null;
    for (const m of restored.messages) {
      if (m.plan?.status === 'pending') activePlanMsg = m;
    }
    for (const m of restored.messages) {
      if (m !== activePlanMsg && m.plan?.status === 'pending') {
        m.plan = { ...m.plan, active: false };
      }
    }
    if (activePlanMsg?.plan) {
      restored.planMessageId = activePlanMsg.id;
      restored.modeController.planSteps = activePlanMsg.plan.steps.map((s) => ({ ...s }));
    }
  }
  if(shutdowns.has(host)||!host.openedSessionIds.has(sessionId))throw new Error(t('会话已关闭'));
  host.entries.set(sessionId,restored);
  return restored;
  } catch(error) {
    retireSessionWriter(host,sessionId,()=>host.store.release(sessionId));
    throw error;
  }
}

export function isOpen(host: HostCore, sessionId: string): boolean {
  return !!host.openedSessionIds?.has(sessionId) || host.entries.has(sessionId);
}

export function isBusy(host: HostCore, sessionId: string): boolean {
  return host.entries.get(sessionId)?.busy === true;
}

/** 最近一条 assistant 回复（正文 text part 拼接；无回复或纯空返回 null） */
export function lastAssistantReply(host: HostCore, sessionId: string): { id: string; text: string } | null {
  if(!isOpen(host,sessionId))return null;
  for(const message of historyNewestFirst(host,sessionId)){
    if(message.role!=='assistant')continue;
    const text=guiMessageText(message);
    return text.trim()?{id:message.id,text}:null;
  }
  return null;
}

export function messageCount(host: HostCore, sessionId: string): number {
  return host.entries.get(sessionId)?.messages.length ?? (isOpen(host,sessionId)?host.store.loadRangeSnapshot(sessionId,0,1).total:0);
}

/** P5：当前 GUI 回合开始时刻；会话未打开则 undefined */
export function getTurnStartedAt(host: HostCore, sessionId: string): number | undefined {
  return host.entries.get(sessionId)?.turnStartedAt;
}

/** O6：进行中回合的开始时刻（busy 中才有值；回合收口/清空归零）。压缩占 busy 但不是回合，恒 undefined */
export function getActiveTurnStartedAt(host: HostCore, sessionId: string): number | undefined {
  return host.entries.get(sessionId)?.activeTurnStartedAt;
}

export async function waitUntilOpen(host: HostCore, sessionId: string, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (isOpen(host,sessionId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return isOpen(host,sessionId);
}

export async function close(
  host: HostCore,
  sessionId: string,
  opts?: { purgeHistory?: boolean; meta?: SessionMeta }
): Promise<void> {
  host.openedSessionIds?.delete(sessionId);
  const archive=archiveOperationFor(host,sessionId);
  if(archive){await archive;if(opts?.purgeHistory)await purgeDeletedSession(host,sessionId,opts.meta);return;}
  const entry = host.entries.get(sessionId);
  const cleanupErrors: unknown[] = [];
  let backgroundCleanup: Promise<void>;
  try { backgroundCleanup = host.ctx.bgTasks?.killAllForSessionAndWait(sessionId) ?? Promise.resolve(); }
  catch (error) { backgroundCleanup = Promise.reject(error); }
  void backgroundCleanup.catch(() => {});
  let replCleanup:Promise<void>;
  try{replCleanup=Promise.resolve(disposeNodeReplSession(sessionId));}catch(error){replCleanup=Promise.reject(error);}
  void replCleanup.catch(()=>{});
  if (!entry) {
    const projectionCleanup=hasMaterializationRetirement(host,sessionId);
    if(opts?.purgeHistory||projectionCleanup){try{await retirementBarrier(host,sessionId);}catch(error){cleanupErrors.push(error);}}
    if(!projectionCleanup){try{await host.store.release(sessionId);}catch(error){cleanupErrors.push(error);}}
    try{await backgroundCleanup;}catch(error){cleanupErrors.push(error);}
    try{await replCleanup;}catch(error){cleanupErrors.push(error);}
    if(cleanupErrors.length)throw new AggregateError(cleanupErrors,`GUI session close failed: ${cleanupErrors.map(String).join('; ')}`);
    if(opts?.purgeHistory)await purgeDeletedSession(host,sessionId,opts.meta);
    return;
  }
  entry.closed = true;
  entry.workerSwitchAbort?.abort();
  entry.queue = [];
  applyInjectQueueChange(host, entry);
  cancelStreamingPersist(host, sessionId);
  const wasBusy = entry.busy;
  if (entry.activeApproval) {
    entry.activeApproval.resolve({ approved: false, reason: t('会话已关闭') });
    entry.activeApproval = null;
  }
  if (entry.activeUserQuestion) {
    resolveUserQuestionInternal(host, entry, entry.activeUserQuestion.questionId, { kind: 'aborted' });
  }
  rejectSubagentApprovalsFor(host, entry, t('会话已关闭'));
  // node-repl 执行内核（worker_threads）随会话关闭释放：不释放则 vm 全局与
  // 用户代码留下的定时器在会话结束后永久滞留（CPU/内存泄漏）

  // 退出/切走前落盘，避免内存 entry 销毁后历史丢失
  try { persistEntry(host, entry, [entry.assistant]); } catch (error) { cleanupErrors.push(error); }
  const conn = retireConnection(host, entry);
  const pendingConnection = entry.connecting;
  // Register the in-flight connection before removing the entry, so a quick
  // reopen of the same session still waits for its cleanup.
  retirePendingConnection(host, entry, entry.connecting, conn);
  host.entries.delete(sessionId);
  try {
    // A close requested while driver.connect is still pending must not make
    // the UI wait on a provider that has not resolved yet. The in-flight
    // connection is already registered in the host barrier; late resolution
    // will be closed there, while reopen/purge paths still await it.
    if (!pendingConnection || opts?.purgeHistory) await retirementBarrier(host, sessionId);
    else void retirementBarrier(host, sessionId).catch((error: unknown) => {
      console.error(`[agentSession] late connection cleanup failed for ${sessionId}:`, error);
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try { endWorkspaceContext(entry); } catch (error) { cleanupErrors.push(error); }
  try {
    await host.store.release(sessionId);
  } catch (error) {
    cleanupErrors.push(error);
  }
  // skill 预算与「已注入」台账按会话保存，关闭时必须丢——否则 Map 随会话数无界增长
  skillTurnBook().forgetSession(sessionId);
  // 回合截图归属台账同理按会话丢（未收口就关会话的残留，防 Map 无界）
  turnTabLedger.clearSession(sessionId);
  // 回合中关闭：补一次 busy:false 收口（飞书流式卡等主进程订阅方依赖它定格；
  // 渲染层对该会话的订阅随删除自然失效，重复推送无感）
  if (wasBusy) push(host, { kind: 'busy', sessionId, busy: false, queued: 0 });
  try { await backgroundCleanup; } catch (error) { cleanupErrors.push(error); }
  try { await replCleanup; } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `GUI session close failed: ${cleanupErrors.map(String).join('; ')}`);
  if (opts?.purgeHistory) {
    // conn 已关、entry 已摘：引擎侧清理在连接释放后执行（Windows 下 Pi 若仍持有
    // 文件句柄，先删会 EBUSY）
    await purgeDeletedSession(host, sessionId, opts?.meta);
  }
}

/** Try both local and engine cleanup, then surface any failures to the caller. */
async function purgeDeletedSession(host: HostCore, sessionId: string, meta?: SessionMeta): Promise<void> {
  const errors: string[] = [];
  try { await host.store.flush(); host.store.delete(sessionId); }
  catch (error) { errors.push(String(error)); }
  try { await purgeEngine(host, sessionId, meta, { propagateFailure: true }); }
  catch (error) { errors.push(String(error)); }
  if (errors.length) throw new GuiSessionDataCleanupError(errors.join(t('；')));
}

/**
 * 引擎侧落盘清理（删除/清空共用）：按 meta.runtime 取 driver.purge，无需活连接。
 * 默认 best-effort；永久删除可要求上报驱动错误。Pi 的 purge 是纯同步 fs 操作（防 clear 后同 id
 * 新会话被异步间隙误删）；声明 purgeDefersOnBusy 的引擎（共享 ndjson 整文件重写）
 * 在有同引擎回合在跑时等其收口（上限 120s）再动手——固定睡一段对长回合只是把
 * 撞车时刻平移，等收口才能真避开与活 worker 追加写互踩。
 */
export async function purgeEngine(host: HostCore, sessionId: string, meta?: SessionMeta, opts?: { propagateFailure?: boolean }): Promise<void> {
  if (!meta?.runtime) return;
  const driver = host.drivers.get(meta.runtime);
  if (!driver?.purge) return;
  if (driver.purgeDefersOnBusy && hasBusyTurn(host, driver.runtimeId)) {
    await deferForBusyTurn(host, driver.runtimeId);
  }
  try {
    await driver.purge({
      sessionId,
      externalSessionId: meta.externalSessionId,
      runtimeResumeToken: meta.runtimeResumeToken
    });
  } catch (e) {
    console.warn(`[agentSession] 引擎侧数据清理失败 (${sessionId}, ${meta.runtime})`, e);
    if (opts?.propagateFailure) throw new Error(t('引擎侧数据清理失败（{{runtime}}）：{{error}}', { runtime: meta.runtime, error: String(e) }));
  }
}

/** 指定 runtime 是否有回合进行中（purge/sweep 错峰判断用） */
export function hasBusyTurn(host: HostCore, runtimeId: string): boolean {
  for (const e of host.entries.values()) {
    if (e.runtimeId === runtimeId && e.busy) return true;
  }
  return false;
}

/** 错峰等待：等指定引擎的忙回合收口（2s 轮询，上限 120s 防悬挂；后台定时器不阻止进程退出） */
export async function deferForBusyTurn(host: HostCore, runtimeId: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (hasBusyTurn(host, runtimeId) && Date.now() < deadline) {
    if (signal?.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 2_000);
      timer.unref?.();
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
  if (signal?.aborted) return;
  // M-9：到期仍忙时不再静默放行 purge/sweep——至少留下可观测线索（现有 SQLite 行级
  // 清理 + 维护串行链 + snapshotAt 护栏仍在，此日志用于事后归因）
  if (hasBusyTurn(host, runtimeId)) {
    console.warn(
      `[agentSession] deferForBusyTurn 等待 120s 到期，${runtimeId} 仍有忙回合，继续执行 purge/sweep（护栏：driver 内维护串行链 + snapshotAt 时效）`
    );
  }
}

/**
 * 启动孤儿清扫（一次）：应用侧 agent-sessions 孤儿文件 + 各 driver 引擎侧存量。
 * 覆盖早期版本「删除会话不清引擎数据」的遗留与 dropOrphanWorkspaceSessions 等
 * 异常路径；名单取自含 hidden 的注册表快照，后台执行、失败只 log。
 */
export async function sweepEngineOrphans(host: HostCore, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  try {
    const roster = host.ctx.sessions.engineSweepRoster();
    // 时效护栏基准取名单快照时刻：下面错峰等待不改基准，睡眠窗口内新建的
    // 会话即使不在名单里，其引擎数据也晚于 snapshotAt 而不被删
    const snapshotAt = Date.now();
    const liveIds = new Set(roster.map((r) => r.id));
    const bgTokens: string[] = [];
    for (const r of host.ctx.bgTasks?.taskParentPairs() ?? []) {
      if (liveIds.has(r.parentSessionId)) bgTokens.push(`bg-${r.id}`);
    }
    const sweptFiles = host.store.sweepOrphans(liveIds);
    if (sweptFiles > 0) {
      console.info(`[agentSession] 孤儿清扫：应用侧历史文件 ${sweptFiles} 个`);
    }
    for (const driver of host.drivers.values()) {
      if (signal?.aborted) return;
      if (!driver.sweepOrphans) continue;
      try {
        if (driver.purgeDefersOnBusy && hasBusyTurn(host, driver.runtimeId)) {
          await deferForBusyTurn(host, driver.runtimeId, signal);
        }
        if (signal?.aborted) return;
        await driver.sweepOrphans({ metas: roster, bgTokens, snapshotAt });
      } catch (e) {
        console.warn(`[agentSession] 引擎侧孤儿清扫失败 (${driver.runtimeId})`, e);
      }
    }
  } catch (e) {
    console.warn('[agentSession] 孤儿清扫失败', e);
  }
}

export function closeAll(host: HostCore): Promise<void> {
  const pending = shutdowns.get(host);
  if (pending) return pending;
  const shutdown = Promise.resolve().then(() => closeAllOwned(host));
  shutdowns.set(host, shutdown);
  return shutdown;
}

async function closeAllOwned(host: HostCore): Promise<void> {
  const errors: unknown[] = [];
  for (const id of new Set([...(host.openedSessionIds??[]),...host.entries.keys(),...archiveSessionIds(host)])) {
    try { await close(host, id); } catch (error) { errors.push(error); }
  }
  try { await drainRetirements(host); } catch (error) { errors.push(error); }
  try { await host.store.flush(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'GUI session shutdown failed');
}

/** before-quit 同步收口：closeAll 是异步的，退出时未必跑得完 */
export function flushPersist(host: HostCore): void {
  for (const entry of host.entries.values()) {
    persistEntry(host, entry, [entry.assistant]);
  }
  host.store.flushSync();
}

/** Async quit-barrier variant. It waits for write-behind commits instead of
 * relying on the synchronous emergency flush after the app has started closing. */
export async function flushPersistAsync(host: HostCore): Promise<void> {
  for (const entry of host.entries.values()) persistEntry(host, entry, [entry.assistant]);
  await host.store.flush();
}
