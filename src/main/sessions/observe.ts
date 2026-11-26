import { validateObserveMode } from '../../shared/sessionToolArgs';
import { queryRuntimeState } from '../capabilities/hosts/awareness';
import { readSessionHistory } from './history';
import type { AppContext } from '../context';
import { currentAgentSessionId } from '../agent/agentScope';
import { findSessions, matchFlexibleSessionId, sessionUsedAt } from '../../shared/sessionQuery';
import { activeTurnMetrics, normalizePipelineSlowTurnMs } from '../../shared/pipelineStatus';
import { clipObservationText, OBSERVE_TERMINAL_CHARS, sessionObservation } from '../../shared/sessionObservation';
import type { SessionMeta } from '../../shared/types';
import { t } from '../../shared/i18n';
import { workerRouteReceipt } from '../tasks/workerRouting';

export interface ObserveSessionsArgs {
  mode?: 'directory' | 'detail';
  includeGit?: boolean;
  includeHistory?: boolean;
  historyLimit?: number;
  facts?: Record<string, unknown>;
  sessionId?: string;
  externalSessionId?: string;
  workspaceId?: string;
  includeArchived?: boolean;
  includeShell?: boolean;
  archivedOnly?: boolean;
  lastUsedBefore?: number;
  nameContains?: string;
  shortId?: string;
  worktreePath?: string;
  limit?: number;
  offset?: number;
}

/** One common read path for all harnesses. Directory reads never load transcripts or run Git. */
export function observeSessions(ctx: AppContext, args: ObserveSessionsArgs = {}) {
  validateObserveMode({ ...args });
  const sessionId = args.sessionId?.trim() || args.externalSessionId?.trim();
  const scheduler = sessionId === 'scheduler' || sessionId?.startsWith('orchestrator:');
  const schedulerWorkspaceId = sessionId?.startsWith('orchestrator:') ? sessionId.slice('orchestrator:'.length) : undefined;
  let target = sessionId && !scheduler ? ctx.sessions.get(sessionId) : undefined;
  if (sessionId && !scheduler && !target) {
    const found = matchFlexibleSessionId(ctx.sessions.list(), sessionId);
    if (found.kind === 'many') throw new Error(`会话定位不唯一：${sessionId}`);
    if (found.kind === 'one') target = ctx.sessions.get(found.id);
  }
  if (sessionId && !target && !scheduler) throw new Error(`会话不存在: ${sessionId}`);
  const actor = currentAgentSessionId();
  const workspaceId = args.workspaceId?.trim() || target?.workspaceId || schedulerWorkspaceId ||
    (actor ? ctx.sessions.get(actor)?.workspaceId : undefined) || ctx.resolveBubbleWorkspaceId();
  if (target && target.workspaceId !== workspaceId) throw new Error('目标会话不属于指定工作区');
  if (schedulerWorkspaceId !== undefined && schedulerWorkspaceId !== workspaceId) throw new Error('调度会话不属于指定工作区');
  const schedulerSnapshot = (includeReply: boolean, wsId = workspaceId) => {
    if (!ctx.orchestrator) throw new Error(t('调度 Agent 未就绪'));
    if (!ctx.workspaces.list().some(w => w.id === wsId)) throw new Error(`工作区不存在: ${wsId}`);
    const detail = ctx.orchestrator.observe(wsId, includeReply);
    const status = ctx.schedulerStatus?.get(wsId);
    const id = `orchestrator:${wsId}`;
    const meta: SessionMeta = { id, name: t('调度'), type: 'terminal', runtime: 'pi', workspaceId: wsId,
      createdAt: detail.createdAt, lifecycle: detail.busy ? 'working' : 'idle',
      ...(status?.phase ? { phase: { value: status.phase, source: 'model', ts: status.ts } } : {}),
      ...(status?.note ? { liveStatus: { label: status.note, ts: status.ts } } : {}) };
    const base = sessionObservation(meta, ctx.awareness?.getShare(id), detail.busy);
    return { ...base, activeTurnMs: null, slowTurn: false,
      updatedAt: Math.max(base.updatedAt, detail.updatedAt),
      ...(includeReply ? { transcript: 'structured', lastReply: detail.lastReply } : {}) };
  };
  if (scheduler) return schedulerSnapshot(true);
  const snapshot = (s: NonNullable<typeof target>) => {
    const chat = ctx.sessions.isChatRuntime(s.runtime ?? '');
    const busy = s.archived || s.runtimePresence === 'dormant' || s.lifecycle === 'exited' ? false : chat
      ? ctx.agentSessions?.isBusy(s.id) ?? null
      : s.lifecycle === 'working' ? true : s.lifecycle === 'idle' ? false : null;
    const turnStartedAt = chat
      ? busy ? ctx.agentSessions?.getActiveTurnStartedAt?.(s.id) : undefined
      : s.lifecycle === 'working' ? ctx.sessions.getPtyWorkingSince?.(s.id) : undefined;
    const explicitState = args.includeGit || args.facts;
    const turn = activeTurnMetrics({ now: Date.now(), turnStartedAt,
      slowTurnMs: normalizePipelineSlowTurnMs(explicitState ? ctx.config.get().pipeline?.slowTurnMs : undefined) });
    return { ...sessionObservation(s, ctx.awareness?.getShare(s.id), busy), activeTurnMs: turn.activeTurnMs,
      ...(s.workerRouting ? { routing: workerRouteReceipt(s.workerRouting) } : {}),
      ...(explicitState ? { slowTurn: turn.slowTurn } : {}) };
  };
  if (target) {
    const base = { ...snapshot(target), ...(target.workerRouting ? { routeAttempts: target.workerRouting.attempts.slice(-8).map(attempt => ({
      attempt: attempt.attempt, tierId: attempt.tierId, harnessId: attempt.config.harnessId, state: attempt.state, reason: attempt.reason
    })), routeAttemptCount: target.workerRouting.attempts.length } : {}) };
    if (ctx.sessions.isChatRuntime(target.runtime ?? '')) {
      const detail = ctx.agentSessions?.observe(target.id);
      return { ...base, ...(detail ? { busy: detail.busy,
        updatedAt: Math.max(base.updatedAt, detail.updatedAt) } : {}),
        transcript: detail ? 'structured' : 'unavailable', lastReply: detail?.lastReply ?? null,
        retry: detail?.retry ?? null };
    }
    const raw = ctx.pty.getBufferTail(target.id, OBSERVE_TERMINAL_CHARS + 1);
    const ptyStatus = ctx.pty.getStatus?.(target.id);
    if (raw === undefined) return { ...base, ptyStatus, transcript: 'unavailable', lastReply: null, terminalTail: null };
    const tail = clipObservationText(raw, OBSERVE_TERMINAL_CHARS, true);
    return { ...base, ptyStatus, transcript: 'terminal', lastReply: null,
      terminalTail: { text: tail.text, truncated: tail.truncated } };
  }
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 12;
  const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  const allWorkspaces = workspaceId === '*' || workspaceId === 'all';
  let rows = ctx.sessions.list().filter(s => !s.hidden && (allWorkspaces || s.workspaceId === workspaceId) && s.type === 'terminal' &&
    (args.includeShell || s.launchKind !== 'shell') && (args.archivedOnly ? s.archived : args.includeArchived === true || !s.archived));
  if (args.nameContains?.trim() || args.shortId?.trim() || args.worktreePath?.trim()) {
    rows = findSessions(rows, { name: args.nameContains, shortId: args.shortId, worktreePath: args.worktreePath }).matches;
  }
  if (typeof args.lastUsedBefore === 'number') rows = rows.filter(s => sessionUsedAt(s) < args.lastUsedBefore!);
  rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  // Synthetic scheduler identity is discoverable without loading its transcript.
  const filtered = args.archivedOnly || args.nameContains || args.shortId || args.worktreePath || args.lastUsedBefore !== undefined;
  const schedulerWorkspaces = ctx.orchestrator && !filtered
    ? allWorkspaces ? ctx.workspaces.list().map(w => w.id) : [workspaceId] : [];
  const total = rows.length + schedulerWorkspaces.length;
  const directoryItem = (item: ReturnType<typeof snapshot>) => {
    const { cwd, worktreePath, worktreeBranch, externalSessionId, launchError, summary, ...status } = item;
    return { ...status,
      ...(cwd === null ? {} : { cwd }),
      ...(worktreePath === null ? {} : { worktreePath }),
      ...(worktreeBranch === null ? {} : { worktreeBranch }),
      ...(externalSessionId === null ? {} : { externalSessionId }),
      ...(launchError === null ? {} : { launchError }),
      ...(summary === null ? {} : { summary })
    };
  };
  const sessions: ReturnType<typeof directoryItem>[] = [];
  let size = 0;
  for (let i = offset; i < Math.min(total, offset + limit); i++) {
    const item = directoryItem(i >= rows.length ? schedulerSnapshot(false, schedulerWorkspaces[i - rows.length]) : snapshot(rows[i]!));
    const chars = JSON.stringify(item).length;
    if (sessions.length && size + chars > 9500) break;
    sessions.push(item); size += chars;
  }
  const next = offset + sessions.length;
  return { workspaceId, count: sessions.length, total, sessions,
    nextOffset: next < total ? next : null, repliesIncluded: false };
}

export async function observeHost(ctx: AppContext, args: ObserveSessionsArgs = {}) {
  if (args.includeHistory && !args.sessionId?.trim() && !args.externalSessionId?.trim()) throw new Error('includeHistory 需要指定 sessionId');
  // scheduler-observe F-01: 调度合成身份（scheduler / orchestrator:<ws>）没有会话转写，
  // readSessionHistory 只查实体会话表——若放行会在快照刚成功返回后抛「会话不存在」，
  // 自相矛盾。显式拦截并给出可纠正指引。
  const historyTarget = args.sessionId?.trim() || args.externalSessionId?.trim() || '';
  if (args.includeHistory && (historyTarget === 'scheduler' || historyTarget.startsWith('orchestrator:'))) {
    throw new Error(t('调度会话不支持 includeHistory，请用 observe/display 快照查看调度状态'));
  }
  const snapshot = observeSessions(ctx, args);
  const state = args.includeGit || args.facts ? await queryRuntimeState(ctx, { ...args.facts,
    workspaceId: ['*', 'all'].includes(snapshot.workspaceId!) ? undefined : snapshot.workspaceId,
    sessionId: 'sessionId' in snapshot ? snapshot.sessionId : undefined, includeGit: args.includeGit }) : undefined;
  const history = args.includeHistory ? await readSessionHistory(ctx, {
    sessionId: 'sessionId' in snapshot ? snapshot.sessionId : args.sessionId, n: args.historyLimit ?? 10 }) : undefined;
  return { ...snapshot, ...(state ? { state } : {}), ...(history ? { history } : {}) };
}
