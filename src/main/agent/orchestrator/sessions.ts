import { replaceDisplay, publishCurrentHistory } from './eventBus';
import { publishHistoryRange } from './eventBus';
import { getColdHistoryRange } from './buckets';
import { resolveChatHistoryWindow } from '../../../shared/chatHistory';
/**
 * 调度会话档案：历史 Pi 会话的列举/重命名/删除/装载/分叉，以及工作区绑定切换。
 * R-12 去历史会话：聊天桶历史不再提供切换续聊，只放行无头定时任务桶的回看。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，逻辑逐字保留。）
 */
import { randomUUID } from 'node:crypto';
import { t } from '../../../shared/i18n';
import type { AgentSessionSummary, ChatMessage } from '../../../shared/types';
import {
  createForkedPiSession,
  deletePiSession,
  listPiSessions,
  loadPiSessionDisplay,
  renamePiSession
} from '../providers/piProvider';
import {
  bindOrchestratorFork,
  planOrchestratorForkRange,
  iterateOrchestratorForkMessages,
  iterateOrchestratorForkSeeds,
  cloneOrchestratorForkMessage
} from '../../../shared/orchestratorFork';
import { withoutDisplayThinking } from '../../../shared/thinkingDisplay';
import { pickSessionTitle } from '../../../shared/sessionTitle';
import { resetCompactBreaker } from '../../../shared/compactBreaker';
import {
  isOpenableSchedulerSessionFile,
  listableSchedulerSessions
} from '../../../shared/schedulerSessions';
import type { OrchestratorHost } from './internal';
import { beginSchedulerWorkspaceContext, captureSchedulerWorkspaceContext } from '../schedulerWorkspaceContext';
import { assertWorkspaceExecutionContextCurrent } from '../../workspaceExecutionContext';
import { purgeSchedulerReminders } from '../../sessionReminders/service';
import { errorMessage } from '../../../shared/errors';

/**
 * 调度面板历史会话列表（R-12 去历史会话）：只保留**无头定时任务桶**的回看入口；
 * 聊天桶历史不再提供切换续聊——跨会话上下文由 .muster/scheduler/ 双文件
 * 记忆通道承载（新对话首轮自动注入）。
 */
export async function listSessions(o: OrchestratorHost, wsId: string): Promise<AgentSessionSummary[]> {
  const all = await listPiSessions(o.ctx, wsId);
  return listableSchedulerSessions(all);
}

/** 重命名一个历史 Pi 会话（追加 session_info 条目） */
export async function renameSession(
  o: OrchestratorHost,
  wsId: string,
  sessionFile: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  return renamePiSession(o.ctx, wsId, sessionFile, name);
}

/**
 * 删除一个历史 Pi 会话。若删的正是当前桶绑定的会话，清掉桶内指针与 display，
 * 下次 send 会新建落盘会话，避免指向已删除文件。
 */
export async function deleteSession(
  o: OrchestratorHost,
  wsId: string,
  sessionFile: string
): Promise<{ ok: boolean; error?: string }> {
  // Cold deletes resolve the active branch too; a fork pointer must never be
  // left bound to a Pi archive that this operation just removed.
  const boundBeforeDelete = (o.buckets.get(wsId) ?? o.ensureBucket(wsId)).piSessionFile === sessionFile;
  try { if (boundBeforeDelete) o.ctx.desktopEpochs?.endScheduler?.(wsId); }
  catch (error) { return { ok: false, error: errorMessage(error) }; }
  const res = await deletePiSession(o.ctx, wsId, sessionFile);
  if (!res.ok) return res;
  let cleanupError: unknown;
  let cleanupFailed = false;
  try { purgeSchedulerReminders(wsId, sessionFile); }
  catch (error) { cleanupError = error; cleanupFailed = true; }
  const b = o.buckets.get(wsId);
  if (b && b.piSessionFile === sessionFile) {
    if (!boundBeforeDelete) {
      try { o.ctx.desktopEpochs?.endScheduler?.(wsId); }
      catch (error) { cleanupError = t('桌面任务撤销失败：{{error}}', { error: errorMessage(error) }); cleanupFailed = true; }
    }
    b.display = [];
    b.api = [];
    b.queue = [];
    b.piSessionFile = undefined;
    b.resetPiOnNextSend = true;
    // 删除即会话重建：熔断状态与快照指针随之失效
    b.compactBreaker = resetCompactBreaker();
    b.transcriptPointer = undefined;
    o.invalidatePiSession(wsId);
    o.persistBucket(wsId);
    replaceDisplay(o, wsId, 'reset');
    o.emitContextStatus(wsId);
  }
  return cleanupFailed ? { ok: false, error: t('会话已删除，但清理失败：{{error}}', { error: errorMessage(cleanupError) }) } : { ok: true };
}

/**
 * 重命名当前绑定 Pi 会话（调度 Agent 自我命名）。作用于桶内 piSessionFile；
 * 若当前还没有落盘会话（清空后尚未 send），返回错误提示先发一条消息。
 */
export async function renameCurrentSession(
  o: OrchestratorHost,
  wsId: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const b = o.ensureBucket(wsId);
  if (!b.piSessionFile) {
    return { ok: false, error: t('当前还没有可命名的会话，先发一条消息生成会话后再命名') };
  }
  return renamePiSession(o.ctx, wsId, b.piSessionFile, name);
}

/**
 * 装载一个历史 Pi 会话到调度面板：display 重建为只读消息，
 * 桶内记住文件指针，下一次 send 从该会话续聊。
 *
 * R-12 去历史会话：只放行**定时任务桶**内的文件（回看无头任务运行）；
 * 聊天桶历史文件拒绝装载——改由调度记忆通道承载跨会话上下文。
 */
export async function openSession(
  o: OrchestratorHost,
  wsId: string,
  sessionFile: string,
  beforeCommit?: () => boolean
): Promise<{ ok: boolean; error?: string }> {
  const b = o.ensureBucket(wsId);
  if (b.busy) return { ok: false, error: t('Agent 正忙，请等当前回合结束后再切换会话') };
  const original = { display: b.display, contents: JSON.stringify(b.display), file: b.piSessionFile,
    session: b.piSession, reset: b.resetPiOnNextSend };
  const taskDir = o.ctx.store.getPiSessionDir(`${wsId}:tasks`);
  if (!isOpenableSchedulerSessionFile(sessionFile, taskDir)) {
    return {
      ok: false,
      error: t('只能打开定时任务会话：调度对话历史已由长期记忆（.muster/scheduler/）承载')
    };
  }
  let display: ChatMessage[];
  try {
    display = await loadPiSessionDisplay(o.ctx, wsId, sessionFile);
  } catch (e) {
    return { ok: false, error: t('会话读取失败：{{message}}', { message: (e as Error).message }) };
  }
  if (o.buckets.get(wsId) !== b || b.busy || b.display !== original.display || JSON.stringify(b.display) !== original.contents ||
      b.piSessionFile !== original.file || b.piSession !== original.session || b.resetPiOnNextSend !== original.reset) {
    return { ok: false, error: t('读取期间会话已变化，请重试') };
  }
  if (!display.length) {
    // 进行中的无头会话文件可能刚建好、消息还没刷盘——仍允许进去回看
    display = [
      {
        id: randomUUID(),
        role: 'assistant',
        content: t('会话仍在进行或刚开始写入，稍后再打开可看到后续消息。'),
        createdAt: Date.now()
      }
    ];
  }
  if (beforeCommit && !beforeCommit()) return { ok: false };
  try { o.ctx.desktopEpochs?.endScheduler?.(wsId); }
  catch (error) { return { ok: false, error: errorMessage(error) }; }
  o.abortPendingAsk(wsId);
  b.display = display;
  b.api = [];
  b.queue = [];
  b.piSessionFile = sessionFile;
  b.resetPiOnNextSend = false;
  // 切到另一份会话文件：旧会话的熔断计数与快照指针不跨会话携带
  b.compactBreaker = resetCompactBreaker();
  b.transcriptPointer = undefined;
  o.invalidatePiSession(wsId);
  o.persistBucket(wsId);
  replaceDisplay(o, wsId, 'native-import');
  o.emitContextStatus(wsId);
  return { ok: true };
}

/**
 * 从历史某条消息分叉出新调度对话：历史前缀作种子写入新 Pi 会话文件，
 * 原会话文件不动（可从历史抽屉打开）。切到新会话后下次 send 续该文件。
 */
export async function forkSession(
  o: OrchestratorHost,
  uptoMessageId: string,
  wsId: string
): Promise<{ ok: boolean; sessionFile?: string; originalSessionFile?: string; error?: string }> {
  const b = o.ensureBucket(wsId);
  const plan = planOrchestratorForkRange({
    busy: b.busy,
    messages: b.display,
    uptoMessageId
  });
  if (!plan.ok || plan.end === undefined || !plan.title) {
    return { ok: false, error: plan.error };
  }

  const liveThinkingOnly = o.ctx.config.get().liveThinkingOnly !== false;
  const targetModel = { providerId: b.providerId, modelId: b.modelId };
  const original = { display: b.display, length: b.display.length, adapter: b.schedulerSession, revision: b.schedulerSession?.forkSourceRevision, file: b.piSessionFile,
    session: b.piSession, reset: b.resetPiOnNextSend };
  let originalFile = b.piSessionFile;
  let release: (() => void) | undefined;
  const files: string[] = [];
  let published = false;
  let prepared: Awaited<ReturnType<NonNullable<typeof b.schedulerSession>['prepareFork']>> | undefined;
  try {
    const workspaceContext = captureSchedulerWorkspaceContext(o.ctx.config.get(), wsId, b.piSession, b.piSessionFile);
    release = beginSchedulerWorkspaceContext(o.ctx.config, workspaceContext, { publish: false, id: `fork:${wsId}` });
    if (!originalFile) {
      const origTitle = pickSessionTitle({ firstMessage: b.display.find((m) => m.role === 'user' && !m.host)?.content });
      const orig = await createForkedPiSession(o.ctx, wsId, iterateOrchestratorForkSeeds(iterateOrchestratorForkMessages(original.display)), origTitle,
        targetModel, { workspaceContext });
      if (!orig.ok || !orig.sessionFile) throw new Error(orig.error ?? t('无法写入分叉会话文件'));
      originalFile = orig.sessionFile;
      files.push(originalFile);
    }
    const created = await createForkedPiSession(o.ctx, wsId, iterateOrchestratorForkSeeds(iterateOrchestratorForkMessages(original.display, plan.end)), plan.title, targetModel,
      { workspaceContext, parentFile: originalFile });
    if (!created.ok || !created.sessionFile) throw new Error(created.error ?? t('无法写入分叉会话文件'));
    files.push(created.sessionFile);
    assertWorkspaceExecutionContextCurrent(o.ctx.config.get(), workspaceContext);
    // Only changes to copied facts invalidate the fork. Late undo/review
    // receipts are stripped from every branch and may finish after agent:done.
    const assertCurrent = (): void => {
      if ((o.ctx.config.get().liveThinkingOnly !== false) !== liveThinkingOnly ||
          o.buckets.get(wsId) !== b || b.busy || b.display !== original.display ||
          b.display.length !== original.length || b.schedulerSession !== original.adapter ||
          b.schedulerSession?.forkSourceRevision !== original.revision || b.piSessionFile !== original.file ||
          b.piSession !== original.session || b.resetPiOnNextSend !== original.reset) throw new Error(t('分叉期间会话已变化，请重试'));
    };
    assertCurrent();
    const copied = Array.from(iterateOrchestratorForkMessages(original.display, plan.end), message =>
      cloneOrchestratorForkMessage(liveThinkingOnly ? withoutDisplayThinking([message])[0] : message));
    if (b.schedulerSession) prepared = await b.schedulerSession.prepareFork(copied, created.sessionFile, uptoMessageId);
    assertCurrent();
    assertWorkspaceExecutionContextCurrent(o.ctx.config.get(), workspaceContext);
    o.ctx.desktopEpochs?.endScheduler?.(wsId);
    o.abortPendingAsk(wsId);
    const bound = bindOrchestratorFork({ copied, newSessionFile: created.sessionFile, originalSessionFile: originalFile });
    // Publish the already-flushed semantic child before rebinding memory. A
    // crash sees either the original branch or the complete new one.
    if (prepared) { prepared.publishFork(); b.schedulerSession = prepared; }
    b.display = bound.display;
    b.api = [];
    b.queue = [];
    b.piSessionFile = bound.piSessionFile;
    b.resetPiOnNextSend = bound.resetPiOnNextSend;
    published = true;
    // 分叉产出新会话文件：熔断计数与快照指针不跨会话携带
    b.compactBreaker = resetCompactBreaker();
    b.transcriptPointer = undefined;
    o.invalidatePiSession(wsId);
    o.persistBucket(wsId);
    publishCurrentHistory(o, wsId);
    o.emitContextStatus(wsId);
    return { ok: true, sessionFile: bound.piSessionFile, originalSessionFile: bound.originalSessionFile };
  } catch (error) {
    let message = (error as Error).message;
    if (!published && prepared) {
      try { await prepared.discardFork(); }
      catch (cleanupError) { message += `\n${(cleanupError as Error).message}`; }
    }
    if (!published) for (const file of files) {
      try {
        const cleaned = await deletePiSession(o.ctx, wsId, file);
        if (!cleaned.ok) message += `\n${file}: ${cleaned.error}`;
      } catch (cleanupError) {
        message += `\n${file}: ${(cleanupError as Error).message}`;
      }
    }
    return { ok: false, error: message,
      ...(published ? { sessionFile: b.piSessionFile, originalSessionFile: originalFile } : {}) };
  } finally { release?.(); }
}

/** 切换工作区：只换绑定指针 + 推送目标区历史；不拆进行中回合 */
export function bindWorkspace(o: OrchestratorHost, workspaceId: string): void {
  if (workspaceId === o.workspaceId) return;
  // 闲时落盘旧区；忙时桶内 display 仍完整，结束时会再 persist
  const prev = o.buckets.get(o.workspaceId);
  if (prev && !prev.busy) o.persistBucket(o.workspaceId);
  o.workspaceId = workspaceId;
  const b = o.buckets.get(workspaceId);
  if (!b) {
    publishHistoryRange(o, workspaceId, getColdHistoryRange(o, workspaceId));
    return;
  }
  const {start,end} = resolveChatHistoryWindow(b.display);
  publishHistoryRange(o, workspaceId, {messages:b.display.slice(start,end),before:start,total:b.display.length,hasEarlier:start>0});
}
