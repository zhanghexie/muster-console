import { assertTaskWorktreeOperationIdle, taskWorktreeOwnership } from '../git/worktreeTaskOperation';
import { projectPrimaryWorktree } from '../../shared/sessionWorktrees';
/**
 * createTerminal 双分支（2026-09-26 sessions.ts → sessions/ 拆分，行为保持）：
 * - shell 分支（createShellTerminalSession）与 agent 分支（createAgentTerminalSession）
 *   从 SessionsService.createTerminal 原样迁出，经 CreateTerminalFlowCtx 回接服务状态；
 * - 会话行构建 / inheritMeta 应用的纯函数由 sessions-split-pure.mjs 覆盖；
 *   多根目录归属与真实路径校验集中在 targets.ts，由 session-source-targets.mjs 覆盖。
 * 先物化会话行并 broadcast；CLI/Shell 后台拉起，GUI 等目录校验与 host.open 完成再返回。
 */
import { randomUUID } from 'node:crypto';
import { assertLaunchModel } from '../../shared/guiInheritMeta';
import { cliArgsForSession, effectiveCliLaunchOptions } from '../../shared/cliLaunchOptions';
import { validateCliModelReasoning } from '../agentSession/cliModelReasoning';
import { supportsGuiPermissionMode } from '../../shared/guiPermissionOptions';
import path from 'node:path';
import type {
  GuiSessionInitialMeta,
  NestedRepoSkipInfo,
  SessionMeta,
  SessionWorktreeGroups,
  WorkspaceWorktreeGroupSelection,
  ShellProfileId
} from '../../shared/types';
import { isShellProfileId } from '../../shared/types';
import { normalizeSessionWorktrees } from '../../shared/sessionWorktrees';
import { t } from '../../shared/i18n';
import type { ConfigManager } from '../config';
import type { GitService } from '../git/service';
import { formatNestedRepoSkipWarning, nestedWorktreePath, rollbackNestedWorktrees } from '../git/nestedRepos';
import { isolateWalkCeiling } from '../git/workspaceResolve';
import { readWorkspaceFile } from '../metaAgent/workspaceFile';
import { createTaskWorktreeGroups, type TaskWorktreeCreateResult } from '../git/worktreeTaskCreate';
import { assertWorktreeSelectionSources, captureWorktreeSelectionSources } from '../git/worktreeSelectionSources';
import { preparationsForSelections, repositoryPreparations, repositoryExclusions } from '../../shared/worktreePreparation';
import type { NotifyStore } from '../notify/store';
import type { RuntimeHost } from '../runtime/host';
import { shellProfileLabel } from '../shell/profiles';
import type { UsageStatsService } from '../usage/service';
import { preflightRuntime } from '../runtime/preflight';
import { RuntimePreflightError } from '../../shared/runtimePreflight';
import { assertSessionTargetCurrent, type SessionTarget } from './targets';
import { sourcePathKey } from '../workspacePaths';
import type { SessionPersister } from './persister';

/** SessionsService 晚绑定的 GUI 会话宿主最小面（预检探测 driver 用） */
export type SessionServiceAgentSessions = {
  validateLaunchParameters?(runtime: string, cwd: string, meta: GuiSessionInitialMeta): Promise<import('../../shared/modelParameters').ModelParameterContext | undefined>;
  rememberLaunchParameterContext?(session: SessionMeta, context: import('../../shared/modelParameters').ModelParameterContext): void;
  validateLaunchModel?(runtime: string, cwd: string, model: SessionMeta['modelOverride'], piModeId?: string): Promise<void>;
  assertLaunchModelAllowed?(runtime: string, model: SessionMeta['modelOverride'], piModeId?: string): void;
  validateNativeConfigIntent?(target: Pick<SessionMeta, 'runtime' | 'piModeId' | 'cwd' | 'workspaceId' | 'sourceRoot'>, raw: unknown):
    Promise<import('../../shared/nativeSessionConfig').NativeConfigIntent | undefined>;
  probeRuntime(
    id: string,
    piModeId?: string,
    modelOverride?: SessionMeta['modelOverride']
  ): Promise<import('../agentSession/types').GuiRuntimeProbeResult>;
};

export interface CreateTerminalOptions {
  /** Host-owned route attempt and source recheck, outside the public IPC schema. */
  workerRouting?: SessionMeta['workerRouting'];
  assertRoutingCurrent?: () => void;
  cliLaunchOptions?: import('../../shared/cliLaunchOptions').CliLaunchOptions;
  configurePermissions?: boolean;
  name?: string;
  runtime?: string;
  cwd?: string;
  workspaceId?: string;
  rootId?: string;
  rootsRevision?: number;
  /** Internal fork/recovery: an existing registered session supplies external tree identity. */
  sourceSessionId?: string;
  /**
   * 父会话 id（子代理通用化）：带此字段建出的会话在左栏挂父下方，链深度上限 3。
   * 深度校验与缺省继承在 `tasks/delegate.ts` 的 delegateTask 内完成（那里才知道父是谁）。
   */
  parentSessionId?: string;
  subagentCharacterId?: SessionMeta['subagentCharacterId'];
  /** Internal queue snapshot. */
  capturedSource?: SessionMeta['sourceRoot'];
  meta?: Record<string, string>;
  initialPrompt?: string;
  /**
   * 无 initialPrompt 时是否发送简短的宿主介绍。
   * 默认 true（先开空会话要让模型认宿主）。首次任务由邮箱提供时应传 false。
   */
  injectHostIntro?: boolean;
  /** 有值则创建 shell 会话，忽略 runtime / CLI allocate */
  shellProfileId?: string;
  /** 隔离派活（P3.5）：在主仓库建 ao/<sessionId> worktree，会话 cwd 指向 worktree */
  isolate?: boolean;
  /**
   * R-18b 多仓隔离组收窄（repoSet 逃生口）：主仓相对路径列表，只含列出的嵌套仓；
   * 缺省=自动发现主仓内全部嵌套独立仓。仅 isolate 时生效。
   */
  repoSet?: string[];
  /** Explicit rooted repository groups; requires isolation. */
  isolationGroups?: WorkspaceWorktreeGroupSelection[];
  /** Host-only queue snapshot; callers cannot redirect an admitted selection. */
  capturedIsolationSources?: NonNullable<SessionMeta['sourceRoot']>[];
  /**
   * GUI（chat surface）Worker 会话初始态：piModeId / guiMode / modelOverride / thinkingLevel。
   * 只对 chat runtime 生效，供 delegate / 新建面板「高级选项」指定。
   */
  inheritMeta?: GuiSessionInitialMeta;
  /** Internal GUI fork/continuation: copy unchanged source configuration without requiring a catalog cache. */
  inheritSourceGuiConfig?: boolean;
  /** Internal handover draft reserves the ID of its future session. */
  reservedSessionId?: string;
  /**
   * 内部入口使用的隐藏临时会话。不进 list/broadcast、不抢 activeId。
   * 外部 IPC sessions:create 不得传入。
   */
  hidden?: boolean;
  /** 是否设为当前选中；缺省 true。hidden 时强制 false */
  activate?: boolean;
  /** Host-only: a hidden Pi panel session validates its model when it runs a turn. */
  deferModelValidation?: boolean;
  /** Host-only: prepare a GUI fork before the session is registered or broadcast. */
  prepareGuiSession?: (session: SessionMeta) => void | Promise<void>;
  /**
   * claude-code 原生 fork：用源 CLI session id `--resume` + `--fork-session`，
   * 新会话自己的 externalSessionId 仍走 allocate。
   */
  forkFromExternalSessionId?: string;
  /** 预检逃生门：true=跳过 runtime 可用性预检强创（预检失败报错里会提示本参数） */
  force?: boolean;
}

/** createTerminal 分支函数回接 SessionsService 状态的窄接口（方法由服务绑定 this 转发） */
export interface CreateTerminalFlowCtx {
  config: ConfigManager;
  runtimes: RuntimeHost;
  git?: GitService;
  notify: NotifyStore;
  usageStats: UsageStatsService | null;
  /** GUI 会话宿主（晚绑定）：chat runtime 预检经它探测 driver 可用性；未绑定=chat 预检落 unknown，按不可用拒绝创建 */
  agentSessionsRef: SessionServiceAgentSessions | null;
  /** 当前注册表数组（getter 转发，close/reload 重赋值后仍拿新引用） */
  readonly sessions: SessionMeta[];
  isChatRuntime(runtimeKey: string | undefined): boolean;
  applySelectDisplay(s: SessionMeta, activate?: boolean): 'show' | 'pending' | 'skip';
  persist(): void;
  persistStrict?: SessionPersister['flushStrict'];
  broadcast(): void;
  get(id: string): SessionMeta | undefined;
  launchTerminal(
    s: SessionMeta,
    mode: 'start' | 'resume' | 'fork',
    initialPrompt?: string,
    forkFromExternalSessionId?: string,
    injectHostIntro?: boolean
  ): Promise<void>;
}

/** shell 会话命名：区内首个用配置档标签，重名追加序号 */
export function shellSessionName(
  optsName: string | undefined,
  inWs: number,
  label: string
): string {
  return optsName ?? (inWs === 0 ? label : `${label} ${inWs + 1}`);
}

/** shell 会话行构建（纯函数；id/时间戳/令牌由调用方播种） */
export function buildShellTerminalSession(input: {
  id: string;
  now: number;
  statusToken: string;
  name?: string;
  inWs: number;
  label: string;
  shellProfileId: ShellProfileId;
  cwd: string;
  workspaceId: string;
  meta?: Record<string, string>;
  hidden?: boolean;
}): SessionMeta {
  return {
    id: input.id,
    type: 'terminal',
    name: shellSessionName(input.name, input.inWs, input.label),
    createdAt: input.now,
    lastUsedAt: input.now,
    launchKind: 'shell',
    shellProfileId: input.shellProfileId,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    status: 'starting',
    lifecycle: 'starting',
    statusToken: input.statusToken,
    meta: input.meta,
    ...(input.hidden ? { hidden: true } : {})
  };
}

/** GUI Worker 会话初始态落到 SessionMeta（引擎侧按「字段缺省才回落默认」消费） */
export function applyInheritMeta(session: SessionMeta, inherit: GuiSessionInitialMeta): void {
  if (inherit.configurePermissions !== undefined) session.configurePermissions = inherit.configurePermissions;
  if (inherit.piModeId) session.piModeId = inherit.piModeId;
  if (session.runtime === 'pi' && inherit.guiMode) session.guiMode = inherit.guiMode;
  if (session.runtime !== 'pi' && inherit.nativeConfig) session.nativeConfig = structuredClone(inherit.nativeConfig);
  if (inherit.modelOverride) {
    session.modelOverride = { ...inherit.modelOverride };
  }
  if (inherit.thinkingLevel) session.thinkingLevel = inherit.thinkingLevel;
  if (inherit.modelParameters) session.modelParameters = { ...inherit.modelParameters };
}

function sourceGuiConfig(source: SessionMeta): GuiSessionInitialMeta {
  return structuredClone({
    ...(source.configurePermissions !== undefined ? { configurePermissions: source.configurePermissions } : {}),
    ...(source.nativeConfig && source.configurePermissions === true ? { nativeConfig: source.nativeConfig } : {}),
    ...(source.piModeId ? { piModeId: source.piModeId } : {}),
    ...(source.runtime === 'pi' && source.guiMode ? { guiMode: source.guiMode } : {}),
    ...(source.modelOverride ? { modelOverride: source.modelOverride } : {}),
    ...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
    ...(source.modelParameters ? { modelParameters: source.modelParameters } : {})
  });
}

/** agent 会话行构建（纯函数；worktree 字段缺省 undefined 占位与原实现一致） */
export function buildAgentTerminalSession(input: {
  id: string;
  now: number;
  statusToken: string;
  name?: string;
  inWs: number;
  runtime: string;
  cwd: string;
  workspaceId: string;
  worktreePath?: string;
  worktreeSource?: SessionMeta['worktreeSource'];
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  worktreeRepoSet?: SessionMeta['worktreeRepoSet'];
  /** 父会话 id（子代理通用化）：带此字段的会话在左栏挂父下方、按链深度受上限约束 */
  parentSessionId?: string;
  subagentCharacterId?: SessionMeta['subagentCharacterId'];
  meta?: Record<string, string>;
  hidden?: boolean;
}): SessionMeta {
  return {
    id: input.id,
    type: 'terminal',
    name: input.name ?? t('工作面板 {{n}}', { n: input.inWs + 1 }),
    // 默认名（创建时未指定）：首条用户指令到达时由 autoNameFromInstruction 改名
    ...(input.name === undefined ? { autoNamed: true } : {}),
    createdAt: input.now,
    lastUsedAt: input.now,
    launchKind: 'agent',
    runtime: input.runtime,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    worktreePath: input.worktreePath,
    ...(input.worktreeSource ? { worktreeSource: input.worktreeSource } : {}),
    worktreeBranch: input.worktreeBranch,
    worktreeBaseBranch: input.worktreeBaseBranch,
    ...(input.worktreeRepoSet?.length ? { worktreeRepoSet: input.worktreeRepoSet } : {}),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.parentSessionId && input.subagentCharacterId ? { subagentCharacterId: input.subagentCharacterId } : {}),
    status: 'starting',
    lifecycle: 'starting',
    statusToken: input.statusToken,
    meta: input.meta,
    ...(input.hidden ? { hidden: true } : {})
  };
}

/** shell 分支（原样迁出）：校验配置档 → 物化会话行 → broadcast → 后台拉起 */
export async function createShellTerminalSession(
  ctx: CreateTerminalFlowCtx,
  opts: CreateTerminalOptions,
  target: SessionTarget
): Promise<SessionMeta> {
  if (opts.cliLaunchOptions !== undefined) throw new Error('Shell 会话不支持 CLI 启动选项');
  if (!isShellProfileId(opts.shellProfileId)) {
    throw new Error(t('未知 Shell 配置档: {{id}}', { id: opts.shellProfileId }));
  }
  const shellProfileId = opts.shellProfileId as ShellProfileId;
  const label = shellProfileLabel(shellProfileId);
  const inWs = ctx.sessions.filter(
    (s) =>
      s.type === 'terminal' &&
      s.launchKind === 'shell' &&
      (s.workspaceId ?? '') === target.workspaceId
  ).length;
  const session = buildShellTerminalSession({
    id: randomUUID(),
    now: Date.now(),
    statusToken: randomUUID(),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    inWs,
    label,
    shellProfileId,
    cwd: target.cwd,
    workspaceId: target.workspaceId,
    meta: opts.meta,
    hidden: opts.hidden
  });
  assertSessionTargetCurrent(ctx.config.get(), target);
  session.sourceRoot = { ...target.sourceRoot };
  ctx.sessions.push(session);
  ctx.applySelectDisplay(session, opts.activate);
  if (!opts.hidden) {
    ctx.persist();
    ctx.broadcast();
    ctx.usageStats?.recordSessionCreated('shell');
  }
  void ctx.launchTerminal(session, 'start');
  return ctx.get(session.id)!;
}

/** agent 分支（原样迁出）：runtime 校验 → isolate worktree（可失败即不建会话行）→ 物化 → 拉起 */
export async function createAgentTerminalSession(
  ctx: CreateTerminalFlowCtx,
  opts: CreateTerminalOptions,
  target: SessionTarget
): Promise<SessionMeta> {
  const assertParentCurrent = (): void => {
    opts.assertRoutingCurrent?.();
    if (!opts.parentSessionId) return;
    const parent = ctx.sessions.find(s => s.id === opts.parentSessionId);
    if (!parent || parent.archived) throw new Error('父会话已归档或删除，不能创建子代理');
    if (parent.workspaceId !== target.workspaceId) throw new Error('子代理必须与父会话位于同一工作区');
  };
  assertParentCurrent();
  const cfg = ctx.config.get();
  const runtime = opts.runtime?.trim() || cfg.defaultRuntime;
  const deferModelValidation = opts.deferModelValidation === true && opts.hidden === true && runtime === 'pi' && !opts.inheritMeta && !opts.inheritSourceGuiConfig;
  const validateLaunchModel = !opts.inheritSourceGuiConfig && !deferModelValidation;
  const sourceOwner = opts.sourceSessionId ? ctx.sessions.find(s => s.id === opts.sourceSessionId) : undefined;
  let assertInheritedSourceCurrent = (): void => {};
  if (opts.inheritSourceGuiConfig) {
    if (!sourceOwner || !ctx.isChatRuntime(runtime) || sourceOwner.runtime !== runtime ||
        (sourceOwner.workspaceId && sourceOwner.workspaceId !== target.workspaceId) ||
        (sourceOwner.cwd && sourceOwner.cwd !== target.cwd && sourcePathKey(sourceOwner.cwd) !== sourcePathKey(target.cwd)) ||
        opts.inheritMeta || opts.isolate || opts.parentSessionId) {
      throw new Error('GUI source session configuration cannot be inherited for this target');
    }
    const inheritedConfig = sourceGuiConfig(sourceOwner);
    const sourceIdentity = (config: GuiSessionInitialMeta): string =>
      JSON.stringify([sourceOwner.runtime, sourceOwner.workspaceId, sourceOwner.cwd, config]);
    const identity = sourceIdentity(inheritedConfig);
    assertInheritedSourceCurrent = () => {
      if (!ctx.sessions.includes(sourceOwner) ||
          sourceIdentity(sourceGuiConfig(sourceOwner)) !== identity) {
        throw new Error('source session configuration changed during creation');
      }
    };
    opts = { ...opts, inheritMeta: inheritedConfig };
  }
  const configurePermissions = opts.configurePermissions === undefined ? opts.inheritMeta?.configurePermissions : opts.configurePermissions;
  if (configurePermissions !== undefined && typeof configurePermissions !== 'boolean') throw new Error('configurePermissions must be a boolean.');
  if (opts.cliLaunchOptions !== undefined && ctx.isChatRuntime(runtime)) throw new Error('GUI 会话不支持 CLI 启动选项');
  const manifest = ctx.runtimes.get(runtime)?.manifest;
  const effectiveCliOptions = effectiveCliLaunchOptions(runtime, opts.cliLaunchOptions, manifest, configurePermissions === true, process.getuid?.());
  // Archive the original choices when automatic permissions are in effect.
  const cliLaunchOptions = configurePermissions === true ? effectiveCliOptions : opts.cliLaunchOptions;
  await validateCliModelReasoning(runtime, effectiveCliOptions, target.sourceRoot.cwd, manifest);
  if (!ctx.isChatRuntime(runtime)) cliArgsForSession(runtime, effectiveCliOptions, [...(manifest?.terminal?.args ?? []), ...(ctx.runtimes.get(runtime)?.extraArgs ?? [])], manifest);
  if (configurePermissions === true && ctx.isChatRuntime(runtime) && opts.inheritMeta?.guiMode &&
      !supportsGuiPermissionMode(runtime, opts.inheritMeta.guiMode)) {
    throw new Error(t('当前引擎暂不支持此权限档，请重新选择'));
  }
  assertLaunchModel(runtime, opts.inheritMeta?.modelOverride, ctx.isChatRuntime(runtime));
  if (configurePermissions === true && !opts.inheritSourceGuiConfig && opts.inheritMeta?.nativeConfig) {
    if (runtime === 'pi' || !ctx.isChatRuntime(runtime) || !ctx.agentSessionsRef?.validateNativeConfigIntent) throw new Error('The selected Harness does not provide native GUI settings.');
    const nativeConfig = await ctx.agentSessionsRef.validateNativeConfigIntent({
      runtime, piModeId: opts.inheritMeta.piModeId, workspaceId: target.workspaceId, cwd: target.sourceRoot.cwd,
      sourceRoot: target.sourceRoot
    }, opts.inheritMeta.nativeConfig);
    opts = { ...opts, inheritMeta: { ...opts.inheritMeta, nativeConfig } };
  }
  // A fork copies the source's persisted choices exactly, like reopening that
  // session. Requiring a per-cwd discovery cache here would prevent cloning
  // after restart; actual turn setup still rejects unavailable parameters.
  if (!deferModelValidation) ctx.agentSessionsRef?.assertLaunchModelAllowed?.(runtime, opts.inheritMeta?.modelOverride, opts.inheritMeta?.piModeId);
  if (validateLaunchModel) await ctx.agentSessionsRef?.validateLaunchModel?.(runtime, target.sourceRoot.cwd, opts.inheritMeta?.modelOverride, opts.inheritMeta?.piModeId);
  const launchParameterContext = ctx.isChatRuntime(runtime) && validateLaunchModel
    ? await ctx.agentSessionsRef?.validateLaunchParameters?.(runtime, target.sourceRoot.cwd, opts.inheritMeta ?? {}) : undefined;
  assertInheritedSourceCurrent();
  const borrowed = !opts.isolate && !path.relative(target.sourceRoot.path, target.cwd).startsWith('..') && !path.isAbsolute(path.relative(target.sourceRoot.path, target.cwd)) && sourceOwner?.worktreeGroups?.cwdPolicy === 'source' ? structuredClone(sourceOwner.worktreeGroups) : undefined;
  const sourceFingerprint = sourceOwner && borrowed ? taskWorktreeOwnership(sourceOwner) : undefined;
  if (borrowed) borrowed.borrowedFrom = sourceOwner!.worktreeGroups!.borrowedFrom ?? sourceOwner!.id;
  if (!ctx.runtimes.get(runtime)?.enabled) {
    throw new Error(t('runtime 未注册或已禁用: {{runtime}}', { runtime }));
  }
  // 可用性预检：pty 查脚本+CLI、chat 查 driver 依赖；失败拒绝创建并说明「差什么、怎么装」。
  // 逃生门：force=true 强创（预检报错里会提示）。脚本加载失败/probe 异常落 unknown，同样按不可用拒绝；仅预检流程自身意外抛错才放行。
  if (!opts.force) {
    try {
      const pre = await preflightRuntime(
        {
          runtimes: ctx.runtimes,
          config: ctx.config,
          agentSessions: ctx.agentSessionsRef
        },
        runtime,
        { piModeId: opts.inheritMeta?.piModeId, modelOverride: opts.inheritMeta?.modelOverride }
      );
      if (!pre.ok && !(deferModelValidation && pre.status === 'not_configured')) throw new RuntimePreflightError(pre);
    } catch (e) {
      if (e instanceof RuntimePreflightError) throw e;
      console.warn('[sessions] runtime 预检异常（放行创建）', runtime, e);
    }
  }
  assertSessionTargetCurrent(ctx.config.get(), target);
  assertInheritedSourceCurrent();
  // 隔离派活（P3.5）：先建 worktree 再建会话（失败则不产生孤儿会话行）；
  // 目录名与分支 ao/<id8> 同源（纯 sessionId 前 8 位），会话名只用于 UI
  let isolateCwd: string | undefined;
  let worktreePath: string | undefined;
  let worktreeSource: SessionMeta['worktreeSource'];
  let worktreeSetupWarning: string | undefined;
  let worktreeBranch: string | undefined;
  let worktreeBaseBranch: string | undefined;
  let worktreeRepoSet: SessionMeta['worktreeRepoSet'];
  let skippedNestedRepos: NestedRepoSkipInfo[] | undefined;
  let worktreeGroups: SessionWorktreeGroups | undefined;
  let taskCreation: Extract<TaskWorktreeCreateResult, { ok: true }> | undefined;
  const sessionId = opts.reservedSessionId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) || ctx.sessions.some(s => s.id === sessionId)) {
    throw new Error('交接会话标识无效或已被使用');
  }
  if (opts.isolate) {
    if (!ctx.git) throw new Error(t('isolate 需要 GitService（应用初始化异常）'));
    const preparation = readWorkspaceFile(target.controlRoot).git;
    const recipes = repositoryPreparations(preparation?.worktreeRepoProvisionCommands ?? []);
    const exclusions = repositoryExclusions(preparation?.worktreeIsolationExclusions ?? []);
    let selections = opts.isolationGroups?.map(selection => ({ ...selection, repoSet: selection.repoSet ?? [] }));
    if (!selections) {
      const main = await ctx.git.resolveMainRepoFor(target.cwd, isolateWalkCeiling(target.wsPath, cfg.workspace));
      assertSessionTargetCurrent(ctx.config.get(), target);
      if (!main) throw new Error('隔离目标尚未明确：请选择实际 Git 仓库，当前工作目录保持不变');
      selections = [{ rootId: target.sourceRoot.rootId, relativePath: path.relative(target.sourceRoot.path, main).split(path.sep).join('/'), repoSet: opts.repoSet ?? [] }];
    }
    if (selections) {
      assertSessionTargetCurrent(ctx.config.get(), target);
      const sources = opts.capturedIsolationSources ?? captureWorktreeSelectionSources(ctx.config.get(), { workspaceId: target.workspaceId, isolationGroups: selections }).sources;
      assertWorktreeSelectionSources(ctx.config.get(), target.workspaceId, selections, sources);
      const result = await createTaskWorktreeGroups({ config: ctx.config, git: ctx.git }, {
        target, sessionId, selections, preserveCwd: true,
        provisionCommands: preparation?.worktreeProvisionCommands ?? [],
        groupProvisionCommands: preparationsForSelections(recipes, selections, exclusions)
      });
      if (!result.ok) {
        const details = result.residuals.map(item => `${item.treeRemoved ? '' : item.path + '；'}${item.mainRepo}；${item.branch}；${item.message}`).join('\n');
        if (details) ctx.notify.push({ workspaceId: target.workspaceId, sessionId, sessionName: opts.name ?? t('新会话'), kind: 'error', toast: true,
          text: t('隔离创建回滚有遗留资源：{{details}}', { details }) });
        throw new Error(t('隔离 worktree 创建失败: {{message}}', { message: [result.message, details].filter(Boolean).join('\n') }));
      }
      taskCreation = result;
      worktreeGroups = result.state;
      isolateCwd = result.cwd;
      worktreeSetupWarning = [...result.warnings, ...result.skipped.map(item => `${item.mainRepo}: ${formatNestedRepoSkipWarning(item.repos)}`)].join('\n') || undefined;
    } else {
      // 隔离树按目标会话所属仓库定位，存储根由应用配置决定
      const targetRoot = isolateWalkCeiling(target.wsPath, cfg.workspace);
      const mainRepo = await ctx.git.resolveMainRepoFor(target.cwd, targetRoot);
      if (!mainRepo) {
        throw new Error(
          t(
            'isolate 派活需要工作区在 git 仓库内（未找到 {{cwd}} 起向上的主仓库根；搜索不越过目标工作区根 {{target}}——若工作区只是仓库的子目录，请把工作区设为仓库根。当前活动工作区 {{active}}）',
            { cwd: target.cwd, target: targetRoot, active: cfg.workspace }
          )
        );
      }
      const provision =
        readWorkspaceFile(target.controlRoot).git?.worktreeProvisionCommands ?? [];
      // R-18b：主仓有嵌套独立仓时走「多仓隔离组」（容器根+逐仓嵌树，失败整组回滚）；
      // 无嵌套仓返回 repos=[]，行为与单仓 addSessionWorktree 完全一致
      const res = await ctx.git.addSessionWorktreeGroup(mainRepo, sessionId, opts.repoSet, provision);
      if (!res.ok || !res.path) {
        throw new Error(t('隔离 worktree 创建失败: {{message}}', { message: res.message ?? t('未知错误') }));
      }
      isolateCwd = res.path;
      worktreePath = res.path;
      worktreeSource = res.source;
      worktreeSetupWarning = res.message;
      worktreeBranch = res.branch;
      // R-18 从哪建回哪：记实际起点分支（守卫回落时=默认分支名；detached 时 undefined）
      worktreeBaseBranch = res.baseBranch;
      if (res.repos?.length) worktreeRepoSet = res.repos;
      if (res.skippedNestedRepos?.length) skippedNestedRepos = res.skippedNestedRepos;
    }
  }
  const inWs = ctx.sessions.filter(
    (s) =>
      s.type === 'terminal' &&
      s.launchKind !== 'shell' &&
      !s.hidden &&
      (s.workspaceId ?? '') === target.workspaceId
  ).length;
  const session = buildAgentTerminalSession({
    id: sessionId,
    now: Date.now(),
    statusToken: randomUUID(),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    inWs,
    runtime,
    cwd: isolateCwd ?? target.cwd,
    workspaceId: target.workspaceId,
    worktreePath,
    worktreeSource,
    worktreeBranch,
    worktreeBaseBranch,
    worktreeRepoSet,
    parentSessionId: opts.parentSessionId,
    subagentCharacterId: opts.subagentCharacterId,
    meta: opts.meta,
    hidden: opts.hidden
  });
  const persistRoutedSession = !opts.hidden && opts.workerRouting ? ctx.persistStrict : undefined;
  const assertCreationCurrent = (): void => {
    assertParentCurrent();
    assertSessionTargetCurrent(ctx.config.get(), target);
    assertInheritedSourceCurrent();
    taskCreation?.assertCurrent();
    if (ctx.sessions.some(row => row.id === sessionId)) throw new Error(t('交接会话标识已被使用'));
  };
  try {
    // Preferences can change while preflight or worktree creation is in flight.
    // Revalidate before publishing and use the existing worktree rollback path on failure.
    if (!deferModelValidation) ctx.agentSessionsRef?.assertLaunchModelAllowed?.(runtime, opts.inheritMeta?.modelOverride, opts.inheritMeta?.piModeId);
    if (validateLaunchModel) await ctx.agentSessionsRef?.validateLaunchModel?.(runtime, target.sourceRoot.cwd, opts.inheritMeta?.modelOverride, opts.inheritMeta?.piModeId);
    // 预检/建树可能异步等待；归档或删除父之后，不能再插入新的活跃子会话。
    assertCreationCurrent();
    session.sourceRoot = { ...target.sourceRoot };
    if (worktreeGroups) session.worktreeGroups = worktreeGroups;
    if (borrowed) {
      assertTaskWorktreeOperationIdle(ctx.config, sourceOwner!.id);
      if (!ctx.sessions.includes(sourceOwner!) || taskWorktreeOwnership(sourceOwner!) !== sourceFingerprint) throw new Error('source worktree ownership changed during creation');
      session.worktreeGroups = borrowed; projectPrimaryWorktree(session);
    }
    normalizeSessionWorktrees(session);
    if (ctx.isChatRuntime(runtime) && opts.inheritMeta) applyInheritMeta(session, opts.inheritMeta);
    if (configurePermissions !== undefined) session.configurePermissions = configurePermissions;
    if (cliLaunchOptions) session.cliLaunchOptions = { ...cliLaunchOptions };
    if (opts.workerRouting) session.workerRouting = structuredClone(opts.workerRouting);
    if (opts.prepareGuiSession) {
      if (!ctx.isChatRuntime(runtime) || !opts.sourceSessionId) throw new Error('GUI fork preparation requires a source session');
      await opts.prepareGuiSession(session);
    }
    const register = () => { ctx.sessions.push(session); };
    if (persistRoutedSession) await persistRoutedSession(assertCreationCurrent, rows => [...rows, session], register);
    else register();
  } catch (error) {
    if (taskCreation) {
      const leftovers = await taskCreation.rollback();
      if (leftovers.length) ctx.notify.push({ workspaceId: target.workspaceId, sessionId, sessionName: session.name, kind: 'error', toast: true,
        text: t('任务源目录失效，隔离资源保留待清理：{{details}}', { details: leftovers.map(item => `${item.path}；${item.mainRepo}；${item.branch}；${item.message}`).join('\n') }) });
    } else if (worktreePath && ctx.git && worktreeSource) {
      const leftovers = await rollbackNestedWorktrees(worktreeSource.mainRepo, worktreeBranch!, (worktreeRepoSet ?? []).map((repo) => ({ repo: repo.path, worktree: nestedWorktreePath(worktreePath!, repo.path) })));
      // Do not delete a container when nested removal failed.
      const removed = leftovers.length ? { ok: false, message: leftovers.join('；') } : await ctx.git.worktreeRemove(worktreePath, { force: true }).catch((err) => ({ ok: false, message: String(err) }));
      const deleted = removed.ok && worktreeBranch ? await ctx.git.deleteMergedBranch(worktreeSource.mainRepo, worktreeBranch, worktreeBaseBranch).catch((err) => ({ ok: false, message: String(err) })) : removed;
      if (!removed.ok || !deleted.ok) ctx.notify.push({ workspaceId: target.workspaceId, sessionId, sessionName: session.name, kind: 'error', toast: true, text: t('任务源目录失效，隔离资源保留待清理：{{path}}；{{branch}}；{{message}}', { path: removed.ok ? '' : worktreePath, branch: deleted.ok ? '' : worktreeBranch ?? '', message: deleted.message ?? '' }) });
    }
    throw error;
  }
  if (launchParameterContext) ctx.agentSessionsRef?.rememberLaunchParameterContext?.(session, launchParameterContext);
  if (worktreeSetupWarning) {
    ctx.notify.push({ workspaceId: target.workspaceId, sessionId: session.id, sessionName: session.name,
      label: t('worktree 初始化提醒'), text: worktreeSetupWarning, toast: true });
  }
  ctx.applySelectDisplay(session, opts.activate);
  if (!opts.hidden) {
    if (!persistRoutedSession) ctx.persist();
    ctx.broadcast();
    ctx.usageStats?.recordSessionCreated('agent', runtime);
  }
  if (skippedNestedRepos?.length) {
    const text = formatNestedRepoSkipWarning(skippedNestedRepos);
    console.warn('[sessions]', text);
    ctx.notify.push({
      workspaceId: target.workspaceId,
      sessionId: session.id,
      sessionName: session.name,
      label: t('嵌套仓残缺'),
      text,
      kind: 'error',
      toast: true
    });
  }

  // GUI（chat surface）Worker：不吃 CLI 的 initialPrompt / 宿主介绍注入——
  // 首次任务由邮箱保存并提醒收信；内部交接指令由专用管线处理
  if (ctx.isChatRuntime(runtime)) {
    if (opts.initialPrompt?.trim()) {
      console.warn(
        `[sessions] chat runtime ${runtime} 不支持 initialPrompt（应由派活方走 AgentSessionHost.send），已忽略`
      );
    }
    await ctx.launchTerminal(session, 'start');
    return ctx.get(session.id)!;
  }

  const forkFrom = opts.forkFromExternalSessionId?.trim();
  void ctx.launchTerminal(
    session,
    forkFrom ? 'fork' : 'start',
    opts.initialPrompt,
    forkFrom,
    opts.injectHostIntro !== false
  );
  return ctx.get(session.id)!;
}
