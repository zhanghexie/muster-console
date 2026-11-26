import type { AppContext } from '../../context';
import { assertWorkspaceExecutionContextCurrent } from '../../workspaceExecutionContext';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';
import { workspaceRootUsesFor } from '../../workspaceRootUses';
import { getMemoryService } from '../../memory/serviceRef';
import { buildTaskBriefText } from '../../../shared/workerBrief';
import { appendNamedSkillsToBrief, SkillTurnBudget, SKILL_INJECT_TURN_BUDGET_CHARS } from '../../agent/skillInject';
import { t } from '../../../shared/i18n';
import { captureGuiWorkContext } from '../../agentSession/workSnapshot';

/** 找目标终端会话：显式 sessionId > 发起区/当前区下的选中项 > 该区第一个终端 */
function resolveTerminalSession(ctx: AppContext, sessionId?: string) {
  if (sessionId) {
    const s = ctx.sessions.get(sessionId);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: sessionId }));
    if (s.type !== 'terminal') throw new Error(t('不是终端会话: {{id}}', { id: sessionId }));
    return s;
  }
  const preferWs = ctx.resolveBubbleWorkspaceId();
  const active = ctx.sessions.getActive();
  if (active?.type === 'terminal') {
    const aw =
      active.workspaceId ??
      (active.cwd ? ctx.sessions.resolveWorkspaceId(active.cwd) : '');
    if (aw === preferWs) return active;
  }
  const inWs = ctx.sessions.list().find((s) => {
    if (s.type !== 'terminal') return false;
    const id = s.workspaceId ?? (s.cwd ? ctx.sessions.resolveWorkspaceId(s.cwd) : '');
    return id === preferWs;
  });
  if (inWs) return inWs;
  throw new Error(
    t('工作区 {{wsId}} 下没有终端会话，请提供 sessionId 或先 sessions.create', { wsId: preferWs })
  );
}

export async function buildBrief(
  ctx: AppContext,
  sessionId: string | undefined,
  task: string,
  opts: {
    workspaceRoot: string;
  }
): Promise<{ brief: string }> {
  if (sessionId) ctx.sessions.ensureStatusToken(sessionId);
  // 记忆注入（M-A 通道 1 + M-C 检索；B5 §12 收敛）：
  // 基底 = MemoryService.inject（chat 面 bootstrap 画像，kind=bootstrap 落账）；
  // 检索段 = searchMemory 引擎（trigger/importance/repoKey 排序 + MMR，按简报预算取
  // K，kind=brief_injected 落账——喂 B4 信号门）。B8 退役回落：boot 恒装配（index.ts），
  // 服务未装配属装配事故——空记忆段 + 错误日志，不再走旧 readMemoryContext/buildSearchSection
  // 链。静默降级：读不到/解析失败都不影响派活本身。
  let memorySection = '';
  try {
    const svc = getMemoryService();
    if (!svc) {
      console.error('[memory] MemoryService 未装配（应恒装配）——简报记忆段空注入');
    } else {
      const base = svc.injectKnowledge(opts.workspaceRoot, 'chat').text;
      let searchPart = '';
      try {
        searchPart=await svc.recallKnowledge(opts.workspaceRoot,task,'worker');
      } catch (err) {
        console.warn('[brief] memory search failed', err);
      }
      memorySection = [base, searchPart].filter((s) => s.trim()).join('\n\n');
    }
  } catch (err) {
    console.warn('[brief] memory context failed', err);
  }
  return {
    brief: buildTaskBriefText(task, {
      memorySection,
      rules: ctx.config.get().agentRules
    })
  };
}

/**
 * 派活简报 + 点名指路（A2 / A5）：任务原文里显式点名的 skill 以「名 + 路径」附在
 * 简报后，正文由 Worker 自己按需读（终端 Worker 的 SKILL.md 本就可见）。
 * 与 GUI 回合的 prepareEngineSkillText 共用点名检测与审计口径；未点名零附加。
 */
export async function buildBriefWithNamedSkills(
  ctx: AppContext,
  sessionId: string | undefined,
  task: string,
  opts: {
    workspaceRoot: string;
    /** Skill discovery follows the task's source, while memory uses management. */
    skillCwd?: string;
    workspaceContext?: WorkspaceExecutionContext;
  }
): Promise<{ brief: string }> {
  const sid = sessionId ?? `brief:${Date.now().toString(36)}`;
  const context = opts.workspaceContext;
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), context);
  const releases = context?.roots.map(root => workspaceRootUsesFor(ctx.config).acquire({ workspaceId: context.workspaceId,
    rootId: root.rootId, kind: 'launch', id: `skills:${sid}`, label: t('Skill') })) ?? [];
  try {
    const base = await buildBrief(ctx, sessionId, task, opts);
    // 简报路径用局部预算：进共享 TurnBook 会（a）合成 id 的条目永不回收、
    // （b）beginTurn 重置正忙 GUI 会话的当回合预算，与「每次简报独立预算」自相矛盾
    const r = await appendNamedSkillsToBrief(base.brief, task, {
      cwd: context?.cwd ?? opts.skillCwd ?? opts.workspaceRoot,
      workspaceContext: context,
      sessionId: sid,
      budget: new SkillTurnBudget(SKILL_INJECT_TURN_BUDGET_CHARS)
    });
    assertWorkspaceExecutionContextCurrent(ctx.config.get(), context);
    return { brief: r.appended || base.brief };
  } finally { for (const release of releases) release(); }
}

export const chatHost = {
  'sessions.interrupt': async (ctx: AppContext, args: { sessionId: string }) => {
    if (!args?.sessionId?.trim()) throw new Error('sessionId is required');
    const resolved = ctx.sessions.resolveSessionRef({ sessionId: args.sessionId });
    const s = resolveTerminalSession(ctx, resolved.id);
    const turn = ctx.agentSessions?.entries.get(s.id)?.activeExecutionTurnId;
    const binding = ctx.sessions.getCliWorkspaceContext?.(s.id);
    const captured = s.launchKind === 'shell' ? undefined : await ctx.sessions.captureManagedInterruptSnapshot(s.id, Date.now(), captureGuiWorkContext(ctx, s.id));
    if (turn && ctx.agentSessions?.entries.get(s.id)?.activeExecutionTurnId !== turn ||
        !ctx.sessions.isChatRuntime(s.runtime) && ctx.sessions.getCliWorkspaceContext?.(s.id) !== binding)
      throw new Error('捕获快照期间会话或回合已变化，未发送中断');
    if (ctx.sessions.isChatRuntime(s.runtime)) {
      if (!ctx.agentSessions) throw new Error('GUI session host is unavailable');
      await ctx.agentSessions.abort(s.id);
      return { interrupted: true, sessionId: s.id, historyPreserved: true, ...(captured ? { snapshotCaptured: true } : {}) };
    }
    if (!ctx.pty.write(s.id, ctx.sessions.getCliWorkspaceContext?.(s.id)?.interruptInput ?? '\x03')) throw new Error('Terminal process is not running');
    return { interruptRequested: true, sessionId: s.id, historyPreserved: true, ...(captured ? { snapshotCaptured: true } : {}) };
  },

  'sessions.restartConversation': async (ctx: AppContext, args: { sessionId: string }) => {
    if (!args?.sessionId?.trim()) throw new Error('sessionId is required');
    const resolved = ctx.sessions.resolveSessionRef({ sessionId: args.sessionId });
    const s = resolveTerminalSession(ctx, resolved.id);
    if (ctx.sessions.isChatRuntime(s.runtime)) throw new Error('Restarting a GUI conversation is not supported; create a new session instead');
    await ctx.sessions.refreshFresh(s.id);
    return { restarted: true, sessionId: s.id, externalSessionId: ctx.sessions.get(s.id)?.externalSessionId };
  },
};
