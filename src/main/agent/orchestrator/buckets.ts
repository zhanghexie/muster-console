import { replaceDisplay } from './eventBus';
/**
 * 桶生命周期：建立（含重启恢复）、持久化、清空。
 * （自 orchestrator.ts 拆分；逻辑逐字保留，`this.` 改经 OrchestratorHost 协作面。）
 */
import { getModeController } from '../providers/modeExtension';
import { app } from 'electron';
import { clearAttachments } from '../../attachments/service';
import { t } from '../../../shared/i18n';
import { schedulerModelRequestId } from '../../../shared/modelRequest';
import { clearModelRequests } from '../../agentSession/modelRequestStore';
import { publishModelRequestRecording } from '../../agentSession/modelRequestEvents';
import { initialCompactBreakerState, resetCompactBreaker } from '../../../shared/compactBreaker';
import { disposePiSessionResources } from '../providers/piProvider';
import { trackSchedulerCleanup } from './lifecycle';
import type { OrchestratorHost } from './internal';
import { collectRestoredQueue } from './queueOps';
import { loadSchedulerHistoryRange, loadSchedulerSessionMetadata, sanitizeRestoredSchedulerMessages, SchedulerSessionAdapter } from '../../runtimeKernel/schedulerSession';

/**
 * 取（或建）指定工作区的对话桶。新桶做重启恢复：display 里仍带 queued 标记的
 * 用户消息重建为待发送队列。
 */
export function ensureBucket(o: OrchestratorHost, workspaceId: string) {
  let b = o.buckets.get(workspaceId);
  if (!b) {
    const schedulerSession = new SchedulerSessionAdapter(app.getPath('userData'), workspaceId, { display: [], api: [] }, o.ctx.sessionLogs);
    const saved = schedulerSession.snapshot();
    const display = sanitizeRestoredSchedulerMessages(saved.display);
    if (display !== saved.display) schedulerSession.persist({ ...saved, display });
    // 重启恢复：display 里仍带 queued 标记的用户消息重建为待发送队列
    const restoredQueue = collectRestoredQueue(display);
    b = {
      schedulerSession,
      display,
      api: saved.api,
      piSession: null,
      piSessionFile: saved.piSessionFile,
      busy: false,
      resetPiOnNextSend: false,
      queue: restoredQueue,
      mode: o.modes[workspaceId] ?? 'default',
      providerId: o.models[workspaceId]?.providerId,
      modelId: o.models[workspaceId]?.modelId,
      thinkingLevel: o.thinkings[workspaceId],
      // R-12：新桶首轮注入调度记忆+态势（进程内标记，重启即视为新上下文）
      memoryInjectionDue: true,
      // B2：新桶熔断状态机初始态（未熔断、无计数）
      compactBreaker: initialCompactBreakerState()
    };
    o.buckets.set(workspaceId, b);
  }
  return b;
}

/** 桶落盘（display/api/会话文件指针） */
export function persistBucket(o: OrchestratorHost, workspaceId: string): void {
  const b = o.buckets.get(workspaceId);
  if (!b) return;
  if (b.schedulerSession) {
    b.schedulerSession.persistMetadata(b.api, b.piSessionFile);
    // Terminal flags and review settlement can mutate the active assistant
    // just before persist. Only this message is captured, never full history.
    if (b.streamingAssistant) b.schedulerSession.recordMessage(b.streamingAssistant, o.ctx.config.get().liveThinkingOnly !== false);
    return;
  }
  throw new Error(`Scheduler session is not initialized: ${workspaceId}`);
}

/**
 * 丢掉进程内 AgentSession（MCP 连接等）。
 * 下次 send 会从磁盘 continueRecent，不丢对话上下文。
 */
export function invalidatePiSession(o: OrchestratorHost, workspaceId?: string): void {
  if (workspaceId) {
    const b = o.buckets.get(workspaceId);
    if (!b) return;
    const prev = b.piSession;
    b.piSession = null;
    if (prev) trackSchedulerCleanup(o, disposePiSessionResources(prev, workspaceId));
    return;
  }
  for (const [id, b] of o.buckets) {
    const prev = b.piSession;
    b.piSession = null;
    if (prev) trackSchedulerCleanup(o, disposePiSessionResources(prev, id));
  }
}

/**
 * 清空指定区 UI 历史，并在下一轮强制新建 Pi 落盘会话。
 * R-12 记忆豁免：不碰 `.muster/scheduler/`（新对话不是白纸——下回合自动
 * 注入调度记忆+态势冷启动快照），仅重置注入标记。
 */
export function clearHistory(o: OrchestratorHost, wsId: string): void {
  const b = o.ensureBucket(wsId);
  if (b.busy) throw new Error(t('Agent 正忙，稍后再清空'));
  o.ctx.desktopEpochs?.endScheduler?.(wsId);
  clearAttachments(app.getPath('userData'), `scheduler:${wsId}`);
  const requestId = schedulerModelRequestId(wsId);
  clearModelRequests(app.getPath('userData'), requestId);
  publishModelRequestRecording(o.ctx, requestId, false);
  o.abortPendingAsk(wsId);
  b.display = [];
  b.api = [];
  b.queue = [];
  b.resetPiOnNextSend = true;
  b.piSessionFile = undefined;
  // B2/B3：会话重建 = 熔断恢复条件之一；旧会话的快照指针同时失效
  b.compactBreaker = resetCompactBreaker();
  b.transcriptPointer = undefined;
  b.memoryInjectionDue = true;
  // 清掉模式扩展里的旧计划状态
  getModeController(wsId)?.abandonPlan();
  o.invalidatePiSession(wsId);
  o.persistBucket(wsId);
  replaceDisplay(o, wsId, 'reset');
  o.emitContextStatus(wsId);
}

export function getColdHistoryRange(o: Pick<OrchestratorHost, 'ctx'>, workspaceId: string, before?: number, limit?: number, targetMessageId?: string) {
  return loadSchedulerHistoryRange(app.getPath('userData'), workspaceId, before, limit, targetMessageId, o.ctx.sessionLogs);
}

export function getColdSessionFile(o: Pick<OrchestratorHost, 'ctx'>, workspaceId: string): string | undefined {
  return loadSchedulerSessionMetadata(app.getPath('userData'), workspaceId, o.ctx.sessionLogs).piSessionFile;
}
