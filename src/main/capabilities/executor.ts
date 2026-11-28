import { mailboxHost } from './hosts/mailbox';
import { turnChangesHost } from './hosts/turnChanges';
import { resumeWaitHost } from './hosts/resumeWait';
import { feedbackHost } from './hosts/feedback';
import { sessionRemindersHost } from './hosts/sessionReminders';
import { workerOptionsHost } from './hosts/workerOptions';
import type { AppContext } from '../context';
import { errorMessage } from '../../shared/errors';
import { modelToolResult } from '../../shared/modelToolResult';
import { RESULT_MAX_CHARS } from '../../shared/toolResultBudget';
import { t } from '../../shared/i18n';
import { localizeSafetyReason } from '../../shared/safetyReason';
import { getToolDef } from './catalog';
import { internalizedRunToolDefOf, runToolDomainOf } from './catalog/runTools';
import { resolveRunToolCall } from './catalog/runFactory';
import { isNetworkSourceTool } from '../memory/provenance';
import { markTurnNetworkTaint, isHeadlessTurn } from '../agent/turnScope';
import { isToolDefHidden, resolveTurnHiddenTools, schedulerTurnKindFromTurnScope, type TurnHiddenTools } from '../../shared/turnVisibility';
import { runAsAgentSession } from '../agent/agentScope';
import { sessionsHost } from './hosts/sessions';
import { terminalHost } from './hosts/terminal';
import { chatHost } from './hosts/chat';
import { servicesHost } from './hosts/services';
import { uiHost, appHost } from './hosts/misc';
import { runtimesHost } from './hosts/runtimes';
import { extensionsHost } from './hosts/extensions';
import { memoryHost } from './hosts/memory';
import { subscriptionPolicyHost } from './hosts/subscriptionPolicy';
import { workflowHost } from './hosts/workflow';
import { intentsHost } from './hosts/intents';
import { llmHost } from './hosts/llm';
import { attachmentsHost } from './hosts/attachments';
import { awarenessHost } from './hosts/awareness';
import { webHost } from './hosts/web';
import { gitHost } from './hosts/git';
import { githubHost } from './hosts/github';
import { themesHost } from './hosts/themes';
import { cliRunsHost } from './hosts/cliRuns';
import { browserHost } from './hosts/browser';
import { panelHost } from './hosts/panel';
import { desktopHost } from './hosts/desktop';
import { desktopSetupIssue } from '../desktop/desktopSetup';
import { mcpHost } from './hosts/mcp';
import { agentAppsHost } from './hosts/agentApps';
import { uiWidgetsHost } from './hosts/uiWidgets';
import { suggestedRepliesHost } from './hosts/suggestedReplies';
import { splitCaptureDisplay } from '../../shared/terminalCapture';
import {
  buildDangerousConfirmSummary,
  collectSessionRefs,
  confirmActionLabel,
  firstSentence,
  humanizeConfirmArgs,
  isConfirmed,
  pickConfirmNote,
  reviewConfirmAction,
  reviewConfirmIntent,
  shouldSkipReviewConfirm,
  type ConfirmCancelledBy,
  type ConfirmSessionSnapshot,
  type LookedUpSession
} from '../../shared/confirmDialog';
import {
  normalizeCloseBatchIds,
  planCloseBatch,
  sessionToConfirmSnapshot
} from '../../shared/sessionCloseBatch';
import {
  buildIntegrateAutoApprovalTrace,
  shouldSkipIntegrateConfirm
} from '../../shared/integrateApproval';
import { previewFromToolArgs } from '../../shared/permissionOption';
import { authorizeSafetyOperation } from '../safety/bindings';
import { safetyRisk } from '../safety/policy';

type ToolHandler = (ctx: AppContext, args: any, options?: { signal?: AbortSignal; assertCurrent?: () => void; onConfirming?: () => void }) => unknown | Promise<unknown>;

const HANDLERS: Record<string, ToolHandler> = {
  ...turnChangesHost,
  ...sessionRemindersHost,
  ...workerOptionsHost,
  ...feedbackHost,
  ...agentAppsHost,
  ...mcpHost,
  ...sessionsHost,
  ...terminalHost,
  ...chatHost,
  ...servicesHost,
  ...uiHost,
  ...uiWidgetsHost,
  ...suggestedRepliesHost,
  ...appHost,
  ...runtimesHost,
  ...extensionsHost,
  ...mailboxHost,
  ...resumeWaitHost,
  ...themesHost,
  ...cliRunsHost,
  ...browserHost,
  ...Object.fromEntries(Object.entries(panelHost).map(([name, handler]) => [name.slice('host.'.length), handler])),
  ...desktopHost,
  ...memoryHost,
  ...subscriptionPolicyHost,
  ...workflowHost,
  ...intentsHost,
  ...llmHost,
  ...attachmentsHost,
  ...awarenessHost,
  ...webHost,
  ...githubHost,
  ...gitHost
};

export interface ExecuteResult {
  ok: boolean;
  code?: string;
  cancelled?: boolean;
  cancelledBy?: ConfirmCancelledBy;
  result?: unknown;
  error?: string;
  /** 仅 UI 展示（截图路径等），serializeResult 不含此项，不进模型上下文 */
  display?: { imagePath?: string };
}

export { RESULT_MAX_CHARS };

function actorConfirmContext(
  ctx: AppContext,
  dotName: string
): { title: string; subtitle: string } {
  let wsName = t('工作区');
  try {
    const wsId = ctx.resolveBubbleWorkspaceId();
    wsName = ctx.workspaces.list().find((w) => w.id === wsId)?.name?.trim() || wsName;
  } catch {
    /* 无绑定工作区 */
  }
  let role = t('Worker');
  try {
    const wsId = ctx.resolveBubbleWorkspaceId();
    if (ctx.isOrchestratorBusy(wsId)) role = t('调度');
  } catch {
    /* ignore */
  }
  return {
    title: t('{{workspace}} · {{role}}', { workspace: wsName, role }),
    subtitle: t('{{role}} · {{tool}}', { role, tool: dotName })
  };
}

function lookupConfirmSession(ctx: AppContext, ref: string): LookedUpSession {
  try {
    const { id } = ctx.sessions.resolveSessionRef({ sessionId: ref });
    const sess = ctx.sessions.get(id);
    return { ref, session: sess ? sessionToConfirmSnapshot(sess) : undefined };
  } catch {
    return { ref };
  }
}

function lookupServiceName(ctx: AppContext, args: Record<string, unknown>): string | undefined {
  const id = typeof args.automationId === 'string' ? args.automationId.trim() : '';
  if (!id) return undefined;
  try {
    const name = ctx.tasks.get(id)?.name?.trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function lookupThemeName(ctx: AppContext, args: Record<string, unknown>): string | undefined {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return undefined;
  try {
    return ctx.themes.list().find((x) => x.id === id)?.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function firstLookedUpSession(sessions: LookedUpSession[]): ConfirmSessionSnapshot | undefined {
  return sessions.find((x) => x.session)?.session;
}

function resolveConfirmAction(
  def: { name: string; confirmAction?: string },
  args: Record<string, unknown>,
  session?: ConfirmSessionSnapshot
): string | undefined {
  if (def.name === 'automations.setEnabled') return args.enabled === false ? t('停用') : t('启用');
  if (def.name === 'sessions.review') return reviewConfirmAction(args, session);
  return def.confirmAction;
}

function dangerousConfirmOpts(
  ctx: AppContext,
  def: { name: string; description: string; summary?: string; confirmAction?: string; confirmSummary?: (args: Record<string, unknown>) => string },
  args: Record<string, unknown>
): import('../../shared/confirmDialog').ConfirmDialogFields {
  const { subtitle } = actorConfirmContext(ctx, def.name);
  let catalogSummary = '';
  try {
    catalogSummary = def.confirmSummary?.(args)?.trim() ?? '';
  } catch {
    catalogSummary = '';
  }
  const refs = collectSessionRefs(args);
  const sessions = refs.map((ref) => lookupConfirmSession(ctx, ref));
  const closeBatchPlan =
    def.name === 'sessions.delete' ? planCloseBatch(ctx.sessions.list(), normalizeCloseBatchIds(args)) : undefined;
  const summary = buildDangerousConfirmSummary({
    toolName: def.name,
    args,
    catalogSummary,
    sessions,
    closeBatchPlan,
    serviceName: lookupServiceName(ctx, args),
    themeName: def.name === 'themes.remove' ? lookupThemeName(ctx, args) : undefined
  });
  const reviewSession = def.name === 'sessions.review' ? firstLookedUpSession(sessions) : undefined;
  const intent =
    def.name === 'sessions.review'
      ? reviewConfirmIntent(args, reviewSession)
      : (def.summary || firstSentence(def.description) || def.name).trim();
  // D1：文件类工具（含 ApplyPatch files[]）在确认门展示 filePaths + add/update 预览
  const preview = previewFromToolArgs(args);
  return {
    dangerous: true,
    subtitle,
    intent,
    summary,
    confirmNote: pickConfirmNote(args) || undefined,
    toolDescription: def.description,
    confirmLabel: confirmActionLabel(resolveConfirmAction(def, args, reviewSession)),
    cancelLabel: t('取消'),
    ...(preview
      ? {
          permission: {
            preview,
            kinds: ['allowOnce', 'deny', 'custom'] as const
          }
        }
      : {})
  };
}

/**
 * 能力执行器：Agent tool-call 的唯一落地入口。
 * - 未知工具 / 参数解析失败 → 明确报错（回填给模型，不假成功）
 * - dangerous 工具 → 独立安全审核，疑点才 ui.confirm，拒绝无副作用
 * - sessions.review 的 rejected/deferred 免确认；passed/processed 保持确认。
 * - approval=auto 与 always 规则不越过安全审核；合入成功仍留痕
 */
export async function executeTool(
  ctx: AppContext,
  dotName: string,
  argsJson: string,
  opts: { onConfirming?: () => void; signal?: AbortSignal; callingSessionId?: string; assertCurrent?: () => void } = {}
): Promise<ExecuteResult> {
  const run = () => executeToolInner(ctx, dotName, argsJson, opts);
  // 会话作用域：随调用链传播，供「父是谁」这类宿主自判的场景（如 sessions.create
  // 的 asSubagent——父必须是调用者本人，模型自报的值一律不算）。
  // 与 __actorSessionId 的分工：那是个按 meta.bind 逐工具注入的参数，这个是整链上下文。
  let result: ExecuteResult;
  try { result = opts.callingSessionId ? await runAsAgentSession(opts.callingSessionId, run) : await run(); }
  catch (error) { result = { ok: false, ...(opts.signal?.aborted ? { cancelled: true } : {}), error: errorMessage(error) }; }
  // 记忆溯源（B3 §5 回合内污点）：网络来源工具执行过即给当前回合打污点——
  // 其后该回合 assistant 产生的记忆候选按 untrusted 分类（无回合作用域时 no-op）
  try {
    if (isNetworkSourceTool(dotName)) markTurnNetworkTaint();
  } catch {
    /* 污点标记失败不影响工具结果 */
  }
  // 使用统计：只记 Catalog 内的已知工具，避免乱传的名字污染排行。
  // R5：run 入口（browser.run…）按真实 action 记录（入口名不进排行）；展开失败
  // （未知 action/参数错误）时仍记入口名，错误已在结果里。
  const recordName = runUsageRecordName(dotName, argsJson);
  if (getToolDef(recordName)) {
    try {
      ctx.usage?.recordToolCall(recordName, result.ok, { error: result.error, cancelled: result.cancelled });
    } catch {
      /* 统计失败不影响工具结果 */
    }
  }
  return result;
}

/** 使用统计口径：run 入口展开为真实目标名；非 run 入口原样返回 */
function runUsageRecordName(dotName: string, argsJson: string): string {
  const domain = runToolDomainOf(dotName);
  if (!domain) return dotName;
  try {
    const parsed: unknown = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
    const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    return resolveRunToolCall(domain, args).targetTool;
  } catch {
    return dotName;
  }
}

/**
 * 当前调用链的调度回合隐藏面（轮级可见性执行面，turnVisibility 双层第二层）：
 * 处于无头定时任务轮（runAsHeadlessTurn，piProvider.runPiTurn turnKind='headless'）
 * 时返回 prompt-task 隐藏面；其余（交互轮 / 事件唤醒轮 / 无回合上下文——含 GUI、
 * PTY、扩展入口）一律 null，调用方零开销放行。词表对齐单源：回合类型仍经
 * schedulerTurnKindFromTurnScope 推导，不在此内联硬编码。
 */
function currentSchedulerTurnHidden(): TurnHiddenTools | null {
  try {
    return isHeadlessTurn()
      ? resolveTurnHiddenTools(schedulerTurnKindFromTurnScope('headless'))
      : null;
  } catch {
    return null;
  }
}

async function executeToolInner(
  ctx: AppContext,
  dotName: string,
  argsJson: string,
  opts: { onConfirming?: () => void; signal?: AbortSignal; assertCurrent?: () => void } = {}
): Promise<ExecuteResult> {
  if (opts.signal?.aborted) {
    return { ok: false, cancelled: true, error: t('已取消') };
  }
  let args: Record<string, unknown> = {};
  if (argsJson && argsJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      args =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
    } catch (e) {
      return { ok: false, error: t('工具参数不是合法 JSON: {{error}}', { error: errorMessage(e) }) };
    }
  }
  // R5：run 入口（browser.run…）在执行器内展开为真实目标再执行（R5 退役 tools.call 后
  // 调度面常驻注册的 run 入口直调 executeTool，路由落在此处；GUI/Shell API 面在各自
  // 入口已用同一 runRouter 机制先展开，传入真实目标名时此处 no-op）。身份绑定由各
  // 入口完成，这里只做展开与 per-action 参数预检；dangerous 确认门随真实目标的原 def
  // 生效。extensions.run 的 action "run" 目标与入口同名：不递归重入，落回原 def
  // （internalizedRunToolDefOf）保留命令参数和权限分类；包审核在发布时完成。
  const runDomain = runToolDomainOf(dotName);
  if (runDomain) {
    try {
      const resolved = resolveRunToolCall(runDomain, args);
      if (resolved.targetTool !== dotName) {
        return await executeToolInner(ctx, resolved.targetTool, JSON.stringify(resolved.args), opts);
      }
      args = resolved.args;
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
  // 轮级可见性执行面：run 入口展开出真实目标后（递归重入，dotName 已是生效名），以及
  // 一切按点名直调的路径，都按当前调度回合隐藏面以生效名复核一次——无头 prompt-task
  // 轮拒绝本轮被裁工具，堵住绕过注册面入口名检查的一切路径（入口未命中但 action 展开
  // 命中隐藏动词、直接点名退役动词/整组工具等）。无隐藏上下文时 hidden 为 null，零开销。
  const turnHidden = currentSchedulerTurnHidden();
  if (turnHidden && isToolDefHidden({ name: dotName }, turnHidden)) {
    return {
      ok: false,
      error: `${dotName} is hidden for the current turn: unavailable in headless prompt-task turns, so this call was rejected without side effects.`
    };
  }
  const def = internalizedRunToolDefOf(dotName) ?? getToolDef(dotName);
  const handler = HANDLERS[dotName];
  if (!def || !handler) {
    return { ok: false, error: t('未知工具: {{name}}', { name: dotName }) };
  }

  const skipIntegrateConfirm = def.dangerous && shouldSkipIntegrateConfirm(dotName, args);
  const ownsCodeReview = ['extensions.create', 'extensions.write', 'extensions.removeFile', 'extensions.submit', 'extensions.retryReview', 'sessions.integrateWorktree', 'sessions.integrate', 'sessions.delete', 'apps.install', 'apps.setEnabled'].includes(dotName);
  if (safetyRisk({ action: dotName, args, source: 'catalog', workspaceId: '' }) === 'high' && !ownsCodeReview && !shouldSkipReviewConfirm(dotName, args)) {
    opts.onConfirming?.();
    const gateOpts = dangerousConfirmOpts(ctx, def, args);
    const humanConfirm = async (reason: string, signal?: AbortSignal) => {
      const displayedReason = localizeSafetyReason(reason);
      return isConfirmed(await ctx.ui.confirm(
        actorConfirmContext(ctx, dotName).title, `${displayedReason}\n\n${humanizeConfirmArgs(args)}`,
        { ...gateOpts, signal, confirmNote: displayedReason }
      ));
    };
    const decision = await authorizeSafetyOperation(ctx, {
      action: dotName, args, source: 'catalog', dangerous: true,
      summary: def.description,
      signal: opts.signal,
      humanConfirm
    });
    if (!decision.allowed) return { ok: false, cancelled: !!decision.cancelled || !!decision.escalated, error: decision.reason };
  }
  try {
    if (opts.signal?.aborted) {
      return { ok: false, cancelled: true, error: t('已取消') };
    }
    opts.assertCurrent?.();
    const raw = await (handler as ToolHandler)(ctx, args, opts);
    // These handlers return an authoritative GitHub receipt once the write has completed.
    if (opts.signal?.aborted && dotName !== 'github.create' && dotName !== 'github.publish') {
      if (dotName === 'browser.upload') return { ok: false, error: 'File assignment outcome may be unknown after cancellation; inspect the page before retrying.' };
      if (dotName === 'panel.open') return { ok: false, error: 'Panel open outcome may be unknown after cancellation; inspect the panel before retrying.' };
      if (dotName === 'panel.close') return { ok: false, error: 'Panel close outcome may be unknown after cancellation; inspect the panel before retrying.' };
      if (dotName === 'panel.focus') return { ok: false, error: 'Panel focus outcome may be unknown after cancellation; inspect the panel before retrying.' };
      if (dotName === 'panel.split') return { ok: false, error: 'Panel split outcome may be unknown after cancellation; inspect the panel before retrying.' };
      return { ok: false, cancelled: true, error: t('已取消') };
    }
    const { result, imagePath } = splitCaptureDisplay(raw);
    if (dotName.startsWith('desktop.')) {
      const issue = desktopSetupIssue(result, process.platform);
      if (issue) ctx.ui.showDesktopSetup(issue);
    }
    if (dotName.startsWith('desktop.') && result && typeof result === 'object' &&
        'ok' in result && result.ok === false && 'action' in result && typeof result.action === 'string' &&
        'code' in result && typeof result.code === 'string') {
      return { ok: false, code: result.code, result,
        error: 'message' in result && typeof result.message === 'string' ? result.message : result.code };
    }
    if (skipIntegrateConfirm) {
      emitIntegrateAutoApprovalTrace(ctx, args);
    }
    return {
      ok: true,
      result,
      ...(imagePath ? { display: { imagePath } } : {})
    };
  } catch (e) {
    return { ok: false, ...(opts.signal?.aborted ? { cancelled: true } : {}), error: errorMessage(e) };
  }
}

/** 免审批合入成功后的桌面 toast（NotifyStore 内存账本 + toast）；验收账本由 integrateWorktree 落盘 */
function emitIntegrateAutoApprovalTrace(ctx: AppContext, args: Record<string, unknown>): void {
  const sid = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  let sess = sid ? ctx.sessions.get(sid) : undefined;
  if (!sess && sid) {
    try {
      const resolved = ctx.sessions.resolveSessionRef({ sessionId: sid });
      sess = ctx.sessions.get(resolved.id);
    } catch {
      /* 合入已成功，会话可能刚归档 */
    }
  }
  const target =
    typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'main';
  const trace = buildIntegrateAutoApprovalTrace({
    sessionName: sess?.name,
    sessionId: sess?.id || sid,
    target,
    note: pickConfirmNote(args)
  });
  try {
    const workspaceId = sess?.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
    ctx.notify.push({
      workspaceId,
      sessionId: sess?.id || sid || `notify:${workspaceId}`,
      sessionName: sess?.name || trace.sessionName,
      label: trace.label,
      kind: 'info',
      text: trace.text,
      updateKey: trace.updateKey,
      toast: true
    });
  } catch {
    /* 留痕失败不影响已成功的合入 */
  }
}

/** 把执行结果序列化为回填给模型的 tool message 内容 */
export function serializeModelToolResult(r: ExecuteResult, name: string, args: Readonly<Record<string, unknown>>): string {
  // The scheduler supplies this known partial-operation receipt as data. Keep
  // completed effects readable on failure without parsing arbitrary error text.
  const partial = r.result as { ok?: unknown; completed?: unknown; failed?: { error?: unknown } } | null | undefined;
  if (!r.ok && name === 'host.sessions.update' && partial && typeof partial === 'object' &&
      partial.ok === false && Array.isArray(partial.completed)) {
    return serializeResultPayload({ ok: false, cancelled: r.cancelled ?? false,
      ...(r.cancelledBy ? { cancelledBy: r.cancelledBy } : {}),
      ...(r.error !== partial.failed?.error ? { error: r.error } : {}),
      result: modelToolResult(name, args, r.result) }, false);
  }
  // These handlers throw on failure and return only { ok: true } on completion.
  // A new outcome field, including a warning, must still reach the caller.
  if (r.ok && r.result && typeof r.result === 'object' && !Array.isArray(r.result) &&
      (r.result as { ok?: unknown }).ok === true && Object.keys(r.result).length === 1 &&
      ((name === 'host.browser.run' && (args.action === 'close' || args.action === 'navigate')) ||
       (name === 'host.themes.run' && args.action === 'remove'))) return '{"ok":true}';
  return serializeResult(r.ok ? { ...r, result: modelToolResult(name, args, r.result) } : r);
}

export function serializeResult(r: ExecuteResult): string {
  const payload = r.ok
    ? { ok: true, result: r.result ?? null }
    : {
        ok: false,
        cancelled: r.cancelled ?? false,
        ...(r.cancelledBy ? { cancelledBy: r.cancelledBy } : {}),
        ...(r.code ? { code: r.code, result: r.result } : {}),
        error: r.error
      };
  return serializeResultPayload(payload, r.ok);
}

/** Final model/HTTP envelope budget, after projection and JSON escaping. */
function serializeResultPayload(payload: unknown, ok: boolean): string {
  let s: string;
  try {
    s = JSON.stringify(payload);
  } catch {
    s = JSON.stringify({ ok, error: t('结果序列化失败') });
  }
  if (s.length > RESULT_MAX_CHARS) {
    // 不能直接 slice：会产出非法 JSON（下游 shellApi 还要 JSON.parse 再转发，
    // 会话观察 返回 37 万字符 launchError 时必炸：
    // “Unterminated string in JSON at position 12012”）。改为结构化提示，保证总是合法 JSON。
    s = JSON.stringify({
      ok: false,
      error: t('结果过大（{{length}} 字符，上限 {{max}}），已省略；请改用更精简的查询或缩小范围', {
        length: s.length,
        max: RESULT_MAX_CHARS
      })
    });
  }
  return s;
}
