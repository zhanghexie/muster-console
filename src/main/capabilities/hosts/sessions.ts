import { createSessionWithTask } from './creation';
import { sendSessionMail } from '../../messages/assignment';
import { requireSessionIsolation, requireExplicitRepoSets, type SessionIsolation } from '../../../shared/sessionIsolation';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context';
import { observeHost } from '../../sessions/observe';
import { registeredWorktreeSession, resolveSessionTarget } from '../../sessions/targets';
import { resolveDefaultIsolationGroup } from '../../sessions/defaultIsolation';
import { taskWorktreeOwnership } from '../../git/worktreeTaskOperation';
import { buildIntegrateRequestMessage } from '../../../shared/integrateRequest';
import { captureWorktreeSelectionSources } from '../../git/worktreeSelectionSources';
import { holdPendingSource } from '../../workspaceRootUses';
import type { GuiWorkerMode, SessionMeta } from '../../../shared/types';
import { currentAgentSessionId, isSchedulerInvocation } from '../../agent/agentScope';
import { executeSessionUpdate, planSessionUpdate, type SessionUpdateInput } from '../sessionUpdate';
import { capsuleForSetStatus, normalizeSetStatus } from '../../../shared/setStatus';
import { phaseWriteBlocked } from '../../../shared/boardStatus';
import {
  applySchedulerSetStatus,
  resolveSetStatusChannel
} from '../../../shared/schedulerStatus';
import {
  canReviewSession,
  canCompleteAndArchiveSession,
  isReviewDecision,
  rejectInjectText
} from '../../../shared/boardReview';
import {
  dimensionGateBadgeLabel,
  dimensionGateDetailText,
  dimensionGateOverrideNote,
  hasRedGate
} from '../../../shared/dimensionGates';
import {
  afterNeedsYouReported,
  beforeRequestIntegrate
} from '../../agentSession/workerTreeGuard';
import { t } from '../../../shared/i18n';
import { pickConfirmNote } from '../../../shared/confirmDialog';
import { normalizeCloseBatchIds, planCloseBatch } from '../../../shared/sessionCloseBatch';
import {
  buildIntegrateFailNotifyPush,
  resolveIntegrateApproval,
  shouldNotifyUserOnIntegrateFail
} from '../../../shared/integrateApproval';
import {
  AGENT_MESSAGE_SCHEDULER_TARGET,
  AGENT_MESSAGE_TEXT_MAX,
  isAgentMessageKind,
  type AgentMessageKind
} from '../../../shared/agentMessage';
import { deliverAgentMessage } from '../../messages/deliver';
import { sendInterruptMail } from '../../messages/interrupt';
import { ESCALATE_BUDGET_LIMIT, escalateBudgetKey } from '../../../shared/escalateBudget';
import { ACTOR_SESSION_ID_ARG } from './actors';
import { resolveLaunchConfiguration } from '../../../shared/guiInheritMeta';
import { resolveQueryIds } from '../../../shared/sessionQuery';
import {
  buildSessionHaystack,
  parseSessionSearchQuery,
  parseSessionSearchScope,
  planSessionSearchScan,
  searchSessionDocs,
  sessionBelongsToSearchScope,
  SESSION_SEARCH_COMMIT_MIN,
  SESSION_SEARCH_SCAN_MAX_CHARS,
  type SessionSearchDoc
} from '../../../shared/sessionSearch';

function resolveHostSessionId(ctx: AppContext, sessionId: string): string {
  return ctx.sessions.resolveSessionRef({ sessionId }).id;
}

/**
 * 巨型 meta 字段裁剪：会话启动失败时 launchError 可能记录整屏 ANSI 终端帧
 * （实测 37 万字符），而 sessions.observe 会被 Agent/扩展/Woker 经 shellApi 拉取，
 * 序列化超限导致 JSON 截断损坏（派活轮询 sessions.observe 直接炸）。
 * 仅保留头部 + 省略提示，不影响 UI（UI 只展示错误概要）。
 */
function slimSessionMeta(s: SessionMeta): SessionMeta {
  const meta = s.meta;
  if (!meta || !meta.launchError) return s;
  const le = meta.launchError;
  if (le.length <= 400) return s;
  return {
    ...s,
    meta: {
      ...meta,
      launchError: `${le.slice(0, 400)}${t('…（省略 {{n}} 字符）', { n: le.length - 400 })}`
    }
  };
}

function notifyUserIntegrateFail(
  ctx: AppContext,
  s: Pick<SessionMeta, 'id' | 'name' | 'workspaceId'>,
  err: unknown
): void {
  if (!ctx.notify?.push) return;
  const reason = err instanceof Error ? err.message : String(err);
  try {
    const workspaceId = s.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
    ctx.notify.push(
      buildIntegrateFailNotifyPush({
        workspaceId,
        sessionId: s.id,
        sessionName: s.name,
        reason
      })
    );
  } catch (notifyErr) {
    console.error('[sessions] integrate fail notify failed', notifyErr);
  }
}

async function updateSession(ctx: AppContext, input: SessionUpdateInput): Promise<unknown> {
  const workerId = currentAgentSessionId();
  const caller = isSchedulerInvocation() ? { kind: 'scheduler' as const }
    : workerId ? { kind: 'worker' as const, sessionId: workerId } : null;
  if (!caller) throw new Error('Session update requires an authenticated agent identity');
  if (!input || typeof input !== 'object') throw new Error('Session update parameters are required');
  if (input.sessionId !== undefined && typeof input.sessionId !== 'string') throw new Error('sessionId must be a string');
  const requested = input.sessionId?.trim();
  if (!requested && caller.kind === 'scheduler') {
    if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'name') || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('Only the scheduler title can be changed without a session target');
    }
    return executeSessionUpdate([{ tool: 'sessions.rename', args: { sessionId: '', name: input.name.trim() } }],
      async operation => sessionsHost['sessions.rename'](ctx, operation.args as { sessionId: string; name: string }));
  }
  const id = resolveHostSessionId(ctx, requested || (caller.kind === 'worker' ? caller.sessionId : ''));
  const target = ctx.sessions.get(id);
  if (!target) throw new Error('Session not found');
  const operations = planSessionUpdate({ ...input, sessionId: id }, caller, target);
  return executeSessionUpdate(operations, async operation => {
    switch (operation.tool) {
      case 'sessions.rename': return sessionsHost['sessions.rename'](ctx, operation.args);
      case 'sessions.setPinned': return sessionsHost['sessions.setPinned'](ctx, operation.args);
      case 'sessions.setArchived': return sessionsHost['sessions.setArchived'](ctx, operation.args);
      case 'sessions.setOrchestrated': return sessionsHost['sessions.setOrchestrated'](ctx, operation.args);
      case 'sessions.setModel': return sessionsHost['sessions.setModel'](ctx, operation.args);
      case 'sessions.setThinking': return sessionsHost['sessions.setThinking'](ctx, operation.args);
    }
  });
}

export const sessionsHost = {
  // Internal implementation; projection into the unified public tool surface is separate.
  'sessions.update': updateSession,
  'sessions.observe': observeHost,
  'sessions.isolate': async (ctx: AppContext, args: { sessionId: string; isolationGroups: import('../../../shared/types').WorkspaceWorktreeGroupSelection[]; apply?: boolean }) => {
    requireExplicitRepoSets(args.isolationGroups);
    const id = resolveHostSessionId(ctx, args.sessionId);
    const session = ctx.sessions.get(id);
    if (!session || session.workspaceId !== ctx.resolveBubbleWorkspaceId()) throw new Error('session is outside the current workspace');
    return ctx.sessions.isolateRepositories(id, args.isolationGroups, args.apply === true);
  },

  /**
   * 按路径 / 提交 / 关键词检索历史会话（只读 grep 落盘转写 + 元数据）。
   * 不 select、不写盘。默认当前工作区；workspaceId=*|all 查本机全部区。含归档、不含 hidden。
   * session-search F-01：<7 位 commit 入口报错（不再静默零命中）；
   * F-02：扫描带会话数/字节预算（新→旧，超预算截掉最旧，结果带 truncated 信号）。
   */
  'sessions.search': (
    ctx: AppContext,
    args?: { path?: string; commit?: string; q?: string; workspaceId?: string; limit?: number }
  ) => {
    const parsed = parseSessionSearchQuery(args);
    if ('error' in parsed) {
      if (parsed.error === 'short-commit') {
        throw new Error(t('commit 线索至少需要 {{min}} 位（收到 {{n}} 位），请补全后再搜', {
          min: SESSION_SEARCH_COMMIT_MIN,
          n: parsed.commit.length
        }));
      }
      throw new Error(t('sessions.search 需要 path、commit 或 q 之一'));
    }
    const currentWs = ctx.resolveBubbleWorkspaceId();
    const scope = parseSessionSearchScope(args?.workspaceId, currentWs);
    const wsNames = new Map(ctx.workspaces.list().map((w) => [w.id, w.name] as const));
    const docs: SessionSearchDoc[] = [];
    // F-02：先按 lastUsedAt 新→旧排序再读盘，预算尽时截掉的是最旧会话
    const inScope = ctx.sessions
      .list()
      .filter((s) => sessionBelongsToSearchScope(s.workspaceId, scope, currentWs));
    const scan = planSessionSearchScan(inScope);
    let scannedChars = 0;
    for (const s of scan.ordered) {
      if (scannedChars >= SESSION_SEARCH_SCAN_MAX_CHARS) {
        scan.truncated = true;
        break;
      }
      // Search consumes the same chronological prefix as before, but opens only
      // the next page when the character budget still needs more text.
      function* messages() {
        if (!ctx.sessions.isChatRuntime(s.runtime) || !ctx.agentSessions) return;
        let end = 120, limit = 120;
        for (;;) {
          const page = ctx.agentSessions.getHistoryRange(s.id, end, limit);
          if (!page) return;
          yield* page.messages;
          const next = page.before + page.messages.length;
          if (next >= page.total) return;
          if (next < end) throw new Error('Session search range did not advance');
          end = Math.min(next + 120, page.total);
          limit = end - next;
        }
      }
      const haystack = buildSessionHaystack({
        name: s.name,
        cwd: s.cwd,
        worktreePath: s.worktreePath,
        worktreeBranch: s.worktreeBranch,
        messages: messages()
      }, SESSION_SEARCH_SCAN_MAX_CHARS - scannedChars);
      scannedChars += haystack.length;
      docs.push({
        sessionId: s.id,
        name: s.name,
        ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
        ...(s.workspaceId && wsNames.get(s.workspaceId)
          ? { workspaceName: wsNames.get(s.workspaceId) }
          : {}),
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt ?? s.createdAt,
        ...(s.archived ? { archived: true } : {}),
        ...(s.runtime ? { runtime: s.runtime } : {}),
        haystack
      });
    }
    const sessions = searchSessionDocs(docs, parsed);
    return {
      workspaceId: scope,
      count: sessions.length,
      limit: parsed.limit,
      sessions,
      selected: false,
      // F-02：预算截断信号——true 表示有范围内会话因会话数/字节预算未被扫描
      ...(scan.truncated ? { truncated: true } : {})
    };
  },

  'terminal.create': async (ctx: AppContext, args: { shellProfileId: string; name?: string; workspaceId?: string; rootId?: string; cwd?: string; rootsRevision?: number; select?: boolean }): Promise<SessionMeta> => {
    const allowed = new Set(['shellProfileId', 'name', 'workspaceId', 'rootId', 'cwd', 'rootsRevision', 'select', ACTOR_SESSION_ID_ARG]);
    const extra = Object.keys(args).filter(key => !allowed.has(key));
    if (extra.length) throw new Error(`terminal.create does not accept Agent options: ${extra.join(', ')}`);
    if (!args.shellProfileId?.trim()) throw new Error('shellProfileId is required.');
    return await sessionsHost['sessions.create'](ctx, { ...args, isolation: 'shared' }) as SessionMeta;
  },

  'sessions.create': async (
    ctx: AppContext,
    args: {
      name?: string;
      runtime?: string;
      cwd?: string;
      workspaceId?: string;
      rootId?: string;
      task?: string;
      asSubagent?: boolean;
      /** 已停用（F-04）：出现即拒（含纯建会话分支）。角色由宿主轮选；显式角色仅剩内部可信路径（重试复用/队列重入直调 delegateTask） */
      characterId?: string;
      shellProfileId?: string;
      /** 模型必须明确选择，隔离时还须明确仓库范围。 */
      isolation: SessionIsolation;
      rootsRevision?: number;
      isolationGroups?: import('../../../shared/types').WorkspaceWorktreeGroupSelection[];
      /** GUI（chat surface）会话初始态：仅 chat runtime 生效；preset/模式产生首条消息后不可更换 */
      configurePermissions?: boolean;
      guiMode?: GuiWorkerMode;
      nativeConfig?: import('../../../shared/nativeSessionConfig').NativeConfigIntent;
      piModeId?: string;
      acpPresetId?: string;
      cliLaunchOptions?: import('../../../shared/cliLaunchOptions').CliLaunchOptions;
      target?: unknown;
      inherit?: boolean;
      model?: { providerId: string; modelId: string };
      thinking?: 'off' | 'low' | 'medium' | 'high' | 'max';
      modelParameters?: import('../../../shared/modelParameters').ModelParameterValues;
      /** 是否选中中栏（R8）；缺省 true */
      select?: boolean | string;
      /** 预检逃生门：true=跳过 runtime 可用性预检强创 */
      force?: boolean;
    }
  ) => {
    if (Object.hasOwn(args, 'repoSet')) throw new Error('sessions.create removed the top-level repoSet argument; select the repository scope with isolation=isolated and isolationGroups');
    // F-04（可靠性审查）：executor 不按 schema 拒收未声明参数，模型硬猜 characterId 仍可透传。
    // 在 handler 入口统一拒收（覆盖派活与纯建会话两个分支）；重试复用/队列重入直调 delegateTask，不经此面。
    if (Object.hasOwn(args, 'characterId')) throw new Error('sessions.create 不接受 characterId：子代理角色由宿主轮选分配，外部指定已停用');
    if (Object.hasOwn(args, 'crossHarness')) throw new Error('Worker cross-Harness approval is managed in Settings.');
    const isolation = requireSessionIsolation(args, { allowDefaultGroup: true });
    if (args?.task?.trim() || args?.asSubagent === true || args.target !== undefined || args.inherit !== undefined) {
      if (args.shellProfileId) throw new Error('shell sessions do not support tasks or subagents');
      const result = await createSessionWithTask(ctx, args);
      if (!result.routing) return result;
      return { sessionId: result.session?.id, status: result.routing.state, routing: result.routing,
        ...(result.queueId ? { queueId: result.queueId, queuePosition: result.queuePosition } : {}),
        ...(result.inject?.messageId ? { assignment: { receipt: 'stored' as const, messageId: result.inject.messageId } } : {}),
        isolate: result.isolate, warning: result.repoNote };
    }
    // Agent 回合进行中：新建会话归发起区，不跟 UI 当前 active（否则切到 A 后开的 Worker 会改 A 气泡）
    args = { ...args };
    const workspaceId = args?.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
    if (args.isolationGroups !== undefined && (args.isolation !== 'isolated' || args.shellProfileId)) throw new Error('isolationGroups requires an isolated agent');
    let selection = args.isolationGroups === undefined ? undefined : captureWorktreeSelectionSources(ctx.config.get(), { ...args, workspaceId, isolationGroups: args.isolationGroups });
    const release = holdPendingSource(ctx.config, { workspaceId, rootId: args.rootId, cwd: args.cwd, additionalRootIds: selection?.selections.map(item => item.rootId) }, { kind: 'launch', id: randomUUID(), label: args.name || t('新会话') });
    try {
      const target = await resolveSessionTarget(ctx.config.get(), { workspaceId, rootId: args?.rootId, cwd: args?.cwd, rootsRevision: args.rootsRevision }, registeredWorktreeSession(ctx.sessions.listByWorkspace(workspaceId), args?.cwd, workspaceId));
      if (isolation === 'isolated' && !selection) selection = await resolveDefaultIsolationGroup(ctx, target);
      const cwd = target.cwd;
      const { runtime, inheritMeta: initialMeta } = args.shellProfileId
        ? { runtime: undefined, inheritMeta: undefined }
        : resolveLaunchConfiguration(args, undefined, ctx.config.get().defaultRuntime, id => ctx.sessions.isChatRuntime(id));
      const activate = args?.select === false || args?.select === 'false' ? false : true;
      const created = await ctx.sessions.createTerminal({
        name: args?.name,
        runtime,
        cwd,
        workspaceId,
        rootId: target.sourceRoot.rootId,
        capturedSource: target.sourceRoot,
        ...(args.cliLaunchOptions !== undefined ? { cliLaunchOptions: args.cliLaunchOptions } : {}),
        ...(selection ? { isolationGroups: selection.selections, capturedIsolationSources: selection.sources } : {}),
        shellProfileId: args?.shellProfileId,
        isolate: isolation === 'isolated',
        activate,
        ...(args?.force === true ? { force: true } : {}),
        ...(initialMeta ? { inheritMeta: initialMeta } : {})
      });
      // 派活身份：调度建的会话自动置编排标记（用户 UI/扩展面板建的会话不带此上下文）
      if (isSchedulerInvocation()) ctx.sessions.setOrchestrated(created.id, true);
      return created;
    } finally { release(); }
  },

  'sessions.setOrchestrated': (
    ctx: AppContext,
    args: { sessionId?: string; orchestrated?: boolean | string }
  ) => {
    if (
      args?.orchestrated !== true &&
      args?.orchestrated !== false &&
      args?.orchestrated !== 'true' &&
      args?.orchestrated !== 'false'
    ) {
      throw new Error(t('orchestrated 需为布尔值（true 收编 / false 放出）'));
    }
    const value = args.orchestrated === true || args.orchestrated === 'true';
    const id = resolveHostSessionId(ctx, typeof args.sessionId === 'string' ? args.sessionId : '');
    const updated = ctx.sessions.setOrchestrated(id, value);
    if (!updated) throw new Error(t('会话不存在: {{id}}', { id }));
    return { ok: true, sessionId: id, name: updated.name, orchestrated: value };
  },

  'sessions.select': (ctx: AppContext, args: { sessionId: string }) => {
    const id = resolveHostSessionId(ctx, args.sessionId);
    return ctx.sessions.get(id)?.archived ? ctx.sessions.continueArchived(id) : ctx.sessions.select(id);
  },

  'sessions.delete': async (ctx: AppContext, args: { sessionIds: string[] }) => {
    const ids = normalizeCloseBatchIds(args);
    if (!ids.length) throw new Error(t('ids 不能为空'));
    const plan = planCloseBatch(ctx.sessions.list(), ids);
    if (plan.failed.length) {
      return { closed: [], failed: plan.failed, count: 0, aborted: true };
    }
    const closed: Array<{ id: string; name?: string }> = [];
    await ctx.sessions.deletePermanently(plan.targets.map(target => target.id));
    for (const target of plan.targets) closed.push({ id: target.id, name: target.name });
    return { closed, failed: [], count: closed.length, aborted: false };
  },

  'sessions.rename': async (
    ctx: AppContext,
    args: { sessionId?: string; externalSessionId?: string; name: string; title?: string }
  ) => {
    // 调度省略会话定位 = 给调度自己的会话起标题（同 setStatus「调度不传 sessionId 报到本会话」约定）
    if (!args?.sessionId?.trim() && !args?.externalSessionId?.trim() && isSchedulerInvocation()) {
      const name = args.name?.trim() || args.title?.trim();
      if (!name) throw new Error(t('name 不能为空'));
      const result = await ctx.renameAgentSession(ctx.resolveBubbleWorkspaceId(), name);
      if (!result.ok) throw new Error(result.error ?? t('命名失败'));
      return { renamed: true, name };
    }
    const resolved = ctx.sessions.resolveSessionRef({
      sessionId: args?.sessionId,
      externalSessionId: args?.externalSessionId
    });
    return ctx.sessions.rename(resolved.id, args.name);
  },

  'sessions.setPinned': (ctx: AppContext, args: { sessionId: string; pinned: boolean }) =>
    ctx.sessions.setPinned(resolveHostSessionId(ctx, args.sessionId), !!args.pinned),

  'sessions.setArchived': (ctx: AppContext, args: { sessionIds: string[]; archived: boolean; __actorSessionId?: string }) => {
    if (typeof args?.archived !== 'boolean') throw new Error('archived must be a boolean');
    if (
      !Array.isArray(args.sessionIds) || !args.sessionIds.length ||
      args.sessionIds.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('sessionIds must be a non-empty list of session IDs');
    }
    const updated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of new Set(args.sessionIds.map((id) => id.trim()))) {
      try {
        const resolved = resolveHostSessionId(ctx, id);
        if (args.__actorSessionId && ctx.sessions.get(resolved)?.parentSessionId !== args.__actorSessionId)
          throw new Error('a parent session can only archive or restore its own direct child sessions');
        ctx.sessions.setArchived(resolved, args.archived);
        updated.push(resolved);
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { updated, archived: args.archived, failed, count: updated.length };
  },

  'sessions.completeAndArchive': (
    ctx: AppContext,
    args?: {
      workspaceId?: string;
      sessionIds: string[];
    }
  ) => {
    if (
      !Array.isArray(args?.sessionIds) || !args.sessionIds.length ||
      args.sessionIds.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('Explicit non-empty session IDs are required to complete and archive sessions');
    }
    const workspaceId = args?.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
    const { sessions } = ctx.sessions.listForAgent(workspaceId);
    const { ok, failed } = resolveQueryIds(sessions, args.sessionIds);
    const want = new Set(ok);
    const targets = sessions.filter((s) => want.has(s.id));
    if (failed.length) {
      throw new Error(t('会话不存在: {{id}}', { id: failed[0] }));
    }
    // 先校验整个集合，防止陈旧面板把等待审批/执行中的会话当成批量验收。
    if (targets.some((s) => !canCompleteAndArchiveSession(s))) {
      throw new Error(t('会话状态已变化，请刷新后处理；仅待验收或已完成会话可批量归档'));
    }
    const processed: string[] = [];
    for (const s of targets) {
      ctx.sessions.markProcessed(s.id, { source: 'user' });
      processed.push(s.id);
    }
    return { workspaceId, processed, count: processed.length };
  },

  /**
   * 待验收动作（R4）：通过=合入或标记已处理；打回=回注简报；搁置；processed=仅归档收尾。
   * R-14：维度门红灯的会话 passed 被硬阻断——先打回重做；确属误报传 skipDimensionGate=true
   * 强制验收（验收账本留痕 dimension-gate-override）。打回/收尾清除门结果，等下次 needs_you 重跑。
   */
  'sessions.review': async (
    ctx: AppContext,
    args: { sessionId?: string; sessionIds?: string[]; workspaceId?: string; decision?: string; note?: string; skipDimensionGate?: boolean },
    options?: { signal?: AbortSignal; initiatedBy?: 'human' }
  ) => {
    if (args?.sessionIds !== undefined) {
      if (args.decision !== 'processed' || args.sessionId !== undefined || args.skipDimensionGate !== undefined ||
          !Array.isArray(args.sessionIds) || !args.sessionIds.length ||
          args.sessionIds.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('Batch review requires non-empty sessionIds and decision=processed');
      }
      const workspaceId = args.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
      const { sessions } = ctx.sessions.listForAgent(workspaceId);
      const { ok, failed } = resolveQueryIds(sessions, args.sessionIds);
      if (failed.length || !ok.length) throw new Error(t('会话不存在: {{id}}', { id: failed[0] ?? '' }));
      const want = new Set(ok);
      const targets = sessions.filter(s => want.has(s.id));
      if (targets.length !== want.size || targets.some(s => !canCompleteAndArchiveSession(s))) {
        throw new Error(t('会话状态已变化，请刷新后处理；仅待验收或已完成会话可批量归档'));
      }
      options?.signal?.throwIfAborted();
      const processed: string[] = [];
      for (const target of targets) {
        try {
          ctx.sessions.clearDimensionGates(target.id);
          ctx.sessions.markProcessed(target.id, { note: args.note?.trim(), source: 'user' });
          processed.push(target.id);
        } catch (error) {
          return { ok: false, decision: 'processed' as const, workspaceId, processed, outcome: 'unknown' as const,
            error: `Batch review stopped at ${target.id}; inspect this target before retrying: ${String(error)}` };
        }
      }
      return { ok: true, decision: 'processed' as const, workspaceId, processed, count: processed.length };
    }
    const resolved = ctx.sessions.resolveSessionRef({ sessionId: args?.sessionId });
    const s = ctx.sessions.get(resolved.id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: resolved.id }));
    if (!isReviewDecision(args?.decision)) {
      throw new Error(t('decision 必须是 passed | rejected | deferred | processed'));
    }
    const note = args?.note?.trim();
    if (
      (args.decision === 'passed' || args.decision === 'rejected') &&
      !canReviewSession(s)
    ) {
      throw new Error(t('当前会话不是待验收状态，请先处理审批、问题或运行异常'));
    }

    if (args.decision === 'passed') {
      if (hasRedGate(s.dimensionGates) && args?.skipDimensionGate !== true) {
        throw new Error(
          t(
            '维度门红灯：{{badge}}。请先打回重做；确属误报可在全局看板右键强制验收，或传 skipDimensionGate=true（留痕）',
            { badge: dimensionGateBadgeLabel(s.dimensionGates) }
          )
        );
      }
      const overrideNote = hasRedGate(s.dimensionGates)
        ? dimensionGateOverrideNote(dimensionGateDetailText(s.dimensionGates))
        : undefined;
      if (s.worktreePath && s.worktreeBranch) {
        const merge = await ctx.sessions.integrateWorktree(s.id, {
          notifyUserOnFail: shouldNotifyUserOnIntegrateFail('sessions.review')
        }, options?.initiatedBy);
        // 强制验收留痕（approval=auto 先例：重启可查）；integrate 自带的 passed 痕照记
        if (overrideNote) {
          ctx.sessions.recordAcceptance(s.id, { at: Date.now(), decision: 'passed', note: overrideNote });
        }
        ctx.sessions.clearDimensionGates(s.id);
        return {
          ok: true,
          decision: 'passed' as const,
          ...merge,
          merged: true,
        };
      }
      ctx.sessions.setPhase(s.id, { value: 'done', source: 'user' });
      ctx.sessions.recordAcceptance(s.id, {
        at: Date.now(),
        decision: 'passed',
        note: [overrideNote, note].filter(Boolean).join('；') || undefined
      });
      ctx.sessions.clearDimensionGates(s.id);
      if (!s.archived) ctx.sessions.setArchived(s.id, true);
      return {
        ok: true,
        decision: 'passed' as const,
        merged: false,
        sessionId: s.id,
      };
    }
    if (args.decision === 'processed') {
      ctx.sessions.clearDimensionGates(s.id);
      ctx.sessions.markProcessed(s.id, { note, source: 'user' });
      return { ok: true, decision: 'processed' as const, sessionId: s.id };
    }
    if (args.decision === 'deferred') {
      ctx.sessions.setReviewDeferred(s.id, true);
      ctx.sessions.recordAcceptance(s.id, {
        at: Date.now(),
        decision: 'deferred',
        note
      });
      return { ok: true, decision: 'deferred' as const, sessionId: s.id };
    }
    ctx.sessions.setReviewDeferred(s.id, false);
    ctx.sessions.recordAcceptance(s.id, { at: Date.now(), decision: 'rejected', note });
    // 打回即解除红灯占领：门结果清除，Worker 返工后再报 needs_you 会重跑维度门
    ctx.sessions.clearDimensionGates(s.id);
    const task = rejectInjectText(note);
    const inject = (await sendSessionMail(ctx, {
      sessionId: s.id,
      text: task
    })) as Record<string, unknown>;
    return {
      ok: true,
      decision: 'rejected' as const,
      sessionId: s.id,
      messageStored: inject.stored === true,
      ...(typeof inject.error === 'string' ? { error: inject.error } : {}),
    };
  },

  'sessions.setStatus': async (
    ctx: AppContext,
    args: {
      sessionId?: string;
      externalSessionId?: string;
      phase?: string;
      note?: string;
      kind?: string;
      reason?: string;
    }
  ) => {
    const norm = normalizeSetStatus(args ?? {});
    const channel = resolveSetStatusChannel({
      sessionId: args?.sessionId,
      externalSessionId: args?.externalSessionId,
      isScheduler: isSchedulerInvocation(),
      workspaceId: ctx.resolveBubbleWorkspaceId?.()
    });
    if (channel.channel === 'scheduler') {
      const prev = ctx.schedulerStatus.get(channel.workspaceId);
      const next = applySchedulerSetStatus(
        prev,
        {
          workspaceId: channel.workspaceId,
          sessionId: channel.sessionId,
          phase: norm.phase,
          note: norm.note,
          kind: norm.kind
        },
        Date.now()
      );
      ctx.schedulerStatus.set(next);
      // 调度 needs_you 不发桌面通知（该触发类在 notifyDecision 被 orchestrator: 身份
      // 拦截，reason=scheduler），以左下角条目胶囊表达；此处不做任何通知决策。
      return {
        ok: true,
        channel: 'scheduler' as const,
        sessionId: next.sessionId,
        workspaceId: next.workspaceId,
        phase: next.phase,
        note: next.note,
        kind: next.kind
      };
    }
    const resolved = ctx.sessions.resolveSessionRef({
      sessionId: args?.sessionId,
      externalSessionId: args?.externalSessionId
    });
    // needs_you 用户注意通知预算；会话间通信不消费它。预算尽时返回 refused 正常结果，
    // 仍可改 note，但不再产生「等人」新通知（不进 setPhase，避开 notifyBus）。
    // 粘性预检与真实拦截同谓词（phaseWriteBlocked）：model 写入必被拦的相位不烧预算——
    // 否则「写了也被拦」的空转会白白吃掉升级额度。
    if (norm.phase === 'needs_you') {
      const pre = ctx.sessions.get(resolved.id);
      const stickyHeld = phaseWriteBlocked(pre?.phase, { source: 'model' });
      if (!stickyHeld) {
        const key = escalateBudgetKey({ sessionId: resolved.id });
        const attempt = ctx.sessions.consumeEscalateBudget(resolved.id, key);
        if (!attempt.escalate) {
          let session = pre;
          if (norm.note || norm.kind) {
            const noteCapsule = capsuleForSetStatus({ note: norm.note, kind: norm.kind }, false);
            if (noteCapsule) {
              session = ctx.sessions.setLiveStatus(resolved.id, { ...noteCapsule, ts: Date.now() });
            }
          }
          return {
            ...(session ?? {}),
            refused: true,
            message: attempt.message,
            escalate: { allowed: false, used: attempt.used, remaining: 0, budget: ESCALATE_BUDGET_LIMIT }
          };
        }
      }
    }
    let phaseApplied = false;
    if (norm.phase) {
      // 粘性规则（用户手标 done/needs_you 不可被 model 回退）命中时 setPhase 静默返回
      // 旧值——此时看板没动，不自动补默认胶囊，避免覆盖用户语境；显式 note 仍写入。
      // 判据带 source：model→model 永不被拦，写入成功恒为 model、被拦时恒为 user/llm，
      // 可精确区分「用户手标同值被拦」与「真写入」。
      const after = ctx.sessions.setPhase(resolved.id, { value: norm.phase, source: 'model' });
      phaseApplied = after.phase?.value === norm.phase && after.phase?.source === 'model';
    }
    const capsule = capsuleForSetStatus(norm, phaseApplied);
    const session = capsule
      ? ctx.sessions.setLiveStatus(resolved.id, { ...capsule, ts: Date.now() })
      : ctx.sessions.get(resolved.id);
    if (norm.phase === 'needs_you' && phaseApplied) {
      const reason = typeof args?.reason === 'string' ? args.reason : undefined;
      const guard = await afterNeedsYouReported(ctx, resolved.id, reason);
      if (guard.warnings.length) {
        return { ...session, warnings: guard.warnings, dirtyWorktree: guard.dirty };
      }
    }
    return session;
  },

  'sessions.setModel': async (
    ctx: AppContext,
    args: { sessionId: string; providerId?: string; modelId?: string }
  ) => {
    const id = resolveHostSessionId(ctx, args.sessionId);
    const session = ctx.sessions.get(id);
    if (!session) throw new Error(t('会话不存在: {{id}}', { id }));
    const p = args.providerId?.trim() ?? '';
    const m = args.modelId?.trim() ?? '';
    const model = p || m ? { providerId: p, modelId: m } : null;
    if (!ctx.agentSessions) throw new Error(t('GUI 会话宿主未就绪'));
    const r = await ctx.agentSessions.setSessionModel(id, model);
    if (!r.ok) throw new Error(r.error || t('设置模型失败'));
    return {
      ok: true,
      applied: r.applied,
      ...(r.warning ? { warning: r.warning } : {}),
      modelOverride: ctx.sessions.get(id)?.modelOverride ?? null
    };
  },

  'sessions.setThinking': async (
    ctx: AppContext,
    args: { sessionId: string; level?: string | null }
  ) => {
    const id = resolveHostSessionId(ctx, args.sessionId);
    const raw = args.level;
    const level =
      raw === undefined || raw === null || String(raw).trim() === ''
        ? null
        : (String(raw).trim() as import('../../../shared/types').GuiThinkingLevel);
    if (!ctx.agentSessions) throw new Error(t('GUI 会话宿主未就绪'));
    const r = await ctx.agentSessions.setThinkingLevel(id, level);
    if (!r.ok) throw new Error(r.error || t('设置思考档失败'));
    return { ok: true, applied: r.applied, thinkingLevel: ctx.sessions.get(id)?.thinkingLevel ?? null };
  },

  'sessions.integrate': async (
    ctx: AppContext,
    args: {
      sessionId?: string;
      externalSessionId?: string;
      target?: string;
      message?: string;
      noFf?: boolean;
      stashMain?: boolean;
      skipNpmInstall?: boolean;
      skipTypecheck?: boolean;
      onGateFail?: 'warn' | 'abort';
      approval?: string;
    }
  ) => {
    const resolved = ctx.sessions.resolveSessionRef({
      sessionId: args?.sessionId,
      externalSessionId: args?.externalSessionId
    });
    const merge = await ctx.sessions.integrateWorktree(resolved.id, {
      targetBranch: args?.target?.trim() || undefined,
      message: args?.message?.trim() || undefined,
      noFf: args?.noFf === true,
      stashMain: args?.stashMain === true,
      skipNpmInstall: args?.skipNpmInstall === true,
      skipTypecheck: args?.skipTypecheck === true,
      onGateFail: args?.onGateFail === 'abort' ? 'abort' : 'warn',
      approval: resolveIntegrateApproval(args?.approval),
      confirmNote: pickConfirmNote(args as Record<string, unknown>) || undefined,
      notifyUserOnFail: shouldNotifyUserOnIntegrateFail('sessions.integrate', args)
    });

    return {
      ...merge,
    };
  },

  'sessions.requestIntegrate': async (
    ctx: AppContext,
    args: { sessionId?: string; externalSessionId?: string; note?: string }
  ) => {
    let sessionForNotify: SessionMeta | undefined;
    try {
      const resolved = ctx.sessions.resolveSessionRef({
        sessionId: args?.sessionId,
        externalSessionId: args?.externalSessionId
      });
      const s = ctx.sessions.get(resolved.id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: resolved.id }));
      sessionForNotify = s;
      if (!s.worktreePath || !s.worktreeBranch) {
        throw new Error(
          t('本会话没有隔离 worktree。共享检出请在主仓自行合入；不要在当前目录 git worktree remove。')
        );
      }
      const ownership = taskWorktreeOwnership(s);
      const treeGuard = await beforeRequestIntegrate(ctx, s.id);
      if (treeGuard.fallbackError || treeGuard.fallbackCommit === false) {
        throw new Error(treeGuard.fallbackError || treeGuard.warnings.join('\n'));
      }
      treeGuard.assertCurrent?.();
      const latest = ctx.sessions.get(s.id);
      if (!latest || taskWorktreeOwnership(latest) !== ownership) throw new Error('worktree task ownership changed before integration notice');
      const workspaceId = s.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
      const askId = randomUUID();
      const noteParts = [args?.note?.trim(), ...(treeGuard.warnings.length ? treeGuard.warnings : [])].filter(
        Boolean
      ) as string[];
      const question = buildIntegrateRequestMessage({ sessionId: s.id, sessionName: s.name,
        branch: s.worktreeBranch, note: noteParts.join('\n'), worktreeGroups: treeGuard.worktreeGroups });
      // 合入协调事实随同一封任务信保存；回执与审批仍独立。
      const result = await deliverAgentMessage(ctx, {
        from: s.id,
        to: AGENT_MESSAGE_SCHEDULER_TARGET,
        kind: 'ask',
        text: question,
        meta: {
          askId,
          tag: 'notice',
          intent: 'integrate',
          ...(s.worktreeBranch ? { branch: s.worktreeBranch } : {}),
        },
        workspaceId
      });
      const queued = false;
      return {
        ok: true,
        notified: false,
        stored: true, receipt: result.receipt, messageId: result.messageId,
        mailboxWorkspaceId: result.mailboxWorkspaceId, read: result.read,
        queued,
        askId,
        kind: 'notice' as const,
        sessionId: s.id,
        branch: s.worktreeBranch,
        ...(treeGuard.worktreeGroups ? { worktreeGroups: treeGuard.worktreeGroups, snapshots: treeGuard.snapshots } : {}),
        message: '合入请求已保存到调度邮箱，尚未代表调度已读或已合入。',
        ...(treeGuard.warnings.length ? { warnings: treeGuard.warnings } : {}),
        ...(treeGuard.fallbackCommit ? { fallbackCommit: true } : {}),
        ...(treeGuard.dirty ? { dirtyWorktree: true } : {})
      };
    } catch (err) {
      if (sessionForNotify && shouldNotifyUserOnIntegrateFail('sessions.requestIntegrate')) {
        notifyUserIntegrateFail(ctx, sessionForNotify, err);
      }
      throw err;
    }
  },

  /** 信件先保存，独立收信回执；运行中不插话，空闲时宿主合并提醒。 */
  'sessions.message': async (
    ctx: AppContext,
    args: {
      to?: string;
      text?: string;
      kind?: string;
      replyTo?: string;
      subject?: string;
      idempotencyKey?: string;
      interrupt?: boolean;
    } & Record<string, unknown>
    , options?: { signal?: AbortSignal }
  ) => {
    let to = typeof args?.to === 'string' ? args.to.trim() : '';
    const text = typeof args?.text === 'string' ? args.text.trim() : '';
    if (!to || !text) throw new Error(t('需要 to（目标宿主会话 id）与 text（留言正文）'));
    if (text.length > AGENT_MESSAGE_TEXT_MAX) {
      throw new Error(t('text 过长（≤{{max}} 字符，当前 {{n}}）', { max: AGENT_MESSAGE_TEXT_MAX, n: text.length }));
    }
    const kind: AgentMessageKind = args?.kind === undefined ? 'notice' : (args.kind as AgentMessageKind);
    if (!isAgentMessageKind(kind)) {
      throw new Error(t('kind 非法：{{kind}}（ask | answer | notice | handoff）', { kind: String(args?.kind) }));
    }
    const replyTo = typeof args?.replyTo === 'string' ? args.replyTo.trim() : '';
    const fromId =
      typeof (args as Record<string, unknown>)?.[ACTOR_SESSION_ID_ARG] === 'string'
        ? String((args as Record<string, unknown>)[ACTOR_SESSION_ID_ARG]).trim()
        : '';
    const from = fromId ? ctx.sessions.get(fromId) : undefined;
    if (fromId && !from) throw new Error(`sender session does not exist: ${fromId}`);
    if (to === 'parent') {
      if (!from?.parentSessionId) throw new Error('the calling session has no parent session');
      to = from.parentSessionId;
    }
    if (args.interrupt !== undefined && typeof args.interrupt !== 'boolean') throw new Error('interrupt must be a boolean');
    const workspaceId = from?.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
    const fromSessionId = from?.id ?? (isSchedulerInvocation() ? `orchestrator:${workspaceId}` : 'host');
    const input = { from: fromSessionId, to, kind, text, workspaceId,
      ...(replyTo ? { replyToHandle: replyTo } : {}),
      ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
      ...(typeof args.idempotencyKey === 'string' ? { idempotencyKey: args.idempotencyKey } : {}) };
    const result = args.interrupt === true ? await sendInterruptMail(ctx, input, options?.signal) : await deliverAgentMessage(ctx, input);
    return {
      ok: true, ...result, stored: true, delivered: false, audited: false,
      from: fromSessionId,
      to,
      kind,
      ...(replyTo ? { replyTo } : {}),
      message: '邮件已保存到收件箱；不代表对方已读或处理。对方空闲时由宿主合并提醒，正文须主动读取。'
    };
  },

  'sessions.recoverInterrupted': async (
    ctx: AppContext,
    args: { sessionId?: string; select?: boolean }
  ) => {
    const sessionId = resolveHostSessionId(ctx, String(args?.sessionId ?? '').trim());
    const r = await ctx.sessions.resumeInterrupted(sessionId, {
      activate: args?.select === true
    });
    await sendSessionMail(ctx, {
      sessionId: r.session.id,
      text: r.brief
    });
    return {
      ok: true,
      sourceId: r.sourceId,
      session: slimSessionMeta(r.session),
      messageStored: true,
      message: t('已开续作会话并将中断简报保存到邮箱（worktree 归属已移交）。')
    };
  }
};
