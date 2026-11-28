import type { AppContext } from '../context';
import { t } from '../../shared/i18n';
import { currentAgentSessionId, currentAgentWorkspaceId, currentGuiExecutionTurn, currentPtyDesktopTurn,
  currentSchedulerDesktopExecutionTurn, isSchedulerInvocation } from '../agent/agentScope';
import { PreDispatchFailure } from './preDispatchFailure';
import type { DesktopDeliveryLease } from './desktopTurns';
import { isRecordedDesktopOutcome } from './recordedDesktopOutcome';

/** Optional until every desktop entry point is wired; never infer an owner from model arguments. */
export async function withDesktopActivity<T>(ctx: AppContext, mutation: boolean, signal: AbortSignal | undefined,
  execute: (signal?: AbortSignal, delivery?: DesktopDeliveryLease) => Promise<T>): Promise<T> {
  if (!ctx.desktopTurns) return execute(signal);
  const gui = currentGuiExecutionTurn(), caller = currentAgentSessionId();
  const pty = currentPtyDesktopTurn(), scheduler = currentSchedulerDesktopExecutionTurn();
  const turn = gui ?? pty ?? scheduler;
  if (!turn?.desktopTurnId || !turn.isDesktopCurrent?.() ||
      (gui ? !!caller && caller !== gui.sessionId : pty ? caller !== pty.sessionId : !!caller || !isSchedulerInvocation() ||
        scheduler?.sessionId !== `orchestrator:${currentAgentWorkspaceId()}`)) {
    throw new Error('Desktop activity is not available for this execution context');
  }
  const schedulerWorkspace = turn === scheduler
    ? ctx.workspaces?.list().find(workspace => workspace.id === currentAgentWorkspaceId())?.name.trim()
    : undefined;
  const target = turn === scheduler
    ? [t('调度'), schedulerWorkspace].filter(Boolean).join(' · ')
    : ctx.sessions.get(turn.sessionId)?.name?.trim() || t('会话');
  const result = await ctx.desktopTurns().use(turn.sessionId, turn.desktopTurnId, target, async (activitySignal, delivery) => {
    const active = signal ? AbortSignal.any([signal, activitySignal]) : activitySignal;
    if (active.aborted) throw new PreDispatchFailure(active.reason);
    const result = await execute(active, delivery);
    if (!turn.isDesktopCurrent?.()) throw new Error(mutation
      ? 'Desktop action outcome may be unknown after the originating instruction changed'
      : 'Desktop execution context is no longer current');
    if (mutation && result && typeof result === 'object' && 'outcome' in result && result.outcome === 'unknown' &&
        !isRecordedDesktopOutcome(result)) {
      throw new Error('Desktop action outcome is unknown; inspect the target before retrying');
    }
    return result;
  }, mutation);
  return result;
}
