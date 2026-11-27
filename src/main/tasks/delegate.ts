import { observedNativeConfigIntent } from '../../shared/nativeSessionConfig';
import { deliverAgentMessage, INITIAL_ASSIGNMENT_KEY } from '../messages/deliver';
import { resumeLegacyGuiAssignment, sendSessionMail } from '../messages/assignment';
import { holdMailboxWake } from '../messages/wake';
import { isolationRecommendation } from '../sessions/isolationPolicy';
/**
 * 统一派活管线（P4）：UI「＋新建任务」与调度 Agent 的 sessions.create 工具走同一条路径。
 * spawn 是提交点（秒级、无 LLM 失败面）；调度 Agent 的知情通知异步发（走 busy 队列），
 * 拉起速度不受 orchestrator 回合影响——对齐 AO delegation.go 的三段式。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { effectiveCliLaunchOptions } from '../../shared/cliLaunchOptions';
import { validateCliModelReasoning } from '../agentSession/cliModelReasoning';
import { initialGuiWorkerMode } from '../agentSession/host/internal';
import type { AppContext } from '../context';
import { currentAgentSessionId, isSchedulerInvocation } from '../agent/agentScope';
import {
  buildNestedRepoBriefNote,
  formatNestedRepoSkipWarning,
  normalizeRepoSetInput,
  selectHealthyNestedTargets,
  inspectSelectedNestedRepos,
  type NestedRepoDiscovery
} from '../git/nestedRepos';
import type { GuiThinkingLevel, GuiWorkerMode, SessionMeta, WorkspaceWorktreeGroupSelection } from '../../shared/types';
import { resolveLaunchConfiguration } from '../../shared/guiInheritMeta';
import { selectSubagentCharacter, subagentSessionName } from '../../shared/subagentCharacters';
import { canSpawnChild, type ParentLookup } from '../../shared/sessionTree';
import { buildBriefWithNamedSkills } from '../capabilities/hosts/chat';
import {
  activeWorkerCount,
  bindDelegateRunner,
  enqueueDelegate,
  readMaxConcurrentWorkers,
  shouldQueueDelegate
} from './delegateQueue';
import { assertSessionTargetCurrent, legacySessionSourceRoot, resolveSessionTarget } from '../sessions/targets';
import { resolveDefaultIsolationGroup } from '../sessions/defaultIsolation';
import { holdPendingSource } from '../workspaceRootUses';
import { captureWorkspaceExecutionContext } from '../workspaceExecutionContext';
import { captureWorktreeSelectionSources, assertWorktreeSelectionSources } from '../git/worktreeSelectionSources';
import { waitForSessionLaunch } from './delegateLaunch';
import { app } from 'electron';
import { prepareGuiInput } from '../attachments/guiInput';
import { clearAttachments, prepareAttachments } from '../attachments/service';
import { existingHandoverDirectory } from '../handover/paths';
import type { WorkerRouteAttempt, WorkerRoutePlan, WorkerRouteState, WorkerTargetSelection } from '../../shared/workerRouting';
import { WORKER_ROUTING_SETTINGS_LOCATION } from '../../shared/workerRouting';
import { assertWorkerRouteCurrent, captureWorkerRoute, validateWorkerReference, workerRouteReceipt } from './workerRouting';
import { validateWorkerConfig, WorkerOptionError } from './workerRoutingCatalog';
import { classifyWorkerRuntimeFailure, cooldownFor, recordWorkerCooldown } from './workerRoutingPolicy';
import { supportsGuiPermissionMode } from '../../shared/guiPermissionOptions';
import { semanticOperationsFor } from '../runtimeKernel/semanticOperations';

const recoveryEpoch = randomUUID();

export interface DelegateTaskInput {
  extensionMeta?: Record<string, string>;
  /** Set by the desktop IPC handler for an instruction explicitly submitted by the user. */
  desktopUserInstruction?: boolean;
  target?: WorkerTargetSelection;
  inherit?: boolean;
  acpPresetId?: string;
  /** Frozen when an accepted request enters the Worker concurrency queue. */
  capturedRoute?: WorkerRoutePlan;
  /** Host-authenticated source of a routed request, including top-level tasks started by a Worker. */
  routingCallerSessionId?: string;
  /** Host cancellation check carried by the active queue runner, never persisted. */
  isCancelled?: () => boolean;
  /** Internal: a prepared handover document is already owned by this future session ID. */
  reservedSessionId?: string;
  cliLaunchOptions?: import('../../shared/cliLaunchOptions').CliLaunchOptions;
  /** 任务全文（必填） */
  task: string;
  attachments?: import('../../shared/types').ChatImageAttachment[];
  /** Host-only stable link to a workflow step or CLI run. */
  creationKey?: string;
  force?: boolean;
  runtime?: string;
  workspaceId?: string;
  rootId?: string;
  cwd?: string;
  rootsRevision?: number;
  /** Internal queue snapshot, fixed when enqueued. */
  capturedSource?: SessionMeta['sourceRoot'];
  /** 调用方已明确决定：true=隔离，false=共享；执行层没有自动兜底。 */
  isolate: boolean;
  /** 会话名；留空取任务前 20 字派生临时名 */
  name?: string;
  /**
   * 父会话 id（子代理通用化 · D7）：带此字段即按「有父」语义解析缺省——
   * GUI harness 默认继承父会话；CLI 必须显式指定。模型、思考档和权限档按兼容规则继承。
   * 不限定固定层数；归属链有效性和宿主统一并发队列仍校验。
   */
  parentSessionId?: string;
  characterId?: string;
  /** 用户直接拉起时通知调度 Agent（默认 true）；调度 Agent 自己经工具调用时传 false 防自言自语 */
  notifyOrchestrator?: boolean;
  /**
   * GUI（chat surface）会话初始态，仅 chat runtime 生效。开局定好：
   * piModeId 产生首条消息后不可更换；guiMode / model / thinking 事后可调但影响全程。
   */
  configurePermissions?: boolean;
  guiMode?: GuiWorkerMode;
  nativeConfig?: import('../../shared/nativeSessionConfig').NativeConfigIntent;
  piModeId?: string;
  /** 会话级模型覆盖（providerId/modelId）；省略跟随全局激活服务商 */
  model?: { providerId: string; modelId: string };
  /** 会话级思考档（仅 Pi；需服务商配置思考映射，否则引擎侧忽略） */
  thinking?: GuiThinkingLevel;
  modelParameters?: import('../../shared/modelParameters').ModelParameterValues;
  /**
   * R-18b 多仓隔离组收窄（repoSet 逃生口）：主仓相对路径列表，只含列出的嵌套独立仓；
   * 缺省=自动发现全量。仅 isolate 时生效。
   */
  repoSet?: string[];
  isolationGroups?: WorkspaceWorktreeGroupSelection[];
  /** sessions.create only: resolve and freeze the cwd repository before queue admission. */
  defaultIsolationGroup?: boolean;
  /** Internal queue identity, never a public tool argument. */
  capturedIsolationSources?: NonNullable<SessionMeta['sourceRoot']>[];
  /** 内部：creationKey 复用已建会话的重试（F-03）——复用分支不写回角色，跳过轮选避免游标空转 */
  skipCharacterSelection?: boolean;
  /** 是否选中并抢中栏焦点（R8）；缺省 true */
  select?: boolean;
  /** 内部：出队重入，跳过并发入队 */
  skipConcurrencyQueue?: boolean;
}

/** AO delegatedTaskDisplayName 同款：任务前 20 字派生临时会话名 */
export function deriveDisplayName(task: string): string {
  const t = task.trim().replace(/\s+/g, ' ');
  return t.length <= 20 ? t : `${t.slice(0, 20)}…`;
}

/**
 * 同仓活跃 Worker 查询（不参与隔离决策）：目标 cwd 所属主仓库里已有活跃 coding worker
 * （同一工作区、非 shell 的 terminal 会话，cwd 落在同一主仓库内），仅返回占用事实，不替调用方选择隔离。
 * 「活跃」的排除项：
 * - 已归档 / 进程 exited；
 * - 已标记完成（phase=done，用户手动或 Worker 上报均算）——工作已闭环，不构成检出争用；
 * - 从未产生过任何工作信号的 idle 空会话（「先开空会话」后一直没派活/没输入）。
 * needs_you / working / blocked / 用过的 idle 都算活跃：会话还占着检出（可能有未合入改动）。
 */
export function hasActiveCodingWorkerInRepo(
  sessions: Array<
    Pick<
      SessionMeta,
      | 'id'
      | 'type'
      | 'launchKind'
      | 'lifecycle'
      | 'archived'
      | 'cwd'
      | 'phase'
      | 'activity'
      | 'firstSignalAt'
    >
  >,
  mainRepo: string,
  isInside: (child: string, root: string) => boolean
): boolean {
  return sessions.some((s) => {
    if (s.type !== 'terminal' || s.launchKind === 'shell') return false;
    if (s.archived || s.lifecycle === 'exited') return false;
    // 已标记完成 = 工作闭环：不再算活跃，新任务不因它隔离
    if (s.phase?.value === 'done') return false;
    // idle 且没有任何结构化信号 / 看板 phase = 从没用过
    if (s.lifecycle === 'idle' && !s.phase && !s.activity && s.firstSignalAt === undefined) {
      return false;
    }
    return !!s.cwd && isInside(s.cwd, mainRepo);
  });
}

/**
 * 建会话的串行闸：createTerminal 先建 worktree 后入列（建树百 ms 级），
 * 串行完成资源创建与会话登记，保持并发派活的创建顺序；隔离选择已由调用方明确给出。
 */
let creationChain: Promise<unknown> = Promise.resolve();

/** 协调回合文案：调度 Agent 只重命名 + 纳入跟踪，绝不重复派活 */
export function buildDelegationNotifyMessage(sessionId: string, sessionName: string, task: string): string {
  return [
    '【任务已直接拉起】',
    `worker 会话 ${sessionName}（${sessionId}）已创建。`,
    ...(task.trim() ? [`任务：${task.trim()}`] : []),
    '不要重复派活；请用 sessions.rename 把该会话改成 ≤20 字短名，并纳入跟踪与后续汇报。'
  ].join('\n');
}

export type { TaskDelegateResult as DelegateTaskResult } from '../../shared/types';
import type { TaskDelegateResult as DelegateTaskResult } from '../../shared/types';

/**
 * 桌面 UI 隔离建议：目标仓 dirty → 建议隔离；不代替调用方明确选择。
 * 新建任务对话框用它预填隔离勾选框（用户仍可手改）；派活只接收最终布尔选择。
 */
export async function recommendIsolate(ctx: AppContext, workspaceId: string, targetCwd?: string): Promise<boolean> {
  return (await isolationRecommendation(ctx, workspaceId, targetCwd)).isolate;
}

/** 取父会话；未给 parentSessionId 返回 null（顶层拉活，行为与改造前一致） */
function resolveParentSession(ctx: AppContext, parentSessionId?: string): SessionMeta | null {
  const id = parentSessionId?.trim();
  if (!id) return null;
  return ctx.sessions.get(id) ?? null;
}

/** 父会话查找器（供 sessionDepth 回溯链深度） */
function parentLookup(ctx: AppContext): ParentLookup {
  return (sessionId: string) => ctx.sessions.get(sessionId);
}

export async function delegateTask(
  ctx: AppContext,
  input: DelegateTaskInput
): Promise<DelegateTaskResult> {
  if (typeof input.isolate !== 'boolean') throw new Error('isolate 必须显式为 true 或 false；执行层不再支持 auto 或默认值。');
  if (input.cliLaunchOptions !== undefined) {
    if (!input.runtime || ctx.sessions.isChatRuntime(input.runtime)) throw new Error('CLI 启动选项需要指定 CLI runtime');
  }
  const parent = resolveParentSession(ctx, input.parentSessionId);
  if (input.parentSessionId && !parent) throw new Error(`父会话不存在: ${input.parentSessionId}`);
  if (input.characterId !== undefined) {
    if (!parent) throw new Error('characterId 仅用于子代理（asSubagent=true）');
    selectSubagentCharacter(input.task ?? '', input.characterId);
  }
  const workspaceId = input.workspaceId?.trim() || parent?.workspaceId || ctx.resolveBubbleWorkspaceId();
  if (parent && (!parent.workspaceId || parent.workspaceId !== workspaceId)) {
    throw new Error('子代理必须与父会话位于同一工作区');
  }
  input = { ...input, workspaceId };
  const recovered = input.creationKey ? ctx.sessions.listByWorkspace(workspaceId).find(session => session.meta?.creationKey === input.creationKey) : undefined;
  if (recovered) {
    if (recovered.archived || recovered.parentSessionId !== input.parentSessionId) throw new Error('已创建会话已归档或归属不符，不能恢复派活');
    // A durable creation identity does not prove that the first task mail was saved.
    // Reuse the same source/runtime and complete the normal idempotent assignment path.
    // F-03：复用已建会话时角色以会话快照为准（缺失也不重选）——复用分支不会把新角色
    // 写回会话，重试再轮选只会推进游标后丢弃结果；skipConcurrencyQueue 恒真，不会入队。
    input = { ...input, cwd: recovered.cwd, rootId: recovered.sourceRoot?.rootId,
      capturedSource: recovered.sourceRoot, runtime: recovered.runtime, characterId: recovered.subagentCharacterId ?? input.characterId, skipConcurrencyQueue: true, skipCharacterSelection: true };
  }
  if (input.isolationGroups !== undefined) {
    if (input.isolate !== true || input.repoSet !== undefined) throw new Error('isolationGroups requires explicit isolation and cannot be combined with legacy repoSet');
    const selection = captureWorktreeSelectionSources(ctx.config.get(), { ...input, isolationGroups: input.isolationGroups });
    input = { ...input, isolationGroups: selection.selections, capturedIsolationSources: selection.sources };
  }
  const release = holdPendingSource(ctx.config, { ...input, additionalRootIds: input.isolationGroups?.map(selection => selection.rootId) },
    { kind: 'launch', id: randomUUID(), label: input.name?.trim() || deriveDisplayName(input.task ?? '') });
  try { return await delegateTaskWithSource(ctx, input); }
  finally { release(); }
}

async function delegateTaskWithSource(ctx: AppContext, input: DelegateTaskInput): Promise<DelegateTaskResult> {
  const task = input.task?.trim() ?? '';
  if (input.reservedSessionId && !existingHandoverDirectory(app.getPath('userData'), input.reservedSessionId)) {
    throw new Error('交接历史文档不存在，无法创建任务');
  }

  const cfg = ctx.config.get();
  const workspaceId = input.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();

  // 解析父会话、拒损坏归属链、继承缺省；创建并发统一走 delegateQueue。
  const parent = resolveParentSession(ctx, input.parentSessionId);
  if (input.parentSessionId && !parent) {
    throw new Error(`父会话不存在: ${input.parentSessionId}`);
  }
  if (parent && parent.workspaceId !== workspaceId) throw new Error('子代理必须与父会话位于同一工作区');
  if (parent && !canSpawnChild(parent, parentLookup(ctx))) {
    throw new Error('父子会话归属链成环或断链，不能继续创建子代理');
  }

  const target = await resolveSessionTarget(cfg, { ...input, workspaceId });
  if (input.inherit === true && parent?.runtime && !ctx.sessions.isChatRuntime(parent.runtime)) {
    input = { ...input, runtime: parent.runtime, cliLaunchOptions: parent.cliLaunchOptions };
  }
  const plan = input.capturedRoute ?? (input.target ? await captureWorkerRoute(ctx, target, input.target) : undefined);
  if (plan) assertWorkerRouteCurrent(ctx, target, plan);
  if (input.runtime && input.cliLaunchOptions) {
    const manifest = ctx.runtimes.get(input.runtime)?.manifest;
    const configurePermissions = input.configurePermissions ?? (parent?.runtime === input.runtime ? parent.configurePermissions : undefined);
    const launch = effectiveCliLaunchOptions(input.runtime, input.cliLaunchOptions, manifest, configurePermissions === true, process.getuid?.());
    await validateCliModelReasoning(input.runtime, launch, target.sourceRoot.cwd, manifest);
  }
  assertSessionTargetCurrent(ctx.config.get(), target);
  if (input.defaultIsolationGroup && input.isolate && input.isolationGroups === undefined) {
    const selection = await resolveDefaultIsolationGroup(ctx, target);
    input = { ...input, isolationGroups: selection.selections, capturedIsolationSources: selection.sources };
  }
  if (input.isolationGroups) assertWorktreeSelectionSources(ctx.config.get(), workspaceId, input.isolationGroups, input.capturedIsolationSources!);
  const cwd = target.cwd;
  // F-03：creationKey 复用重试（skipCharacterSelection）不重新选角——选了也不会写回复用会话，
  // 只会空转轮选游标；name 在复用分支不落盘，无前缀无影响。
  const character = parent && !input.skipCharacterSelection ? selectSubagentCharacter(task, input.characterId) : undefined;
  const hasTask = !!task || !!input.attachments?.length;
  const taskName = input.name?.trim() || deriveDisplayName(task || input.attachments?.[0]?.name || '');
  const name = character ? subagentSessionName(character.id, taskName) : taskName;

  if (!input.skipConcurrencyQueue && shouldQueueDelegate(ctx, workspaceId)) {
    const q = enqueueDelegate(ctx, workspaceId, { ...input, capturedRoute: plan, characterId: character?.id, name, rootId: target.sourceRoot.rootId, cwd, capturedSource: target.sourceRoot, rootsRevision: undefined, skipConcurrencyQueue: true });
    return {
      notified: false,
      queued: true,
      status: 'queued',
      queueId: q.queueId,
      queuePosition: q.position,
      maxConcurrentWorkers: q.maxConcurrentWorkers,
      activeWorkers: q.activeWorkers,
      ...(plan ? { routing: { requested: 'tierId' in plan.requested ? { tierId: plan.requested.tierId } : { exact: true as const }, state: 'queued' as const } } : {})
    };
  }

  // R-18b 多仓隔离组·事前提示（负担优化）：预发现嵌套仓 → 简报附「本次预计涉及插件」
  // （显式 repoSet 收窄，未指定使用建组清单），并把集合透传给
  // createTerminal（同一次扫描建组，口径不漂移）。预发现失败不拦派活（建组路径统一校验），
  // 但 repoSet 列不存在仍在此早报错——少建一棵树再回滚。
  let nestedRepoNote = '';
  let repoSetForCreate: string[] | undefined;
  if (!input.isolationGroups && input.isolate) {
    const normalized = normalizeRepoSetInput(input.repoSet);
    if (!normalized.ok) throw new Error(normalized.message);
    const wanted = input.repoSet === undefined ? [] : normalized.paths;
    let discovery: NestedRepoDiscovery | null = null;
    try {
      if (wanted !== undefined && !wanted.length) discovery = { healthy: [], skipped: [] };
      else {
        const mainRepo = await ctx.git.resolveMainRepoFor(cwd, target.wsPath);
        if (mainRepo) discovery = wanted !== undefined ? await inspectSelectedNestedRepos(mainRepo, wanted) : await ctx.git.discoverNestedReposDetailedFor(mainRepo, { workspaceId });
      }
    } catch (err) {
      console.warn('[delegate] 嵌套仓预发现失败（建组路径会再校验）', err);
    }
    if (discovery) {
      const selected = selectHealthyNestedTargets(discovery, wanted);
      if (!selected.ok) throw new Error(selected.message);
      // An explicitly empty set must survive every layer, including an empty snapshot.
      repoSetForCreate = selected.targets;
      nestedRepoNote = buildNestedRepoBriefNote({
        ...(wanted !== undefined ? { repoSet: repoSetForCreate } : {}),
        discovered: selected.targets
      });
      if (selected.skipped.length) {
        const warn = formatNestedRepoSkipWarning(selected.skipped);
        console.warn('[delegate]', warn);
        nestedRepoNote = nestedRepoNote ? `${nestedRepoNote}\n${warn}` : warn;
      }
    } else if (wanted !== undefined) {
      repoSetForCreate = wanted;
    }
  }

  // Empty-session and task creation share the same validated launch configuration.
  // A parent's adapter choice remains compatible only in its own source.
  const sourceCompatible = !parent?.sourceRoot || (parent.sourceRoot.rootId === target.sourceRoot.rootId && parent.sourceRoot.cwd === target.sourceRoot.cwd);
  const launchParent = parent && { ...parent, nativeConfig: undefined,
    ...(!sourceCompatible ? { modelOverride: undefined, modelParameters: undefined, thinkingLevel: undefined } : {}) };
  const inheritedNativeConfig = (owner: SessionMeta) => {
    if (owner.configurePermissions !== true || !owner.runtime || owner.runtime === 'pi' || !ctx.sessions.isChatRuntime(owner.runtime)) return undefined;
    if (owner.archived || !owner.sourceRoot || owner.sourceRoot.rootId !== target.sourceRoot.rootId || owner.sourceRoot.cwd !== target.sourceRoot.cwd) {
      throw new WorkerOptionError('Native settings can only be inherited from the same source folder and Harness.');
    }
    const observed = observedNativeConfigIntent(ctx.agentSessions?.getNativeConfig(owner.id) ?? null);
    if (!observed) throw new WorkerOptionError('The parent Harness did not report a complete, transferable permission state.');
    return observed;
  };
  const buildCliBrief = async (sessionId?: string) => {
    let text = task;
    if (input.attachments?.length && sessionId) {
      const prepared = await prepareAttachments({ userData: app.getPath('userData'), scope: 'cli:' + sessionId,
        text, attachments: input.attachments, supportsImages: false, tools: cfg.attachmentTools,
        processing: cfg.attachmentProcessing, workerFile: path.join(app.getAppPath(), 'out/main/attachments/worker.mjs') });
      text = prepared.text;
    }
    return (await buildBriefWithNamedSkills(ctx, undefined, text, {
      workspaceRoot: target.controlRoot,
      skillCwd: cwd,
      workspaceContext: captureWorkspaceExecutionContext(ctx.config.get(), {
        id: 'pending-brief', name, type: 'terminal', createdAt: 0, workspaceId, cwd, sourceRoot: target.sourceRoot
      }, ctx.sessions.rootDependencyRoster?.() ?? ctx.sessions.list())
    })).brief + (nestedRepoNote ? `\n【多仓隔离组】${nestedRepoNote}` : '');
  };
  let cliBrief: string | undefined;

  let reusedSession = false;
  const decideIsolateAndCreate = async (): Promise<{ session: SessionMeta; isolate: boolean }> => {
    const existing = input.creationKey ? ctx.sessions.listByWorkspace(workspaceId).find(session => session.meta?.creationKey === input.creationKey) : undefined;
    if (existing) {
      if (existing.archived || existing.parentSessionId !== input.parentSessionId) throw new Error('已创建会话已归档或归属不符，不能恢复派活');
      reusedSession = true;
      return { session: existing, isolate: !!existing.worktreePath };
    }
    // 排队前调用方已决定；出队不因 dirty 变化改写选择。
    const isolate = input.isolate;
    assertSessionTargetCurrent(ctx.config.get(), target);
    const routeSessionId = input.reservedSessionId ?? (plan || input.attachments?.length ? randomUUID() : undefined);
    const create = async (
      runtime: string,
      initialMeta: ReturnType<typeof resolveLaunchConfiguration>['inheritMeta'],
      cliLaunchOptions = input.cliLaunchOptions,
      routing?: WorkerRouteState,
      assertCallerPermissions?: () => void
    ): Promise<SessionMeta> => ctx.sessions.createTerminal({
      name,
      ...(routeSessionId ? { reservedSessionId: routeSessionId } : {}),
      ...(input.extensionMeta || input.creationKey ? { meta: { ...input.extensionMeta, ...(input.creationKey ? { creationKey: input.creationKey } : {}) } } : {}),
      ...(input.force ? { force: true } : {}),
      runtime,
      cwd,
      ...(cliLaunchOptions ? { cliLaunchOptions } : {}),
      ...(routing ? { workerRouting: routing, assertRoutingCurrent: () => {
        if (input.isCancelled?.()) throw new WorkerOptionError('Worker task was cancelled before launch.');
        assertWorkerRouteCurrent(ctx, target, routing.plan);
        assertCallerPermissions?.();
      } } : {}),
      workspaceId,
      rootId: target.sourceRoot.rootId,
      capturedSource: target.sourceRoot,
      isolate,
      ...(input.isolationGroups ? { isolationGroups: input.isolationGroups, capturedIsolationSources: input.capturedIsolationSources } : {}),
      ...(repoSetForCreate !== undefined ? { repoSet: repoSetForCreate } : {}),
      injectHostIntro: true,
      ...(!ctx.sessions.isChatRuntime(runtime) && hasTask ? { initialPrompt: cliBrief ??= await buildCliBrief(routeSessionId) } : {}),
      activate: input.select !== false,
      ...(parent ? { parentSessionId: parent.id, subagentCharacterId: character!.id } : {}),
      ...(initialMeta ? { inheritMeta: initialMeta } : {})
    });
    if (!plan) {
      const resolved = resolveLaunchConfiguration(input, launchParent, cfg.defaultRuntime, id => ctx.sessions.isChatRuntime(id));
      const sameAdapter = launchParent && launchParent.runtime === resolved.runtime &&
        (resolved.runtime !== 'acp' || launchParent.piModeId === resolved.inheritMeta?.piModeId);
      const nativeConfig = sameAdapter && resolved.inheritMeta?.configurePermissions === true && !input.nativeConfig ? inheritedNativeConfig(launchParent) : undefined;
      const cliOptions = input.cliLaunchOptions ?? (sameAdapter && sourceCompatible && !ctx.sessions.isChatRuntime(resolved.runtime) ? launchParent.cliLaunchOptions : undefined);
      try {
        return { session: await create(resolved.runtime, nativeConfig ? { ...resolved.inheritMeta, nativeConfig } : resolved.inheritMeta, cliOptions), isolate };
      } catch (error) {
        if (routeSessionId && input.attachments?.length && !ctx.sessions.isChatRuntime(resolved.runtime) && !ctx.sessions.get(routeSessionId)) {
          clearAttachments(app.getPath('userData'), 'cli:' + routeSessionId);
        }
        throw error;
      }
    }
    const permissionOwnerId = parent?.id ?? input.routingCallerSessionId;
    const routing: WorkerRouteState = { plan, attempts: [], phase: 'starting',
      ...(parent || input.routingCallerSessionId || input.configurePermissions === true ? { crossHarnessRestricted: true } : {}) };
    const attempted = new Set<string>();
    for (const candidate of plan.candidates) {
      if (input.isCancelled?.()) throw new WorkerOptionError('Worker task was cancelled before launch.');
      assertWorkerRouteCurrent(ctx, target, plan);
      const key = JSON.stringify(candidate.config);
      if (attempted.has(key)) continue;
      attempted.add(key);
      const cooldown = cooldownFor(ctx, target, candidate.config);
      if (cooldown) { routing.reason = cooldown.reason; continue; }
      const { crossHarness: _consent, ...launchCandidate } = candidate;
      const attempt: WorkerRouteAttempt = { ...launchCandidate, attempt: routing.attempts.length + 1, startedAt: Date.now(), state: 'starting' };
      routing.attempts.push(attempt);
      try {
        if ('targetRef' in plan.requested) await validateWorkerReference(ctx, target, plan.requested.targetRef);
        const checked = await validateWorkerConfig(ctx, target, candidate.config, true);
        const config = checked.config;
        if (config.surface === 'cli' && input.configurePermissions === true && (input.guiMode || input.nativeConfig)) throw new WorkerOptionError('GUI engine settings require a GUI Harness.');
        if (input.configurePermissions === true && input.guiMode && !supportsGuiPermissionMode(config.runtimeId, input.guiMode)) throw new WorkerOptionError('This Worker candidate cannot enforce the requested workbench permission mode.');
        const permissionOwner = permissionOwnerId ? ctx.sessions.get(permissionOwnerId) : undefined;
        if (permissionOwnerId && (!permissionOwner || permissionOwner.archived || permissionOwner.workspaceId !== workspaceId ||
            (input.configurePermissions !== undefined && input.configurePermissions !== (permissionOwner.configurePermissions === true)) ||
            (permissionOwner.configurePermissions === true && input.guiMode !== undefined && input.guiMode !== (permissionOwner.guiMode ?? 'default')))) {
          throw new WorkerOptionError('This Worker candidate cannot prove that it preserves the caller’s Harness permissions.');
        }
        const sameHarness = permissionOwner?.runtime === config.runtimeId &&
          (config.runtimeId !== 'acp' || permissionOwner.piModeId === config.acpPresetId);
        let assertCallerPermissions: (() => void) | undefined;
        if (permissionOwner && !sameHarness) {
          if (!parent || input.routingCallerSessionId !== parent.id || !('targetRef' in plan.requested)) {
            throw new WorkerOptionError('Cross-Harness Worker creation requires a subagent with an exact target reference.');
          }
          if (input.configurePermissions !== undefined || input.guiMode !== undefined || input.nativeConfig !== undefined) {
            throw new WorkerOptionError('Cross-Harness subagents use the selected Harness’s launch permissions.');
          }
          // Only Core Full access is a verified broad host policy. Native auto-approval
          // can still run under an engine sandbox, so it cannot authorize another Harness.
          assertCallerPermissions = () => {
            const caller = ctx.sessions.get(parent.id);
            const callerSource = caller && legacySessionSourceRoot(ctx.config.get(), caller);
            const livePolicy = ctx.agentSessions?.getPolicyState(parent.id);
            if (!caller || caller.archived || caller.runtime !== 'pi' || caller.workspaceId !== workspaceId ||
                callerSource?.rootId !== target.sourceRoot.rootId || callerSource.cwd !== target.sourceRoot.cwd ||
                initialGuiWorkerMode(caller) !== 'auto' || (livePolicy && (livePolicy.mode !== 'auto' || livePolicy.planExecuting))) {
              throw new WorkerOptionError('Cross-Harness subagents require a Muster Core parent with Full access in the current source folder.');
            }
          };
          assertCallerPermissions();
        }
        const permissionParent = sameHarness ? permissionOwner : undefined;
        const nativeConfig = permissionParent ? inheritedNativeConfig(permissionParent) : undefined;
        if (permissionParent?.configurePermissions === true && input.nativeConfig !== undefined && JSON.stringify(input.nativeConfig) !== JSON.stringify(nativeConfig)) {
          throw new WorkerOptionError('Requested native settings differ from the caller’s observed Harness permissions.');
        }
        const selected = resolveLaunchConfiguration({ runtime: config.runtimeId, acpPresetId: config.acpPresetId,
          model: config.model, modelParameters: config.surface === 'gui' ? checked.launchParameters : undefined,
          configurePermissions: input.configurePermissions, guiMode: input.guiMode, nativeConfig: input.nativeConfig },
          permissionParent && { runtime: permissionParent.runtime, piModeId: permissionParent.piModeId, configurePermissions: permissionParent.configurePermissions, guiMode: permissionParent.guiMode, nativeConfig },
          cfg.defaultRuntime, id => ctx.sessions.isChatRuntime(id));
        const cli = config.runtimeId === 'kimi-cli' && config.modelParameters?.reasoning
          ? { ...config.cliLaunchOptions, reasoning: config.modelParameters.reasoning } : config.cliLaunchOptions;
        const session = await create(selected.runtime, selected.inheritMeta, cli, routing, assertCallerPermissions);
        return { session, isolate };
      } catch (error) {
        if (routeSessionId && ctx.sessions.get(routeSessionId)) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sessionId: routeSessionId });
        const failure = classifyWorkerRuntimeFailure(error) ?? (error instanceof WorkerOptionError
          ? { reason: error.availability === 'unavailable' ? 'engine-unavailable' as const : 'invalid-choice' as const } : undefined);
        if (!failure || 'targetRef' in plan.requested || input.isCancelled?.()) throw error;
        attempt.state = 'failed'; attempt.reason = failure.reason; routing.reason = failure.reason;
        recordWorkerCooldown(ctx, target, candidate.config, failure);
      }
    }
    const reason = routing.reason ?? 'unavailable';
    try {
      ctx.eventRouter?.publish({ source: 'fact', type: 'worker.route.exhausted', scope: routeSessionId!, workspaceId,
        deliveryId: `worker-route:${routeSessionId}:exhausted`, receivedAt: Date.now(), summary: `Worker route exhausted (${reason})`,
        payload: JSON.stringify({ tierId: 'tierId' in plan.requested ? plan.requested.tierId : undefined,
          attempts: routing.attempts.map(attempt => ({ attempt: attempt.attempt, harnessId: attempt.config.harnessId, reason: attempt.reason })) }) });
    } catch (error) { console.warn('[worker-routing] exhaustion event could not be saved:', error); }
    throw new WorkerOptionError(`Worker route exhausted (${reason}). Check enabled models and cooldowns in ${WORKER_ROUTING_SETTINGS_LOCATION}.`);
  };
  const staged = creationChain.then(
    () => decideIsolateAndCreate(),
    () => decideIsolateAndCreate()
  );
  creationChain = staged.then(
    () => undefined,
    () => undefined
  );
  const { session, isolate } = await staged;
  const isGuiRuntime = ctx.sessions.isChatRuntime(session.runtime);
  ctx.sessions.ensureStatusToken(session.id);
  if (!reusedSession) ctx.sessions.clearDonePhase(session.id);
  // 派活身份：调度经 sessions.create 拉起的会话置编排标记（UI「＋新建任务」/ext-tool
  // 同走此管线但无调度上下文，不置）。延迟 drain 的排队项由 delegateQueue 重包上下文。
  if (isSchedulerInvocation()) ctx.sessions.setOrchestrated(session.id, true);

  let inject: DelegateTaskResult['inject'];
  let status: 'started' | 'starting' = plan ? 'starting' : 'started';
  const completed = reusedSession && ['needs_you', 'done'].includes(session.phase?.value ?? '');
  const dormant = reusedSession && !completed && (isGuiRuntime ? !ctx.agentSessions?.isOpen(session.id) : !ctx.pty.isRunning(session.id));
  const releaseWake = reusedSession ? holdMailboxWake(ctx, session.id, workspaceId) : undefined;
  try {
    if (input.isCancelled?.()) throw new Error('Worker task was cancelled before assignment.');
    const legacy = task && isGuiRuntime && reusedSession ? resumeLegacyGuiAssignment(ctx, session, workspaceId) : undefined;
    if (hasTask && isGuiRuntime && !legacy) {
      const messageId = `worker-task-${session.id}`;
      const submit = async (): Promise<DelegateTaskResult['inject']> => {
        if (input.isCancelled?.()) throw new Error('Worker task was cancelled before assignment.');
        if (completed) return;
        const host = ctx.agentSessions;
        if (!host) throw new Error('GUI Worker host is unavailable.');
        if (dormant && !host.isOpen(session.id)) await ctx.sessions.respawn(session.id);
        const callerId = currentAgentSessionId();
        const caller = callerId ? ctx.sessions.get(callerId) : parent;
        const prepared = input.attachments?.length
          ? await prepareGuiInput(ctx, session, task, input.attachments)
          : { text: task, images: undefined };
        const sent = await host.send(session.id, prepared.text, prepared.images, {
          messageId, steerOnBusy: false,
          ...(!input.desktopUserInstruction ? {
            fromInject: true,
            source: isSchedulerInvocation() ? 'scheduler' as const : 'agent' as const,
            ...(caller ? { sourceAgent: { sessionId: caller.id, name: caller.name, characterId: caller.subagentCharacterId } } : {})
          } : {})
        });
        if (!sent.ok) throw new Error(sent.error ?? 'Could not send the first GUI task message.');
        return { mode: 'gui-prompt', briefChars: task.length, messageId, ...(sent.queued ? { queued: true } : {}) };
      };
      // A keyed creation can be recovered by a workflow or retried concurrently. Reuse its chat receipt.
      inject = input.creationKey
        ? await semanticOperationsFor(ctx, session.id, app.getPath('userData'), ctx.sessionLogs)
          .run('gui.task', messageId, [messageId], submit, result => result !== undefined)
        : await submit();
    } else if (hasTask && !isGuiRuntime && !reusedSession) {
      inject = { mode: 'cli-prompt', briefChars: cliBrief!.length };
    } else if (hasTask && !(input.desktopUserInstruction && !isGuiRuntime && (completed || ctx.pty.isRunning(session.id)))) {
      const mail = legacy ?? await sendSessionMail(ctx, { sessionId: session.id, text: await buildCliBrief(session.id), idempotencyKey: INITIAL_ASSIGNMENT_KEY, reuseExisting: true });
      inject = { mode: 'mailbox', briefChars: mail.textChars, messageId: mail.messageId };
      if (dormant && !mail.initialAssignmentPending) {
        // A prior wake/read receipt is historical. A fresh host notice resumes unfinished
        // work without altering either receipt or duplicating the original assignment.
        await sendSessionMail(ctx, { sessionId: session.id,
          text: `宿主已恢复工作流。请核对原任务信 ${mail.messageId} 与现有上下文：未完成时继续，已完成则保留结果，勿重复执行。`,
          idempotencyKey: `assignment-recovery:${recoveryEpoch}:${session.runtimeStartedAt ?? 'cold'}` });
        if (!isGuiRuntime && !ctx.pty.isRunning(session.id)) await ctx.sessions.respawn(session.id);
      }
    }
    if (!completed && !isGuiRuntime) {
      const launch = await waitForSessionLaunch(ctx, session.id);
      status = launch === 'running' ? 'started' : 'starting';
      const attempt = session.workerRouting?.attempts.at(-1);
      if (launch === 'running' && attempt) ctx.sessions.noteWorkerRoute?.(session.id, attempt.attempt, 'running');
    }
  } catch (error) {
    // 投递阶段失败时会话已建出且保留（r1-W3）：统一结构化附带 sessionId，
    // 工作流取消的迟到补偿据此补关/记账，不留孤儿；其余调用方不受影响
    const failure = error instanceof Error ? error : new Error(String(error));
    if ((failure as Error & { sessionId?: string }).sessionId === undefined) {
      (failure as Error & { sessionId?: string }).sessionId = session.id;
    }
    throw failure;
  } finally { releaseWake?.(); }

  if (input.select !== false) {
    // select 按 workspaceId 隔离：同区才抢中栏+reveal；跨区只记该区待显示
    void ctx.sessions.select(session.id);
  }
  // 3) 异步寄信通知调度 Agent（忙时留信；不阻塞拉起）
  let notified = false;
  if (input.notifyOrchestrator !== false && ctx.orchestrator) {
    const message = buildDelegationNotifyMessage(session.id, session.name, task);
    notified = true;
    void deliverAgentMessage(ctx, { from: 'host', to: 'scheduler', workspaceId, text: message, idempotencyKey: 'created:' + session.id }).catch((err: unknown) => {
      console.error('[delegate] orchestrator notify failed', err);
    });
  }

  // R-18b：建组结果以会话实际记账为准（预发现只是提示口径），带回给调度
  const groupRepos = ctx.sessions
    .get(session.id)
    ?.worktreeRepoSet?.map((r) => r.path);

  const current = ctx.sessions.get(session.id) ?? session;
  return {
    session: current,
    ...(current.workerRouting ? { routing: workerRouteReceipt(current.workerRouting) } : {}),
    inject,
    isolate,
    ...(isolate ? { repoSet: groupRepos ?? [] } : {}),
    ...(nestedRepoNote && groupRepos?.length ? { repoNote: nestedRepoNote } : {}),
    notified,
    status,
    maxConcurrentWorkers: readMaxConcurrentWorkers(ctx, workspaceId),
    activeWorkers: activeWorkerCount(ctx, workspaceId),
  };
}

if (typeof bindDelegateRunner === 'function') bindDelegateRunner(delegateTask);
