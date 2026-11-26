import { appendGuiHostContext, firstGuiUserMessageContext } from '../../prompt';
import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
/**
 * Claude Agent SDK GUI Worker driver（T2.1 骨架）。
 *
 * 形态（T2.0 冒烟定调，docs/research/claude-agent-sdk-smoke-research.md）：
 * - Electron 主进程内动态 import SDK，无 worker 进程层；SDK spawn 原生 claude.exe
 *   （windowsHide 自带，无 hide-console 需求）；
 * - 回合模型：一条连接 = 一次 query（流式 prompt：AsyncIterable<SDKUserMessage> 常驻
 *   子进程），send() 推一条用户消息、回合以 result 消息收口；普通信在适配器排队，
 *   优先信通过 Query.interrupt() 请求中止，等 result 后才推送下一条；abort() 独立停止；
 * - resume：options.resume = runtimeResumeToken（claude session id），transcript 从
 *   CLAUDE_CONFIG_DIR 磁盘召回；resume 失败（会话被清）由引擎侧新建会话兜底；
 * - 鉴权：剥 ANTHROPIC_·/CLAUDE_ 前缀 env 后走 claude 自己的解析链（订阅 / settings.json
 *   中转 / apiKeyHelper）；CLAUDE_CONFIG_DIR 缺省共享 ~/.claude，设置页可开隔离目录
 *   （userData/agents/claude-gui）；探测与引导在 WorkerPane Claude（GUI）卡片；
 * - 权限由 Claude Code 管理。canUseTool 转发 Claude Code 请求的用户决策；
 *   宿主 MCP handler 仍检查宿主资源规则。
 *   原生 AskUserQuestion 禁用；投影的 host.ask 经 MCP 通道接到工作台提问交互；
 * - 待投递的宿主说明（firstPromptPrefix）随首条用户消息发送；模式与扩展提示仍可随连接输入发送；
 * - fork：Claude SDK 目前无法保证压缩后的历史引用在分叉时正确重映射，
 *   暂停原生 fork，由 Host 使用 transcript 前缀；
 * - purge/sweepOrphans：共享 ~/.claude 时宿主无权删用户 transcript；隔离目录落地后
 *   仍未做引擎侧清扫（设置开隔离只换目录，删会话不扫隔离树）。
 */
import type { AppContext } from '../../../context';
import { randomUUID } from 'node:crypto';
import { t } from '../../../../shared/i18n';
import type {
  GuiDriverConnectInput,
  GuiDriverStreamEvent,
  GuiRuntimeConnection,
  GuiRuntimeDriver,
  GuiSendImage
} from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { ClaudeContextUsage } from './contextUsage';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  loadClaudeSdk,
  resolveClaudeExecutable,
  resolveUserClaudeExecutable,
  type ClaudeQueryFn,
  type ClaudeSdkModule
} from './claudeSdk';
import { scrubClaudeSpawnEnv } from './env';
import { applyClaudeConfigDir, resolveClaudeConfigDir } from '../../../../shared/claudeGui';
import { probeClaudeGuiStatus } from './status';
import type { GuiRuntimeProbeResult } from '../../types';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  createClaudeStreamState,
  describeClaudeResultError,
  mapClaudeAssistant,
  mapClaudeStreamEvent,
  mapClaudeUser,
  resetClaudeStreamTurn
} from './streamMap';
import { buildClaudeMcpServer, CLAUDE_HOST_MCP_SERVER } from './hostTools';
import { CLAUDE_APPROVAL_TIMEOUT_MS, createClaudeCanUseTool } from './canUseTool';
import { additionalExecutionDirectories } from '../../../workspaceExecutionContext';
import { createControlledChild, type ControlledChild } from '../../process/controlledChild';
import { ConnectionCleanupError } from '../../host/retirement';
import { redactSafetyText } from '../../../safety/redact';
import { claudeModelEnvironmentVersion, listClaudeModels, selectClaudeModel } from './models';
import { createClaudeReviewHooks } from './reviewCapture';
import type { TurnChangeTracker } from '../../../turnChanges/service';
import { automaticPermissions } from '../nativePermissionPolicy';
import { claudeNativeConfig, isClaudePermissionMode } from './nativeConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';

/** 可注入缝（假 SDK 回放测试用；缺省走真 SDK） */
export interface ClaudeDriverDeps {
  queryFn?: ClaudeQueryFn;
  loadSdk?: () => Promise<ClaudeSdkModule>;
  resolveExecutable?: () => Promise<{ ok: boolean; executable?: string; packaged: boolean }>;
  /** 审批等待超时（ms）；缺省 CLAUDE_APPROVAL_TIMEOUT_MS，回放测试注入缩短 */
  approvalTimeoutMs?: number;
}

/** 流式 prompt 供粮队列：send/redirect 推消息，query 的 AsyncIterable 消费 */
class PromptFeed implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private resolvers: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(msg: SDKUserMessage): void {
    if (this.ended) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: msg, done: false });
    else this.buf.push(msg);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    const next = (): Promise<IteratorResult<SDKUserMessage>> => {
      if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.resolvers.push(resolve));
    };
    return { next };
  }
}

function toImageBlocks(images?: GuiSendImage[]): Array<Record<string, unknown>> {
  if (!images?.length) return [];
  return images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.data }
  }));
}

export class ClaudeRuntimeDriver implements GuiRuntimeDriver {
  readonly runtimeId = 'claude' as const;
  readonly supportsImages = true;
  readonly supportsSeed = false;
  readonly supportsNativeFork = false;
  /** 权限 fire-time（canUseTool 热读档位），切档无需拆连接 */
  readonly modeSwitchReconnects = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'unsupported' as const;

  constructor(
    private ctx: AppContext,
    private opts: {
      userDataDir: string;
      getReviewTracker?: (sessionId: string) => TurnChangeTracker | undefined;
    },
    private deps: ClaudeDriverDeps = {}
  ) {}

  get connectionVersion(): string {
    return claudeModelEnvironmentVersion(this.opts.userDataDir, this.isolatedConfig());
  }

  private isolatedConfig(): boolean {
    try { return this.ctx.config?.get()?.claude?.isolateConfig === true; } catch { return false; }
  }

  async validateModelOverride(input: { cwd: string; model: NonNullable<GuiDriverConnectInput['modelOverride']> }): Promise<void> {
    if (input.model.providerId !== 'claude') throw new Error(t('Claude 模型身份无效'));
    const catalog = await listClaudeModels({ cwd: input.cwd, userDataDir: this.opts.userDataDir,
      isolateConfig: this.isolatedConfig() });
    if (!catalog.ok) throw new Error(t('无法验证 Claude 模型：{{message}}', { message: catalog.error }));
    selectClaudeModel(catalog.items, input.model.modelId?.trim() ?? '');
  }

  async describeModelParameters(input: { cwd: string; modelOverride?: GuiDriverConnectInput['modelOverride']; refresh?: boolean }) {
    const modelId = input.modelOverride?.modelId?.trim() ?? '';
    // Without an explicit model the SDK does not identify the selected model in
    // its initialization result; do not guess its supported effort levels.
    if (!modelId) return { runtimeId: this.runtimeId, providerId: 'claude', modelId, parameters: [] };
    const catalog = await listClaudeModels({ cwd: input.cwd, userDataDir: this.opts.userDataDir, isolateConfig: this.isolatedConfig(), refresh: input.refresh });
    if (!catalog.ok) return { runtimeId: this.runtimeId, providerId: 'claude', modelId, parameters: [], unavailable: true, warning: catalog.error };
    // Only the SDK's actual selected/default row can establish supported effort levels.
    const model = selectClaudeModel(catalog.items, modelId);
    return { runtimeId: this.runtimeId, providerId: 'claude', modelId,
      parameters: model?.effortLevels.length ? [{ id: 'reasoning', label: t('思考强度'), semantic: 'reasoning' as const,
        apply: 'reconnect' as const, supportsDefault: true,
        options: model.effortLevels.map(value => ({ value, label: value })) }] : [] };
  }

  /** 预检：本机 claude 可执行 + 登录态（不 spawn 引擎，同设置页探测） */
  async probe(): Promise<GuiRuntimeProbeResult> {
    const status = await probeClaudeGuiStatus(this.ctx, this.opts.userDataDir);
    const problems: GuiRuntimeProbeResult['problems'] = [];
    if (!status.canLaunch) {
      problems.push({
        code: 'cli_missing',
        message: t('未找到本机 claude 可执行文件（打包版需安装 Native Claude Code）'),
        fix: 'npm install -g @anthropic-ai/claude-code',
        fixHint: 'https://code.claude.com/docs/en/quickstart'
      });
    }
    const cliMissing = problems.some((p) => p.code === 'cli_missing');
    return {
      status: cliMissing ? 'not_installed' : problems.length ? 'not_configured' : 'available',
      problems,
      ...(status.executable ? { executable: status.executable } : {})
    };
  }

  nativeConfigVersion(): string { return nativeExecutableVersion(resolveUserClaudeExecutable(), `claude-agent-sdk-0.3.272:${this.connectionVersion}`); }

  async describeNativeConfig() { return claudeNativeConfig(); }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const clean = (text: string): string => redactSafetyText(text);
    const log: GuiDriverConnectInput['log'] = (level, message) => input.log(level, clean(message));
    const loadSdk = this.deps.loadSdk ?? loadClaudeSdk;
    let turnActive = false;
    let aborted = false;
    let closed = false;
    let ownedProcess: ControlledChild | undefined;
    // The owner coalesces concurrent reclamation and permits a later retry if
    // an attempt fails or its bounded wait expires.
    const reclaim = (): Promise<void> => ownedProcess?.reclaim() ?? Promise.resolve();

    // 可执行文件：dev 优先用户安装、回落 SDK 平台包；打包版只认用户安装
    const exeInfo = this.deps.resolveExecutable
      ? await this.deps.resolveExecutable()
      : await resolveClaudeExecutable();
    if (!exeInfo.ok) {
      throw new Error(
        '未找到本机 claude 安装。请到设置 → Worker 终端 → Claude（GUI）查看引导并安装 Native Claude Code 后重试'
      );
    }

    // 宿主工具进程内 MCP server（状态四件套 / browser.* / bgtasks.*）
    const mcpServer = await buildClaudeMcpServer({
      sdk: await loadSdk(),
      input,
      isCurrent: () => !closed && turnActive && !aborted
    });

    // B2（capability-delivery-mcp-relay-plan）：用户配置的第三方 MCP 不再直注引擎——
    // options.mcpServers 只装宿主自家进程内 server，第三方工具经宿主中转（mcp.search/call）
    const queue = new AsyncEventQueue<GuiDriverStreamEvent>();
    let requestedMode = input.nativeConfig?.selections[0];
    const automatic = automaticPermissions(input);
    if (automatic && process.getuid?.() === 0) {
      log('info', 'Claude Code native bypass is unavailable under root. Workbench will handle permission requests.');
    } else if (automatic) {
      try {
        await input.onNativePermissionRestore?.([{ id: 'permissionMode', value: 'default' }]);
        if (automaticPermissions(input)) requestedMode = { id: 'permissionMode', value: 'bypassPermissions' };
      } catch (error) {
        log('warn', `Claude Code native bypass unavailable. Workbench will handle permission requests. ${(error as Error).message}`);
      }
    }
    const restoringPermissions = !automatic && !!input.getNativePermissionRestore?.()?.length;
    let restorationPending = restoringPermissions;
    if (requestedMode && (requestedMode.id !== 'permissionMode' || !isClaudePermissionMode(requestedMode.value) ||
        (input.nativeConfig && input.nativeConfig.selections.length !== 1))) throw new Error('Invalid Claude Code permissionMode.');
    let nativeState = claudeNativeConfig();
    const contextUsage = new ClaudeContextUsage();

    const streamState = createClaudeStreamState();
    const feed = new PromptFeed();
    let lastResumeToken: string | null = input.resumeToken?.trim() || null;
    let finalized = true;
    let forkCapture: { identity: import('../../types').GuiForkIdentity; userUuid: string; assistantUuid?: string } | undefined;
    const nativePending: Array<import('../../../../shared/runtimeCommunication').RuntimeMessage> = [];
    let stopRequested = false;
    let interrupting: Promise<void> | undefined;
    /** 本回合是否已报过 api_retry（重试风暴只扰一次） */
    let retryWarned = false;
    /** 首条用户消息的待投递宿主说明与模式、扩展提示。 */
    let policyPrefix = firstGuiUserMessageContext(input) || null;

    const emitResumeToken = (token: unknown): void => {
      const t = typeof token === 'string' ? token.trim() : '';
      if (t && t !== lastResumeToken) {
        lastResumeToken = t;
        queue.push({ type: 'resume-token', token: t });
      }
    };

    const finalizeTurn = (error?: string): void => {
      if (finalized) return;
      finalized = true;
      turnActive = false;
      resetClaudeStreamTurn(streamState);
      if (error) {
        forkCapture = undefined;
        queue.push({ type: 'error', message: error });
        return;
      }
      queue.push({ type: 'turn-complete' });
    };

    const handleMsg = (msg: SDKMessage): void => {
      try {
        if (turnActive && !closed) {
          const usage = contextUsage.observe(msg);
          if (usage !== undefined) queue.push({ type: 'context-usage', usage });
        }
        switch (msg.type) {
          case 'system': {
            const subtype = (msg as { subtype?: string }).subtype;
            if (!closed && (subtype === 'init' || subtype === 'status') &&
                (!lastResumeToken || msg.session_id === lastResumeToken) &&
                'permissionMode' in msg && isClaudePermissionMode(msg.permissionMode)) {
              nativeState = claudeNativeConfig(msg.permissionMode);
              queue.push({ type: 'native-config', state: nativeState });
              if (restorationPending && msg.permissionMode === requestedMode?.value) {
                restorationPending = false;
                void input.onNativePermissionRestore?.().catch(error => log('warn', String(error)));
              }
            }
            if (subtype === 'init') {
              const init = msg as unknown as {
                session_id?: string;
                model?: string;
                apiKeySource?: string;
                tools?: string[];
              };
              emitResumeToken(init.session_id);
              log(
                'info',
                `claude 会话就绪（model=${init.model ?? '?'} · 鉴权=${init.apiKeySource ?? '?'} · 引擎工具 ${init.tools?.length ?? 0} 个）`
              );
            } else if (subtype === 'api_retry' && !retryWarned) {
              // 重试风暴（鉴权失效/中转不可用）首条可见：否则用户只看到无限等待
              retryWarned = true;
              const r = msg as unknown as { attempt?: number; error_status?: number | null; error?: string };
              log(
                'warn',
                `claude 请求失败重试中（${r.attempt ?? '?'} 次，${r.error_status ?? '网络'} ${r.error ?? ''}）——若持续出现请检查本机 claude 鉴权（claude /login 或 settings.json 中转）`
              );
            }
            // 其余 system 子型（permission_denied/task_notification…）：拒绝已回模型、任务通知
            // 不进聊天流
            return;
          }
          case 'stream_event': {
            for (const ev of mapClaudeStreamEvent(streamState, msg)) queue.push(ev);
            return;
          }
          case 'assistant': {
            if (forkCapture && turnActive && msg.parent_tool_use_id === null && typeof msg.uuid === 'string') forkCapture.assistantUuid = msg.uuid;
            for (const ev of mapClaudeAssistant(streamState, msg)) {
              queue.push(ev);
            }
            return;
          }
          case 'user': {
            for (const ev of mapClaudeUser(streamState, msg)) {
              queue.push(ev);
            }
            return;
          }
          case 'result': {
            interrupting = undefined;
            const result = msg as Extract<SDKMessage, { type: 'result' }>;
            emitResumeToken(result.session_id);
            const rawError = describeClaudeResultError(result);
            const error = rawError ? clean(rawError) : rawError;
            if (error && !aborted && nativePending.length) log('warn', `Claude 上一回合失败，继续待投递消息: ${error}`);
            // 用户中止后的错误结果是预期行为，静默收口（不弹错误横幅）
            const next = !closed && !stopRequested ? nativePending.shift() : undefined;
            if (!next && !error && !aborted && forkCapture?.assistantUuid && result.session_id) {
              const capture = forkCapture;
              const assistantUuid = forkCapture.assistantUuid;
              queue.push({ type: 'native-fork-points', engine: 'claude', sessionToken: result.session_id,
                points: [
                  ...(capture.identity.userMessageId ? [{ messageId: capture.identity.userMessageId, entryId: capture.userUuid }] : []),
                  { messageId: capture.identity.assistantMessageId, entryId: assistantUuid }
                ] });
            }
            forkCapture = undefined;
            if (next) {
              // SDK input is a queue of user turns, not a steer acknowledgement. Each result
              // closes exactly one input; keep host busy until the adapter's queue settles.
              resetClaudeStreamTurn(streamState);
              queue.push({ type: 'native-message-start', messageId: next.messageId, text: next.text });
              aborted = false;
              retryWarned = false;
              feed.push({ type: 'user', message: { role: 'user', content: next.text }, parent_tool_use_id: null });
            } else {
              nativePending.length = 0;
              finalizeTurn(aborted ? undefined : error);
            }
            return;
          }
          default:
            // 流式 ping/压缩边界等未知帧：安静丢弃
            return;
        }
      } catch (e) {
        log('error', `claude 事件处理异常: ${(e as Error).message}`);
      }
    };

    // ── 启动 query（流式 prompt 常驻；spawn 失败/进程崩溃统一走 onStreamError）──
    const queryFn: ClaudeQueryFn = this.deps.queryFn ?? (await loadSdk()).query;
    let handle: import('./claudeSdk').ClaudeQueryHandle;
    const canUseTool = createClaudeCanUseTool({
      cwd: input.cwd,
      workspaceContext: input.workspaceContext,
      hostToolIds: input.hostTools.map((t) => t.id),
      hostClassOf: (dotName) =>
        input.hostTools.find((t) => t.id === dotName)?.permissionClass ?? 'status',
      getTurnId: input.getTurnId,
      isCurrent: () => !closed && turnActive && !aborted,
      requestApproval: input.requestApproval,
      timeoutMs: this.deps.approvalTimeoutMs ?? CLAUDE_APPROVAL_TIMEOUT_MS
    });
    const isolate = (() => {
      try {
        return this.ctx.config?.get()?.claude?.isolateConfig === true;
      } catch {
        return false;
      }
    })();
    const configDir = resolveClaudeConfigDir({
      isolate,
      isolatedConfigDir: isolate ? userDataStorage(this.opts.userDataDir).resolve('app', 'claude-gui-home') : undefined,
      userDataDir: this.opts.userDataDir,
      homedir: os.homedir(),
      envConfigDir: process.env.CLAUDE_CONFIG_DIR,
      join: path.join
    });
    if (isolate) {
      try {
        fs.mkdirSync(configDir, { recursive: true });
      } catch (e) {
        log('warn', `无法创建隔离 CLAUDE_CONFIG_DIR: ${(e as Error).message}`);
      }
    }
    const spawnEnv = applyClaudeConfigDir(scrubClaudeSpawnEnv(process.env), configDir);
    const options: Options = {
      cwd: input.cwd,
      ...(input.workspaceContext ? { additionalDirectories: additionalExecutionDirectories(input.workspaceContext) } : {}),
      env: spawnEnv as Options['env'],
      // The SDK's close() does not expose process-tree completion. Own the
      // spawned child so the host's retirement barrier can await reclamation.
      spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
        if (closed) throw new Error('Claude 会话已关闭');
        if (ownedProcess) throw new Error('Claude 会话不能启动第二个引擎进程');
        // Return synchronous stdio to the SDK while the shared owner holds
        // CLI activation until its Job/process group is established.
        ownedProcess = createControlledChild(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], signal });
        const child = ownedProcess.child;
        // The SDK's custom spawn contract does not consume stderr.
        child.stderr.resume();
        return child;
      },
      ...(input.modelOverride?.providerId === 'claude' && input.modelOverride.modelId?.trim()
        ? { model: input.modelOverride.modelId.trim() } : {}),
      ...(input.modelParameters?.reasoning
        ? { effort: input.modelParameters.reasoning as Options['effort'] } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      // Only the host's own inline MCP server may be loaded. strictMcpConfig keeps the
      // engine from reading the user's native CLI MCP config; third-party MCP is no
      // longer injected here (host relay mcp.search/mcp.call instead).
      strictMcpConfig: true,
      ...(requestedMode && isClaudePermissionMode(requestedMode.value) ? { permissionMode: requestedMode.value,
        ...(requestedMode.value === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}) } : {}),
      canUseTool: canUseTool as Options['canUseTool'],
      hooks: createClaudeReviewHooks({
        tracker: () => this.opts.getReviewTracker?.(input.sessionId),
        turnId: () => input.getTurnId?.(),
        isCurrent: () => !closed && turnActive && !aborted,
        log: message => log('warn', message)
      }),
      // 原生问卷工具在 headless 下必然自动拒绝；提问由已注册的 MCP host_ask 处理
      disallowedTools: ['AskUserQuestion'],
      ...(input.resumeToken?.trim() ? { resume: input.resumeToken.trim() } : {}),
      ...(mcpServer
        ? {
            mcpServers: { [CLAUDE_HOST_MCP_SERVER]: mcpServer } as Options['mcpServers']
          }
        : {}),
      ...(exeInfo.executable ? { pathToClaudeCodeExecutable: exeInfo.executable } : {})
    };
    try {
      handle = queryFn({ prompt: feed, options });
    } catch (e) {
      closed = true;
      try { await reclaim(); }
      catch (failure) { throw new ConnectionCleanupError(`Claude 启动失败且进程回收未确认：${(failure as Error).message}`); }
      finally { feed.end(); }
      throw new Error(clean(`Claude 引擎启动失败：${(e as Error).message}`));
    }

    let closing: Promise<void> | undefined;
    let sdkClosed = false;
    const closeResources = (): Promise<void> => {
      closed = true;
      if (closing) return closing;
      const attempt = (async () => {
        try {
          // Do not ask the SDK to abort the same owner while its reclamation
          // is unconfirmed. Keep all remaining resources for a later retry.
          await reclaim();
          feed.end();
          if (!sdkClosed) { await handle.close?.(); sdkClosed = true; }
        } catch (error) { throw new Error(`Claude 引擎回收未确认：${(error as Error).message}`); }
      })();
      closing = attempt;
      // Keep the owner attached after failure so a later close can recheck
      // reclamation. A rejected attempt still reaches the Host barrier.
      void attempt.catch(() => { if (closing === attempt) closing = undefined; });
      return attempt;
    };

    const onStreamError = (err: unknown): void => {
      if (closed) return;
      const message = clean((err as Error)?.message ?? String(err));
      // End the visible turn only after the owned process is reclaimed; a
      // failed cleanup stays attached to close() and blocks the next writer.
      const cleanup = closeResources();
      void (async () => {
        let cleanupError = '';
        try { await cleanup; } catch (failure) { cleanupError = `；${(failure as Error).message}`; }
        if (turnActive) {
          log('error', `claude 子进程/事件流异常: ${message}${cleanupError}`);
          finalizeTurn(`${message}${cleanupError}；请重发消息（将自动重连恢复）`);
        } else log('warn', `claude 连接空闲期中断: ${message}${cleanupError}`);
        queue.close();
      })();
    };
    void (async () => {
      try {
        for await (const msg of handle) handleMsg(msg);
        // 流正常结束（子进程退出）：同崩溃路径收口（正常关停走 connection.close，closed 已置位）
        onStreamError(new Error('claude 事件流结束'));
      } catch (e) {
        onStreamError(e);
      }
    })();

    const connection: GuiRuntimeConnection = {
      events: queue,
      getNativeConfig: () => nativeState,
      async setNativeConfig(id, value) {
        if (closed || id !== 'permissionMode' || !isClaudePermissionMode(value) || !handle.setPermissionMode) throw new Error('Claude Code permissionMode is unavailable.');
        if (value === 'bypassPermissions' && requestedMode?.value !== 'bypassPermissions') throw new Error('Claude Code Bypass Permissions requires explicit opt-in at session launch.');
        await handle.setPermissionMode(value);
      },
      getContextUsage: () => contextUsage.get(),
      async send(text: string, images?: GuiSendImage[], _parameters?: import('../../../../shared/modelParameters').ModelParameterValues, authority?: { userText?: string; forkIdentity?: import('../../types').GuiForkIdentity }): Promise<void> {
        if (closed) throw new Error('claude 连接已中断，请重发消息（将自动重连恢复）');
        // 只有宿主提供的待投递内容才进入本连接的首条消息。
        const engineText = appendGuiHostContext(text, policyPrefix);
        policyPrefix = null;
        const imageBlocks = toImageBlocks(images);
        turnActive = true;
        aborted = false;
        stopRequested = false;
        finalized = false;
        retryWarned = false;
        const userUuid = randomUUID();
        forkCapture = authority?.forkIdentity ? { identity: authority.forkIdentity, userUuid } : undefined;
        const content = imageBlocks.length
          ? ([{ type: 'text', text: engineText }, ...imageBlocks] as unknown as NonNullable<
              SDKUserMessage['message']['content']
            >)
          : engineText;
        feed.push({
          type: 'user',
          uuid: userUuid,
          message: { role: 'user', content },
          parent_tool_use_id: null
        });
        const identity = authority?.forkIdentity;
        if (identity?.userMessageId) queue.push({ type: 'engine-input', identity, text: engineText });
      },
      async nativeFork(point) {
        if (closed || turnActive || stopRequested) throw new Error('Claude 会话忙碌或已关闭，无法分叉');
        if (point.engine !== 'claude') return { status: 'unsupported' };
        if (point.sessionToken !== lastResumeToken) throw new Error('Claude 恢复后的会话标识已变化，无法安全分叉');
        // SDK 0.3.272 remaps transcript UUIDs but not preserved-message UUIDs
        // in compact metadata. Its public history API omits those metadata and
        // filters the source chain, so it cannot prove that a fork is safe.
        return { status: 'unsupported' };
      },
      async receiveMessage(message) {
        if (closed || !turnActive || stopRequested)
          return { status: 'unsupported', reason: 'Claude SDK 当前没有可接收消息的运行回合' };
        if (nativePending.length >= 32) return { status: 'deferred', reason: 'Claude SDK 原生待投递队列已满' };
        if (message.intent === 'normal') {
          forkCapture = undefined;
          nativePending.push(message);
          return { status: 'accepted', method: 'queued' };
        }
        // Fail before accepting if this SDK cannot cancel. Never push another input and
        // assume it folded into the active response.
        if (!handle.interrupt) return { status: 'unsupported', reason: 'Claude SDK 未提供 interrupt' };
        forkCapture = undefined;
        nativePending.splice(nativePending.findIndex(m => m.intent !== 'interrupt') < 0 ? nativePending.length : nativePending.findIndex(m => m.intent !== 'interrupt'), 0, message);
        aborted = true;
        if (!interrupting) {
          const operation = Promise.resolve().then(async () => { await handle.interrupt!(); });
          interrupting = operation;
          void operation.finally(() => { if (interrupting === operation) interrupting = undefined; }).catch(() => {});
        }
        await interrupting;
        return { status: 'accepted', method: 'queued' };
      },
      redirect(): boolean {
        // PromptFeed enqueues another user turn; it does not prove mid-turn steering.
        return false;
      },
      async abort(): Promise<void> {
        stopRequested = true;
        if (!turnActive || aborted) return;
        aborted = true;
        try {
          await handle.interrupt?.();
        } catch (e) {
          log('warn', `claude interrupt 失败: ${(e as Error).message}`);
        }
      },
      async close(): Promise<void> {
        try {
          await closeResources();
        } finally {
          finalizeTurn();
          queue.close();
        }
      }
    };
    return connection;
  }
}
