import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { SafetyOperation, SafetyService } from '../../shared/safety';
import {
  currentAgentSessionId,
  currentAgentWorkspaceId,
  isSchedulerInvocation,
} from '../agent/agentScope';
import { createSafetyService, type SafetyServiceOptions } from './service';
import { safetyRisk, operationFingerprint } from './policy';
import { isConfirmed } from '../../shared/confirmDialog';
import { redactSafetyEvidence } from './redact';
import { t } from '../../shared/i18n';
import { localizeSafetyReason, localizeSafetySummary } from '../../shared/safetyReason';
export type SafetyOperationInput = Omit<
  SafetyOperation,
  'workspaceId' | 'actorId'
> & { workspaceId?: string; actorId?: string };
type SafetyContext = AppContext & { safety?: SafetyService | null };
/** Every business gate has a human UI fallback, including callers without a custom review sheet. */
function confirmSafetyOperation(ctx: AppContext, op: SafetyOperation, reason: string, signal?: AbortSignal): Promise<boolean> {
  const safe = redactSafetyEvidence({ action: op.action, summary: op.summary, args: op.args });
  const workspace = ctx.config.get().workspaces.find(w => w.id === op.workspaceId);
  const displayedReason = localizeSafetyReason(reason);
  return ctx.ui.confirm(t('审批需要你确认'), displayedReason, {
    dangerous: true, signal,
    summary: `${workspace?.name || t('当前工作区')} · ${safe.summary ? localizeSafetySummary(safe.action, safe.summary) : safe.action}\n${JSON.stringify(safe.args, null, 2)}`,
    confirmNote: displayedReason, confirmLabel: t('批准本次操作'), cancelLabel: t('拒绝')
  }).then(isConfirmed);
}
export function createSafetyServiceForContext(
  ctx: AppContext,
  options: Omit<SafetyServiceOptions, 'reviewer'>,
): SafetyService {
  let reviewer: import('./pi').SafetyReviewer | undefined;
  const invoke: import('./pi').SafetyReviewer = async (request, signal) => {
    const { createSafetyPiReviewer } = await import('./pi');
    reviewer ??= createSafetyPiReviewer({
      config: () => ctx.config.get(),
      targetModel: (workspaceId) =>
        ctx.orchestrator?.schedulerModelFor(workspaceId),
      directory: path.join(userDataStorage(options.userDataPath).resolve('app', 'safety'), 'pi-home'),
    });
    return reviewer(request, signal);
  };
  invoke.release = (id) => reviewer?.release?.(id);
  invoke.dispose = () => reviewer?.dispose?.();
  return createSafetyService({
    ...options,
    captureTrustedState: (op) => captureSafetyContext(ctx, op),
    humanConfirm: options.humanConfirm ?? ((op, reason, signal) => confirmSafetyOperation(ctx, op, reason, signal)),
    reviewer: invoke,
  });
}
/** Host closures retain object identity; payloads cannot forge these lifecycle tokens. */
export function captureSafetyContext(
  ctx: AppContext,
  op: SafetyOperation,
): () => boolean {
  const scheduler = isSchedulerInvocation();
  const entry = op.actorId
    ? ctx.agentSessions?.entries.get(op.actorId)
    : undefined;
  const meta = op.actorId ? ctx.sessions.peek(op.actorId) : undefined;
  const sessionToken = meta && op.actorId ? ctx.sessions.sessionScopeToken(op.actorId) : undefined;
  const bucket = scheduler
    ? ctx.orchestrator?.buckets.get(op.workspaceId)
    : undefined;
  const session = bucket?.piSession,
    assistant = bucket?.streamingAssistant;
  const executionId = entry?.execution?.id,
    started = entry?.activeTurnStartedAt,
    connection = entry?.connection;
  const token = () => {
    const config = ctx.config.get(),
      matches = config.workspaces.filter((w) => w.id === op.workspaceId);
    if (matches.length !== 1 || matches[0].rootsError)
      throw new Error('安全工作区已删除或无效');
    const w = matches[0],
      selected = ctx.orchestrator?.schedulerModelFor(op.workspaceId);
    const providerId = selected?.providerId || config.llm?.activeProviderId,
      modelId = selected?.modelId || config.llm?.activeModelId;
    const provider = config.llm?.providers.find((p) => p.id === providerId);
    return createHash('sha256')
      .update(
        JSON.stringify({
          roots: w.roots,
          path: w.path,
          controlRoot: w.controlRoot,
          revision: w.rootsRevision,
          defaultRootId: w.defaultRootId,
          providerId,
          modelId,
          provider,
        }),
      )
      .digest('hex');
  };
  const captured = token();
  if (op.actorId && (!meta || !sessionToken || meta.workspaceId !== op.workspaceId || meta.archived))
    throw new Error('安全操作会话不存在');
  return () => {
    try {
      if (token() !== captured) return false;
      if (
        entry &&
        (ctx.agentSessions?.entries.get(op.actorId!) !== entry ||
          entry.closed ||
          entry.abortRequested ||
          entry.clearing ||
          entry.workspaceId !== op.workspaceId ||
          entry.execution?.id !== executionId ||
          entry.activeTurnStartedAt !== started ||
          entry.connection !== connection)
      )
        return false;
      if (
        meta &&
        (ctx.sessions.peek(op.actorId!) !== meta ||
          ctx.sessions.sessionScopeToken(op.actorId!) !== sessionToken ||
          meta.archived ||
          meta.workspaceId !== op.workspaceId)
      )
        return false;
      if (
        scheduler &&
        (!bucket ||
          ctx.orchestrator?.buckets.get(op.workspaceId) !== bucket ||
          bucket.piSession !== session ||
          bucket.streamingAssistant !== assistant ||
          !bucket.busy)
      )
        return false;
      return true;
    } catch {
      return false;
    }
  };
}
export async function authorizeSafetyOperation(
  ctx: SafetyContext,
  input: SafetyOperationInput,
) {
  const bound = currentAgentWorkspaceId(),
    workspaceId = bound ?? input.workspaceId ?? ctx.resolveBubbleWorkspaceId();
  if (
    !workspaceId ||
    (bound && input.workspaceId && bound !== input.workspaceId)
  )
    throw new Error('安全操作工作区与宿主作用域不匹配');
  const actorId = currentAgentSessionId() ?? input.actorId;
  if (
    currentAgentSessionId() &&
    input.actorId &&
    currentAgentSessionId() !== input.actorId
  )
    throw new Error('安全操作身份与宿主作用域不匹配');
  const operation: SafetyOperation = { ...input, workspaceId, actorId };
  operation.humanConfirm ??= (reason, signal) => confirmSafetyOperation(ctx, operation, reason, signal);
  let auditUnavailable = false;
  let fallbackReason = '安全服务未就绪，请确认本次高危操作';
  if (ctx.safety) {
    const result = await ctx.safety.authorize(operation);
    if (!result.auditUnavailable || result.cancelled) return result;
    if (result.humanDecision !== undefined) return {
      ...result,
      allowed: result.humanDecision && !operation.signal?.aborted,
      reason: `${result.humanDecision ? '人工批准本次操作' : '人工拒绝本次操作'}；审批记录暂不可保存`
    };
    auditUnavailable = true;
    fallbackReason = '审批记录暂时无法保存，本次改由人工直接决定；此次决定无法写入审批历史。';
  }
  const requestId = randomUUID(),
    fingerprint = operationFingerprint(operation);
  // Missing service is never approval for a dangerous operation. Same service policy and bounded fallback.
  if (input.signal?.aborted)
    return {
      allowed: false,
      requestId,
      risk: safetyRisk(operation),
      reason: '调用已取消',
      cancelled: true,
    };
  if (safetyRisk(operation) === 'routine')
    return {
      allowed: true,
      requestId,
      risk: 'routine' as const,
      reason: '例行操作，沿用既有授权',
    };
  let currentTrusted: () => boolean;
  try { currentTrusted = captureSafetyContext(ctx, operation); }
  catch { return { allowed: false, requestId, risk: 'high' as const, reason: '人工确认目标作用域无效', cancelled: true }; }
  const current = () => !input.signal?.aborted && currentTrusted() && operationFingerprint(operation) === fingerprint;
  const confirmation = new AbortController();
  let monitor: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const stopped = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 300000);
      cancel = () => resolve(false);
      input.signal?.addEventListener('abort', cancel, { once: true });
      monitor = setInterval(() => { if (!current()) resolve(false); }, 50);
      monitor.unref();
    });
    const accepted = await Promise.race([
      operation.humanConfirm(fallbackReason, confirmation.signal),
      stopped,
    ]);
    return {
      allowed:
        accepted &&
        current(),
      requestId,
      risk: 'high' as const,
      reason: current() ? `${accepted ? '人工批准本次操作' : '人工未批准本次操作'}${auditUnavailable ? '；审批记录暂不可保存' : ''}` : '人工确认期间目标作用域已变化',
      ...(auditUnavailable ? { auditUnavailable: true } : {}),
      escalated: true,
      cancelled: !current(),
    };
  } catch {
    return {
      allowed: false,
      requestId,
      risk: 'high' as const,
      reason: '人工确认失败',
      escalated: true,
    };
  } finally {
    confirmation.abort();
    clearInterval(monitor);
    if (timer) clearTimeout(timer);
    if (cancel) input.signal?.removeEventListener('abort', cancel);
  }
}
