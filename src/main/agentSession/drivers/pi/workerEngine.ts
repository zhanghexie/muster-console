import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
import {readForkContextSpool} from '../../forkContextSpool';
import {writePiSeedArchive} from '../../piSeedArchive';
/** Pi SDK connection hosted inside the dedicated worker process. */
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { t } from '../../../../shared/i18n';
import type { ModelParameterValues } from '../../../../shared/modelParameters';
import type { GuiDriverConnectInput, GuiRuntimeConnection, GuiDriverStreamEvent, GuiSendImage, GuiCompactResult, GuiSeedMessage } from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { loadPiSdk, type PiModule } from './piSdk';
import { filterPiNativeTools, PI_NATIVE_TOOL_ALL } from './modes';
import { buildPiCustomTools } from './customTools';
import { createPiGuardExtension } from './guardExtension';
import { CORE_CONTEXT_TOOL, createCoreContextExtension } from '../../../agent/coreContext';
import { applyInputTransforms, createPiModeHooksExtension } from './modeHooksExtension';
import { createPiApprovalExtension } from './approvalExtension';
import { createModeExtensionFactory } from '../../../agent/providers/modeExtension';
import { installAttachmentPayload } from '../../../attachments/piExtension';
import { configurePiReasoning } from '../../../agent/piReasoning';
import type { PiShellEnv } from './shellEnv';
import { PiCallMetrics } from './callMetrics';
import { useProviderOutputDefaults } from '../../../agent/piOutputLimit';
import { captureModelRequests } from './modelRequestCapture';
import { traceRequestCompression } from './requestCompression';
import type { GuiEngineCapture, GuiHarnessSummary, GuiToolCatalogItem } from '../../../../shared/guiWorker';
import { hashInjectionText, summarizeToolParams } from '../../../../shared/guiWorker';
import { lastAssistantOutcome, safeCompactSession, safeSetThinkingLevel } from '../../../../shared/piEvents';
import { runAsNonUserTurn, runWithPromptAuthority } from '../../../agent/turnScope';
import { createSkillSourceLoader, workspaceSkillPaths } from '../../../agent/skillSources';
import { interjectHostNotification } from '../../piInterject';
import { appendGuiHostContext, formatGuiHostContext } from '../../prompt';
import { createPiReviewCaptureExtension } from './reviewCaptureExtension';
import type { DesktopCaptureImage } from '../../../desktop/captureImageScope';
import { observeWorkerProviderFailure } from './workerProviderFailure';
import type { WorkerRuntimeFailure } from '../../../tasks/workerRoutingPolicy';

function isValidPiToken(token: string): boolean {
  return token === path.basename(token) && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(token);
}
function resolveResumeTokenSessionFile(token: string, sessionDir: string): string | null {
  if (!isValidPiToken(token)) throw new Error('内置引擎会话标识无效，无法安全恢复');
  try {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // A crash during fork replay may leave an incomplete staging directory.
        // It is never an authoritative conversation and must not be resumed.
        if (entry.isDirectory() && !entry.name.startsWith('.muster-fork-seed-')) walk(full);
        else if (entry.name.endsWith(`_${token}.jsonl`)) hits.push(full);
      }
    };
    walk(sessionDir);
    return hits.sort().at(-1) ?? null;
  } catch (error) { throw new Error(`无法读取内置引擎会话目录：${(error as Error).message}`); }
}

/** Verify identity/history before SDK.open can migrate or repair the file. */
function openVerifiedSession(pi: PiModule, file: string, sessionDir: string, cwd: string, expectedId: string,
  hasPriorConversation: boolean, seeds?: Iterable<GuiSeedMessage>) {
  const stats = fs.statSync(file);
  if (!stats.isFile() || stats.size === 0) throw new Error('内置引擎会话文件为空或不可用，无法安全恢复');
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = '';
  let headerSeen = false;
  let hasConversation = false;
  const seedIterator=seeds?.[Symbol.iterator]();
  let expectedSeed=seedIterator?.next();
  let done = false;
  const inspect = (line: string): void => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('内置引擎会话文件包含无法解析的记录'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内置引擎会话记录无效');
    const entry = value as { type?: unknown; id?: unknown; message?: { role?: unknown; content?: unknown } };
    if (!headerSeen) {
      if (entry.type !== 'session' || entry.id !== expectedId) throw new Error('内置引擎会话标识与历史不一致，无法安全恢复');
      headerSeen = true;
    } else if (entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant')) {
      hasConversation = true;
      if (expectedSeed && !expectedSeed.done) {
        const seed = expectedSeed.value;
        const content = entry.message.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')
          ? content.map(part => part.text).join('') : undefined;
        if (entry.message.role !== seed.role || text !== seed.text) throw new Error('内置引擎已有的 fork 会话与待恢复历史不一致，未重复回放');
        expectedSeed=seedIterator!.next();
      }
    }
    done = headerSeen && (!hasPriorConversation || hasConversation) && (!seedIterator || expectedSeed?.done===true);
  };
  try {
    while (!done) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) { pending += decoder.end(); if (pending) inspect(pending); break; }
      pending += decoder.write(buffer.subarray(0, count));
      let newline: number;
      while (!done && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        inspect(line);
      }
      if (pending.length > 384 * 1024 * 1024) throw new Error('内置引擎会话记录超过恢复读取上限');
    }
  } finally { fs.closeSync(fd);seedIterator?.return?.(); }
  if (!headerSeen || (hasPriorConversation && !hasConversation) || (seedIterator && expectedSeed?.done!==true)) {
    throw new Error('内置引擎会话缺少完整历史，无法安全恢复');
  }
  const manager = pi.SessionManager.open(file, sessionDir, cwd);
  if (manager.getSessionId() !== expectedId || (hasPriorConversation && !manager.getEntries().some(entry =>
    entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')))) {
    throw new Error('内置引擎会话在恢复期间发生变化，无法安全恢复');
  }
  return manager;
}
function toolResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
    const text = (result as { content: Array<{ text?: string }> }).content
      .map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
    if (text) return text;
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}
export interface PiWorkerEngineOptions {
  providerDefaultOutput?: import('../../../agent/piConfigSync').PiSyncResult['providerDefaultOutput'];
  userDataDir: string;
  resolved: { provider: { id: string }; model: { id: string } };
  shellEnv: PiShellEnv;
  memorySnapshot(): { text: string; versionToken: string } | undefined;
  refreshSkills(): Promise<void>;
  verifySkills(): Promise<void>;
  markEvent?(event: GuiDriverStreamEvent): void;
  recordModelCall?(input: { startedAt: number; providerId: string; providerHint: string; ok: boolean; error?: string }): void;
  captureStart?(event: { toolCallId: string; toolName: string; input: Record<string, unknown> }): Promise<void>;
  captureEnd?(event: { toolCallId: string; ok: boolean }): Promise<void>;
  attachDeliveryAgent?(agent: import('@earendil-works/pi-agent-core').Agent, settings: { getImageAutoResize(): boolean }): void;
  toolExtraContent?(name: string, id: string, signal: AbortSignal | undefined, text: string):
    Array<{ type: 'text'; text: string } | DesktopCaptureImage>;
  onToolStart?(event: { toolCallId?: unknown; toolName?: unknown; parentToolCallId?: unknown }): void;
}
export class PiWorkerEngine {
  constructor(private readonly options: PiWorkerEngineOptions) {}
  private get opts() { return this.options; }
  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const pi = await loadPiSdk();
    const log = input.log;

    const agentDir = userDataStorage(this.opts.userDataDir).resolve('app', 'muster-core');
    const sessionDir = userDataStorage(this.opts.userDataDir).resolve('app', 'pi-native-sessions');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    // The parent has resolved and synchronized its trusted model configuration before spawning.
    const resolved = this.options.resolved;
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      allowModelNetwork: false
    });
    useProviderOutputDefaults(modelRuntime, this.options.providerDefaultOutput);
    const registeredModel = modelRuntime.getModel(resolved.provider.id, resolved.model.id);
    if (!registeredModel) {
      throw new Error(
        `Pi 找不到模型 ${resolved.provider.id}/${resolved.model.id}（隔离配置已写入 ${agentDir}），请检查设置里的 Base URL / 模型名`
      );
    }
    const reasoning = input.coreReasoning ? configurePiReasoning(modelRuntime, registeredModel, input.coreReasoning) : undefined;
    const model = reasoning?.model ?? registeredModel;
    const authOk = await modelRuntime.checkAuth(resolved.provider.id);
    if (!authOk) {
      throw new Error(`Pi 模型 ${resolved.provider.id}/${resolved.model.id} 无可用凭证`);
    }

    // ── 资源加载：扩展/模板/主题仍按模式路径开启；技能与调度同一套 extra 目录（可召唤 /skill:） ──
    // shell 环境（bug 三件套 A/B）：inMemory 不读隔离目录 settings.json，这里把
    // 「显式传入 > 隔离目录手工/同步值 > 宿主探测」合并进 inMemory settings；
    // 本机确实无 bash 时用 pi 自带 powershell 原生工具替换 bash，并追加系统提示引导。
    const shellEnv = this.options.shellEnv;
    if (!shellEnv.bashAvailable) {
      log(
        'warn',
        '[pi] 未检测到 Git Bash：bash 工具已替换为 powershell（建议安装 Git for Windows，或在设置 → 通用 → 命令行环境手工指定 bash 路径）'
      );
    }
    const settingsManager = pi.SettingsManager.inMemory(
      shellEnv.settings,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { projectTrusted: true } as any
    );
    if (input.managedWorkerRouting) settingsManager.setRetryEnabled?.(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extensionFactories: Array<(api: any) => void> = [];
    // 模式硬守卫（tool_call 拦截）排最前：守卫拒绝不进审批
    const guardFactory = createPiGuardExtension(input.guards, (msg) => log('warn', msg));
    if (guardFactory) extensionFactories.push(guardFactory);
    // 模式钩子（回合注入 / 记忆注入 / 上下文瘦身）排在守卫之后；截断全文按会话落盘 trim-cache
    // 记忆注入数据源（B5 §12 收敛）：MemoryService.inject（worker 面 bootstrap 画像 +
    // versionToken 刷新 + bootstrap 落账）。B8 退役回落：boot 恒装配（index.ts），
    // 服务未装配属装配事故——无注入源（空注入）+ 错误日志，不再走旧 memoryStore 链。
    const memInjectSource = input.memoryInject ? {
      read: () => this.options.memorySnapshot()?.text ?? '',
      version: () => this.options.memorySnapshot()?.versionToken ?? 'unavailable'
    } : undefined;
    // 逐轮注入变化上报（Harness 透明·逐轮注入追踪）：队列在下方才创建，晚绑定。
    let pushEvent: ((ev: GuiDriverStreamEvent) => void) | null = null;
    const hooksFactory = createPiModeHooksExtension(
      {
        turnInject: input.turnInject,
        turnInjectStable: input.turnInjectStable,
        memoryInject: input.memoryInject,
        contextTrim: input.contextTrim
      },
      {
        cwd: input.cwd,
        trimDir: path.join(userDataStorage(this.opts.userDataDir).resolve('app', 'trim-cache'), input.sessionId),
        memory: memInjectSource,
        onInjectChange: (source: string, text: string) =>
          pushEvent?.({ type: 'injection-update', source, text })
      }
    );
    if (hooksFactory) extensionFactories.push(hooksFactory);
    extensionFactories.push(createCoreContextExtension(() => ({
      ...input.contextCompression,
      enabled: input.contextCompression?.enabled !== false && settingsManager.getCompactionEnabled?.() !== false
    }), input.contextTrim?.maxToolResultChars));
    let getReadableSkills: () => ReturnType<ReturnType<typeof createSkillSourceLoader>['getSkills']>['skills'] = () => [];
    extensionFactories.push(
      createModeExtensionFactory(input.modeController),
      createPiApprovalExtension({
        sessionId: input.sessionId,
        cwd: input.cwd,
        workspaceContext: input.workspaceContext,
        getSkills: () => getReadableSkills(),
        getPolicyState: input.getPolicyState,
        requestApproval: input.requestApproval,
        hostToolIds: input.hostTools.map((t) => t.id),
        hostGatewayHandlesTools: true,
        hostClassOf: (dotName) =>
          input.hostTools.find((t) => t.id === dotName)?.permissionClass,
        log
      })
    );
    // The SDK awaits these hooks inside the worker. The parent must finish its
    // capture before this process can execute the corresponding file tool.
    if (this.options.captureStart && this.options.captureEnd) {
      extensionFactories.push(createPiReviewCaptureExtension({ start: this.options.captureStart, end: this.options.captureEnd },
        message => log('warn', message)));
    }
    // 模式的请求级参数覆盖（temperature / 请求头）：钩 provider 请求链
    if (input.temperature !== undefined || input.providerHeaders) {
      const temperature = input.temperature;
      const headers = input.providerHeaders;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extensionFactories.push(((pi: any) => {
        if (headers) {
          pi.on('before_provider_headers', (event: { headers: Record<string, unknown> }) => {
            for (const [k, v] of Object.entries(headers)) event.headers[k] = v;
          });
        }
        if (temperature !== undefined) {
          pi.on('before_provider_request', (event: { payload: Record<string, unknown> }) => ({
            ...event.payload,
            temperature
          }));
        }
      }) as any);
    }
    if (input.skillsPaths?.length) log('warn', 'Pi 只从全局和项目 .agents/skills 发现技能；模式 skillsPaths 不再扩展来源，请将所需技能链接到 .agents/skills');
    const resourceLoader = createSkillSourceLoader(pi, {
      cwd: input.cwd,
      agentDir,
      settingsManager,
      // 模式可携带自定义扩展/主题（TS 代码以宿主进程权限执行，模式创作者自负）
      noExtensions: !input.extensionPaths?.length,
      additionalExtensionPaths: input.extensionPaths,
      // Host supplies only global/project .agents roots; SDK defaults are disabled.
      noSkills: true,
      additionalSkillPaths: workspaceSkillPaths(input.cwd, input.workspaceContext),
      noPromptTemplates: !input.promptPaths?.length,
      additionalPromptTemplatePaths: input.promptPaths,
      noThemes: !input.themePaths?.length,
      additionalThemePaths: input.themePaths,
      noContextFiles: input.contextFiles === false,
      extensionFactories,
      // 模式可整体替换 Pi 原生基底系统提示。
      ...(input.systemPromptReplace ? { systemPrompt: input.systemPromptReplace } : {}),
      // 模式 persona、扩展领域提示和 Shell 使用说明属于引擎系统层。
      appendSystemPromptOverride: () => [
        shellEnv.promptNote
          ? [input.systemPromptAppend, shellEnv.promptNote].filter(Boolean).join('\n\n')
          : input.systemPromptAppend
      ]
    } as ConstructorParameters<typeof pi.DefaultResourceLoader>[0], input.cwd, agentDir, input.workspaceContext);
    getReadableSkills = () => resourceLoader.getSkills().skills;
    const reloadResources = resourceLoader.reload.bind(resourceLoader);
    resourceLoader.reload = async (options) => {
      await this.options.refreshSkills();
      await reloadResources(options);
      await this.options.verifySkills();
    };
    await resourceLoader.reload({ resolveProjectTrust: async () => true });

    // ── 会话：resume token = Pi session id（不持久化绝对路径，打开时在 sessionDir 解析） ──
    const sessionManager = this.resolveSessionManager(pi, input, sessionDir, model, log);

    const customTools = buildPiCustomTools(
      input.hostTools,
      {
        sessionId: input.sessionId,
        cwd: input.cwd
      },
      input.requestUserQuestion,
      this.options.toolExtraContent
    );
    // 模式可裁剪引擎原生工具：白名单（nativeTools）+ 黑名单（nativeToolsDeny，后应用）。
    // 过滤与政策层目录共用 filterPiNativeTools 单源，保证「注册的工具面 = 目录声明的工具面」
    const nativeSet = new Set(
      filterPiNativeTools(PI_NATIVE_TOOL_ALL, {
        nativeTools: input.nativeTools,
        nativeToolsDeny: input.nativeToolsDeny
      })
    );
    // 无 bash 兑底（bug 三件套 B）：bash 从工具面换成 pi 自带 powershell；
    // 目录/白名单仍按 bash 声明，政策层语义不变（两者都是 shell 执行器）
    const shellExcludeTools =
      !shellEnv.bashAvailable && nativeSet.has('bash')
        ? [...(input.excludeTools ?? []), 'bash']
        : input.excludeTools;
    if (!shellEnv.bashAvailable && nativeSet.has('bash')) {
      nativeSet.delete('bash');
      nativeSet.add('powershell');
    }
    // 可切换模型集：逐条经 modelRuntime 解析（缺失跳过并告警）
    const scopedModels = input.scopedModels?.length
      ? input.scopedModels
          .map((entry) => {
            const m = modelRuntime.getModel(entry.providerId, entry.modelId);
            if (!m) {
              log('warn', `scopedModels 跳过不存在的模型 ${entry.providerId}/${entry.modelId}`);
              return null;
            }
            return { model: m, ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}) };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : undefined;
    // 思考档：会话级热读（getThinkingLevel，切档即时生效）> 模式覆盖 > 缺省
    // （reasoning 模型 medium / 非 reasoning off）；每回合显式重设
    // （续聊可能落盘 thinkingLevel=off，小米思考流会被误关）
    const resolveThinking = (parameters?: ModelParameterValues): import('@earendil-works/pi-ai').ModelThinkingLevel => {
      const requested = parameters !== undefined ? parameters.reasoning : input.modelParameters?.reasoning ?? input.getThinkingLevel?.();
      if (reasoning) return reasoning.setLevel(requested, input.thinkingLevel);
      return (requested as import('@earendil-works/pi-ai').ModelThinkingLevel | null | undefined) ??
        input.thinkingLevel ?? (model.reasoning ? 'medium' : 'off');
    };
    const effThinking = resolveThinking();
    const created = await pi.createAgentSession({
      cwd: input.cwd,
      agentDir,
      model,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader,
      tools: [...nativeSet, ...customTools.map((t) => t.name), CORE_CONTEXT_TOOL],
      excludeTools: shellExcludeTools?.length ? [...shellExcludeTools] : undefined,
      ...(scopedModels ? { scopedModels } : {}),
      customTools,
      thinkingLevel: effThinking
    });
    const session = created.session;
    let providerFailure: WorkerRuntimeFailure | undefined;
    if (input.managedWorkerRouting) observeWorkerProviderFailure(session.agent, failure => { providerFailure = failure; });
    this.options.attachDeliveryAgent?.(session.agent, settingsManager);
    installAttachmentPayload(session, this.opts.userDataDir, `gui:${input.sessionId}`);
    // 忽略失败：部分版本无此方法
    safeSetThinkingLevel(session, effThinking);

    // Harness 透明·引擎真身捕获（§7 落地）：生效系统提示词 + 工具目录，连接期一次。
    // 旁路纪律：SDK 形状差异/异常一律缺省，绝不影响连接。
    const engineCapture: GuiEngineCapture = (() => {
      try {
        const s = session as unknown as {
          systemPrompt?: unknown;
          getAllTools?: () => unknown[] | undefined;
        };
        const promptText = typeof s.systemPrompt === 'string' ? s.systemPrompt : undefined;
        const rawTools =
          typeof s.getAllTools === 'function' ? (s.getAllTools() ?? []) : [];
        const tools: GuiToolCatalogItem[] = [];
        for (const raw of rawTools) {
          const item = raw as {
            name?: unknown;
            label?: unknown;
            description?: unknown;
            source?: unknown;
            parameters?: unknown;
          };
          if (typeof item.name !== 'string' || !item.name) continue;
          const params = summarizeToolParams(item.parameters);
          tools.push({
            name: item.name,
            ...(typeof item.label === 'string' && item.label ? { label: item.label } : {}),
            ...(typeof item.source === 'string' && item.source ? { source: item.source } : {}),
            ...(typeof item.description === 'string' && item.description
              ? { description: item.description }
              : {}),
            ...(params ? { params } : {})
          });
        }
        return {
          ...(promptText
            ? { enginePrompt: { chars: promptText.length, hash: hashInjectionText(promptText), text: promptText } }
            : {}),
          ...(tools.length ? { tools } : {})
        };
      } catch {
        return {};
      }
    })();

    const queue = new AsyncEventQueue<GuiDriverStreamEvent>();
    const push = (event: GuiDriverStreamEvent): void => { this.options.markEvent?.(event); queue.push(event); };
    // 逐轮注入上报的晚绑定出口就位（hooksFactory 闭包在此之前已创建）
    pushEvent = (ev) => push(ev);
    // Harness 透明计量状态机（pi-trajectory-plan v3 §4.3）：原 traceMap 的计时逻辑
    // 迁移为私有状态，随 turn-complete 携带 summary（不产出账本事件——账本已随 B3' 退役）。
    const metrics = new PiCallMetrics();
    /** 工具执行起止（tool_execution_start 打点 → end 算 durationMs；迟到 end 无起点则缺省） */
    const toolStartedAt = new Map<string, number>();
    // pi-ai 观测钩子（旁路）：每次真实 HTTP 响应计数——同 payload 多次响应 = 重试次数。
    // 钩子是公开可变字段（agent-session.d.ts `readonly agent`），旧版本无此字段则跳过。
    // M-1：SDK 在 createAgentSession 里把该字段设为 after_provider_response 扩展事件的
    // 发射器——直接覆盖会静默废掉用户自定义模式的该钩子，必须链式保留原回调。
    // Fix 10（r2 复审）：保留全部参数转发与异步合同（原回调可能返回 Promise）。
    // 无论原值是否存在都安装包装（SDK 原值是函数时链式保留；null 时只计计量）。
    try {
      const agent = (
        session as unknown as {
          agent?: { onResponse?: (...args: unknown[]) => unknown } | null;
        }
      ).agent;
      if (agent && typeof agent === 'object') {
        const prevOnResponse: ((...args: unknown[]) => unknown) | null =
          typeof agent.onResponse === 'function' ? agent.onResponse.bind(agent) : null;
        agent.onResponse = (...args: unknown[]): unknown => {
          const countMetric = (): void => {
            try {
              metrics.onResponse();
            } catch {
              /* 计量旁路故障不影响主链路 */
            }
          };
          if (!prevOnResponse) {
            countMetric();
            return undefined;
          }
          try {
            const result = prevOnResponse(...args);
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              return (result as Promise<unknown>).then(
                () => { countMetric(); },
                () => { countMetric(); }
              );
            }
            countMetric();
            return result;
          } catch {
            countMetric();
            return undefined;
          }
        };
      }
    } catch {
      /* 无钩子（版本差异）：retry 计数缺省 */
    }
    let lastResumeToken: string | null = null;
    const maybeEmitResumeToken = (): void => {
      const token = session.sessionId;
      if (token && token !== lastResumeToken) {
        lastResumeToken = token;
        push({ type: 'resume-token', token });
      }
    };
    maybeEmitResumeToken();

    /** 回合状态：settled 或 prompt 异常时收口，一次回合只收一次 */
    let promptRunActive = false;
    let finalizedThisTurn = true;
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let forkCapture: { identity: import('../../types').GuiForkIdentity; before: string | null; text: string; token: string } | undefined;
    const emitForkPoints = (): void => {
      const capture = forkCapture;
      forkCapture = undefined;
      if (!capture || capture.token !== session.sessionId || lastStopReason === 'aborted') return;
      const branch = sessionManager.getBranch();
      const baseline = capture.before ? branch.findIndex(item => item.id === capture.before) : -1;
      if (capture.before && baseline < 0) return;
      const added = branch.slice(baseline + 1).filter(item => item.type === 'message');
      const users = added.filter(item => {
        if (item.type !== 'message' || item.message.role !== 'user') return false;
        const content = item.message.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
        return text === capture.text;
      });
      const last = added.at(-1);
      if (users.length !== 1 || !last || last.type !== 'message' || last.message.role !== 'assistant' ||
          added.filter(item => item.type === 'message' && item.message.role === 'user').length !== 1) return;
      const points = [
        ...(capture.identity.userMessageId ? [{ messageId: capture.identity.userMessageId, entryId: users[0].id }] : []),
        { messageId: capture.identity.assistantMessageId, entryId: last.id }
      ];
      push({ type: 'native-fork-points', engine: 'pi', sessionToken: capture.token, points });
    };
    const finalizeTurn = (error?: string, failure?: WorkerRuntimeFailure): void => {
      if (finalizedThisTurn) return;
      finalizedThisTurn = true;
      promptRunActive = false;
      // 计量收口（旁路：组装失败不带 summary，不影响收口事件本身）
      let summary: GuiHarnessSummary | undefined;
      try {
        summary = metrics.finalize(Date.now());
      } catch {
        summary = undefined;
      }
      if (error) {
        forkCapture = undefined;
        // 失败回合也带 partial summary：已结算的 token 不随失败丢弃（子代理预算口径
        // 与失败回合的透明计量都靠它）
        push({ type: 'error', message: error, ...(summary ? { summary } : {}),
          ...(failure ? { workerFailure: { ...failure, boundary: 'settled' as const } } : {}) });
        return;
      }
      maybeEmitResumeToken();
      try { emitForkPoints(); }
      catch (error) { log('warn', `原生分叉截点记录失败：${(error as Error).message}`); }
      push({ type: 'turn-complete', ...(summary ? { summary } : {}) });
    };

    const unsubscribe = session.subscribe((event: { type: string } & Record<string, unknown>) => {
      try {
        switch (event.type) {
          case 'message_update': {
            const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
            if (!inner) break;
            if ((inner.type === 'text_delta' || inner.type === 'thinking_delta') && inner.delta) {
              metrics.onChunk(Date.now());
              push({
                type: inner.type === 'text_delta' ? 'text-delta' : 'thinking-delta',
                delta: inner.delta
              });
            } else if (inner.type === 'toolcall_start' || inner.type === 'toolcall_delta') {
              // 纯工具调用响应没有文本增量：toolcall 流首现也作 TTFT 打点（补盲）
              metrics.onChunk(Date.now());
            }
            break;
          }
          case 'tool_execution_start': {
            this.options.onToolStart?.({ toolCallId: event.toolCallId, toolName: event.toolName,
              parentToolCallId: event.parentToolCallId });
            const toolCallId = String(event.toolCallId ?? '');
            toolStartedAt.set(toolCallId, Date.now());
            push({
              type: 'tool-start',
              toolCallId,
              toolName: String(event.toolName ?? 'tool'),
              input: (event.args as Record<string, unknown>) ?? {}
            });
            break;
          }
          case 'turn_start': {
            // SDK turn_start = 一次 LLM 调用开始（工具循环里每调一次模型一发）
            metrics.onTurnStart(Date.now());
            if (promptRunActive && forkCapture?.identity.userMessageId)
              push({ type: 'turn-started', userMessageId: forkCapture.identity.userMessageId });
            break;
          }
          case 'turn_end': {
            const message = event.message as { stopReason?: string; errorMessage?: string } | undefined;
            if (message?.stopReason !== 'aborted') {
              this.options.recordModelCall?.({
                startedAt: Date.now(), providerId: resolved.provider.id,
                providerHint: resolved.model.id, ok: message?.stopReason !== 'error',
                ...(message?.errorMessage ? { error: message.errorMessage } : {})
              });
            }
            // SDK turn_end = 一次 LLM 调用结束（message 自带该次 usage/model/stopReason）
            metrics.onTurnEnd(event.message as Record<string, unknown> | undefined, Date.now());
            break;
          }
          case 'compaction_start': {
            // 压缩生命周期（账本退役后的独立事件源；渲染层压缩分隔线）
            push({ type: 'compaction', phase: 'start' });
            break;
          }
          case 'compaction_end': {
            push({
              type: 'compaction',
              phase: 'end',
              ...(event.aborted === true ? { aborted: true } : {}),
              ...(event.willRetry === true ? { willRetry: true } : {}),
              ...(typeof event.errorMessage === 'string' && event.errorMessage
                ? { errorMessage: event.errorMessage }
                : {})
            });
            break;
          }
          case 'tool_execution_end': {
            // edit 工具的 details 自带 unified patch（渲染层 git-diff 展示）
            const details = (event.result as { details?: { patch?: string } } | undefined)?.details;
            const patch =
              typeof details?.patch === 'string' && details.patch ? details.patch : undefined;
            const toolCallId = String(event.toolCallId ?? '');
            const startedAt = toolStartedAt.get(toolCallId);
            toolStartedAt.delete(toolCallId);
            push({
              type: 'tool-result',
              toolCallId,
              toolName: String(event.toolName ?? 'tool'),
              ok: !event.isError,
              output: toolResultText(event.result),
              ...(patch ? { patch } : {}),
              ...(startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - startedAt) } : {})
            });
            break;
          }
          case 'agent_end': {
            const outcome = lastAssistantOutcome(
              event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }> | undefined
            );
            lastStopReason = outcome.stopReason;
            lastErrorMessage = outcome.errorMessage;
            if (event.willRetry === true) {
              // 自动重试中：本回合未结束，等下一次 settled（失败调用的结算已由 turn_end 落行）
              lastStopReason = undefined;
              lastErrorMessage = undefined;
            }
            break;
          }
          case 'agent_settled': {
            if (!promptRunActive) break;
            if (lastStopReason === 'error') {
              finalizeTurn(lastErrorMessage || t('Pi 模型 {{model}} 返回错误，请检查服务商配置、凭证与余额', { model: `${resolved.provider.id}/${resolved.model.id}` }), providerFailure);
            } else {
              finalizeTurn();
            }
            break;
          }
          default:
            break;
        }
      } catch (e) {
        log('error', `pi 事件处理异常: ${(e as Error).message}`);
      }
    });

    let closed = false;
    const stopRequestCapture = captureModelRequests(modelRuntime, this.opts.userDataDir, input.sessionId,
      message => log('warn', `模型请求记录失败：${message}`), {
        leaf: () => sessionManager.getLeafId(),
        trace: (body, leaf) => traceRequestCompression(body, leaf, sessionManager, sessionDir, pi.buildSessionProjection)
      });
    let firstPromptPrefix = formatGuiHostContext(input.firstPromptPrefix) || undefined;
    const connection: GuiRuntimeConnection = {
      events: queue,
      // Harness 透明：连接期引擎真身（host 记注入代际时合并；其他引擎无此字段）
      ...(Object.keys(engineCapture).length ? { engineCapture } : {}),
      async send(text: string, images?: GuiSendImage[], parameters?: ModelParameterValues, authority?: import('../../types').GuiInputAuthority): Promise<void> {
        if (closed) throw new Error('pi 会话已关闭');
        if (images?.length && !model.input.includes('image')) {
          throw new Error(t('模型 {{name}} 不支持图片输入', { name: model.name || model.id }));
        }
        // 每回合保险：显式重设思考档（会话级热读 > 模式覆盖；缺省 reasoning=medium，避免误关小米思考流）
        safeSetThinkingLevel(session, resolveThinking(parameters));
        finalizedThisTurn = false;
        promptRunActive = true;
        lastStopReason = undefined;
        lastErrorMessage = undefined;
        providerFailure = undefined;
        metrics.onSend(Date.now());
        // 模式输入变换：发送前按序应用（Host 侧，保证 SDK prompt 路径确定性生效）；
        // 超规模门槛跳过并告警（pi-modes F-02：防贪婪回溯 pattern 阻塞发送路径）
        const transformedText = applyInputTransforms(text, input.inputTransforms, (reason) =>
          log('warn', reason)
        );
        // Pi dispatches native slash commands and prompt templates from the first token.
        const prefix = /^\/[\w:-]+(?:\s|$)/.test(transformedText) ? undefined : firstPromptPrefix;
        const engineText = appendGuiHostContext(transformedText, prefix);
        const beforePrompt = sessionManager.getLeafId();
        if (prefix) firstPromptPrefix = undefined;
        forkCapture = authority?.forkIdentity
          ? { identity: authority.forkIdentity, before: beforePrompt, text: engineText, token: session.sessionId }
          : undefined;
        // 回合作用域（B3 记忆写路径）：GUI 会话用用户**原始**输入（变换前）作明示记住
        // 判定证据沿调用链传播；后台子代理连接（nonUserTurns）任务提示词非用户证据，
        // 走非用户回合（remember 保守拒绝，污点跟踪保留——MAJOR-1）；回合内网络工具
        // 污点由 executor 打点（§5）
        const runPrompt = (): Promise<void> => {
          const identity = authority?.forkIdentity;
          if (identity?.userMessageId) push({ type: 'engine-input', identity, text: engineText });
          return session
            .prompt(engineText, {
              ...(authority?.literalText ? { expandPromptTemplates: false } : {}),
              ...(images?.length
                ? {
                    images: images.map((img) => ({
                      type: 'image' as const,
                      data: img.data,
                      mimeType: img.mimeType
                    }))
                  }
                : {})
            })
            .then(
              () => {
                /* 完成统一由 agent_settled 收口 */
              },
              (err: unknown) => {
                // prompt 直接拒绝（如模型/凭证校验失败）且 settled 未到 → 立即收口
                if (prefix && sessionManager.getLeafId() === beforePrompt) firstPromptPrefix = prefix;
                finalizeTurn((err as Error)?.message ?? 'Pi 回合启动失败');
              }
            );
        };
        void (input.nonUserTurns ? runAsNonUserTurn(runPrompt) : runWithPromptAuthority(authority?.userText, runPrompt));
      },
      async nativeFork(point) {
        if (closed || promptRunActive || session.isStreaming) throw new Error('内置引擎忙碌或已关闭，无法分叉');
        if (point.engine !== 'pi') return { status: 'unsupported' as const };
        if (point.sessionToken !== session.sessionId) throw new Error('内置引擎恢复后的会话标识已变化，无法安全分叉');
        const sourceFile = sessionManager.getSessionFile();
        const sourceHeader = sessionManager.getHeader();
        if (!sourceFile || !sourceHeader || !fs.existsSync(sourceFile)) throw new Error('找不到原生会话文件，无法安全分叉');
        const branch = sessionManager.getBranch();
        const target = branch.find(item => item.id === point.entryId);
        if (!target || target.type !== 'message' || target.message.role !== point.role)
          throw new Error('原生分叉截点已不在当前会话分支中');
        const copy = pi.SessionManager.inMemory(input.cwd, {}, [sourceHeader, ...sessionManager.getEntries()]);
        copy.createBranchedSession(point.entryId);
        const header = copy.getHeader();
        if (!header || !isValidPiToken(header.id) || header.id === point.sessionToken) throw new Error('内置引擎返回的分叉会话标识无效');
        const file = path.join(sessionDir, `${header.timestamp.replace(/[:.]/g, '-')}_${header.id}.jsonl`);
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, [JSON.stringify({ ...header, parentSession: sourceFile }), ...copy.getEntries().map(item => JSON.stringify(item))].join('\n') + '\n');
        } catch (error) {
          try { fs.closeSync(fd); } finally { fs.unlinkSync(file); }
          throw error;
        }
        fs.closeSync(fd);
        return { status: 'forked' as const, token: header.id, preservesPointIds: true };
      },
      async receiveMessage(message) {
        if (closed || !session.isStreaming)
          return { status: 'unsupported', reason: '当前没有可插话的 Pi 回合' };
        if (message.idleOnly) return { status: 'deferred', reason: '等待当前回合结束后重新确认消息' };
        if (!message.hostNotification) {
          if (message.intent !== 'interrupt' || typeof session.steer !== 'function') {
            return { status: 'unsupported', reason: '当前 Pi 会话没有原生插话通道' };
          }
          // Pi's SDK steer() is the same turn-scoped path used by the native
          // TUI: it queues the user input after the current tool call and
          // before the next model call. Treat extension-handled input as
          // unsupported so the renderer can choose its explicit fallback;
          // only a queued disposition proves that Pi accepted the text.
          const disposition = await session.steer(message.text);
          if (disposition === 'handled') {
            return { status: 'unsupported', reason: 'Pi 扩展已接管该插话，未交给模型' };
          }
          return { status: 'accepted', method: 'steered' };
        }
        const inserted = await interjectHostNotification(session, {
          prepare: () => ({ ids: [message.messageId], summary: '续接等待已触发', content: message.text }),
          accepted: () => {}
        }, () => !closed && promptRunActive, () => {});
        return inserted ? { status: 'accepted', method: 'steered' } : { status: 'unsupported', reason: 'Pi 当前回合不可插话' };
      },
      redirect(): boolean { return false; },
      async abort(): Promise<void> {
        // The parent must be able to distinguish a confirmed SDK stop from a
        // failed one before it decides how to retire the worker process.
        await session.abort();
      },
      async compact(instructions?: string): Promise<GuiCompactResult> {
        // compaction_start/end 事件经订阅统一映射成轨迹账本的 compaction 行，
        // 这里只归一结果。忙时到不了这里（Host 拒绝）；引擎自身还会再 abort 一道兜底。
        const r = await safeCompactSession(session, instructions);
        return r.ok
          ? {
              ok: true,
              ...(r.summary !== undefined ? { summary: r.summary } : {}),
              tokensBefore: r.tokensBefore,
              estimatedTokensAfter: r.estimatedTokensAfter
            }
          : { ok: false, error: r.error };
      },
      getContextUsage(): { tokens: number | null; contextWindow: number } | null {
        try {
          const usage = session.getContextUsage();
          if (!usage) return null;
          return {
            // compaction 后 tokens 可为 null（未知）；contextWindow 必有
            tokens: typeof usage.tokens === 'number' ? usage.tokens : null,
            contextWindow: usage.contextWindow
          };
        } catch {
          return null;
        }
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        let failure: unknown;
        try {
          unsubscribe();
        } catch (error) { failure = error; }
        try {
          await session.abort();
        } catch (error) { failure ??= error; }
        try {
          session.dispose();
        } catch (error) { failure ??= error; }
        queue.close();
        stopRequestCapture();
        // Closing a connection is not a completed model turn; report SDK
        // cleanup failures to the supervisor instead of inventing a terminal.
        if (failure) throw failure;
      }
    };
    return connection;
  }

  private resolveSessionManager(
    pi: PiModule,
    input: GuiDriverConnectInput,
    sessionDir: string,
    model: { id: string; name?: string; api: string; provider: string },
    log: GuiDriverConnectInput['log']
  ) {
    if (!input.resumeToken && input.hasPriorConversation && !input.seedSource?.descriptor.count && !input.forkTranscriptPending) {
      const oldFile = resolveResumeTokenSessionFile(input.sessionId, sessionDir);
      if (oldFile) return openVerifiedSession(pi, oldFile, sessionDir, input.cwd, input.sessionId, true);
      throw new Error('原有会话缺少内置引擎上下文，无法恢复；工作台可见历史仍保留，请新建会话继续');
    }
    if (!input.resumeToken) {
      // fork 首连：把先前对话作为真实消息历史回放（工具调用不进种子，正文保真）
      if (input.seedSource?.descriptor.count) {
        // The seed may already have been atomically published before a crash
        // prevented the host from clearing its durable pending-fork record.
        const published = resolveResumeTokenSessionFile(input.sessionId, sessionDir);
        if (published) {
          const existing = openVerifiedSession(pi, published, sessionDir, input.cwd, input.sessionId, true, readForkContextSpool(input.seedSource.directory,input.sessionId,input.seedSource.descriptor));
          log('info', 'pi fork 种子已完整发布，恢复已有原生会话');
          return existing;
        }
        // Stage a whole replay before publishing it. A partial write must never
        // be mistaken for the session's original history after an app restart.
        const root = path.resolve(sessionDir);
        const staging = fs.mkdtempSync(path.join(root, '.muster-fork-seed-'));
        const rel = path.relative(root, staging);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('内置引擎 fork 暂存目录无效');
        try {
          const archive=writePiSeedArchive(pi,{sessionId:input.sessionId,cwd:input.cwd,directory:staging,
            seeds:readForkContextSpool(input.seedSource.directory,input.sessionId,input.seedSource.descriptor),
            model:{api:model.api,provider:model.provider,id:model.id}});
          const stagedFile=archive.file;
          if (!stagedFile || !fs.existsSync(stagedFile) || path.dirname(path.resolve(stagedFile)) !== staging) throw new Error('fork 种子文件未完整生成');
          const publishedFile = path.join(root, path.basename(stagedFile));
          if (fs.existsSync(publishedFile)) throw new Error('fork 目标会话文件已存在');
          fs.linkSync(stagedFile,publishedFile);fs.unlinkSync(stagedFile);
          log('info', `pi fork 种子回放 ${input.seedSource.descriptor.count} 条消息`);
          return openVerifiedSession(pi, publishedFile, sessionDir, input.cwd, input.sessionId, true, readForkContextSpool(input.seedSource.directory,input.sessionId,input.seedSource.descriptor));
        } catch (e) {
          throw new Error(`内置引擎 fork 种子回放失败，未继续空会话：${(e as Error).message}`);
        } finally {
          try { fs.rmSync(staging, { recursive: true, force: true }); }
          catch (e) { throw new Error(`内置引擎 fork 暂存目录清理失败：${(e as Error).message}`); }
        }
      }
      return pi.SessionManager.create(input.cwd, sessionDir, { id: input.sessionId });
    }
    const file = resolveResumeTokenSessionFile(input.resumeToken, sessionDir);
    if (file) {
      return openVerifiedSession(pi, file, sessionDir, input.cwd, input.resumeToken, !!input.hasPriorConversation);
    }
    if (input.hasPriorConversation) {
      throw new Error('找不到内置引擎的原生会话文件，无法恢复原有上下文；工作台可见历史仍保留，请新建会话继续');
    }
    // Pi 懒落盘：首条 assistant 消息前不写文件，token 找不到文件时降级同 id 新建（勿 brick）
    log('warn', `pi resume token 无对应会话文件，同 id 新建：${input.resumeToken}`);
    return pi.SessionManager.create(input.cwd, sessionDir, { id: input.sessionId });
  }
}
