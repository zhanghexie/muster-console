import { appendGuiHostContext, firstGuiUserMessageContext } from '../../prompt';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ConnectionCleanupError } from '../../host/retirement';
import { GuiDeliveryError } from '../../types';
import type { GuiDriverConnectInput, GuiDriverStreamEvent, GuiForkIdentity, GuiRuntimeConnection, GuiRuntimeDriver, GuiRuntimeProbeResult, GuiSendImage } from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { startHostToolGateway } from '../acp/hostToolGateway';
import { hostToolsToCatalog } from '../acp/mcpServers';
import { boundedAcpRequest } from '../acp/models';
import { nativeOptionAccepts } from '../../../../shared/nativeSessionConfig';
import { automaticPermissions } from '../nativePermissionPolicy';
import { externalPiNativeConfig } from './nativeConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import { EXTERNAL_PI_BRIDGE_SOURCE } from './bridge';
import { ExternalPiRpc } from './rpc';
import { externalPiLaunchArgs, externalPiLaunchEnvironment, resolveExternalPiExecutable, type ExternalPiId } from './executable';
import { listExternalPiModels, selectExternalPiModel } from './models';
import { parseExternalPiModelKey } from '../../../../shared/externalPiModel';
import { normalizeContextUsage } from '../../../../shared/guiContextUsage';
import { forkExternalPi } from './nativeFork';
import { forkOmp } from './ompFork';
import { ExternalPiReviewEvents } from './reviewEvents';

type Frame = Record<string, unknown>;
const record = (value: unknown): Frame => value && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

function contentText(value: unknown): string {
  const content = record(value).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => text(record(item).text)).filter(Boolean).join('\n');
  return typeof value === 'string' ? value : '';
}

/** Preserve exactly the text-block order used by the engine's final message. */
function assistantText(value: unknown): string | null {
  const content = record(value).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let result = '';
  for (const part of content) {
    const item = record(part);
    if (item.type !== 'text') continue;
    if (typeof item.text !== 'string') return null;
    result += item.text;
  }
  return result;
}

/** A separate user-installed Pi/OMP process; it never rewrites their settings. */
export class ExternalPiRuntimeDriver implements GuiRuntimeDriver {
  readonly supportsImages = true;
  readonly supportsSeed = false;
  readonly modeSwitchReconnects = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'unsupported' as const;

  constructor(readonly runtimeId: ExternalPiId, private readonly options: { getExecutable?: () => string | undefined } = {}) {}

  private configuredExecutable(): string | undefined {
    const value: unknown = this.options.getExecutable?.();
    if (value == null) return undefined;
    if (typeof value !== 'string') throw new Error('外部 Pi 的手动路径配置无效');
    return value.trim() || undefined;
  }

  get connectionVersion(): string { return this.configuredExecutable() ?? ''; }

  nativeConfigVersion(): string {
    return nativeExecutableVersion(resolveExternalPiExecutable(this.runtimeId, this.configuredExecutable()), `${this.runtimeId}-rpc`);
  }

  async validateModelOverride(input: { cwd: string; model: NonNullable<GuiDriverConnectInput['modelOverride']> }): Promise<void> {
    const modelId = input.model.modelId?.trim() ?? '';
    if (!modelId) return;
    if (input.model.providerId !== this.runtimeId) throw new Error('外部 Pi 模型必须来自所选引擎');
    const catalog = await listExternalPiModels({ cwd: input.cwd, runtimeId: this.runtimeId, executableOverride: this.configuredExecutable() });
    if (!catalog.ok) throw new Error(`无法读取外部 Pi 模型目录：${catalog.error}`);
    selectExternalPiModel(catalog.items, modelId);
  }

  async probe(): Promise<GuiRuntimeProbeResult> {
    const preferred = this.configuredExecutable();
    const executable = resolveExternalPiExecutable(this.runtimeId, preferred);
    if (executable) {
      try {
        // Connect passes a bridge in the system temporary directory. Check the
        // same cmd wrapper restrictions without starting the executable.
        externalPiLaunchArgs(executable, ['--mode', 'rpc', ...(this.runtimeId === 'pi-external' ? ['--no-extensions'] : []),
          '--extension', path.join(os.tmpdir(), 'muster-external-pi-check', 'bridge.mjs')]);
        return { status: 'available', problems: [], executable };
      } catch (error) {
        const message = error instanceof Error ? error.message : '外部 Pi 启动配置无效';
        return { status: 'not_configured', executable, problems: [{ code: 'config_missing',
          message,
          fix: message.includes('%') ? '请使用不含 % 的可执行文件和临时目录，然后重新检测' : '请安装所需运行时或修正 PATH，然后重新检测' }] };
      }
    }
    const name = this.runtimeId === 'omp' ? 'Oh My Pi' : 'Pi';
    return { status: 'not_installed', problems: [{ code: 'cli_missing', message: preferred ? `指定的 ${name} 可执行文件不存在或不可用` : `找不到用户安装的 ${name} 可执行文件`,
      fix: preferred ? '请修正或清除手动路径后重新检测' : `请安装并配置 ${name}，然后重新检测`, fixHint: this.runtimeId === 'omp' ? 'https://github.com/can1357/oh-my-pi' : 'https://github.com/earendil-works/pi' }] };
  }

  async describeNativeConfig() { return externalPiNativeConfig(this.runtimeId); }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const nativeConfig = externalPiNativeConfig(this.runtimeId);
    const approval = this.runtimeId === 'omp' && automaticPermissions(input)
      ? { id: 'tools.approvalMode', value: 'yolo' } : input.nativeConfig?.selections[0];
    if (approval && ((input.nativeConfig && input.nativeConfig.selections.length !== 1) || approval.id !== nativeConfig.options[0]?.id ||
        !nativeOptionAccepts(nativeConfig.options[0], approval.value))) throw new Error('Invalid Oh My Pi approval mode.');
    const resume = input.resumeToken?.trim() ?? '';
    if (input.hasPriorConversation && !resume && !input.forkTranscriptPending) {
      throw new Error('外部 Pi 历史缺少原生会话标识，无法安全恢复；请保留历史并新建会话');
    }
    const preferred = this.configuredExecutable();
    const executable = resolveExternalPiExecutable(this.runtimeId, preferred);
    if (!executable) throw new Error(preferred ? '指定的外部 Pi 可执行路径无效；请修正或清除设置' : `找不到用户安装的 ${this.runtimeId === 'omp' ? 'Oh My Pi' : 'Pi'}`);
    if (resume && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(resume)) throw new Error('外部 Pi 会话标识无效，无法安全恢复');
    const catalog = hostToolsToCatalog(input.hostTools, { includeAskQuestion: !!input.requestUserQuestion });
    const ids = new Set<string>();
    for (const item of catalog.tools) {
      if (ids.has(item.name)) throw new Error(`宿主工具名称冲突：${item.name}`);
      ids.add(item.name);
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-external-pi-'));
    const extensionPath = path.join(temp, 'bridge.mjs');
    const bridgeConfigPath = path.join(temp, 'bridge-config.json');
    let gateway: Awaited<ReturnType<typeof startHostToolGateway>> | undefined;
    let rpc: ExternalPiRpc | undefined;
    let closed = false;
    let active = false;
    let stopping = false;
    let turn = 0;
    let bridgeActive = false;
    let lastError = '';
    let lastAssistantStopReason = '';
    let promptId = '';
    let submitted = false;
    let contextUsage: import('../../types').GuiContextUsage | null = null;
    let usageWarningLogged = false;
    let terminalFailure: GuiDeliveryError | undefined;
    let ompPromptSettledSeen = false;
    let cleanupPromise: Promise<void> | undefined;
    let cleanupStarted = false;
    let nativeSessionId = '';
    let forkTurn: { identity: GuiForkIdentity; hash: string } | undefined;
    let forkPoints: { userEntryId: string; assistantEntryId: string } | undefined;
    let ompTextError = '';
    let ompTextUnverified = false;
    const ompTextStreams = new Map<string, { hash: ReturnType<typeof createHash>; length: number }>();
    const reviewEvents = new ExternalPiReviewEvents(message => input.log('warn', message));
    let bridgeReady!: () => void;
    const ready = new Promise<void>(resolve => { bridgeReady = resolve; });
    let protocolReady!: (frame: Frame) => void;
    const protocol = new Promise<Frame>(resolve => { protocolReady = resolve; });
    const queue = new AsyncEventQueue<GuiDriverStreamEvent>();

    const finish = (error?: string): void => {
      if (!active) return;
      if (this.runtimeId === 'omp' && ompTextStreams.size) ompTextUnverified = true;
      const resultError = ompTextError || error;
      if (!resultError && !stopping && forkTurn && forkPoints && nativeSessionId && !ompTextUnverified) {
        const points = [
          ...(forkTurn.identity.userMessageId ? [{ messageId: forkTurn.identity.userMessageId, entryId: forkPoints.userEntryId }] : []),
          { messageId: forkTurn.identity.assistantMessageId, entryId: forkPoints.assistantEntryId }
        ];
        queue.push({ type: 'native-fork-points', engine: this.runtimeId === 'omp' ? 'omp' : 'pi-external', sessionToken: nativeSessionId, points });
      }
      forkTurn = undefined;
      forkPoints = undefined;
      reviewEvents.clear();
      active = false;
      turn += 1;
      if (ompTextUnverified && !resultError) input.log('warn', 'Oh My Pi 未提供可逐条校验的最终正文，本回合不记录原生分叉截点');
      queue.push(resultError ? { type: 'error', message: resultError } : { type: 'turn-complete' });
      // Stats are optional and must never delay turn completion or overwrite a
      // newer turn. This queries the running session, not model discovery.
      const epoch = turn;
      void rpc?.request('get_session_stats', {}, 5000).then(response => {
        if (closed || active || turn !== epoch) return;
        const raw = record(record(response.data).contextUsage);
        const usage = normalizeContextUsage(raw.tokens, raw.contextWindow);
        if (!usage) return;
        contextUsage = usage;
        queue.push({ type: 'context-usage', usage });
      }).catch(cause => {
        if (!closed && !usageWarningLogged) {
          usageWarningLogged = true;
          input.log('warn', `外部 Pi 未提供上下文统计：${rpc?.sanitize((cause as Error).message) || '未知错误'}`);
        }
      });
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      if (!cleanupStarted) { closed = true; turn += 1; }
      const attempt = (async () => {
        if (!cleanupStarted) { gateway?.close(); cleanupStarted = true; }
        try { await rpc?.close(); }
        finally {
          if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('muster-external-pi-')) fs.rmSync(temp, { recursive: true, force: true });
        }
      })();
      cleanupPromise = attempt;
      void attempt.catch(() => { if (cleanupPromise === attempt) cleanupPromise = undefined; });
      return attempt;
    };
    const failConnection = (message: string): GuiDeliveryError => {
      const failure = terminalFailure ?? new GuiDeliveryError(rpc?.sanitize(message) || message,
        active && submitted ? 'unknown' : 'not-submitted');
      if (closed) return failure;
      terminalFailure = failure;
      const pending = cleanup();
      queue.fail(failure);
      void pending.catch(error => input.log('error', `外部 Pi 进程回收失败：${rpc?.sanitize((error as Error).message) || '未知错误'}`));
      return failure;
    };
    const reply = (id: string, fields: Frame): void => {
      if (!closed) rpc?.send({ type: 'extension_ui_response', id, ...fields });
    };
    const handleUi = async (frame: Frame): Promise<void> => {
      const method = text(frame.method), id = text(frame.id);
      if (method === 'setStatus') {
        if (frame.statusKey === 'muster-external-bridge' && frame.statusText === 'ready') bridgeReady();
        if (frame.statusKey === 'muster-turn-bridge' && frame.statusText === 'ready') bridgeActive = true;
        if (frame.statusKey === 'muster-fork-points' && active && !closed && forkTurn && text(frame.statusText).length < 4096) {
          try {
            const candidate = record(JSON.parse(text(frame.statusText)));
            if (candidate.sessionId === nativeSessionId && candidate.hash === forkTurn.hash) {
              forkPoints = text(candidate.userEntryId) && text(candidate.assistantEntryId)
                ? { userEntryId: text(candidate.userEntryId), assistantEntryId: text(candidate.assistantEntryId) } : undefined;
            }
          } catch { input.log('warn', '外部 Pi 原生分叉截点格式无效，本回合使用原有回退方式'); }
        }
        return;
      }
      if (!id) return;
      const epoch = turn;
      const hostTurnId = input.getTurnId?.();
      if (!active || closed || stopping || !hostTurnId) { reply(id, { cancelled: true }); return; }
      if (method === 'confirm') {
        const decision = await input.requestApproval({ toolCallId: `external-pi-ui-${id}`, toolName: text(frame.title) || 'Confirm',
          input: {}, reason: text(frame.message), nativeSource: this.runtimeId === 'omp' ? 'Oh My Pi' : 'Pi',
          nativeChoices: [{ id: 'true', name: 'Confirm', kind: 'allow_once' }, { id: 'false', name: 'Cancel', kind: 'reject_once' }] });
        reply(id, !closed && active && !stopping && turn === epoch && input.getTurnId?.() === hostTurnId && decision.nativeChoiceId
          ? { confirmed: decision.nativeChoiceId === 'true' } : { cancelled: true });
        return;
      }
      if ((method === 'select' || method === 'input' || method === 'editor') && input.requestUserQuestion) {
        const choices = Array.isArray(frame.options) ? frame.options.filter((value): value is string => typeof value === 'string').slice(0, 50) : [];
        const result = await input.requestUserQuestion({ questions: [{ id: 'external-pi-question', question: text(frame.title) || '请选择',
          ...(text(frame.placeholder) || text(frame.prefill) ? { detail: text(frame.placeholder) || text(frame.prefill) } : {}),
          ...(choices.length ? { options: choices.map(label => ({ label })) } : {}) }] });
        const answer = result.kind === 'answered' ? result.answers[0] : undefined;
        const value = method === 'select'
          ? choices.find(choice => answer?.selected.length === 1 && answer.selected[0] === choice)
          : answer?.custom || answer?.selected?.[0];
        reply(id, !closed && active && !stopping && turn === epoch && input.getTurnId?.() === hostTurnId && value ? { value } : { cancelled: true });
        return;
      }
      reply(id, { cancelled: true });
    };
    const handleFrame = (frame: Frame): void => {
      if (closed) return;
      const kind = text(frame.type);
      if (kind === 'ready') { protocolReady(frame); return; }
      if (kind === 'extension_ui_request') {
        void handleUi(frame).catch(error => { input.log('warn', `外部 Pi 交互失败：${rpc?.sanitize((error as Error).message) || '未知错误'}`); const id = text(frame.id); if (id) reply(id, { cancelled: true }); });
        return;
      }
      if (kind === 'extension_error' && text(frame.extensionPath).includes('muster-external-pi-')) {
        failConnection('外部 Pi 宿主扩展加载失败');
        return;
      }
      if (!active) return;
      if (kind === 'message_start' && this.runtimeId === 'omp' && record(frame.message).role === 'assistant') {
        const id = text(frame.messageId);
        if (!id || ompTextStreams.has(id) || ompTextStreams.size >= 1024) ompTextUnverified = true;
        else ompTextStreams.set(id, { hash: createHash('sha256'), length: 0 });
      } else if (kind === 'message_update') {
        if (!bridgeActive) { failConnection('外部 Pi 未确认本轮宿主桥接，正在回收连接'); return; }
        const update = record(frame.assistantMessageEvent);
        const delta = text(update.delta);
        if (delta && update.type === 'text_delta') {
          if (this.runtimeId === 'omp') {
            const stream = ompTextStreams.get(text(frame.messageId));
            if (stream) { stream.hash.update(delta, 'utf16le'); stream.length += delta.length; }
            else ompTextUnverified = true;
          }
          queue.push({ type: 'text-delta', delta });
        }
        if (delta && update.type === 'thinking_delta') queue.push({ type: 'thinking-delta', delta });
      } else if (kind === 'message_end') {
        const message = record(frame.message);
        if (message.role === 'assistant') lastAssistantStopReason = text(message.stopReason);
        if (this.runtimeId === 'omp' && message.role === 'assistant') {
          const id = text(frame.messageId), stream = ompTextStreams.get(id), final = assistantText(message);
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            if (id) ompTextStreams.delete(id);
            ompTextUnverified = true;
          } else if (!id || !stream || final === null) ompTextUnverified = true;
          else {
            ompTextStreams.delete(id);
            const prefixHash = createHash('sha256').update(final.slice(0, stream.length), 'utf16le').digest('hex');
            if (final.length < stream.length || prefixHash !== stream.hash.digest('hex'))
              ompTextError = 'Oh My Pi 的最终正文与已显示的流式内容不一致；请检查引擎原始会话，本回合不会记录原生分叉截点';
            else if (final.length > stream.length) queue.push({ type: 'text-delta', delta: final.slice(stream.length) });
          }
        }
        if (message.role === 'assistant' && message.stopReason === 'error') lastError = rpc?.sanitize(text(message.errorMessage)) || '外部 Pi 模型调用失败';
        else if (message.role === 'assistant' && message.stopReason !== 'aborted') lastError = '';
      } else if (kind === 'tool_execution_start') {
        const id = text(frame.toolCallId), name = text(frame.toolName), args = record(frame.args);
        reviewEvents.start(id, name, args);
        queue.push({ type: 'tool-start', toolCallId: id, toolName: name, input: args });
      } else if (kind === 'tool_execution_end') {
        const id = text(frame.toolCallId), reviewChanges = reviewEvents.finish(id, frame.result);
        queue.push({ type: 'tool-result', toolCallId: id, toolName: text(frame.toolName), ok: frame.isError !== true, output: contentText(frame.result),
          ...(reviewChanges ? { reviewChanges } : {}) });
      } else if (kind === 'auto_retry_end') {
        if (frame.success === true) lastError = '';
        else if (text(frame.finalError)) lastError = rpc?.sanitize(text(frame.finalError)) || '外部 Pi 模型调用失败';
      } else if (kind === 'agent_settled' && this.runtimeId === 'pi-external') {
        // Older Pi versions emit agent_settled without an aborted field. Do
        // not let auto_retry_end(success) erase an observed aborted message.
        const aborted = frame.aborted === true || stopping || lastAssistantStopReason === 'aborted';
        const knownStop = ['stop', 'length', 'error', 'aborted'].includes(lastAssistantStopReason);
        const terminalError = aborted ? '外部 Pi 回合已中止'
          : lastAssistantStopReason === 'error' ? lastError || '外部 Pi 模型调用失败'
            : !knownStop ? '外部 Pi 未确认回合终态，请检查引擎版本' : '';
        if (!lastError && !terminalError && !bridgeActive) failConnection('外部 Pi 未确认本轮宿主桥接，正在回收连接');
        else finish(lastError || terminalError || undefined);
      }
      else if (kind === 'prompt_result' && frame.id === promptId) {
        ompPromptSettledSeen = true;
        if (frame.agentInvoked === false) { failConnection('外部 Pi 扩展接管了输入，无法确认原文已送达引擎'); return; }
        if (frame.status === 'error' || frame.success === false) lastError = rpc?.sanitize(text(record(frame.error).message) || text(frame.error)) || '外部 Pi 回合失败';
        if (frame.status === 'aborted') lastError = '外部 Pi 回合已中止';
        if (!lastError && !bridgeActive) { failConnection('外部 Pi 未确认本轮宿主桥接，正在回收连接'); return; }
        if (frame.sessionSettled === true) finish(lastError || undefined);
      } else if (kind === 'session_settled' && this.runtimeId === 'omp' && ompPromptSettledSeen) finish(lastError || undefined);
    };

    try {
      fs.writeFileSync(extensionPath, EXTERNAL_PI_BRIDGE_SOURCE, { encoding: 'utf8', mode: 0o600 });
      if (!input.getTurnId) throw new Error('外部 Pi 缺少宿主回合身份，无法安全接入工具');
      gateway = await startHostToolGateway({ ...input,
        getTurnId: () => active && !closed && !stopping && bridgeActive ? input.getTurnId?.() : undefined });
      fs.writeFileSync(bridgeConfigPath, JSON.stringify({ url: gateway.url, token: gateway.token, tools: catalog.tools,
        captureForkPoints: this.runtimeId === 'omp' ? 'omp' : 'pi' }), { encoding: 'utf8', mode: 0o600 });
      // Keep the host bridge explicit while disabling Pi's discovered/configured extensions.
      const args = ['--mode', 'rpc', ...(this.runtimeId === 'pi-external' ? ['--no-extensions'] : []), '--extension', extensionPath];
      if (approval) args.push('--approval-mode', String(approval.value));
      if (resume) args.push(this.runtimeId === 'omp' ? '--resume' : '--session-id', resume);
      const launch = externalPiLaunchArgs(executable, args);
      rpc = new ExternalPiRpc({ ...launch, cwd: input.cwd,
        env: { ...externalPiLaunchEnvironment(executable),
          ...(this.runtimeId === 'pi-external' ? { PI_OFFLINE: '1' } : {}),
          MUSTER_EXTERNAL_PI_BRIDGE: bridgeConfigPath },
        onFrame: handleFrame, onFailure: error => failConnection(error.message),
        log: message => input.log('warn', `外部 Pi: ${message}`), secrets: [gateway.token] });
      await boundedAcpRequest(rpc.waitReady(), 30_000, '外部 Pi 进程启动');
      if (this.runtimeId === 'omp') {
        const greeting = await boundedAcpRequest(protocol, 30_000, 'Oh My Pi 启动');
        if (Array.isArray(greeting.supportedProtocolVersions) && greeting.supportedProtocolVersions.includes(2)) {
          await rpc.request('negotiate_protocol', { protocolVersion: 2 });
        }
      }
      const [state] = await Promise.all([
        rpc.request('get_state'),
        boundedAcpRequest(ready, 30_000, '外部 Pi 宿主桥接')
      ]);
      const stateData = record(state.data), sessionId = text(stateData.sessionId);
      if (!sessionId) throw new Error('外部 Pi 未返回原生会话标识');
      nativeSessionId = sessionId;
      if (resume) {
        if (sessionId !== resume) throw new Error('外部 Pi 恢复后的会话标识不一致');
        const history = record((await rpc.request('get_messages')).data).messages;
        if (!Array.isArray(history) || (input.hasPriorConversation && !input.forkTranscriptPending && history.length === 0)) throw new Error('外部 Pi 未恢复历史；请保留工作台记录并新建会话');
      }
      const requested = input.modelOverride?.modelId?.trim() ?? '';
      if (requested) {
        let choice = parseExternalPiModelKey(requested);
        if (!choice) {
          const catalog = await listExternalPiModels({ cwd: input.modelCatalogCwd ?? input.cwd, runtimeId: this.runtimeId, executableOverride: this.configuredExecutable() });
          if (!catalog.ok) throw new Error('旧模型标识需要先手动刷新模型目录');
          choice = selectExternalPiModel(catalog.items, requested);
        }
        const provider = choice.providerId, modelId = choice.modelId;
        await rpc.request('set_model', { provider, modelId });
        const actual = record(record((await rpc.request('get_state')).data).model);
        if (actual.provider !== provider || actual.id !== modelId) throw new Error('外部 Pi 未确认所选模型');
      }
      queue.push({ type: 'resume-token', token: sessionId });
      const connection = rpc;
      const sourceFile = text(stateData.sessionFile);
      const isPi = this.runtimeId === 'pi-external';
      const isOmp = this.runtimeId === 'omp';
      let firstPromptPrefix = firstGuiUserMessageContext(input);
      return {
        getNativeConfig: () => nativeConfig,
        events: queue,
        getContextUsage: () => contextUsage,
        async send(text: string, images?: GuiSendImage[], _parameters?: Parameters<GuiRuntimeConnection['send']>[2], authority?: Parameters<GuiRuntimeConnection['send']>[3]) {
          if (active || closed) throw new GuiDeliveryError('外部 Pi 会话当前不可发送', 'not-submitted');
          // Leave native slash commands intact and append host guidance to the next plain input.
          const prefix = /^\/[\w:-]+(?:\s|$)/.test(text) ? '' : firstPromptPrefix;
          const message = appendGuiHostContext(text, prefix);
          active = true; stopping = false; bridgeActive = false; lastError = ''; lastAssistantStopReason = ''; ompPromptSettledSeen = false; turn += 1; promptId = `prompt-${randomUUID()}`;
          ompTextError = ''; ompTextUnverified = false; ompTextStreams.clear();
          forkTurn = authority?.forkIdentity ? { identity: authority.forkIdentity, hash: createHash('sha256').update(message).digest('hex') } : undefined;
          forkPoints = undefined;
          submitted = false;
          const sendTurn = turn, sentPromptId = promptId;
          try {
            if (closed || !active || stopping || turn !== sendTurn) throw new GuiDeliveryError('外部 Pi 回合已中止', 'not-submitted');
            submitted = true;
            if (prefix) firstPromptPrefix = '';
            const request = connection.request('prompt', { message,
              ...(images?.length ? { images: images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data })) } : {}) }, 30_000, sentPromptId);
            const identity = authority?.forkIdentity;
            if (identity?.userMessageId) queue.push({ type: 'engine-input', identity, text: message });
            const accepted = await request;
            if (record(accepted.data).disposition === 'handled') {
              if (active && turn === sendTurn) throw failConnection('外部 Pi 扩展接管了输入，无法确认原文已送达引擎');
              throw new GuiDeliveryError('外部 Pi 扩展接管了输入，无法确认原文已送达引擎', 'unknown');
            }
          } catch (error) {
            if (error instanceof GuiDeliveryError) throw error;
            const reason = `外部 Pi 未确认消息是否受理：${(error as Error).message}`;
            if (!closed && active && turn === sendTurn) throw failConnection(reason);
            throw terminalFailure ?? new GuiDeliveryError(connection.sanitize(reason), submitted ? 'unknown' : 'not-submitted');
          }
        },
        async nativeFork(point) {
          if (active || closed) throw new Error('外部 Pi 会话当前不可分叉');
          if (isOmp) return forkOmp({ rpc: connection, sessionId, sessionFile: sourceFile, point, executable, cwd: input.cwd,
            log: message => input.log('warn', `Oh My Pi 分叉: ${message}`) });
          if (!isPi || point.engine !== 'pi-external' || point.sessionToken !== sessionId || !sourceFile) return { status: 'unsupported' };
          return forkExternalPi({ executable, cwd: input.cwd, sourceFile, point,
            log: message => input.log('warn', `外部 Pi 分叉: ${message}`) });
        },
        async receiveMessage(message) {
          if (active && !closed && message.idleOnly) return { status: 'deferred', reason: '等待当前回合结束后重新确认消息' };
          return { status: 'unsupported', reason: '外部 Pi 无法确认原生消息是否被扩展改写或实际消费；由工作台排队' };
        },
        async abort() {
          if (active && !closed) {
            stopping = true; turn += 1;
            try { await connection.request('abort'); }
            catch (error) { failConnection(`外部 Pi 未确认停止：${(error as Error).message}`); throw error; }
          }
        },
        async close() { await cleanup(); queue.close(); }
      };
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) { throw new ConnectionCleanupError(`${(error as Error).message}；外部 Pi 资源回收失败：${(cleanupError as Error).message}`); }
      queue.close();
      throw error;
    }
  }
}
