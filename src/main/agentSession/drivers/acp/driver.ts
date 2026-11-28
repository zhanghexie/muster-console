/**
 * ACP 通用 GUI Worker driver（T5.2）。
 *
 * JSON-RPC over stdio 子集：initialize → session/new|load → session/prompt；
 * 入站 session/update / session/request_permission。
 * 五事件合同见 streamMap.ts 头注释。MCP 经 session/new.mcpServers 只注入宿主工具
 * stdio shim（复用 tools/registry 的 GuiHostTool）——B2 起用户配置的第三方 MCP 不再
 * 直接注入（经宿主中转 mcp.search/mcp.call）。
 * 零 API 态度：不代填厂商凭证；找不到 CLI 或需 authenticate 时给出 setup 指引。
 */
import { appendGuiHostContext, firstGuiUserMessageContext } from '../../prompt';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { normalizeContextUsage } from '../../../../shared/guiContextUsage';
import { ConnectionCleanupError } from '../../host/retirement';
import { spawnOwnedProcess } from '../../process/owner';
import type { AppContext } from '../../../context';
import type {
  GuiDriverConnectInput,
  GuiDriverStreamEvent,
  GuiForkIdentity,
  GuiRuntimeConnection,
  GuiRuntimeDriver,
  GuiSendImage
} from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { NdjsonRpc, NdjsonRpcResponseError, type JsonRpcMessage } from './jsonRpc';
import { classifyWorkerRuntimeFailure, type WorkerRuntimeFailure } from '../../../tasks/workerRoutingPolicy';
import {
  createAcpStreamState,
  mapAcpSessionUpdate,
  resetAcpStreamTurn
} from './streamMap';
import { ACP_APPROVAL_TIMEOUT_MS, resolveAcpPermission } from './permission';
import type { GuiRuntimeProbeResult } from '../../types';
import {
  getAcpPresets,
  defaultAcpAgentId,
  isAcpAgentId,
  resolveAcpLaunch,
  type AcpAgentId,
  type AcpAgentPreset
} from './agents';
import {
  ACP_HOST_MCP_NAME,
  hostToolsToCatalog,
  type AcpMcpServerStdio,
  type AcpMcpServer
} from './mcpServers';
import { startHostToolGateway } from './hostToolGateway';
import { hostMcpShimSpawn, resolveInboundMcpEntryFile } from '../../../inboundMcp/launch';
import { findHarnessCatalogEntry } from '../../../../shared/harnessCatalog';
import { acpLoginHint, authenticateAcpIfNeeded, listAcpModels } from './models';
import { acpModelSelection, acpReasoningSelection, parseAcpModelList, parseAcpReasoningOption } from './modelOptions';
import { acpLaunchEnvironment, decodeAcpResumeToken } from './launchPolicy';
import { forkOpenCode } from './opencodeFork';
import { cursorPlanQuestion, cursorPlanResponse, cursorQuestionResponse, parseCursorQuestions } from './cursor';
import { additionalExecutionDirectories } from '../../../workspaceExecutionContext';
import { applyNativePermissionStrategy, automaticAcpPermissions, automaticPermissions, restoreNativePermissions } from '../nativePermissionPolicy';
import { acpNativeConfig, acpNativeId, acpNativeSelection } from './nativeConfig';
import { AcpNativeHistory, acpHistoryStorageKey, acpInitializeParams } from './nativeHistory';
import type { NativeConfigState, NativeConfigValue } from '../../../../shared/nativeSessionConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';

export interface AcpTransport {
  rpc: NdjsonRpc;
  waitReady?: () => Promise<void>;
  kill: () => void | Promise<void>;
}

/** 握手/会话建立 RPC 超时：CLI 冷启动（node 大包 import）可到十几秒，给足余量 */
export const ACP_RPC_TIMEOUT_MS = 30_000;
/** close() 等待在飞 session/prompt 收口的上限：agent 不响应 cancel 时强制清理（P1-3） */
export const ACP_CLOSE_DRAIN_TIMEOUT_MS = 10_000;

interface AcpSpawnCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AcpDriverDeps {
  spawnAgent?: (cmd: AcpSpawnCommand) => AcpTransport;
  resolveLaunch?: typeof resolveAcpLaunch;
  hostMcpScript?: string;
  approvalTimeoutMs?: number;
  rpcTimeoutMs?: number;
  closeDrainTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function resolveHostMcpScript(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const bundled = resolveInboundMcpEntryFile();
    if (bundled) return bundled;
  } catch {
    /* 测试转译 ESM 时 __dirname 不可用 */
  }
  // 只认构建产物 .mjs：源码 .ts 入口有无扩展名相对导入，Node 原生加载不了（P0-1 附注）
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', '..', 'inboundMcp', 'stdioEntry.mjs'),
    path.join(process.cwd(), 'out/main/inboundMcp/stdioEntry.mjs')
  ];
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) throw new Error('找不到宿主工具 MCP 脚本 inboundMcp/stdioEntry');
  return hit;
}

function spawnRealAgent(cmd: AcpSpawnCommand, monitor?: { workspaceId?: string; workspaceName?: string; sessionId?: string; sessionName?: string; taskId?: string; businessLabel?: string }): AcpTransport {
  const owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
    command: cmd.command,
    args: cmd.args,
    windows: { kind: 'taskkill' },
    spawnOptions: {
      windowsVerbatimArguments: process.platform === 'win32' && path.basename(cmd.command).toLowerCase() === 'cmd.exe',
      cwd: cmd.cwd,
      env: cmd.env,
      stdio: ['pipe', 'pipe', 'pipe']
    },
    monitor: {
      businessLabel: monitor?.businessLabel ?? 'ACP 会话引擎',
      role: 'AI 会话工作进程',
      workspaceId: monitor?.workspaceId,
      workspaceName: monitor?.workspaceName,
      sessionId: monitor?.sessionId,
      sessionName: monitor?.sessionName,
      taskId: monitor?.taskId
    }
  });
  const child = owner.child;
  const rpc = new NdjsonRpc(child.stdin, child.stdout);
  // spawn 失败（ENOENT/EACCES）走 ChildProcess 'error'，无监听会变成主进程未捕获异常
  child.on('error', (e: Error) => rpc.failExternal(e));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (s: string) => {
    const t = s.trim();
    if (t) rpc.emit('stderr', t);
  });
  return {
    rpc,
    async waitReady() {
      await owner.ready;
      if (owner.state !== 'ready') throw new Error('ACP 进程已退出或正在回收');
    },
    kill: () => owner.reclaim()
  };
}

function promptBlocks(text: string, images?: GuiSendImage[]): unknown[] {
  const blocks: unknown[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const img of images ?? []) {
    blocks.push({
      type: 'image',
      mimeType: img.mimeType,
      data: img.data
    });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

export class AcpRuntimeDriver implements GuiRuntimeDriver {
  readonly runtimeId = 'acp';
  readonly permissionStrategyHot = true;
  readonly supportsImages = true;
  readonly supportsSeed = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'unsupported' as const;

  private userDataDir: string;
  readonly nativeHistory: AcpNativeHistory;

  constructor(
    // Product-level launch preferences use the host config; MCP still uses the session gateway.
    private readonly _ctx: AppContext,
    _opts: { userDataDir: string; },
    private deps: AcpDriverDeps = {}
  ) {
    // Keep the user-data root for model catalog files; presets come from the built-in catalogue.
    this.userDataDir = _opts.userDataDir;
    this.nativeHistory = new AcpNativeHistory({
      label: id => this.presets.find(preset => preset.id === id)?.name,
      resolve: id => {
        const launch = (this.deps.resolveLaunch ?? ((agentId: string) => resolveAcpLaunch(agentId, undefined, this.presets)))(id);
        return 'error' in launch ? undefined : launch;
      },
      spawn: this.deps.spawnAgent,
      timeout: this.deps.rpcTimeoutMs
    });
  }

  private get presets(): AcpAgentPreset[] {
    return getAcpPresets(this.userDataDir);
  }

  get connectionVersion(): string {
    return crypto.createHash('sha256').update(JSON.stringify(this.presets)).digest('hex');
  }

  nativeConfigVersion(presetId?: string): string {
    const presets = this.presets;
    const id = defaultAcpAgentId(presetId, presets);
    const launch = (this.deps.resolveLaunch ?? ((agentId: string) => resolveAcpLaunch(agentId, undefined, presets)))(id);
    return nativeExecutableVersion('error' in launch ? null : launch.executable ?? launch.command, `acp-v1:${this.connectionVersion}`);
  }

  async validateModelOverride(input: {
    cwd: string;
    model: NonNullable<GuiDriverConnectInput['modelOverride']>;
    piModeId?: string;
  }): Promise<void> {
    const modelId = input.model.modelId?.trim() ?? '';
    if (!modelId) return;
    if (input.model.providerId !== 'acp') throw new Error('ACP 模型必须来自当前 ACP 引擎');
    const agentId = defaultAcpAgentId(input.piModeId, this.presets);
    const catalog = await listAcpModels({ cwd: input.cwd, agentId, userDataDir: this.userDataDir });
    if (!catalog.ok) throw new Error(`无法读取 ${agentId} 模型目录：${catalog.error}`);
    if (!catalog.items.some(item => item.id === modelId)) {
      throw new Error(`${agentId} 未声明模型 ${modelId}；请刷新模型目录或使用引擎默认模型`);
    }
  }

  /** Discover only values the selected ACP agent advertises for the selected model. */
  async describeModelParameters(input: {
    cwd: string;
    modelOverride?: GuiDriverConnectInput['modelOverride'];
    piModeId?: string;
    refresh?: boolean;
  }): Promise<import('../../../../shared/modelParameters').ModelParameterContext> {
    const agentId = defaultAcpAgentId(input.piModeId, this.presets);
    const modelId = input.modelOverride?.modelId?.trim() ?? '';
    const result = await listAcpModels({ cwd: input.cwd, agentId, userDataDir: this.userDataDir, modelId, refresh: input.refresh });
    if (!result.ok) throw new Error(result.error);
    const reasoning = result.reasoning;
    const context: import('../../../../shared/modelParameters').ModelParameterContext = {
      runtimeId: this.runtimeId,
      providerId: `acp:${agentId}`,
      modelId: modelId && modelId !== 'default' ? modelId : result.currentModelId ?? '',
      ...(result.parametersUnknown ? { unavailable: true, warning: '当前模型的参数尚未读取，请手动刷新模型目录' } : {}),
      parameters: reasoning ? [{ id: 'reasoning', semantic: 'reasoning', label: '思考强度',
        options: reasoning.options, apply: 'reconnect', supportsDefault: true,
        ...(reasoning.currentValue ? { defaultValue: reasoning.currentValue } : {}) }] : []
    };
    return context;
  }

  async describeNativeConfig(input: { cwd: string; piModeId?: string; refresh?: boolean }): Promise<NativeConfigState> {
    const agentId = defaultAcpAgentId(input.piModeId, this.presets);
    const result = await listAcpModels({ cwd: input.cwd, agentId, userDataDir: this.userDataDir, refresh: input.refresh });
    if (!result.ok) return input.refresh ? { status: 'error', options: [], error: result.error } : { status: 'uninitialized', options: [] };
    return result.nativeConfig ?? { status: 'uninitialized', options: [] };
  }

  listPresets() {
    return this.presets.map((p, i) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      trust: 'system' as const,
      order: i + 1,
      broken: undefined as string | undefined
    }));
  }

  /** 预检：默认 ACP agent 的 CLI 是否可寻（不 spawn、不发 JSON-RPC） */
  async probe(input: { piModeId?: string; } = {}): Promise<GuiRuntimeProbeResult> {
    const agentId = defaultAcpAgentId(input.piModeId, this.presets);
    const catalogEntry = findHarnessCatalogEntry(agentId);
    const resolveLaunch =
      this.deps.resolveLaunch ??
      ((id: AcpAgentId, o?: { command?: string; args?: string[]; }) =>
        resolveAcpLaunch(id, o, this.presets));
    const launch = resolveLaunch(agentId);
    if ('error' in launch) {
      return {
        status: 'not_installed',
        problems: [
          {
            code: 'cli_missing',
            message: launch.error,
            fix: `安装并配置 ${catalogEntry?.name ?? agentId} 后重新检测`,
          fixHint: this.presets.find(preset => preset.id === agentId)?.installUrl ?? catalogEntry?.installUrl ?? 'https://agentclientprotocol.com'
          }
        ]
      };
    }
    return { status: 'available', problems: [] };
  }

  resolveMode(modeId: string) {
    if (!isAcpAgentId(modeId, this.presets)) return null;
    return { connectExtras: { acpAgent: modeId } };
  }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const rawResume = input.resumeToken?.trim() ?? '';
    if (input.hasPriorConversation && !rawResume && !input.forkTranscriptPending) {
      throw new Error('ACP 历史缺少原生会话标识，无法安全恢复；请保留历史并新建会话');
    }
    const log = input.log;
    const extras = input as GuiDriverConnectInput & { acpAgent?: string; };
    const presets = this.presets;
    const agentId: AcpAgentId = defaultAcpAgentId(extras.acpAgent, presets);
    const mcpPermissionMetadata = presets.find(preset => preset.id === agentId)?.mcpPermissionMetadata;
    if (this._ctx.config?.get().disabledAcpAgents?.includes(agentId)) {
      throw new Error('此 Agent 的聊天入口已停用，可在设置中启用。');
    }
    const resolveLaunch =
      this.deps.resolveLaunch ??
      ((id: AcpAgentId, o?: { command?: string; args?: string[]; }) =>
        resolveAcpLaunch(id, o, presets));
    const cursorDirs = agentId === 'cursor' ? additionalExecutionDirectories(input.workspaceContext) : [];
    const launch = resolveLaunch(agentId, cursorDirs.length ? { args: [...cursorDirs.flatMap(dir => ['--add-dir', dir]), 'acp'] } : undefined);
    if ('error' in launch) throw new Error(launch.error);

    const queue = new AsyncEventQueue<GuiDriverStreamEvent>();
    const streamState = createAcpStreamState(agentId);

    let catalogPath: string | undefined;
    let gateway: Awaited<ReturnType<typeof startHostToolGateway>> | undefined;
    let hostServer: AcpMcpServerStdio | undefined;
    // 网关/临时目录创建后，connect 任一段失败都必须拆掉（否则泄漏带 token 的 socket 与
    // %TEMP% 目录）——dropGateway 供创建段与握手失败共用（N-6：旧实现只护住 catalog 写入段，
    // effectiveMcp/构建/spawn 抛错会漏拆）
    const dropGateway = (): void => {
      gateway?.close();
      if (catalogPath) {
        try {
          fs.rmSync(path.dirname(catalogPath), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    };
    const wantAsk = !!input.requestUserQuestion;
    if (input.hostTools.length || wantAsk) {
      gateway = await startHostToolGateway(input);
      // 网关已监听，后续创建段任一步失败都必须拆掉它（否则泄漏带 token 的 socket）
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-host-mcp-'));
        catalogPath = path.join(dir, 'catalog.json');
        fs.writeFileSync(
          catalogPath,
          JSON.stringify(
            hostToolsToCatalog(input.hostTools, {
              includeAskQuestion: wantAsk
            })
          )
        );
        const script = resolveHostMcpScript(this.deps.hostMcpScript);
        // P0-1 单源：spawn 计划（execPath + ELECTRON_RUN_AS_NODE 判定）一律来自
        // hostMcpShimSpawn——也在此 try 内，组装失败同样要拆网关
        const shim = hostMcpShimSpawn(script);
        const envPairs = [
          { name: 'MUSTER_HOST_TOOLS_URL', value: gateway.url },
          { name: 'MUSTER_HOST_TOOLS_TOKEN', value: gateway.token },
          { name: 'MUSTER_HOST_TOOLS_CATALOG', value: catalogPath },
          { name: 'MUSTER_HOST_TOOLS_PRESET', value: 'acp-subset' },
          ...Object.entries(shim.env).map(([name, value]) => ({ name, value }))
        ];
        hostServer = {
          name: ACP_HOST_MCP_NAME,
          command: shim.command,
          args: shim.args,
          env: envPairs
        };
      } catch (e) {
        dropGateway();
        throw e;
      }
    }

    let mcpServers: AcpMcpServer[];
    let transport: AcpTransport;
    const env = acpLaunchEnvironment(agentId, process.env);
    const historyStorageKey = acpHistoryStorageKey(agentId, env);
    try {
      const command = { command: launch.command, args: launch.args, cwd: input.cwd, env };
      transport = this.deps.spawnAgent
        ? this.deps.spawnAgent(command)
        : spawnRealAgent(command, {
          businessLabel: `ACP · ${agentId}`,
          workspaceId: input.workspaceContext?.workspaceId,
          workspaceName: input.workspaceContext?.workspaceName,
          sessionId: input.sessionId,
          sessionName: input.sessionName,
          taskId: input.taskId
        });
    } catch (e) {
      dropGateway();
      throw e;
    }
    const rpc = transport.rpc;
    const secrets = collectEnvSecrets(process.env);
    if (gateway?.token) secrets.push(gateway.token);
    const diagnostic = (message: string): string => redactSafetyText(message, secrets).slice(0, 800);
    rpc.on('stderr', (t: string) => log('warn', `acp stderr: ${diagnostic(t).slice(0, 400)}`));

    // 禁止用 resumeToken 冒充本进程已建立的 session：agent 未声明 loadSession
    // 时旧 id 对这次 stdio 连接无效，必须 session/new，否则 prompt 打到幽灵会话。
    let acpSessionId: string | null = null;
    let lastResume: string | null = null;
    let acceptsImages = false;
    let turnActive = false;
    let finalized = true;
    let closed = false;
    let cancelled = false;
    let promptInFlight: Promise<unknown> | null = null;
    let activePrompt: { sessionId: string; userMessageId?: string; started: boolean; settled: boolean } | undefined;
    const confirmPromptStarted = (prompt = activePrompt): void => {
      // A pipe write is only submission. Confirm from the active session's
      // response/activity, retaining the exact host input identity once.
      if (!prompt || prompt !== activePrompt || prompt.settled || prompt.started ||
          !prompt.userMessageId || !turnActive || cancelled || closed) return;
      prompt.started = true;
      queue.push({ type: 'turn-started', userMessageId: prompt.userMessageId });
    };
    let sessionMetadata: Record<string, unknown> = {};
    let nativeState: NativeConfigState = { status: 'uninitialized', options: [] };
    const configObservers = new Set<(state: NativeConfigState) => void>();
    const earlyConfig = new Map<string, Record<string, unknown>>();
    const unknownTypes = new Set<string>();
    const publishConfig = () => {
      nativeState = acpNativeConfig(sessionMetadata, type => {
        if (unknownTypes.has(type)) return;
        unknownTypes.add(type);
        log('warn', `ACP ignored an unsupported session config type: ${diagnostic(type)}`);
      });
      queue.push({ type: 'native-config', state: nativeState });
      for (const observe of configObservers) observe(nativeState);
    };
    const applyConfigUpdate = (update: Record<string, unknown>) => {
      if (Array.isArray(update.configOptions)) {
        sessionMetadata = { ...sessionMetadata, configOptions: update.configOptions };
      } else {
        const currentModeId = acpNativeId(update.currentModeId);
        if (!currentModeId) return;
        if (Array.isArray(sessionMetadata.configOptions)) return;
        sessionMetadata = { ...sessionMetadata, modes: { ...asRecord(sessionMetadata.modes), currentModeId } };
      }
      publishConfig();
    };
    const observeSession = (reply: unknown, resume?: string) => {
      const metadata = asRecord(reply);
      const sid = acpNativeId(metadata.sessionId ?? metadata.session_id ?? resume);
      if (!sid || (resume && sid !== resume)) throw new Error('ACP 返回了无效或不匹配的 sessionId');
      acpSessionId = sid;
      sessionMetadata = metadata;
      const early = earlyConfig.get(sid);
      earlyConfig.clear();
      if (early) applyConfigUpdate(early);
      else publishConfig();
    };
    let contextUsage: import('../../types').GuiContextUsage | null = null;
    let grokModels: Record<string, unknown> = {};
    let grokModel = '';
    let openCodeFork: { identity: GuiForkIdentity; hash: string; first: string; last: string } | undefined;
    const interactions = new Set<AbortController>();
    const cancelInteractions = (): void => { for (const controller of interactions) controller.abort(); interactions.clear(); };

    const publishContext = (used: unknown, window: unknown): void => {
      const usage = normalizeContextUsage(used, window);
      if (!usage || usage.tokens === null) return;
      if (contextUsage?.tokens === usage.tokens && contextUsage.contextWindow === usage.contextWindow) return;
      contextUsage = usage;
      queue.push({ type: 'context-usage', usage });
    };
    const grokWindow = (): unknown => {
      const current = grokModel || (typeof grokModels.currentModelId === 'string' ? grokModels.currentModelId : '');
      const models = Array.isArray(grokModels.availableModels) ? grokModels.availableModels : [];
      const model = models.map(asRecord).find(item => item.modelId === current);
      return asRecord(model?._meta).totalContextTokens;
    };

    const emitResume = (token: unknown): void => {
      const t = typeof token === 'string' ? token.trim() : '';
      if (t && t !== lastResume) {
        lastResume = t;
        acpSessionId = t;
        queue.push({ type: 'resume-token', token: t, historyStorageKey, historyCwd: input.cwd });
      }
    };

    const finalizeTurn = (error?: string, workerFailure?: WorkerRuntimeFailure): void => {
      if (finalized) return;
      if (!error && !cancelled && agentId === 'opencode' && acpSessionId && openCodeFork?.first && openCodeFork.last) {
        const entryId = `${openCodeFork.first}|${openCodeFork.last}|${openCodeFork.hash}`;
        const points = [
          ...(openCodeFork.identity.userMessageId ? [{ messageId: openCodeFork.identity.userMessageId, entryId }] : []),
          { messageId: openCodeFork.identity.assistantMessageId, entryId }
        ];
        queue.push({ type: 'native-fork-points', engine: 'opencode', sessionToken: acpSessionId, points });
      }
      openCodeFork = undefined;
      activePrompt = undefined;
      finalized = true;
      turnActive = false;
      cancelInteractions();
      resetAcpStreamTurn(streamState);
      if (error) queue.push({ type: 'error', message: error, ...(workerFailure ? { workerFailure: { ...workerFailure, boundary: 'settled' as const } } : {}) });
      else queue.push({ type: 'turn-complete', ...(cancelled ? { cancelled: true } : {}) });
    };

    const handleIncoming = (msg: JsonRpcMessage): void => {
      if (agentId === 'cursor' && (msg.method === 'cursor/ask_question' || msg.method === 'cursor/create_plan') && msg.id != null) {
        const requestId = msg.id;
        const origin = input.getTurnId?.();
        if (!turnActive || cancelled || closed || (input.getTurnId && !origin) || !input.requestUserQuestion) {
          rpc.respond(requestId, { outcome: { outcome: 'cancelled' } });
          return;
        }
        const controller = new AbortController();
        interactions.add(controller);
        const timer = setTimeout(() => controller.abort(), this.deps.approvalTimeoutMs ?? ACP_APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        void (async () => {
          try {
            const parsed = msg.method === 'cursor/ask_question' ? parseCursorQuestions(msg.params) : undefined;
            const request = parsed?.request ?? cursorPlanQuestion(msg.params);
            const aborted = new Promise<{ kind: 'aborted' }>(resolve => controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true }));
            const result = await Promise.race([input.requestUserQuestion!(request, controller.signal), aborted]);
            const current = !closed && turnActive && !cancelled && !controller.signal.aborted && (!input.getTurnId || input.getTurnId() === origin);
            rpc.respond(requestId, !current ? { outcome: { outcome: 'cancelled' } }
              : parsed ? cursorQuestionResponse(parsed.questions, result) : cursorPlanResponse(result, request.questions[0]?.options?.[0]?.label));
          } catch (error) {
            rpc.respondError(requestId, diagnostic((error as Error).message));
          } finally {
            clearTimeout(timer);
            interactions.delete(controller);
          }
        })();
        return;
      }
      if (agentId === 'grok' && msg.method === '_x.ai/session_notification') {
        const params = asRecord(msg.params), update = asRecord(params.update);
        if (acpSessionId && params.sessionId === acpSessionId && update.sessionUpdate === 'model_changed' && typeof update.model_id === 'string') {
          grokModel = update.model_id;
        }
        return;
      }
      if (msg.method === 'session/update') {
        const params = asRecord(msg.params);
        const eventSession = params.sessionId ?? params.session_id;
        const update = params.update ?? params;
        const configUpdate = asRecord(update);
        const updateKind = configUpdate.sessionUpdate ?? configUpdate.session_update;
        if (updateKind === 'config_option_update' || updateKind === 'current_mode_update') {
          const id = acpNativeId(eventSession);
          if (!id || closed || Object.hasOwn(asRecord(configUpdate._meta), 'cognition.ai/subagent_context')) return;
          if (!acpSessionId) {
            if (earlyConfig.size < 8 || earlyConfig.has(id)) earlyConfig.set(id, { ...earlyConfig.get(id), ...configUpdate });
            return;
          }
          if (id === acpSessionId) applyConfigUpdate(configUpdate);
          if (updateKind === 'config_option_update') return;
        }
        if (typeof eventSession === 'string' && eventSession !== acpSessionId) return;
        if (agentId === 'opencode' && turnActive && eventSession === acpSessionId && openCodeFork &&
            configUpdate.sessionUpdate === 'agent_message_chunk' &&
            !Object.hasOwn(asRecord(configUpdate._meta), 'cognition.ai/subagent_context') &&
            typeof configUpdate.messageId === 'string' && /^msg_[A-Za-z0-9_-]{1,180}$/.test(configUpdate.messageId)) {
          if (!openCodeFork.first) openCodeFork.first = configUpdate.messageId;
          openCodeFork.last = configUpdate.messageId;
        }
        if (acpSessionId && eventSession === acpSessionId &&
            (configUpdate.sessionUpdate ?? configUpdate.session_update) === 'usage_update' &&
            !Object.hasOwn(asRecord(configUpdate._meta), 'cognition.ai/subagent_context')) {
          publishContext(configUpdate.used, configUpdate.size);
        }
        if (agentId === 'grok' && acpSessionId && eventSession === acpSessionId &&
            !Object.hasOwn(asRecord(configUpdate._meta), 'cognition.ai/subagent_context')) {
          const meta = asRecord((msg as JsonRpcMessage & { _meta?: unknown })._meta);
          if (meta.totalTokens != null) publishContext(meta.totalTokens, grokWindow());
        }
        const events = mapAcpSessionUpdate(streamState, update);
        if (eventSession === activePrompt?.sessionId &&
            events.some(event => ['text-delta', 'thinking-delta', 'tool-start', 'tool-update', 'tool-result'].includes(event.type))) {
          confirmPromptStarted();
        }
        for (const ev of events) {
          queue.push(ev);
        }
        return;
      }
      if (msg.method === 'session/request_permission' && msg.id != null) {
        const params = asRecord(msg.params);
        const requestSession = params.sessionId ?? params.session_id;
        const hostTurnId = input.getTurnId?.();
        if (!turnActive || (input.getTurnId && !hostTurnId) || requestSession !== acpSessionId) {
          rpc.respondError(msg.id, 'ACP 权限请求不属于当前活动会话'); return;
        }
        confirmPromptStarted();
        const controller = new AbortController();
        interactions.add(controller);
        void resolveAcpPermission({
          params: msg.params,
          input,
          mcpPermissionMetadata,
          cancelled: () => cancelled || closed || !turnActive || input.getTurnId?.() !== hostTurnId,
          signal: controller.signal,
          timeoutMs: this.deps.approvalTimeoutMs ?? ACP_APPROVAL_TIMEOUT_MS
        })
          .then((r) => rpc.respond(msg.id!, r))
          .catch((e: Error) => rpc.respondError(msg.id!, diagnostic(e.message)))
          .finally(() => interactions.delete(controller));
        return;
      }
      if (msg.id != null) rpc.respondError(msg.id, 'ACP 客户端不支持此请求', -32601);
    };
    rpc.on('message', handleIncoming);

    // 握手失败 / agent 死亡 / 主动关闭共用一套资源清理（网关 socket / 临时目录 / 子进程）
    let cleanupPromise: Promise<void> | undefined;
    let gatewayDropped = false;
    const cleanupResources = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      const attempt = (async () => {
        if (!gatewayDropped) {
          rpc.close();
          dropGateway();
          gatewayDropped = true;
        }
        await transport.kill();
      })();
      cleanupPromise = attempt;
      void attempt.catch(() => { if (cleanupPromise === attempt) cleanupPromise = undefined; });
      return attempt;
    };

    // agent 进程死亡（EOF/错误/spawn 失败）：收口本回合并关闭事件流，
    // Host 侧会拆掉这条连接、下一条消息自动重建（对齐 claude driver 的流死亡路径）。
    rpc.on('close', (err: Error) => {
      if (closed) return;
      closed = true;
      if (turnActive) {
        finalizeTurn(`ACP agent 进程已退出（${diagnostic(err.message)}）；下一条消息会自动重建会话`);
      } else {
        log('warn', `ACP agent 进程已退出（${diagnostic(err.message)}）；下一条消息将自动重连`);
      }
      void cleanupResources().catch(error => log('error', `ACP 进程回收失败：${(error as Error).message}`));
      queue.close();
    });

    let init: Record<string, unknown>;
    const rpcTimeoutMs = this.deps.rpcTimeoutMs ?? ACP_RPC_TIMEOUT_MS;
    const closeDrainTimeoutMs = this.deps.closeDrainTimeoutMs ?? ACP_CLOSE_DRAIN_TIMEOUT_MS;
    const configRequest = async (method: string, params: unknown, label: string) => {
      let active = true;
      try {
        return await withTimeout(rpc.request(method, params, reply => {
          if (active && !closed && Array.isArray(asRecord(reply).configOptions)) applyConfigUpdate(asRecord(reply));
        }), rpcTimeoutMs, label);
      } finally {
        active = false;
      }
    };
    const setNativeConfig = async (id: string, value: NativeConfigValue) => {
      if (!acpSessionId || closed) throw new Error('ACP 会话未连接');
      const before = nativeState;
      const selection = acpNativeSelection(sessionMetadata, acpSessionId, id, value);
      await configRequest(selection.method, selection.params, 'ACP 设置会话配置');
      if (nativeState === before && selection.method === 'session/set_mode') return;
      if (nativeState.options.find(option => option.id === id)?.currentValue !== value) {
        throw new Error('ACP 引擎未确认所选配置');
      }
    };
    const setConfirmedNativeConfig = async (id: string, value: NativeConfigValue) => {
      if (nativeState.options.find(option => option.id === id)?.currentValue === value) return;
      await setNativeConfig(id, value);
      if (nativeState.options.find(option => option.id === id)?.currentValue === value) return;
      let observe!: (state: NativeConfigState) => void;
      try {
        await withTimeout(new Promise<void>(resolve => {
          observe = state => {
            if (state.options.find(option => option.id === id)?.currentValue === value) resolve();
          };
          configObservers.add(observe);
        }), rpcTimeoutMs, 'ACP 确认会话权限');
      } finally { configObservers.delete(observe); }
    };
    let permissionSync: Promise<void> | undefined;
    const refreshPermissionStrategy = () => {
      if (permissionSync) return permissionSync;
      const pending = applyNativePermissionStrategy(input, () => nativeState, automaticAcpPermissions(nativeState), setConfirmedNativeConfig);
      permissionSync = pending;
      void pending.finally(() => { if (permissionSync === pending) permissionSync = undefined; }).catch(() => {});
      return pending;
    };
    try {
      if (transport.waitReady) await withTimeout(transport.waitReady(), rpcTimeoutMs, 'ACP 进程启动');
      // P1-3：握手/会话建立 RPC 必须有期限——agent spawn 成功但挂死时 connect 永久悬挂
      init = (await withTimeout(
        rpc.request('initialize', acpInitializeParams),
        rpcTimeoutMs,
        'ACP initialize'
      )) as Record<string, unknown>;
      this.nativeHistory.observe(agentId, launch, env, init);
      await authenticateAcpIfNeeded(agentId, init, rpc, rpcTimeoutMs);

      // authMethods 是「可用登录方式」广告，不代表未登录（N-2：已登录的 agent 也会返回）；
      // 真实鉴权缺失会在 session/new 或 prompt 以引擎自己的报错呈现。仅提示，不拒绝连接。
      const authMethods = Array.isArray(init.authMethods) ? init.authMethods : [];
      if (authMethods.length) {
        const names = authMethods
          .map((m) => (typeof (m as { name?: string; })?.name === 'string' ? (m as { name: string; }).name : ''))
          .filter(Boolean)
          .join('、');
        log(
          'info',
          `agent 广告了登录方式${names ? `（${names}）` : ''}；若尚未登录，后续调用会以引擎的鉴权报错提示`
        );
      }

      const caps = asRecord(init.agentCapabilities ?? init.capabilities);
      acceptsImages = asRecord(caps.promptCapabilities).image === true;
      // B2：session/new.mcpServers 只装宿主自家 stdio shim——用户 MCP 不再按
      // `acp:<presetId>` 过滤注入，initialize 的 mcpCapabilities 协商随之退役
      mcpServers = hostServer ? [hostServer] : [];
      const resume = rawResume ? decodeAcpResumeToken(agentId, rawResume) : '';
      if (resume) {
        const resumeCapability = asRecord(caps.sessionCapabilities).resume;
        const method = resumeCapability === true || (resumeCapability && typeof resumeCapability === 'object')
          ? 'session/resume'
          : caps.loadSession === true ? 'session/load' : '';
        if (!method) throw new Error('该 ACP 引擎未声明会话恢复能力；请保留历史并新建会话');
        try {
          await withTimeout(
            rpc.request(method, { sessionId: resume, cwd: input.cwd, mcpServers }, reply => observeSession(reply, resume)),
            rpcTimeoutMs,
            `ACP ${method}`
          );
        } catch (error) {
          if (agentId === 'cursor') throw new Error(`Cursor ACP 无法恢复原生会话：${(error as Error).message}；历史仍可查看，请检查 Cursor CLI 登录与会话后重试，或新建会话`);
          throw error;
        }
      } else {
        await withTimeout(rpc.request('session/new', { cwd: input.cwd, mcpServers }, reply => observeSession(reply)), rpcTimeoutMs, 'ACP session/new');
      }
      if (!acpSessionId) throw new Error('ACP 未返回 sessionId');
      const sessionId = acpSessionId as string;
      const selectedModel = input.modelOverride?.modelId?.trim() ?? '';
      const selectedReasoning = input.modelParameters?.reasoning;
      if (selectedModel && selectedModel !== 'default') {
        const selection = acpModelSelection(sessionMetadata, sessionId, selectedModel);
        if (parseAcpModelList(sessionMetadata).currentModelId !== selectedModel) {
          const before = nativeState;
          const reply = await configRequest(selection.method, selection.params, 'ACP 设置模型');
          const confirmation = parseAcpModelList(reply).currentModelId;
          if (confirmation && confirmation !== selectedModel) throw new Error('ACP 引擎未确认所选模型');
          if (before === nativeState && selectedReasoning) throw new Error('ACP 引擎未报告新模型的配置选项');
        }
      }
      if (selectedReasoning) {
        const option = parseAcpReasoningOption(sessionMetadata);
        const selection = acpReasoningSelection(sessionMetadata, sessionId, selectedReasoning);
        if (option?.currentValue !== selectedReasoning) {
          const reply = await configRequest('session/set_config_option', selection, 'ACP 设置思考强度');
          const confirmation = parseAcpReasoningOption(reply);
          if (confirmation?.configId === selection.configId && confirmation.currentValue && confirmation.currentValue !== selectedReasoning) {
            throw new Error('ACP 引擎未确认所选思考强度');
          }
        }
      }
      for (const selection of automaticPermissions(input) ? [] : input.nativeConfig?.selections ?? []) {
        await setConfirmedNativeConfig(selection.id, selection.value);
      }
      await refreshPermissionStrategy();
      if (agentId === 'grok') {
        grokModels = asRecord(sessionMetadata.models);
        grokModel = selectedModel && selectedModel !== 'default' ? selectedModel : '';
      }
      emitResume(acpSessionId);
    } catch (e) {
      // 先置 closed 再清理：cleanupResources 会经 rpc.close() 触发上面的 'close'
      // 处理器，那里会打「ACP agent 进程已退出」——握手失败（如需先鉴权）时进程
      // 根本没退出，那是误导日志；真实错误由下面的 throw 上抛。
      closed = true;
      const message = acpLoginHint(agentId, e) ?? diagnostic((e as Error).message);
      try { await cleanupResources(); }
      catch (cleanupError) { throw new ConnectionCleanupError(`${message}；ACP 资源回收失败：${diagnostic((cleanupError as Error).message)}`); }
      throw new Error(message);
    }
    log('info', `acp 会话就绪（agent=${agentId} · session=${acpSessionId}）`);

    let policyPrefix = firstGuiUserMessageContext(input) || null;

    const sendPrompt = async (text: string, images?: GuiSendImage[], identity?: GuiForkIdentity): Promise<void> => {
      if (!acpSessionId) throw new Error('ACP session 未建立');
      cancelled = false;
      turnActive = true;
      finalized = false;
      const prompt = { sessionId: acpSessionId, userMessageId: identity?.userMessageId, started: false, settled: false };
      activePrompt = prompt;
      let body = text;
      const prefixUsed = policyPrefix;
      if (policyPrefix) {
        body = appendGuiHostContext(text, policyPrefix);
        policyPrefix = null;
      }
      openCodeFork = agentId === 'opencode' && identity
        ? { identity, hash: crypto.createHash('sha256').update(body).digest('hex'), first: '', last: '' } : undefined;
      const p = rpc.request('session/prompt', {
        sessionId: acpSessionId,
        prompt: promptBlocks(body, images)
      }, response => {
        // A successful, request-correlated response also proves acceptance when
        // the turn produced no chunks. Cancellation does not start new work.
        if (asRecord(response).stopReason !== 'cancelled') confirmPromptStarted(prompt);
        prompt.settled = true;
      }, () => {
        if (identity?.userMessageId) queue.push({ type: 'engine-input', identity, text: body });
      });
      promptInFlight = p;
      try {
        const response = await p;
        if (activePrompt !== prompt) return;
        if (asRecord(response).stopReason === 'cancelled') cancelled = true;
        if (agentId === 'grok' && turnActive && !cancelled) {
          const meta = asRecord(asRecord(response)._meta);
          if (meta.sessionId == null || meta.sessionId === acpSessionId) {
            if (typeof meta.modelId === 'string') grokModel = meta.modelId;
            if (meta.totalTokens != null) publishContext(meta.totalTokens, grokWindow());
          }
        }
        finalizeTurn();
      } catch (e) {
        if (activePrompt !== prompt) return;
        // F-01（reliability/acp-gui-driver）：prompt 未被引擎接受即失败时，Host 的
        // 网络续作 resend 走 lastSentPayload 再次 send——回填本次消费的宿主说明，
        // 重试时仍附在用户正文之后。用户主动取消（cancelled）不回填：引擎可能
        // 已收到并部分处理，回填会让下一回合重复注入。
        if (prefixUsed && !cancelled && !prompt.started) policyPrefix = prefixUsed;
        if (cancelled) finalizeTurn();
        else finalizeTurn(acpLoginHint(agentId, e) ?? diagnostic((e as Error).message), e instanceof NdjsonRpcResponseError ? classifyWorkerRuntimeFailure(e) : undefined);
      } finally {
        if (promptInFlight === p) promptInFlight = null;
      }
    };

    return {
      events: queue,
      getNativeConfig: () => nativeState,
      setNativeConfig,
      refreshPermissionStrategy,
      restorePermissionStrategy: selections => restoreNativePermissions(() => nativeState, selections, setConfirmedNativeConfig),
      getContextUsage: () => contextUsage,
      async send(text: string, images?: GuiSendImage[], _parameters?: Parameters<GuiRuntimeConnection['send']>[2], authority?: Parameters<GuiRuntimeConnection['send']>[3]) {
        if (turnActive) throw new Error('ACP 回合进行中，已忽略新的 send（与 codex driver 契约一致）');
        if (images?.length && !acceptsImages) throw new Error('当前 ACP 引擎未声明图片输入能力；请移除图片或使用支持图片的引擎');
        await refreshPermissionStrategy();
        if (closed) throw new Error('ACP 会话已关闭');
        if (turnActive) throw new Error('ACP 回合进行中，已忽略新的 send（与 codex driver 契约一致）');
        void sendPrompt(text, images, authority?.forkIdentity).catch((e: Error) => finalizeTurn(e.message));
      },
      async nativeFork(point) {
        if (agentId !== 'opencode' || point.engine !== 'opencode' || point.sessionToken !== acpSessionId)
          return { status: 'unsupported' };
        if (closed || turnActive) throw new Error('OpenCode 会话当前不可分叉');
        return forkOpenCode({ executable: launch.executable ?? launch.command, cwd: input.cwd, point,
          env: acpLaunchEnvironment(agentId, process.env), log: message => log('warn', message) });
      },
      redirect() {
        return false;
      },
      async receiveMessage() {
        // ACP v1 has prompt/cancel, but no queue/steer. The mailbox fallback waits for
        // the original prompt response before sending through this same RPC session.
        return { status: 'unsupported', reason: 'ACP v1 未协商原生队列或插话扩展；使用 session/cancel → prompt 响应收口 → session/prompt' };
      },
      async abort() {
        cancelled = true;
        cancelInteractions();
        if (acpSessionId && turnActive) {
          try {
            rpc.notify('session/cancel', { sessionId: acpSessionId });
          } catch {
            /* ignore */
          }
        }
      },
      async close() {
        if (closed) { await cleanupResources(); return; }
        closed = true;
        cancelled = true;
        cancelInteractions();
        if (acpSessionId && turnActive) {
          try {
            rpc.notify('session/cancel', { sessionId: acpSessionId });
          } catch {
            /* ignore */
          }
        }
        try {
          // P1-3：agent 不响应 session/cancel 时 promptInFlight 永不落定，无期限等待会把
          // 会话关闭/资源回收一起挂死——超时后强制走清理
          await withTimeout(
            Promise.resolve(promptInFlight ?? undefined).catch(() => undefined),
            closeDrainTimeoutMs,
            'ACP close 等待回合收口'
          );
        } catch (e) {
          log('warn', `${(e as Error).message}；强制清理连接资源`);
        }
        try { await cleanupResources(); }
        finally { queue.close(); }
      }
    };
  }
}
