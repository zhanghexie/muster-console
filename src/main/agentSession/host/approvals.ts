import { isOpen } from './lifecycle';
import { initialGuiWorkerMode } from './internal';
/**
 * AgentSessionHost 工具执行人机门：审批卡（含后台子代理审批冒泡）与用户提问卡。
 * 主进程是审批/消息状态的唯一 writer；卡面渲染与应答经渲染层 IPC 回流。
 */
import { randomUUID } from 'node:crypto';
import { decideToolCallPermission } from '../tools/policy';
import type {
  GuiApprovalDecision,
  GuiApprovalRequest,
  GuiUserQuestionOutcome,
  GuiUserQuestionRequest
} from '../types';
import type { NativeApprovalChoice } from '../../../shared/nativeSessionConfig';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { t } from '../../../shared/i18n';
import type { GuiWorkerMode } from '../../../shared/types';
import { isPlanToolName } from '../../../shared/planExtract';
import {
  buildPlanApprovalGate,
  parsePlanSubmission,
  resolvePlanApproval
} from '../../../shared/planApproval';
import type { HostCore, SessionEntry } from './internal';
import { applySignal, log, persistEntry, syncEntry } from './base';

export function respondApproval(
  host: HostCore,
  sessionId: string,
  approvalId: string,
  approved: boolean,
  reason?: string,
  nativeChoiceId?: string
): boolean {
  // 后台子代理审批卡：按 approvalId 独立应答（先查冒泡表，再走本回合审批）
  const sub = host.subagentApprovals.get(approvalId);
  if (sub) {
    const entry = host.entries.get(sessionId);
    if (!entry || sub.sessionId !== sessionId || !sub.isCurrent()) return false;
    const choice = sub.nativeChoices?.find(item => item.id === nativeChoiceId);
    if (sub.nativeChoices ? !choice : nativeChoiceId !== undefined) return false;
    return finishSubagentApproval(host, entry, approvalId,
      choice ? { approved: isNativeAllow(choice), nativeChoiceId } : { approved, reason });
  }
  const entry = host.entries.get(sessionId);
  if (!entry) return false;
  const active = entry.activeApproval;
  if (active?.approvalId !== approvalId || (active.isCurrent && !active.isCurrent())) return false;
  if (active.nativeChoices) {
    const choice = active.nativeChoices.find(item => item.id === nativeChoiceId);
    if (!choice || !active.isCurrent?.()) return false;
    return resolveApprovalInternal(host, entry, approvalId, { approved: isNativeAllow(choice), nativeChoiceId });
  }
  if (nativeChoiceId) return false;
  return resolveApprovalInternal(host, entry, approvalId, { approved, reason });
}

/** fire-time 模式快照（后台子代理审批门控活读用）；会话未打开返回 null */
export function getPolicyState(
  host: HostCore,
  sessionId: string
): { mode: GuiWorkerMode; planExecuting: boolean; allowedPrompts: string[] } | null {
  const entry = host.entries.get(sessionId);
  if (!entry) {
    const session=host.ctx.sessions.get(sessionId);
    return session&&isOpen(host,sessionId)?{mode:initialGuiWorkerMode(session),planExecuting:false,allowedPrompts:[]}:null;
  }
  return {
    mode: entry.mode,
    planExecuting: entry.planExecuting,
    allowedPrompts: entry.planAllowedPrompts
  };
}

/**
 * 后台子代理审批冒泡：在父会话消息流挂一张独立审批卡（不占当前回合）。
 * 卡面渲染与应答复用现有审批卡 UI（respondApproval 按 approvalId 匹配）。
 */
function requestSubagentHumanApproval(
  host: HostCore,
  parentSessionId: string,
  req: GuiApprovalRequest,
  signal?: AbortSignal
): Promise<GuiApprovalDecision> {
  const entry = host.entries.get(parentSessionId);
  if (!entry || entry.closed || signal?.aborted) return Promise.resolve({ approved: false, reason: '父会话已关闭' });
  const isCurrent = () => !entry.closed && !entry.abortRequested && !signal?.aborted &&
    host.entries.get(parentSessionId) === entry && !!host.ctx.sessions.get(parentSessionId);
  return new Promise<GuiApprovalDecision>((resolve) => {
    const approvalId = randomUUID();
    const card: GuiChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [],
      approval: {
        approvalId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        input: req.input,
        reason: req.reason,
        nativeChoices: req.nativeChoices,
        nativeSource: req.nativeSource
      },
      ts: Date.now()
    };
    entry.messages.push(card);
    const cancel = () => finishSubagentApproval(host, entry, approvalId, { approved: false, reason: t('审批请求已取消') });
    host.subagentApprovals.set(approvalId, { cardId: card.id, sessionId: parentSessionId, nativeChoices: req.nativeChoices, isCurrent,
      resolve: decision => { signal?.removeEventListener('abort', cancel); resolve(decision); } });
    signal?.addEventListener('abort', cancel, { once: true });
    applySignal(host, entry, 'blocked', 'gui-subagent-approval');
    syncEntry(host, entry);
  });
}

function finishSubagentApproval(host: HostCore, entry: SessionEntry, id: string, decision: GuiApprovalDecision): boolean {
  const pending = host.subagentApprovals.get(id);
  if (!pending || pending.sessionId !== entry.sessionId) return false;
  host.subagentApprovals.delete(id);
  entry.messages = entry.messages.filter(message => message.id !== pending.cardId);
  pending.resolve(decision);
  if (!entry.activeApproval && ![...host.subagentApprovals.values()].some(approval => approval.sessionId === entry.sessionId)) {
    applySignal(host, entry, entry.busy ? 'active' : 'idle', 'gui-subagent-approval-resolved');
  }
  syncEntry(host, entry);
  return true;
}

/** Background operations keep their parent-session identity and originating cancellation. */
export async function requestSubagentApproval(host: HostCore, parentSessionId: string, req: GuiApprovalRequest, signal?: AbortSignal): Promise<GuiApprovalDecision> {
  const entry = host.entries.get(parentSessionId);
  if (!entry || entry.closed || entry.abortRequested || signal?.aborted || !host.ctx.sessions.get(parentSessionId)) {
    return { approved: false, reason: 'Parent session is closed or the request was cancelled' };
  }
  const human = (reason: string) => usesAutomaticPermissions(host, entry) || req.nativeChoices?.length === 0
    ? Promise.resolve(automaticDecision(req.nativeChoices))
    : requestSubagentHumanApproval(host, parentSessionId, { ...req, reason }, signal);
  return req.nativeChoices ? human(req.reason ?? 'Native permission request') : authorizeWorkerOperation(host, entry, req, human);
}

/** 拒绝某会话消息流里还挂着的子代理审批卡（close/clear 用） */
export function rejectSubagentApprovalsFor(host: HostCore, entry: SessionEntry, reason: string): void {
  cancelPlanApproval(entry);
  for (const [aid, sub] of [...host.subagentApprovals]) {
    if (sub.sessionId !== entry.sessionId) continue;
    host.subagentApprovals.delete(aid);
    sub.resolve({ approved: false, reason });
  }
}

export function resolveApprovalInternal(
  host: HostCore,
  entry: SessionEntry,
  approvalId: string,
  decision: GuiApprovalDecision
): boolean {
  const ap = entry.activeApproval;
  if (!ap || ap.approvalId !== approvalId) return false;
  entry.activeApproval = null;
  if (entry.assistant) entry.assistant.approval = undefined;
  ap.resolve(decision);
  // 无论批准/拒绝，回合都继续（拒绝=工具被 block，模型可见）；
  // 迟到应答（回合早已结束，如 24h 超时后补点）不要把看板拨活
  if (entry.busy) {
    host.ctx.sessions.applyActivitySignal(entry.sessionId, 'active', 'gui-approval-resolved');
  }
  persistEntry(host, entry, [entry.assistant]);
  syncEntry(host, entry);
  return true;
}

/**
 * C2 计划门：计划类工具提交（结构化工具输入）→ ui.confirm 确认卡。
 * 批准 → 回灌「Approved Plan」+ allowedPrompts 预授权；空答案=拒绝；计划卡可回看（挂卡照旧）。
 */
const planApproval = new WeakMap<SessionEntry, { controller: AbortController; approve(): void }>();

export function cancelPlanApproval(entry: SessionEntry): void {
  planApproval.get(entry)?.controller.abort();
}

async function handlePlanApproval(
  host: HostCore,
  entry: SessionEntry,
  req: GuiApprovalRequest,
  signal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<GuiApprovalDecision> {
  if (entry.closed) return { approved: false, reason: t('会话已关闭') };
  const sub = parsePlanSubmission(req.toolName, req.input);
  // 空答案=拒绝：提不出够长计划正文就地拒绝，不进卡
  if (!sub) return { approved: false, reason: t('计划为空或过短，已拒绝') };
  const gate = buildPlanApprovalGate(sub);
  const controller = new AbortController();
  let auto = usesAutomaticPermissions(host, entry);
  const cancel = () => controller.abort();
  let result: Awaited<ReturnType<HostCore['ctx']['ui']['confirm']>> | { confirmed: true };
  if (auto) {
    result = { confirmed: true };
  } else {
    cancelPlanApproval(entry);
    planApproval.set(entry, { controller, approve() {
      auto = true;
      controller.abort();
    } });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      result = await host.ctx.ui.confirm(
        t('审批计划'),
        sub.markdown.slice(0, 8000),
        {
          dangerous: true,
          subtitle: entry.cwd,
          intent: t('批准后按该计划执行，并回灌 Approved Plan'),
          ...(gate.confirmNote ? { confirmNote: gate.confirmNote } : {}),
          summary: gate.summary,
          permission: gate.permission,
          confirmLabel: t('批准计划'),
          cancelLabel: t('拒绝'),
          signal: controller.signal
        }
      );
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (planApproval.get(entry)?.controller === controller) planApproval.delete(entry);
    }
  }
  if (entry.closed || entry.abortRequested || signal?.aborted || (controller.signal.aborted && !auto) || (isCurrent && !isCurrent())) {
    return { approved: false, reason: t('审批请求已取消') };
  }
  const outcome = resolvePlanApproval(sub, auto && usesAutomaticPermissions(host, entry) ? { confirmed: true } : result);
  if (!outcome.approved) {
    return {
      approved: false,
      reason:
        outcome.reason === 'empty-answer'
          ? t('空答案视为拒绝')
          : (outcome.freeText ?? t('计划未获批准'))
    };
  }
  // C2 批准产物落会话：feedback 经下一回合 turn-prefix 回灌（takePlanApprovedFeedback
  // 取走即清）；allowedPrompts 即刻生效（decideToolCallPermission 的 shell 预授权面，
  // 严格匹配——等值/纯空白前缀，含元字符不命中）
  if (outcome.feedback) entry.planApprovedFeedback = outcome.feedback;
  if (outcome.allowedPrompts?.length) {
    const merged = [
      ...new Set([...entry.planAllowedPrompts, ...outcome.allowedPrompts])
    ];
    entry.planAllowedPrompts = merged.slice(0, 20);
  }
  syncEntry(host, entry);
  return {
    approved: true,
    feedback: outcome.feedback,
    allowedPrompts: outcome.allowedPrompts
  };
}

/** C2 计划批准回灌：startTurn 前缀注入用；取走即清（不重复注入） */
export function takePlanApprovedFeedback(entry: SessionEntry): string {
  const fb = entry.planApprovedFeedback ?? '';
  entry.planApprovedFeedback = null;
  return fb;
}

const allowKinds = ['allow_once', 'allow_session', 'allow_always', 'approved', 'allow'];

function isNativeAllow(choice: NativeApprovalChoice): boolean {
  return !!choice.kind && allowKinds.includes(choice.kind);
}

function automaticDecision(choices?: NativeApprovalChoice[]): GuiApprovalDecision {
  if (!choices) return { approved: true };
  const valid = choices.filter(isNativeAllow);
  const choice = valid.find(option => option.kind === 'allow_once' || option.scope === 'once')
    ?? valid.find(option => option.kind === 'allow_session' || option.scope === 'session') ?? valid[0];
  return choice ? { approved: true, nativeChoiceId: choice.id }
    : { approved: false, reason: 'The Harness did not offer a native allow choice.' };
}

function usesAutomaticPermissions(host: HostCore, entry: SessionEntry): boolean {
  const session = host.ctx.sessions.get(entry.sessionId);
  return !!session && !session.archived && session.configurePermissions !== true &&
    !session.workerRouting?.attempts.at(-1)?.crossHarness;
}

export function resolveAutomaticApprovals(host: HostCore, entry: SessionEntry): void {
  if (!usesAutomaticPermissions(host, entry)) return;
  if (entry.busy && !entry.closed && !entry.abortRequested) planApproval.get(entry)?.approve();
  const active = entry.activeApproval;
  if (active) {
    const valid = entry.busy && !entry.closed && !entry.abortRequested && (active.isCurrent?.() ?? !active.nativeChoices);
    const decision = valid ? automaticDecision(active.nativeChoices) : { approved: false, reason: t('审批请求已取消') };
    resolveApprovalInternal(host, entry, active.approvalId, decision);
  }
  for (const [approvalId, pending] of host.subagentApprovals) {
    if (pending.sessionId !== entry.sessionId || !pending.isCurrent()) continue;
    finishSubagentApproval(host, entry, approvalId, automaticDecision(pending.nativeChoices));
  }
}

/** C2 计划门：计划类工具提交走 ui.confirm 确认卡（结构化输入/契约文件均可），不走模态枚举 */
export async function handleApprovalRequest(
  host: HostCore,
  entry: SessionEntry,
  req: GuiApprovalRequest,
  signal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<GuiApprovalDecision> {
  if (signal?.aborted || entry.closed || entry.abortRequested || (isCurrent && !isCurrent())) return { approved: false, reason: t('审批请求已取消') };
  if (req.nativeChoices) {
    if (!isCurrent?.()) return { approved: false, reason: t('审批请求已取消') };
    return queueExternalApproval(host, entry, req, signal, isCurrent);
  }
  if (entry.runtimeId !== 'pi') {
    if (req.requireHumanApproval) return queueExternalApproval(host, entry, req, signal, isCurrent);
    return { approved: false, reason: 'The engine did not provide native approval choices.' };
  }
  if (isPlanToolName(req.toolName)) {
    return handlePlanApproval(host, entry, req, signal, isCurrent);
  }
  return authorizeWorkerOperation(host, entry, req, reason => automaticOrHuman(host, entry, { ...req, reason }, signal, isCurrent));
}

const externalApprovals = new WeakMap<SessionEntry, Promise<unknown>>();

function queueExternalApproval(host: HostCore, entry: SessionEntry, req: GuiApprovalRequest, signal?: AbortSignal, isCurrent?: () => boolean): Promise<GuiApprovalDecision> {
  const cancelled = { approved: false, reason: t('审批请求已取消') };
  const turnId = entry.activeExecutionTurnId;
  const previous = externalApprovals.get(entry) ?? Promise.resolve();
  const result = previous.then(() => entry.closed || entry.abortRequested || !turnId ||
    entry.activeExecutionTurnId !== turnId || signal?.aborted || (isCurrent && !isCurrent())
    ? cancelled : automaticOrHuman(host, entry, req, signal, isCurrent));
  const tail = result.catch(() => {});
  externalApprovals.set(entry, tail);
  void tail.finally(() => {
    if (externalApprovals.get(entry) === tail) externalApprovals.delete(entry);
  });
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const cancel = () => resolve(cancelled);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

function automaticOrHuman(host: HostCore, entry: SessionEntry, req: GuiApprovalRequest, signal?: AbortSignal, isCurrent?: () => boolean): Promise<GuiApprovalDecision> {
  if (usesAutomaticPermissions(host, entry)) {
    const decision = automaticDecision(req.nativeChoices);
    if (!decision.approved) log(host, entry, 'warn', decision.reason ?? 'The Harness denied the request.');
    return Promise.resolve(decision);
  }
  if (req.nativeChoices?.length === 0) return Promise.resolve(automaticDecision(req.nativeChoices));
  return requestHumanApproval(host, entry, req, signal, isCurrent);
}

function requestHumanApproval(host: HostCore, entry: SessionEntry, req: GuiApprovalRequest, signal?: AbortSignal, isCurrent?: () => boolean): Promise<GuiApprovalDecision> {
  return new Promise<GuiApprovalDecision>((resolve) => {
    // 会话关闭后仍可能有迟到请求：直接拒绝
    if (entry.closed || signal?.aborted) {
      resolve({ approved: false, reason: t('会话已关闭') });
      return;
    }
    const approvalId = randomUUID();
    let settled = false;
    const finish = (decision: GuiApprovalDecision): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      resolve(decision);
    };
    const cancel = (): void => {
      const decision = { approved: false, reason: t('审批请求已取消') };
      if (!resolveApprovalInternal(host, entry, approvalId, decision)) finish(decision);
    };
    // 防御：一轮应只有一张卡（依赖 Worker 引擎工具串行调度）。真出现第二张时先把
    // 旧的拒绝结掉——否则旧 promise 永不 settle，driver 侧一直挂到超时。
    if (entry.activeApproval) {
      const prev = entry.activeApproval;
      entry.activeApproval = null;
      if (entry.assistant) entry.assistant.approval = undefined;
      prev.resolve({ approved: false, reason: t('新的审批请求已到达，旧请求已自动拒绝') });
    }
    entry.activeApproval = { approvalId, toolCallId: req.toolCallId, resolve: finish, nativeChoices: req.nativeChoices, isCurrent };
    if (entry.assistant) {
      // 锚点=请求到达时的 parts 长度：卡渲染在该下标前，按真实发生顺序插入
      // （提问/审批夹在两个工具调用之间时不再沉到消息底部）
      entry.assistant.approval = {
        approvalId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        input: req.input,
        reason: req.reason,
        nativeChoices: req.nativeChoices,
        nativeSource: req.nativeSource,
        anchorPartIndex: entry.assistant.parts.length
      };
    }
    applySignal(host, entry, 'blocked', 'gui-approval');
    persistEntry(host, entry, [entry.assistant]);
    syncEntry(host, entry);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function authorizeWorkerOperation(host: HostCore, entry: SessionEntry, req: GuiApprovalRequest, human: (reason: string) => Promise<GuiApprovalDecision>): Promise<GuiApprovalDecision> {
  if (entry.closed || entry.abortRequested) return { approved: false, reason: 'Session closed or cancelled' };
  // The gateway evaluated the real action already. Its prompt is an actual
  // human decision, not the native transport's preliminary permission hop.
  if (req.requireHumanApproval) return human(req.reason ?? 'Tool permission requires approval');
  const ids = entry.toolset?.hostTools.map(tool => tool.id) ?? [];
  const canonical = ids.find(id => id === req.toolName || id.replace(/\./g, '_') === req.toolName) ?? req.toolName;
  const input = req.input && typeof req.input === 'object' && !Array.isArray(req.input) ? req.input as Record<string, unknown> : {};
  const policy = decideToolCallPermission({ mode: entry.mode, planExecuting: entry.planExecuting,
    engineToolName: canonical, input, cwd: entry.turnWorkspaceContext?.cwd ?? entry.cwd, workspaceContext: entry.turnWorkspaceContext,
    hostToolIds: ids, hostClassOf: name => entry.toolset?.hostClassOf(name) ?? 'dynamic', allowedPrompts: entry.planAllowedPrompts });
  if (policy.decision === 'deny') return { approved: false, reason: policy.ruleReason ?? 'Operation is outside the session permission scope' };
  if (policy.decision === 'auto') return { approved: true };
  // Explicit engine/user/directory prompts retain their original human path.
  return human(policy.ruleReason ?? req.reason ?? 'Tool permission requires approval');
}

/** 用户提问（ask_user_question）：挂卡等渲染层作答（respondUserQuestion） */
export function handleUserQuestionRequest(
  host: HostCore,
  entry: SessionEntry,
  req: GuiUserQuestionRequest,
  signal?: AbortSignal
): Promise<GuiUserQuestionOutcome> {
  return new Promise<GuiUserQuestionOutcome>((resolve) => {
    if (entry.closed || signal?.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    const questionId = randomUUID();
    let settled = false;
    const finish = (outcome: GuiUserQuestionOutcome): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      resolve(outcome);
    };
    const cancel = (): void => {
      const outcome: GuiUserQuestionOutcome = { kind: 'aborted' };
      if (!resolveUserQuestionInternal(host, entry, questionId, outcome)) finish(outcome);
    };
    // 防御：同审批卡——第二张提问卡到达时先取消旧卡（依赖引擎 exclusive 调度，
    // 引擎若未来放开并发 ask_user_question 也不至于让旧 promise 悬挂 24h）
    if (entry.activeUserQuestion) {
      const prev = entry.activeUserQuestion;
      entry.activeUserQuestion = null;
      if (entry.assistant?.userQuestion) {
        entry.assistant.userQuestion = { ...entry.assistant.userQuestion, status: 'aborted' };
      }
      prev.resolve({ kind: 'aborted' });
    }
    entry.activeUserQuestion = { questionId, resolve: finish };
    if (entry.assistant) {
      entry.assistant.userQuestion = {
        questionId,
        questions: req.questions,
        status: 'pending',
        anchorPartIndex: entry.assistant.parts.length
      };
    }
    applySignal(host, entry, 'blocked', 'gui-user-question');
    persistEntry(host, entry, [entry.assistant]);
    syncEntry(host, entry);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

/** 渲染层作答/取消（IPC agentSession:respondUserQuestion）；返回是否命中挂起卡 */
export function respondUserQuestion(
  host: HostCore,
  sessionId: string,
  questionId: string,
  action: 'answer' | 'abort',
  answers?: Array<{ id: string; selected: string[]; custom?: string }>
): boolean {
  const entry = host.entries.get(sessionId);
  if (!entry) return false;
  if (action === 'abort') {
    return resolveUserQuestionInternal(host, entry, questionId, { kind: 'aborted' });
  }
  return resolveUserQuestionInternal(host, entry, questionId, {
    kind: 'answered',
    answers: (answers ?? []).map((a) => ({
      id: String(a.id),
      selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
      ...(typeof a.custom === 'string' ? { custom: a.custom } : {})
    }))
  });
}

export function resolveUserQuestionInternal(
  host: HostCore,
  entry: SessionEntry,
  questionId: string,
  outcome: GuiUserQuestionOutcome
): boolean {
  const uq = entry.activeUserQuestion;
  if (!uq || uq.questionId !== questionId) return false;
  entry.activeUserQuestion = null;
  if (entry.assistant?.userQuestion?.questionId === questionId) {
    entry.assistant.userQuestion =
      outcome.kind === 'answered'
        ? { ...entry.assistant.userQuestion, status: 'answered', answers: outcome.answers }
        : { ...entry.assistant.userQuestion, status: 'aborted' };
  }
  // 提问卡与审批卡互斥出现（同属回合内人机等待），解决即回 active；
  // 迟到作答（回合早已结束）不拨看板
  if (entry.busy) {
    host.ctx.sessions.applyActivitySignal(entry.sessionId, 'active', 'gui-question-resolved');
  }
  persistEntry(host, entry, [entry.assistant]);
  syncEntry(host, entry);
  uq.resolve(outcome);
  return true;
}
