import { appendGuiHostContext, firstGuiUserMessageContext } from '../../prompt';
import { randomUUID } from 'node:crypto';
import { ConnectionCleanupError } from '../../host/retirement';
import { GuiDeliveryError } from '../../types';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import type { GuiDriverConnectInput, GuiDriverStreamEvent, GuiRuntimeConnection, GuiRuntimeDriver, GuiRuntimeProbeResult, GuiSendImage } from '../../types';
import { evaluateNativeToolBoundary } from '../../tools/policy';
import { nativeOptionAccepts, type NativeApprovalChoice, type NativeConfigState, type NativeConfigValue } from '../../../../shared/nativeSessionConfig';
import { applyNativePermissionStrategy, automaticNativeSelections, automaticPermissions, restoreNativePermissions } from '../nativePermissionPolicy';
import { zcodeNativeConfig } from './nativeConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import { AsyncEventQueue } from '../eventQueue';
import { boundedAcpRequest } from '../acp/models';
import type { JsonRpcId, JsonRpcMessage } from '../acp/jsonRpc';
import { createPromptAuthorityScope } from '../../../agent/turnScope';
import { startMuseHostMcp, type MuseTurnAuthority } from '../muse/hostMcp';
import { asZCodeRecord as object, assertZCodeDefaultUnambiguous, listZCodeModels, resolveZCodeExecutable, respondZCodeRuntimePreferences, selectZCodeModel, startZCodeProcess, zcodeSnapshotModels, zcodeString as string, zcodeWorkspace } from './process';
import { formatZCodeQuestionnaireAnswer, parseZCodeQuestionnaire } from './questions';

type ZCodeTool = { name: string; input: Record<string, unknown>; started: boolean; ended: boolean };
type BufferedTurn = { events: GuiDriverStreamEvent[]; bytes: number; error: string; eventIds: Set<string>; tools: Map<string, ZCodeTool> };
type PendingInteraction = { fingerprint: string; id: JsonRpcId; epoch: number; hostTurnId: string;
  nativeTurnId: string; settled: boolean; uiActive: boolean; controller?: AbortController };
const MAX_BUFFERED_TURNS = 8;
const MAX_BUFFERED_EVENTS = 512;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_EVENT_IDS = 32_768;
const clean = (message: string): string => redactSafetyText(message, collectEnvSecrets(process.env)).slice(0, 800);

/** One ZCode process and one host MCP credential are scoped to one turn. */
export class ZCodeRuntimeDriver implements GuiRuntimeDriver {
  readonly runtimeId = 'zcode-gui';
  readonly permissionStrategyHot = true;
  readonly supportsImages = false;
  readonly supportsSeed = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'unsupported' as const;

  constructor(private readonly options: { getExecutable?: () => string | undefined } = {}) {}

  private configuredExecutable(): string | undefined {
    const value: unknown = this.options.getExecutable?.();
    if (value == null) return undefined;
    if (typeof value !== 'string') throw new Error('ZCode 手动路径配置无效');
    return value.trim() || undefined;
  }

  get connectionVersion(): string { return this.configuredExecutable() ?? ''; }
  nativeConfigVersion(): string { return nativeExecutableVersion(resolveZCodeExecutable(this.configuredExecutable()), 'zcode-protocol-v1'); }

  async describeNativeConfig(input: { cwd: string; refresh?: boolean }): Promise<NativeConfigState> {
    const result = await listZCodeModels({ cwd: input.cwd, refresh: input.refresh, executableOverride: this.configuredExecutable() });
    if (!result.ok) return input.refresh ? { status: 'error', options: [], error: result.error } : { status: 'uninitialized', options: [] };
    return result.nativeConfig ?? { status: 'uninitialized', options: [] };
  }

  async probe(): Promise<GuiRuntimeProbeResult> {
    const preferred = this.configuredExecutable();
    const executable = resolveZCodeExecutable(preferred);
    return executable
      ? { status: 'available', problems: [], executable }
      : { status: 'not_installed', problems: [{ code: 'cli_missing', message: preferred ? '指定的 ZCode 可执行文件不存在或不可用' : '找不到 ZCode CLI', fix: preferred ? '请修正或清除手动路径后重新检测' : '安装 ZCode 并完成其登录，然后重新检测', fixHint: 'https://github.com/zai-org/ZCode' }] };
  }

  async validateModelOverride(input: { cwd: string; model: NonNullable<GuiDriverConnectInput['modelOverride']> }): Promise<void> {
    const id = input.model.modelId?.trim() ?? '';
    if (!id) return;
    if (input.model.providerId !== this.runtimeId) throw new Error('ZCode 模型必须来自当前引擎');
    const executableOverride = this.configuredExecutable();
    const models = await listZCodeModels({ cwd: input.cwd, executableOverride });
    if (this.configuredExecutable() !== executableOverride) throw new Error('ZCode 程序路径在模型验证期间变化，请重试');
    if (!models.ok) throw new Error(`无法读取 ZCode 模型目录：${models.error}`);
    if (id === 'default') assertZCodeDefaultUnambiguous(models.items);
    else selectZCodeModel(models.items, id);
  }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    let current = await this.connectTurn(input);
    const events = new AsyncEventQueue<GuiDriverStreamEvent>();
    let closed = false, used = false, sending = false, turnPending = false, stopEpoch = 0;
    let failure: unknown;
    let initializationCleanupFailure: ConnectionCleanupError | undefined;
    let rotation: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const pump = (connection: GuiRuntimeConnection): void => {
      void (async () => {
        try {
          for await (const event of connection.events) {
            if (event.type === 'turn-complete' || event.type === 'error') turnPending = false;
            if (!closed) events.push(event);
          }
        } catch (error) {
          turnPending = false;
          if (!closed) { failure = error; events.fail(error); }
        }
      })();
    };
    pump(current.connection);
    const rotate = (): Promise<void> => {
      if (rotation) return rotation;
      const attempt = (async () => {
        const previous = current;
        await previous.connection.close();
        if (closed) return;
        let next: typeof current;
        try {
          next = await this.connectTurn({ ...input, nativeConfig: undefined, resumeToken: previous.sessionId,
            hasPriorConversation: true, forkTranscriptPending: false, systemPromptAppend: '', firstPromptPrefix: '' });
        } catch (error) {
          if (error instanceof ConnectionCleanupError) initializationCleanupFailure = error;
          throw error;
        }
        current = next;
        used = false;
        if (closed) return;
        pump(next.connection);
      })();
      rotation = attempt;
      void attempt.finally(() => { if (rotation === attempt) rotation = undefined; }).catch(() => {});
      return attempt;
    };
    return {
      events,
      async restorePermissionStrategy(selections) {
        if (closed || rotation || sending || turnPending || !current.connection.restorePermissionStrategy) {
          throw new Error('ZCode 正在执行回合，请等待结束后开启权限配置');
        }
        await current.connection.restorePermissionStrategy(selections);
      },
      async refreshPermissionStrategy() {
        if (!closed && !rotation && !sending && !turnPending) await current.connection.refreshPermissionStrategy?.();
      },
      async send(text, images, parameters, authority) {
        if (closed || rotation || sending || turnPending) throw new GuiDeliveryError('ZCode 会话当前不可发送', 'not-submitted');
        if (failure) throw new GuiDeliveryError('ZCode 上一轮发生连接错误，请重新连接后再发送', 'not-submitted');
        sending = true;
        try {
          const sendEpoch = stopEpoch;
          if (used) await rotate();
          if (closed) throw new GuiDeliveryError('ZCode 会话已关闭', 'not-submitted');
          if (stopEpoch !== sendEpoch) throw new GuiDeliveryError('ZCode 恢复期间已停止，输入未提交', 'not-submitted');
          await current.connection.refreshPermissionStrategy?.();
          used = true; turnPending = true;
          try { return await current.connection.send(text, images, parameters, authority); }
          catch (error) {
            turnPending = false;
            if (error instanceof GuiDeliveryError && error.delivery === 'not-submitted') used = false;
            else failure = error;
            throw error;
          }
        } finally { sending = false; }
      },
      async receiveMessage() { return { status: 'unsupported', reason: 'ZCode 未协商原生插话；由工作台排队' }; },
      async abort() {
        stopEpoch += 1;
        if (rotation) await rotation;
        if (!closed) await current.connection.abort();
      },
      close() {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          let failure: unknown;
          try {
            try { if (rotation) await rotation; } catch (error) { failure = error; }
            try { await current.connection.close(); } catch (error) { failure ??= error; }
            failure ??= initializationCleanupFailure;
            if (failure) throw failure;
          } finally { events.close(); }
        })();
        void closing.catch(() => { closing = undefined; });
        return closing;
      }
    };
  }

  private async connectTurn(input: GuiDriverConnectInput): Promise<{ connection: GuiRuntimeConnection; sessionId: string }> {
    const resume = input.resumeToken?.trim() ?? '';
    if (input.hasPriorConversation && !resume && !input.forkTranscriptPending) {
      throw new Error('ZCode 历史缺少原生会话标识，无法安全恢复；请保留历史并新建会话');
    }
    const native = startZCodeProcess(input.cwd, this.configuredExecutable(), {
      workspaceId: input.workspaceContext?.workspaceId,
      workspaceName: input.workspaceContext?.workspaceName,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      taskId: input.taskId
    });
    const rpc = native.rpc;
    const queue = new AsyncEventQueue<GuiDriverStreamEvent>();
    let closed = false, active = false, stopping = false, turnEpoch = 0;
    let sessionId = '', inputId = '', correlatedTurnId = '';
    let accepted = false;
    let submitted = false;
    let terminalFailure: GuiDeliveryError | undefined;
    let completed: { turnId: string; resultType: string } | undefined;
    let buffered = new Map<string, BufferedTurn>();
    let bufferedEvents = 0, bufferedBytes = 0;
    const retiredTurnIds = new Set<string>();
    const pendingQuestions = new Map<string, PendingInteraction>();
    const pendingPermissions = new Map<string, PendingInteraction>();
    let interactionTail: Promise<void> = Promise.resolve();
    const serializeInteraction = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = interactionTail.then(operation);
      interactionTail = result.then(() => undefined, () => undefined);
      return result;
    };
    let policyPrefix = firstGuiUserMessageContext(input);
    let cleanupPromise: Promise<void> | undefined;
    let mcp: Awaited<ReturnType<typeof startMuseHostMcp>> | undefined;
    let hostToolsListed = false;
    let turnAuthority: (MuseTurnAuthority & { controller: AbortController }) | undefined;
    const diagnostic = (message: string): string => redactSafetyText(clean(message), mcp ? [mcp.token] : []);
    const retireAuthority = (): void => {
      const authority = turnAuthority;
      turnAuthority = undefined;
      authority?.controller.abort();
      authority?.scope.close();
    };
    const timeout = <T>(promise: Promise<T>, label: string) => boundedAcpRequest(promise, 30_000, label);
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      closed = true; turnEpoch += 1;
      retireAuthority();
      const attempt = (async () => {
        let failure: unknown;
        try { await native.close(); } catch (error) { failure = error; }
        try { await mcp?.close(); } catch (error) { failure ??= error; }
        if (failure) throw failure;
      })();
      cleanupPromise = attempt;
      void attempt.catch(() => { if (cleanupPromise === attempt) cleanupPromise = undefined; });
      return attempt;
    };
    const failConnection = (message: string): GuiDeliveryError => {
      const failure = terminalFailure ?? new GuiDeliveryError(diagnostic(message), active && submitted ? 'unknown' : 'not-submitted');
      if (closed) return failure;
      terminalFailure = failure;
      // Close first: the host must wait for this reclaim before another turn.
      void cleanup().catch(error => input.log('error', `ZCode 资源回收失败：${diagnostic((error as Error).message)}`));
      queue.fail(failure);
      return failure;
    };
    const finish = (message?: string): void => {
      if (!active) return;
      active = false; turnEpoch += 1;
      retireAuthority();
      queue.push(message ? { type: 'error', message: diagnostic(message) } : { type: 'turn-complete' });
    };
    const finalizeVerified = (): void => {
      if (!active || !accepted || !completed) return;
      if (!rememberTurn(completed.turnId)) return;
      if (input.hostTools.length && !hostToolsListed) {
        input.log('warn', '本轮未观察到 ZCode 请求工作台工具目录；无法确认宿主工具是否可用，请检查 MCP 设置和版本。');
      }
      const turn = buffered.get(completed.turnId);
      for (const event of turn?.events ?? []) queue.push(event);
      const resultType = completed.resultType;
      const failure = turn?.error || (resultType === 'cancelled' ? 'ZCode 回合已中止' : 'ZCode 回合未成功完成');
      buffered.clear(); bufferedBytes = 0; bufferedEvents = 0;
      finish(resultType === 'success' ? undefined : failure);
    };
    const rememberTurn = (turnId: string): boolean => {
      if (retiredTurnIds.has(turnId)) return true;
      if (retiredTurnIds.size >= 4096) {
        failConnection('ZCode 会话的回合标识记录已满，请重新连接');
        return false;
      }
      retiredTurnIds.add(turnId);
      return true;
    };
    const discardBuffered = (turnId: string): void => {
      const turn = buffered.get(turnId);
      if (!turn) return;
      bufferedEvents -= turn.events.length;
      bufferedBytes -= turn.bytes;
      buffered.delete(turnId);
    };
    const getBuffered = (turnId: string): BufferedTurn | undefined => {
      let turn = buffered.get(turnId);
      if (!turn) {
        if (buffered.size >= MAX_BUFFERED_TURNS) {
          failConnection('ZCode 未关联的回合过多，无法安全确认响应归属');
          return;
        }
        turn = { events: [], bytes: 0, error: '', eventIds: new Set(), tools: new Map() };
        buffered.set(turnId, turn);
      }
      return turn;
    };
    const bufferEvent = (turn: BufferedTurn, event: GuiDriverStreamEvent): void => {
      const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (bufferedEvents >= MAX_BUFFERED_EVENTS || bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
        failConnection('ZCode 回合输出超过安全缓冲上限，无法确认响应归属');
        return;
      }
      turn.events.push(event); turn.bytes += bytes; bufferedEvents += 1; bufferedBytes += bytes;
    };
    // A send ACK only confirms admission, not which engine turn owns it. Once
    // turn.started (or an interaction carrying inputId) binds both identities,
    // release buffered events in order and stream subsequent events directly.
    const flushCorrelated = (): void => {
      if (!active || !accepted || stopping || closed || !correlatedTurnId) return;
      const turn = buffered.get(correlatedTurnId);
      if (!turn || !turn.events.length) return;
      for (const event of turn.events) queue.push(event);
      bufferedEvents -= turn.events.length;
      bufferedBytes -= turn.bytes;
      turn.events = [];
      turn.bytes = 0;
    };
    const publishEvent = (turnId: string, turn: BufferedTurn, event: GuiDriverStreamEvent): void => {
      if (!active || stopping || closed) return;
      if (accepted && correlatedTurnId === turnId) {
        flushCorrelated();
        queue.push(event);
      } else bufferEvent(turn, event);
    };
    let nativeState: NativeConfigState = { status: 'uninitialized', options: [] };
    let nativeRevision = -1;
    let nativeProtocol = false;
    const observeSettings = (settings: unknown, revision: unknown) => {
      if (typeof revision === 'number' && revision < nativeRevision) return;
      if (!Object.hasOwn(object(settings), 'mode')) return;
      if (typeof revision === 'number') nativeRevision = revision;
      nativeState = zcodeNativeConfig(settings, nativeProtocol);
      queue.push({ type: 'native-config', state: nativeState });
    };
    const setNativeConfig = async (id: string, value: NativeConfigValue) => {
      const option = nativeState.options.find(option => option.id === id);
      if (closed || !sessionId || !option || !nativeOptionAccepts(option, value)) throw new Error('ZCode did not advertise the selected mode.');
      const changed = object(await timeout(rpc.request('session/setMode', { sessionId, mode: value,
        ...(nativeRevision >= 0 ? { expectedRevision: nativeRevision } : {}) }), 'ZCode 权限模式'));
      if (string(object(changed.session).sessionId) !== sessionId) throw new Error('ZCode returned settings from a different session.');
      observeSettings(changed.settings, changed.stateRevision);
      if (nativeState.options[0]?.currentValue !== value) throw new Error('ZCode 未确认所选权限模式');
    };
    const replyPermission = (message: JsonRpcMessage): void => {
      if (message.id == null) return;
      const params = object(message.params), name = string(params.toolName), requestId = string(params.requestId);
      const hostTurnId = input.getTurnId?.();
      const requestTurnId = string(params.turnId), requestInputId = string(params.inputId);
      const fingerprint = JSON.stringify(params);
      const previous = pendingPermissions.get(requestId);
      if (previous || pendingQuestions.has(requestId)) {
        if (!active || closed || stopping || !submitted || !hostTurnId) return;
        if (!previous || previous.fingerprint !== fingerprint || previous.epoch !== turnEpoch ||
            previous.hostTurnId !== hostTurnId || previous.nativeTurnId !== correlatedTurnId) {
          failConnection('ZCode 重复审批请求的来源或内容不一致'); return;
        }
        if (!previous.settled) previous.id = message.id;
        return;
      }
      if (!active || closed || stopping || !submitted || !hostTurnId || params.sessionId !== sessionId ||
          !requestId || requestId.length > 512 || !name || !params.input || typeof params.input !== 'object' || Array.isArray(params.input)) {
        rpc.respondError(message.id, '当前回合不能执行该工具'); return;
      }
      if (!requestTurnId || retiredTurnIds.has(requestTurnId) || (requestInputId !== inputId && requestTurnId !== correlatedTurnId) ||
          (correlatedTurnId && correlatedTurnId !== requestTurnId)) {
        rpc.respondError(message.id, 'ZCode 未提供可关联当前输入的权限请求，无法安全审批'); return;
      }
      correlatedTurnId = requestTurnId;
      flushCorrelated();
      if (pendingPermissions.size >= 64) { rpc.respondError(message.id, '当前回合的审批请求过多'); return; }
      const pending: PendingInteraction = { fingerprint, id: message.id, epoch: turnEpoch, hostTurnId,
        nativeTurnId: requestTurnId, settled: false, uiActive: false, controller: new AbortController() };
      pendingPermissions.set(requestId, pending);
      const current = (): boolean => !closed && active && !stopping && turnEpoch === pending.epoch &&
        input.getTurnId?.() === pending.hostTurnId && correlatedTurnId === pending.nativeTurnId;
      const args = object(params.input);
      const hostMatches = input.hostTools.filter(tool => {
        const alias = tool.id.replace(/\./g, '_').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
        return name === `mcp__muster__${alias}`;
      });
      if (hostMatches.length > 1) {
        pending.settled = true;
        rpc.respondError(pending.id, 'ZCode 宿主工具名称不唯一，无法安全审批'); return;
      }
      const policyName = hostMatches[0]?.id ?? name;
      const decide = () => evaluateNativeToolBoundary({ engineToolName: policyName, input: args, cwd: input.cwd,
        workspaceContext: input.workspaceContext, hostToolIds: input.hostTools.map(tool => tool.id),
        hostClassOf: toolName => input.hostTools.find(tool => tool.id === toolName)?.permissionClass ?? 'status' }, false);
      const initial = decide();
      void serializeInteraction(async () => {
        if (!current() || pending.settled) return;
        const options = Array.isArray(params.options) ? params.options.slice(0, 64).map(object)
          .filter(option => typeof option.optionId === 'string' && option.optionId.length <= 512 && ['allow', 'deny'].includes(string(object(option.response).decision))) : [];
        const choices: NativeApprovalChoice[] = options.map(option => ({
          id: string(option.optionId), name: string(option.name) || string(option.optionId), kind: string(option.kind),
          description: string(option.description) || undefined,
          scope: option.kind === 'allow_session' || option.kind === 'reject_session' ? 'session'
            : option.kind === 'allow_always' || option.kind === 'reject_always' ? 'persistent' : 'once'
        }));
        let choiceId: string | undefined;
        const canAsk = initial.decision !== 'deny' && JSON.stringify(initial.updatedInput) === JSON.stringify(args) &&
          JSON.stringify(initial) === JSON.stringify(decide());
        if (canAsk && choices.length) {
          pending.uiActive = true;
          try {
            const signals = [pending.controller!.signal];
            if (turnAuthority) signals.push(turnAuthority.signal);
            const result = await input.requestApproval({ toolCallId: string(params.toolCallId) || requestId,
              toolName: policyName, input: args, nativeChoices: choices, nativeSource: 'ZCode',
              reason: string(params.reason) || initial.ruleReason }, AbortSignal.any(signals));
            choiceId = result.nativeChoiceId;
          } finally { pending.uiActive = false; }
        }
        if (!current() || pending.settled) return;
        const choice = choiceId && JSON.stringify(initial) === JSON.stringify(decide()) ? options.find(option => option.optionId === choiceId)
          : options.find(option => object(option.response).decision === 'deny' && !Object.hasOwn(object(option.response), 'permissionUpdates'));
        pending.settled = true;
        if (!choice) { rpc.respondError(pending.id, 'ZCode 未提供可安全使用的单次权限选项'); return; }
        rpc.respond(pending.id, object(choice.response));
      }).catch(error => {
        if (!current() || pending.settled) return;
        pending.settled = true;
        rpc.respondError(pending.id, diagnostic((error as Error).message));
      });
    };
    const replyQuestion = (message: JsonRpcMessage): void => {
      if (message.id == null) return;
      const params = object(message.params), requestId = string(params.requestId), nativeTurnId = string(params.turnId);
      const hostTurnId = input.getTurnId?.();
      const fingerprint = JSON.stringify(params);
      const previous = pendingQuestions.get(requestId);
      if (previous || pendingPermissions.has(requestId)) {
        if (!active || closed || stopping || !submitted || !hostTurnId) return;
        if (!previous || previous.fingerprint !== fingerprint || previous.epoch !== turnEpoch ||
            previous.hostTurnId !== hostTurnId || previous.nativeTurnId !== correlatedTurnId) {
          failConnection('ZCode 重复提问的来源或内容不一致'); return;
        }
        if (!previous.settled) previous.id = message.id;
        return;
      }
      if (!active || closed || stopping || !submitted || !hostTurnId || params.sessionId !== sessionId ||
          !requestId || requestId.length > 512 || !nativeTurnId || nativeTurnId !== correlatedTurnId ||
          retiredTurnIds.has(nativeTurnId)) {
        rpc.respond(message.id, { action: 'decline', reason: '无法确认该提问属于当前回合' });
        return;
      }
      if (!input.requestUserQuestion) {
        rpc.respond(message.id, { action: 'decline', reason: '当前会话没有用户提问通道' });
        return;
      }
      let form: ReturnType<typeof parseZCodeQuestionnaire>;
      try { form = parseZCodeQuestionnaire(params); }
      catch (error) {
        rpc.respond(message.id, { action: 'decline', reason: clean((error as Error).message) });
        return;
      }
      if (pendingQuestions.size >= 64) {
        rpc.respond(message.id, { action: 'decline', reason: '当前回合的交互请求过多' });
        return;
      }
      const pending: PendingInteraction = { fingerprint, id: message.id,
        epoch: turnEpoch, hostTurnId, nativeTurnId, settled: false, uiActive: false };
      pendingQuestions.set(requestId, pending);
      const current = (): boolean => !closed && active && !stopping && turnEpoch === pending.epoch &&
        input.getTurnId?.() === pending.hostTurnId && correlatedTurnId === pending.nativeTurnId;
      void serializeInteraction(async () => {
        if (!current() || pending.settled) return;
        pending.uiActive = true;
        let result: Awaited<ReturnType<NonNullable<typeof input.requestUserQuestion>>>;
        try { result = await input.requestUserQuestion!(form.request); }
        finally { pending.uiActive = false; }
        if (!current() || pending.settled) return;
        let answer: Record<string, unknown>;
        try { answer = formatZCodeQuestionnaireAnswer(form, result); }
        catch (error) { answer = { action: 'cancel', reason: diagnostic((error as Error).message) }; }
        pending.settled = true;
        rpc.respond(pending.id, answer);
      }).catch(error => {
        if (!current() || pending.settled) return;
        pending.settled = true;
        rpc.respond(pending.id, { action: 'cancel', reason: diagnostic((error as Error).message) });
      });
    };
    rpc.on('message', (message: JsonRpcMessage) => {
      const params = object(message.params);
      if (respondZCodeRuntimePreferences(rpc, message)) return;
      if (message.id != null && message.method === 'interaction/requestPermission') {
        try { replyPermission(message); } catch (error) { failConnection(`ZCode 审批处理失败：${(error as Error).message}`); }
        return;
      }
      if (message.id != null && message.method === 'interaction/requestUserInput') {
        try { replyQuestion(message); } catch (error) { failConnection(`ZCode 提问处理失败：${(error as Error).message}`); }
        return;
      }
      if (message.id != null) { rpc.respondError(message.id, '该 ZCode 交互暂不支持', -32601); return; }
      if (!closed && sessionId && message.method === 'state.updated' && params.scope === 'session' && params.sessionId === sessionId) {
        observeSettings(params.patch, params.revision);
        return;
      }
      if (!active || closed || message.method !== 'session/event') return;
      const payload = object(params.payload), kind = string(payload.type) || string(params.type);
      if (kind === 'userInput.resolved' || kind === 'permission.resolved') {
        const pending = (kind === 'userInput.resolved' ? pendingQuestions : pendingPermissions).get(string(payload.requestId));
        if (params.sessionId === sessionId && pending && !pending.settled && pending.epoch === turnEpoch &&
            (typeof params.turnId !== 'string' || params.turnId === pending.nativeTurnId)) {
          pending.settled = true;
          if (pending.controller) pending.controller.abort();
          else if (pending.uiActive) failConnection('ZCode 已结束或自动处理交互，工作台无法再提交用户答复');
        }
        return;
      }
      if (!['turn.started', 'model.streaming', 'tool.updated', 'turn.failed', 'turn.completed'].includes(kind)) return;
      if (typeof params.sessionId === 'string' && params.sessionId !== sessionId) return;
      const eventTurnId = string(params.turnId);
      if (params.sessionId !== sessionId || !eventTurnId || eventTurnId.length > 512) {
        failConnection('ZCode 事件缺少会话或回合标识，无法确认响应归属'); return;
      }
      const completedInput = kind === 'turn.completed' ? string(payload.inputId) : '';
      if (kind === 'turn.completed' && !completedInput && correlatedTurnId !== eventTurnId) {
        failConnection('ZCode 未返回输入标识，无法确认响应归属'); return;
      }
      if (retiredTurnIds.has(eventTurnId)) {
        if (completedInput === inputId) failConnection('ZCode 复用了已结束的回合标识，无法确认响应归属');
        return;
      }
      if (completedInput && completedInput !== inputId) {
        if (correlatedTurnId === eventTurnId) {
          failConnection('ZCode 回合的输入标识不一致，无法确认响应归属'); return;
        }
        discardBuffered(eventTurnId); rememberTurn(eventTurnId); return;
      }
      const turn = getBuffered(eventTurnId);
      if (!turn) return;
      const eventId = string(params.eventId);
      if (eventId.length > 512) { failConnection('ZCode 事件标识超过安全上限'); return; }
      if (eventId && turn.eventIds.has(eventId)) {
        failConnection('ZCode 重复使用事件标识，无法确认输出是否重复'); return;
      }
      if (eventId) {
        if (turn.eventIds.size >= MAX_TRACKED_EVENT_IDS) {
          failConnection('ZCode 回合事件标识超过安全记录上限'); return;
        }
        turn.eventIds.add(eventId);
      }
      if (kind === 'turn.started') {
        const startedInput = string(payload.inputId);
        if (startedInput === inputId) {
          if (correlatedTurnId && correlatedTurnId !== eventTurnId) {
            failConnection('ZCode 同一输入出现多个回合标识'); return;
          }
          correlatedTurnId = eventTurnId;
          flushCorrelated();
        }
        return;
      }
      if (kind === 'model.streaming') {
        const delta = string(payload.delta);
        if (delta && payload.kind === 'text_delta') publishEvent(eventTurnId, turn, { type: 'text-delta', delta });
        if (delta && payload.kind === 'reasoning_delta') publishEvent(eventTurnId, turn, { type: 'thinking-delta', delta });
      } else if (kind === 'tool.updated') {
        const toolCallId = string(payload.toolCallId), toolName = string(payload.toolName);
        if (!toolCallId || !['scheduled', 'started', 'result', 'error'].includes(string(payload.kind))) return;
        let tool = turn.tools.get(toolCallId);
        if (!tool) {
          if (turn.tools.size >= 4096) { failConnection('ZCode 回合工具调用超过安全记录上限'); return; }
          tool = { name: '', input: {}, started: false, ended: false };
          turn.tools.set(toolCallId, tool);
        }
        if (tool.ended) { failConnection('ZCode 重复使用已结束的工具调用标识'); return; }
        if (toolName) {
          if (tool.name && tool.name !== toolName) { failConnection('ZCode 工具调用名称前后不一致'); return; }
          tool.name = toolName;
        }
        if (payload.kind === 'scheduled' && payload.input !== undefined) {
          tool.input = object(payload.input);
          if (tool.started) publishEvent(eventTurnId, turn, { type: 'tool-update', toolCallId, toolName: tool.name, input: tool.input });
        }
        const final = payload.kind === 'result' || payload.kind === 'error';
        if (!tool.started && (tool.name || final)) {
          tool.started = true;
          tool.name ||= 'ZCode tool';
          publishEvent(eventTurnId, turn, { type: 'tool-start', toolCallId, toolName: tool.name, input: tool.input,
            ...(final ? { reviewLate: true } : {}) });
        }
        if (final) {
          tool.ended = true;
          const result = object(payload.result), output = payload.kind === 'error' ? payload.error : result.content;
          publishEvent(eventTurnId, turn, { type: 'tool-result', toolCallId, toolName: tool.name, ok: payload.kind === 'result' && result.success === true,
            output: typeof output === 'string' ? output : JSON.stringify(output ?? '') });
        }
      } else if (kind === 'turn.failed') {
        const failedInput = string(payload.inputId);
        if (failedInput && failedInput !== inputId) {
          if (correlatedTurnId === eventTurnId) {
            failConnection('ZCode 失败事件的输入标识与已关联回合不一致'); return;
          }
          discardBuffered(eventTurnId); rememberTurn(eventTurnId); return;
        }
        if (correlatedTurnId && correlatedTurnId !== eventTurnId) {
          if (failedInput === inputId) failConnection('ZCode 同一输入的失败事件出现多个回合标识');
          return;
        }
        if (!failedInput && !correlatedTurnId) {
          failConnection('ZCode 报告回合失败但未提供可确认归属的输入标识'); return;
        }
        correlatedTurnId = eventTurnId;
        turn.error = diagnostic(string(payload.error) || string(object(payload.error).message) || 'ZCode 回合失败');
        completed = { turnId: eventTurnId, resultType: 'error_during_execution' };
        finalizeVerified();
      }
      else if (kind === 'turn.completed') {
        if ((correlatedTurnId && correlatedTurnId !== eventTurnId) || (completed && completed.turnId !== eventTurnId)) {
          failConnection('ZCode 同一输入出现多个回合标识'); return;
        }
        correlatedTurnId = eventTurnId;
        completed = { turnId: eventTurnId, resultType: string(payload.resultType) };
        finalizeVerified();
      }
    });
    rpc.on('close', (error: Error) => {
      if (closed) return;
      failConnection(`ZCode 连接已退出：${error.message}`);
    });
    try {
      await timeout(native.waitReady(), 'ZCode 进程启动');
      const mcpInput: GuiDriverConnectInput = { ...input, requestApproval: (request, signal) => {
        const authority = turnAuthority, hostTurnId = input.getTurnId?.();
        return serializeInteraction(async () => {
          if (!authority || !hostTurnId || !active || closed || stopping || authority !== turnAuthority ||
              authority.signal.aborted || signal?.aborted || input.getTurnId?.() !== hostTurnId) {
            return { approved: false, reason: '原始回合已结束，审批请求失效' };
          }
          return input.requestApproval(request, signal);
        });
      } };
      mcp = await startMuseHostMcp(mcpInput, () => active && submitted && !closed && !stopping ? turnAuthority : undefined,
        { onToolsListed: () => { hostToolsListed = true; } });
      const mcpServers = [{ name: 'muster', scope: 'user', type: 'http', url: mcp.url,
        headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }], isolation: 'session', alwaysLoad: true }];
      if (resume && (resume.length > 200 || /[\u0000-\u001f]/.test(resume))) throw new Error('ZCode 会话标识无效');
      const response = object(await timeout(rpc.request(resume ? 'session/resume' : 'session/create', resume
        ? { sessionId: resume, workspace: zcodeWorkspace(input.cwd), mcpServers }
        : { workspace: zcodeWorkspace(input.cwd), persistence: 'deferred', titleGenerationEnabled: false, mcpServers }), 'ZCode 会话建立'));
      nativeProtocol = object(response.protocol).name === 'ZCode Protocol';
      sessionId = string(object(response.session).sessionId);
      if (!sessionId || (resume && sessionId !== resume)) throw new Error('ZCode 未确认原生会话标识');
      if (resume && input.hasPriorConversation && !input.forkTranscriptPending && (!Array.isArray(response.messages) || response.messages.length === 0)) {
        throw new Error('ZCode 未确认恢复了会话历史；请保留工作台记录并新建会话');
      }
      observeSettings(response.settings, response.stateRevision);
      for (const selection of automaticPermissions(input) ? [] : input.nativeConfig?.selections ?? []) await setNativeConfig(selection.id, selection.value);
      const refreshPermissionStrategy = () => applyNativePermissionStrategy(input, () => nativeState,
        automaticNativeSelections(nativeState, [{ id: 'mode', value: 'yolo' }]), setNativeConfig);
      await refreshPermissionStrategy();
      const modelId = input.modelOverride?.modelId?.trim() ?? '';
      if (modelId === 'default') assertZCodeDefaultUnambiguous(zcodeSnapshotModels(response));
      else if (modelId) {
        const choice = selectZCodeModel(zcodeSnapshotModels(response), modelId);
        const changed = object(await timeout(rpc.request('session/setModel', { sessionId, model: choice.ref }), 'ZCode 模型设置'));
        const model = object(object(changed.session).model);
        if (model.providerId !== choice.ref.providerId || model.modelId !== choice.ref.modelId) throw new Error('ZCode 未确认所选模型');
        observeSettings(changed.settings, changed.stateRevision);
      }
      await timeout(rpc.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }), 'ZCode 会话订阅');
      queue.push({ type: 'resume-token', token: sessionId });
      const connection: GuiRuntimeConnection = {
        events: queue,
        getNativeConfig: () => nativeState,
        setNativeConfig,
        refreshPermissionStrategy,
        restorePermissionStrategy: selections => restoreNativePermissions(() => nativeState, selections, setNativeConfig),
        async send(text: string, images?: GuiSendImage[], _parameters?, authority?) {
          if (images?.length) throw new GuiDeliveryError('ZCode 尚未协商图片输入能力', 'not-submitted');
          if (active || closed) throw new GuiDeliveryError('ZCode 会话当前不可发送', 'not-submitted');
          const hostTurnId = input.getTurnId?.();
          if (!hostTurnId) throw new GuiDeliveryError('ZCode 缺少当前宿主回合标识', 'not-submitted');
          const controller = new AbortController();
          turnAuthority = { hostTurnId, controller, signal: controller.signal,
            scope: createPromptAuthorityScope(authority?.userText, !!input.nonUserTurns) };
          active = true; stopping = false; correlatedTurnId = ''; accepted = false; completed = undefined;
          buffered = new Map(); bufferedEvents = 0; bufferedBytes = 0;
          pendingQuestions.clear();
          pendingPermissions.clear();
          turnEpoch += 1; inputId = `muster-${randomUUID()}`;
          submitted = false;
          const sentInputId = inputId;
          const prefix = policyPrefix, content = appendGuiHostContext(text, prefix);
          try {
            submitted = true;
            const response = object(await timeout(rpc.request('session/send', { sessionId, content, inputId: sentInputId }), 'ZCode 发送'));
            if (response.accepted !== true) throw new Error('ZCode 未确认接受该输入');
            if (closed) throw new Error('ZCode 连接已关闭');
            accepted = true;
            const identity = authority?.forkIdentity;
            if (identity?.userMessageId) queue.push({ type: 'engine-input', identity, text: content });
            if (prefix === policyPrefix) policyPrefix = '';
            flushCorrelated();
            finalizeVerified();
          } catch (error) {
            if (error instanceof GuiDeliveryError) throw error;
            const reason = `ZCode 发送失败或结果未知：${(error as Error).message}`;
            if (!closed && active && inputId === sentInputId) throw failConnection(reason);
            throw terminalFailure ?? new GuiDeliveryError(diagnostic(reason), submitted ? 'unknown' : 'not-submitted');
          }
        },
        async receiveMessage() { return { status: 'unsupported', reason: 'ZCode 未协商原生插话；由工作台排队' }; },
        async abort() {
          if (active && !closed) {
            stopping = true; turnEpoch += 1;
            retireAuthority();
            const stoppedInput = inputId, stoppedEpoch = turnEpoch;
            try { await timeout(rpc.request('session/stop', { sessionId }), 'ZCode 停止'); }
            catch (error) {
              if (!active || inputId !== stoppedInput || turnEpoch !== stoppedEpoch) return;
              failConnection(`ZCode 未确认停止：${(error as Error).message}`); throw error;
            }
          }
        },
        async close() {
          if (!closed && active) {
            closed = true; stopping = true; turnEpoch += 1;
            retireAuthority();
            try { await boundedAcpRequest(rpc.request('session/stop', { sessionId }), 3000, 'ZCode 停止'); }
            catch { /* Reclaiming the process below is the authoritative stop. */ }
          }
          try { await cleanup(); } finally { queue.close(); }
        }
      };
      return { connection, sessionId };
    } catch (error) {
      try { await cleanup(); }
      catch (failure) { throw new ConnectionCleanupError(`${diagnostic((error as Error).message)}；ZCode 资源回收失败：${diagnostic((failure as Error).message)}`); }
      queue.close();
      throw new Error(diagnostic((error as Error).message));
    }
  }
}
