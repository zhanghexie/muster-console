/** Runs Codex GUI turns through an owned native app-server process. */
import { appendGuiHostContext, firstGuiUserMessageContext } from '../../prompt';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../../context';
import type {
  GuiDriverConnectInput,
  GuiDriverStreamEvent,
  GuiRuntimeConnection,
  GuiRuntimeDriver,
  GuiSendImage
} from '../../types';
import { GuiDeliveryError } from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { resolveCodexExecutable, resolveUserCodexExecutable } from './executable';
import type { CodexClientHandle, CodexThreadEvent, CodexThreadHandle, CodexThreadOptions } from './protocol';
import { createCodexAppServerClient, sameCodexHome, type CodexAppServerClientOptions } from './appServerTransport';
import { forkCodexTurn } from './nativeFork';
import { normalizeContextUsage } from '../../../../shared/guiContextUsage';
import { ConnectionCleanupError } from '../../host/retirement';
import { scrubCodexSpawnEnv } from './env';
import { t } from '../../../../shared/i18n';
import { listCodexModels } from './models';
import type { ModelParameterValues } from '../../../../shared/modelParameters';
import type { GuiRuntimeProbeResult } from '../../types';
import { automaticPermissions } from '../nativePermissionPolicy';
import { codexNativeConfig, queryCodexNativeConfig, queryCodexWorkerPermission, type CodexConfigCatalog } from './nativeConfig';
import { nativeOptionAccepts, type NativeConfigState, type NativeConfigValue } from '../../../../shared/nativeSessionConfig';
import { ModelCatalogCache } from '../../modelCatalogCache';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import { setupCodexHostToolsMcp } from './hostToolsMcp';
import { desktopEngineDeliveryFromContext } from '../../../desktop/globalEngineDelivery';
import { classifyWorkerRuntimeFailure, type WorkerRuntimeFailure } from '../../../tasks/workerRoutingPolicy';
import {
  createCodexStreamState,
  describeCodexTurnError,
  mapCodexEvent,
  mapCodexReviewEvent
} from './streamMap';

interface CodexTurn {
  userMessageId?: string;
  stop?: () => Promise<void> | undefined;
  controller: AbortController;
  aborted: boolean;
  completed: boolean;
  nativeTurnId?: string;
  error?: string;
  workerFailure?: WorkerRuntimeFailure;
  stream: ReturnType<typeof createCodexStreamState>;
  settled: Promise<void>;
  settle: () => void;
  writerKeys: Set<string>;
}

// Connections may be rebuilt before stale.close() returns. Keep the writer lease
// until that turn's event stream has drained, including abort and failed exits.
const threadWriters = new Map<string, CodexTurn>();
// A failed helper reclamation leaves the source thread's writer unknown.
// Keep that thread unavailable across connections until the app is restarted.
const blockedThreadWriters = new Map<string, string>();

function codexHomeOf(env: Record<string, string>): string {
  let home = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  try { home = fs.realpathSync.native(home); } catch { /* Codex may create the home later */ }
  return process.platform === 'win32' ? home.toLowerCase() : home;
}

async function acquireThreadWriter(key: string, turn: CodexTurn): Promise<boolean> {
  while (!turn.controller.signal.aborted) {
    const cleanupFailure = blockedThreadWriters.get(key);
    if (cleanupFailure) throw new ConnectionCleanupError(`无法确认 Codex 分叉进程已回收，请检查残留进程并重启工作台：${cleanupFailure}`);
    const owner = threadWriters.get(key);
    if (!owner || owner === turn) {
      threadWriters.set(key, turn);
      turn.writerKeys.add(key);
      return true;
    }
    const signal = turn.controller.signal;
    await new Promise<void>((resolve) => {
      const done = (): void => { signal.removeEventListener('abort', done); resolve(); };
      signal.addEventListener('abort', done, { once: true });
      void owner.settled.then(done);
      if (signal.aborted) done();
    });
  }
  return false;
}

export interface CodexDriverDeps {
  listModels?: typeof listCodexModels;
  /** Injects an event replay client for offline tests. */
  createClient?: (options: { codexPathOverride?: string; env: Record<string, string>; config: Record<string, unknown> }) => CodexClientHandle;
  resolveExecutable?: () => Promise<{ ok: boolean; executable?: string; packaged: boolean }>;
  /** 回放/单测可注入宿主 MCP 脚本路径 */
  hostMcpScript?: string;
  createAppServerClient?: (options: CodexAppServerClientOptions) => CodexClientHandle;
  readVersion?: (executable: string) => Promise<string>;
}

function threadOptionsOf(input: GuiDriverConnectInput, parameters?: ModelParameterValues): CodexThreadOptions {
  return {
    workingDirectory: input.cwd,
    ...(parameters?.reasoning ? { modelReasoningEffort: parameters.reasoning } : {}),
    ...(input.modelOverride?.modelId?.trim() ? { model: input.modelOverride.modelId.trim() } : {})
  };
}

function writeTempImages(images?: GuiSendImage[]): { paths: string[]; cleanup: () => void } {
  if (!images?.length) return { paths: [], cleanup: () => undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-codex-img-'));
  const paths: string[] = [];
  images.forEach((img, i) => {
    const ext = (img.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const file = path.join(dir, `img-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    paths.push(file);
  });
  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
}

export class CodexRuntimeDriver implements GuiRuntimeDriver {
  readonly runtimeId = 'codex-gui';
  readonly permissionStrategyHot = true;
  readonly deliveryCapabilities = { interject: false, snapshot: true } as const;
  readonly supportsImages = true;
  readonly supportsSeed = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'unsupported' as const;

  constructor(
    private ctx: AppContext,
    _opts: { userDataDir: string },
    private deps: CodexDriverDeps = {}
  ) {}

  async validateModelOverride({ cwd, model }: { cwd: string; model: NonNullable<GuiDriverConnectInput['modelOverride']> }): Promise<void> {
    const catalog = await (this.deps.listModels ?? listCodexModels)(cwd);
    if (!catalog.ok) throw new Error(`无法验证 Codex 模型：${catalog.error}`);
    if (!catalog.items.some(item => item.id === model.modelId))
      throw new Error(`Codex 模型 ${model.modelId} 不在当前可用目录中，请查询目标 runtime 的模型后重试`);
  }

  private readonly nativeCatalogs = new ModelCatalogCache<CodexConfigCatalog>('codex-native-config');

  nativeConfigVersion(): string {
    return nativeExecutableVersion(resolveUserCodexExecutable(), `codex-app-server-0.167:${codexHomeOf(scrubCodexSpawnEnv(process.env))}`);
  }

  private nativeCatalogKey(cwd: string, executable: string, env: Record<string, string>): string {
    const version = fs.statSync(executable, { throwIfNoEntry: false });
    return JSON.stringify([cwd, executable, version?.mtimeMs, version?.size, codexHomeOf(env)]);
  }

  async describeNativeConfig({ cwd, refresh }: { cwd: string; refresh?: boolean }): Promise<NativeConfigState> {
    try {
      const executable = this.deps.resolveExecutable ? await this.deps.resolveExecutable() : await resolveCodexExecutable();
      if (!executable.ok || !executable.executable) throw new Error('Codex app-server executable unavailable.');
      const env = scrubCodexSpawnEnv(process.env);
      const key = this.nativeCatalogKey(cwd, executable.executable, env);
      if (!refresh) {
        const cached = this.nativeCatalogs.get(key);
        return cached ? codexNativeConfig(cached) : { status: 'uninitialized', options: [] };
      }
      const catalog = await queryCodexNativeConfig(executable.executable, cwd, env, raw => {
        const init = raw as { codexHome?: string } | null;
        if (!sameCodexHome(init?.codexHome, env)) throw new Error('Codex reported a different home directory.');
      });
      this.nativeCatalogs.set(key, catalog);
      return codexNativeConfig(catalog);
    } catch (error) {
      return { status: 'error', options: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async captureWorkerPermission({ cwd, nativeConfig }: { cwd: string; nativeConfig: NonNullable<GuiDriverConnectInput['nativeConfig']> }): Promise<string> {
    const executable = await (this.deps.resolveExecutable ?? resolveCodexExecutable)();
    if (!executable.ok || !executable.executable) throw new Error('Codex app-server executable unavailable.');
    const env = scrubCodexSpawnEnv(process.env);
    return queryCodexWorkerPermission(executable.executable, cwd, env, raw => {
      const init = raw as { codexHome?: string } | null;
      if (!sameCodexHome(init?.codexHome, env)) throw new Error('Codex reported a different home directory.');
    }, nativeConfig.selections);
  }

  /** 预检只定位本机 Codex CLI。 */
  async probe(): Promise<GuiRuntimeProbeResult> {
    const exeInfo = this.deps.resolveExecutable
      ? await this.deps.resolveExecutable()
      : await resolveCodexExecutable();
    if (!exeInfo.ok) {
      return {
        status: 'not_installed',
        problems: [
          {
            code: 'cli_missing',
            message: t(
              '未找到本机 Codex 安装。Codex（GUI）依赖你自己的 Codex CLI（订阅/API 鉴权）'
            ),
            fix: 'npm install -g @openai/codex'
          }
        ]
      };
    }
    return { status: 'available', problems: [] };
  }

  async describeModelParameters(input: { cwd: string; modelOverride?: GuiDriverConnectInput['modelOverride']; refresh?: boolean }) {
    const catalog = await (this.deps.listModels ?? listCodexModels)(input.cwd, input.refresh);
    const modelId = input.modelOverride?.modelId?.trim() || (catalog.ok ? catalog.defaultModelId : '');
    const row = catalog.ok ? catalog.items.find(m => m.id === modelId) : undefined;
    const parameters = row?.parameters?.map(p => ({ ...p, label: t('思考强度') })) ?? [];
    if (catalog.ok && modelId === catalog.defaultModelId && catalog.defaultParameters) {
      for (const p of parameters) {
        const value = catalog.defaultParameters[p.id];
        if (p.options.some(o => o.value === value)) p.defaultValue = value;
      }
    }
    const warning = !catalog.ok ? catalog.error : row?.parameters !== undefined ? undefined
      : catalog.warning ?? t('Codex 尚未返回 {{model}} 的思考档位，请刷新模型目录。', { model: modelId });
    return { runtimeId: this.runtimeId, providerId: this.runtimeId, modelId, parameters,
      ...(warning ? { unavailable: true, warning } : {}) };
  }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const log = input.log;
    const exeInfo = this.deps.resolveExecutable
      ? await this.deps.resolveExecutable()
      : await resolveCodexExecutable();
    if (!exeInfo.ok) {
      throw new Error(
        '未找到本机 Codex 安装。Codex（GUI）依赖你自己的 Codex CLI（订阅/API 鉴权）：请安装 codex 后重试'
      );
    }

    const createAppClient = this.deps.createAppServerClient ?? createCodexAppServerClient;
    // Keep offline event replays isolated from the production path.
    const testFactory = this.deps.createAppServerClient ? undefined : this.deps.createClient;
    const spawnEnv = scrubCodexSpawnEnv(process.env);
    let hostMcp: Awaited<ReturnType<typeof setupCodexHostToolsMcp>> = null;
    let injectedTestClient: CodexClientHandle | undefined;
    try {
      const globalDelivery = desktopEngineDeliveryFromContext(this.ctx);
      hostMcp = await setupCodexHostToolsMcp(input, { hostMcpScript: this.deps.hostMcpScript,
        ...(globalDelivery ? { globalDelivery } : {}) });
      injectedTestClient = testFactory?.({ ...(exeInfo.executable ? { codexPathOverride: exeInfo.executable } : {}),
        env: spawnEnv, config: { show_raw_agent_reasoning: true, ...hostMcp?.configFragment } });
    } catch (e) {
      hostMcp?.close();
      throw new Error(`Codex 宿主工具 MCP 组装失败：${(e as Error).message}`);
    }
    const queue = new AsyncEventQueue<GuiDriverStreamEvent>();
    const codexHome = codexHomeOf(spawnEnv);
    const writerKey = (id: string): string => JSON.stringify([codexHome, id]);
    let threadId: string | null = input.resumeToken?.trim() || null;
    let lastResumeToken: string | null = threadId;
    let activeTurn: CodexTurn | null = null;
    let closed = false;
    let closing: Promise<void> | null = null;
    let policyPrefix = firstGuiUserMessageContext(input) || null;
    let contextUsage: import('../../types').GuiContextUsage | null = null;
    let nativeState: NativeConfigState = { status: 'uninitialized', options: [] };
    const nativeSelections = new Map(input.nativeConfig?.selections.map(({ id, value }) => [id, value]));
    const workerPermission = input.workerPermission;

    const emitResumeToken = (turn: CodexTurn, token: unknown): void => {
      const t = typeof token === 'string' ? token.trim() : '';
      if (!t) return;
      const key = writerKey(t);
      const owner = threadWriters.get(key);
      if (owner && owner !== turn) {
        throw new Error(`thread-store conflict: thread ${t} already has an active writer`);
      }
      threadWriters.set(key, turn);
      turn.writerKeys.add(key);
      if (t !== lastResumeToken) {
        lastResumeToken = t;
        threadId = t;
        queue.push({ type: 'resume-token', token: t });
      }
    };

    const handleEvent = (turn: CodexTurn, raw: unknown): void => {
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'app.review-warning') {
        if (activeTurn === turn && !turn.completed && !turn.error && !turn.aborted && 'message' in raw && typeof raw.message === 'string')
          queue.push({ type: 'review-warning', message: raw.message });
        return;
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'app.review-only') {
        if (activeTurn === turn && !turn.completed && !turn.error && !turn.aborted && 'event' in raw) {
          for (const mapped of mapCodexReviewEvent(turn.stream, raw.event as CodexThreadEvent)) queue.push(mapped);
        }
        return;
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'app.turn-identity') {
        const id = (raw as { turnId?: unknown }).turnId;
        if (activeTurn === turn && typeof id === 'string' && id) turn.nativeTurnId = id;
        return;
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'app.context-usage') {
        const usage = (raw as { usage?: { tokens?: unknown; contextWindow?: unknown } }).usage;
        const snapshot = usage && normalizeContextUsage(usage.tokens, usage.contextWindow);
        if (snapshot && activeTurn === turn && !turn.completed && !turn.error && !turn.aborted) {
          contextUsage = snapshot;
          queue.push({ type: 'context-usage', usage: snapshot });
        }
        return;
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'app.warning') {
        const warning = raw as { message?: unknown };
        if (typeof warning.message === 'string') log('warn', warning.message);
        return;
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'app.tool-progress') {
        const progress = raw as { toolCallId?: unknown; delta?: unknown };
        if (!turn.completed && !turn.error && !turn.aborted && typeof progress.toolCallId === 'string' && typeof progress.delta === 'string') {
          queue.push({ type: 'tool-progress', toolCallId: progress.toolCallId, delta: progress.delta });
        }
        return;
      }
      const ev = raw as CodexThreadEvent;
      try {
        if (ev?.type === 'turn.started' && activeTurn === turn && turn.userMessageId) {
          queue.push({ type: 'turn-started', userMessageId: turn.userMessageId });
        }
        if (ev?.type === 'thread.started') {
          emitResumeToken(turn, ev.thread_id);
        }
        const error = describeCodexTurnError(ev);
        if (error) {
          turn.error = error;
          if (ev.type === 'turn.failed') turn.workerFailure = classifyWorkerRuntimeFailure(ev.error);
          return;
        }
        if (ev?.type === 'turn.completed') {
          turn.completed = true;
          return;
        }
        if (turn.completed || turn.error) return;
        for (const mapped of mapCodexEvent(turn.stream, ev)) {
          queue.push(mapped);
        }
      } catch (e) {
        log('error', `codex 事件处理异常: ${(e as Error).message}`);
        turn.error = (e as Error).message;
        turn.controller.abort();
      }
    };

    const connection: GuiRuntimeConnection = {
      events: queue,
      getContextUsage: () => contextUsage,
      getNativeConfig: () => nativeState,
      refreshNativeConfig: async () => {
        if (nativeState.options.some(option => option.currentValue !== undefined)) return nativeState;
        const refreshed = await this.describeNativeConfig({ cwd: input.modelCatalogCwd ?? input.cwd, refresh: true });
        if (!closed && !nativeState.options.some(option => option.currentValue !== undefined)) nativeState = refreshed;
        return nativeState;
      },
      async setNativeConfig(id: string, value: NativeConfigValue) {
        const option = nativeState.options.find(item => item.id === id);
        if (closed || activeTurn || !option || !nativeOptionAccepts(option, value)) throw new Error('Codex settings are unavailable or the session is busy.');
        if (option.currentValue === value) nativeSelections.delete(id);
        else nativeSelections.set(id, value);
      },
      async send(text: string, images?: GuiSendImage[], parameters?: ModelParameterValues, authority?: { userText?: string; forkIdentity?: import('../../types').GuiForkIdentity }): Promise<void> {
        if (closed) throw new Error('codex 连接已中断，请重发消息（将自动重连恢复）');
        if (activeTurn) throw new Error('Codex 本回合尚未结束');
        const img = writeTempImages(images);
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => { settle = resolve; });
        const turn: CodexTurn = {
          userMessageId: authority?.forkIdentity?.userMessageId,
          controller: new AbortController(),
          aborted: false,
          completed: false,
          stream: createCodexStreamState(),
          settled,
          settle,
          writerKeys: new Set()
        };
        activeTurn = turn;
        let thread: CodexThreadHandle | undefined;
        let constructionFailed = false;
        const usingAppServer = !injectedTestClient;
        let appSubmitted = false;
        let consumedPrefix: string | null = null;
        try {
          if (threadId && !await acquireThreadWriter(writerKey(threadId), turn)) return;
          if (closed || turn.aborted) return;
          consumedPrefix = policyPrefix;
          const engineText = appendGuiHostContext(text, policyPrefix);
          policyPrefix = null;
          const inputPayload = img.paths.length === 0 ? engineText : [
            { type: 'text' as const, text: engineText },
            ...img.paths.map((p) => ({ type: 'local_image' as const, path: p }))
          ];
          // P1-2：线程构造也必须在 try 内——resumeThread/startThread 同步抛错时旧实现
          // 会漏掉 img 清理与 writer 释放，毒化本连接的后续 send
          const opts = threadOptionsOf(input, parameters ?? input.modelParameters);
          if (usingAppServer && !threadId && input.hasPriorConversation && !input.forkTranscriptPending) {
            throw new Error('Codex 历史缺少原生会话标识，无法安全恢复；请保留历史并新建会话');
          }
          // A gateway credential belongs to this process/turn, not the whole GUI
          // connection. Late HTTP requests from a retired process cannot borrow
          // the next instruction even if their headers arrive after it starts.
          hostMcp?.rotateTurn();
          let selectedClient: CodexClientHandle;
          if (injectedTestClient) selectedClient = injectedTestClient;
          else {
            if (!exeInfo.executable) throw new Error('Codex app-server executable unavailable.');
            selectedClient = createAppClient({
              executable: exeInfo.executable, env: spawnEnv, host: input,
              nativeSelections: workerPermission ? input.nativeConfig?.selections : automaticPermissions(input)
                ? [] : [...nativeSelections].map(([id, value]) => ({ id, value })),
              workerPermission,
              onNativeConfig: state => {
                if (activeTurn !== turn || closed || turn.controller.signal.aborted) return;
                nativeState = state;
                for (const option of automaticPermissions(input) ? [] : state.options) {
                  if (nativeSelections.has(option.id) && nativeSelections.get(option.id) === option.currentValue) nativeSelections.delete(option.id);
                }
                queue.push({ type: 'native-config', state });
              },
              hostMcpConfig: hostMcp?.configFragment ?? {}, expectedTools: hostMcp?.catalog.tools.map(tool => tool.name) ?? [],
              desktopDelivery: hostMcp?.desktopDelivery
            });
          }
          thread = threadId ? selectedClient.resumeThread(threadId, opts) : selectedClient.startThread(opts);
          turn.stop = () => thread?.stop?.();
          const identity = authority?.forkIdentity;
          const recordInput = () => {
            if (identity?.userMessageId) queue.push({ type: 'engine-input', identity, text: engineText });
          };
          const { events } = await thread.runStreamed(inputPayload, {
            signal: turn.controller.signal,
            onSubmission: () => { appSubmitted = true; recordInput(); },
            onExecution: state => {
              if (activeTurn !== turn) return;
              queue.push({ type: 'execution', state });
              log(state.process === 'reclaim_failed' ? 'error' : 'info',
                `Codex lifecycle ${JSON.stringify({ sessionId: input.sessionId, ...state })}`);
            }
          });
          if (!usingAppServer && !appSubmitted) recordInput();
          for await (const ev of events) handleEvent(turn, ev);
          if (thread.id) emitResumeToken(turn, thread.id);
          if (!turn.completed && !turn.error && !turn.aborted) {
            turn.error = 'codex 事件流结束（下一条消息会自动 resume 续聊）';
          }
        } catch (e) {
          if (usingAppServer && !turn.aborted) {
            const message = turn.error ?? (e as Error)?.message ?? String(e);
            log('error', `codex app-server 异常: ${message}`);
            // The host owns this terminal error; suppress the duplicate stream
            // terminal and preserve whether turn/start could have been delivered.
            constructionFailed = true;
            throw Object.assign(new GuiDeliveryError(message, appSubmitted ? 'unknown' : 'not-submitted'), { cause: e });
          }
          if (!thread && !turn.aborted) {
            // Host 的 send catch 处理构造失败；finally 仍释放资源，不重复发终态。
            constructionFailed = true;
            throw e;
          }
          const message = turn.error ?? (e as Error)?.message ?? String(e);
          if (!turn.aborted) {
            log('error', `codex exec 异常: ${message}`);
            // resume 的线程已不存在（rollout 被清理/迁移）：丢掉旧 id 自愈，否则每条消息
            // 重复失败。只在错误同时提到线程语境且是「缺失」语义时才丢——裸 not found/
            // no such 会误伤网络类文案（ENOTFOUND / "No such host is known" / 404），
            // 清错线程会静默丢引擎侧上下文。
            const mentionsThread = /thread|session|rollout|线程|会话/i.test(message);
            const looksMissing = /not\s+found|no\s+such|unknown|missing|expired|不存在|已失效|已过期/i.test(message);
            if (threadId && mentionsThread && looksMissing && usingAppServer) {
              turn.error = `${message}（原会话标识已保留，恢复失败；请检查 Codex 会话，不会自动创建空会话）`;
            } else if (threadId && mentionsThread && looksMissing) {
              threadId = null;
              log('warn', 'codex resume 线程已失效，下次发送将新建线程');
              // 自愈已丢线程 id：下一条消息是新建线程而非 resume，引擎侧上下文不再延续，
              // 文案必须如实说，否则用户误以为上下文还在
              turn.error = `${message}（线程已失效，下一条消息将新建线程，上下文不延续）`;
            } else {
              turn.error = `${message}（下一条消息会自动 resume 续聊）`;
            }
          }
        } finally {
          // On a definite pre-submit failure/cancellation, the engine did not
          // receive the connection policy. Keep it for the next attempt.
          if (usingAppServer && !appSubmitted && consumedPrefix && !policyPrefix) policyPrefix = consumedPrefix;
          img.cleanup();
          for (const key of turn.writerKeys) {
            if (threadWriters.get(key) === turn) threadWriters.delete(key);
          }
          if (activeTurn === turn) activeTurn = null;
          turn.settle();
          // The transport waits for process reclamation before the Host may drain the next message.
          if (!constructionFailed) {
            if (turn.completed && !turn.error && !turn.aborted && turn.nativeTurnId && threadId && authority?.forkIdentity) {
              queue.push({ type: 'native-fork-points', engine: 'codex', sessionToken: threadId,
                points: [{ messageId: authority.forkIdentity.assistantMessageId, entryId: turn.nativeTurnId }] });
            }
            queue.push(turn.error && !turn.aborted
              ? { type: 'error', message: turn.error, ...(turn.workerFailure ? { workerFailure: { ...turn.workerFailure, boundary: 'settled' as const } } : {}) }
              : { type: 'turn-complete' });
          }
        }
      },
      async nativeFork(point) {
        if (closed || activeTurn) throw new Error('Codex 会话忙碌或已关闭，无法分叉');
        if (point.engine !== 'codex' || point.role !== 'assistant' || !exeInfo.executable)
          return { status: 'unsupported' };
        if (point.sessionToken !== threadId) throw new Error('Codex 会话标识已变化，无法安全分叉');
        let settle!: () => void;
        const settled = new Promise<void>(resolve => { settle = resolve; });
        const lease: CodexTurn = { controller: new AbortController(), aborted: false, completed: false,
          stream: createCodexStreamState(), settled, settle, writerKeys: new Set() };
        try {
          if (!await acquireThreadWriter(writerKey(point.sessionToken), lease)) throw new Error('Codex 会话写入锁不可用');
          if (closed || activeTurn || threadId !== point.sessionToken) throw new Error('Codex 会话在分叉期间发生变化');
          return await forkCodexTurn(point, input.cwd, exeInfo.executable, spawnEnv);
        } catch (error) {
          if (error instanceof ConnectionCleanupError) {
            for (const key of lease.writerKeys) blockedThreadWriters.set(key, error.message);
          }
          throw error;
        } finally {
          for (const key of lease.writerKeys) if (threadWriters.get(key) === lease) threadWriters.delete(key);
          lease.settle();
        }
      },
      redirect(): boolean {
        return false;
      },
      async receiveMessage() {
        return { status: 'unsupported', reason: '工作台的 Codex 接入使用宿主队列，当前回合结束后在同一线程发送' };
      },
      async abort(): Promise<void> {
        const turn = activeTurn;
        if (!turn) return;
        turn.aborted = true;
        try {
          turn.controller.abort();
          const attempt = turn.stop?.();
          if (attempt) {
            await Promise.race([turn.settled, attempt]);
            return;
          }
        } catch (e) {
          log('warn', `codex abort 失败: ${(e as Error).message}`);
          throw e;
        }
        await turn.settled;
      },
      async close(): Promise<void> {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          try {
            await connection.abort();
            if (activeTurn) await activeTurn.settled;
          } finally {
            hostMcp?.close();
            queue.close();
          }
        })();
        return closing;
      }
    };
    return connection;
  }
}
