/** Muse Code MSP over stdio. The CLI owns its credentials and native history. */
import { appendGuiHostContext, firstGuiUserMessageContext } from '../../prompt';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPromptAuthorityScope } from '../../../agent/turnScope';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { spawnOwnedProcess, type OwnedProcess } from '../../process/owner';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { normalizeContextUsage } from '../../../../shared/guiContextUsage';
import type { GuiDriverConnectInput, GuiDriverStreamEvent, GuiRuntimeConnection, GuiRuntimeDriver, GuiSendImage } from '../../types';
import { GuiDeliveryError } from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { NdjsonRpc, type JsonRpcMessage } from '../acp/jsonRpc';
import { boundedAcpRequest } from '../../processReclamation';
import { evaluateNativeToolBoundary } from '../../tools/policy';
import type { NativeApprovalChoice } from '../../../../shared/nativeSessionConfig';
import { applyNativePermissionStrategy, automaticNativeSelections, automaticPermissions } from '../nativePermissionPolicy';
import { isMuseApprovalMode, museNativeConfig, readMuseProfiles } from './nativeConfig';
import type { NativeConfigChoice, NativeConfigState } from '../../../../shared/nativeSessionConfig';
import { nativeExecutableVersion } from '../nativeExecutableVersion';
import { startMuseHostMcp, type MuseTurnAuthority } from './hostMcp';
import { listMuseModels, museLaunch, musePath } from './process';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const REQUEST_TIMEOUT = 30_000;

/** MSP commands require RFC 9562 UUIDv7, not crypto.randomUUID()'s v4. */
function commandId(): string {
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function promptContent(text: string, images?: GuiSendImage[]): unknown[] {
  const parts: unknown[] = [{ type: 'text', text }];
  for (const image of images ?? []) parts.push({ type: 'image', base64Data: image.data, mediaType: image.mimeType });
  // NdjsonRpc has an 8 MiB outbound limit. Fail before starting Muse rather than
  // dropping an image or turning a too-large frame into an ambiguous send.
  if (Buffer.byteLength(JSON.stringify(parts), 'utf8') > 7 * 1024 * 1024) {
    throw new Error('Muse 消息及图片超过单次传输上限，请缩小附件后重试');
  }
  return parts;
}

type ActiveTurn = MuseTurnAuthority & {
  controller: AbortController;
  operation?: Promise<void>;
  rpc?: NdjsonRpc;
  owner?: OwnedProcess<ChildProcessWithoutNullStreams>;
  mcp?: Awaited<ReturnType<typeof startMuseHostMcp>>;
  remoteSession?: string;
  remoteTurn?: string;
  startCommand: string;
  closing: boolean;
  aborted: boolean;
  ended: boolean;
  fatal?: Error;
  finish(value: Record<string, unknown>): void;
  fail(error: Error): void;
  completion: Promise<Record<string, unknown>>;
  admission: Promise<void>;
  admit(): void;
  rejectAdmission(error: Error): void;
  startSubmitted: boolean;
  admitted: boolean;
  earlyMessages: JsonRpcMessage[];
  earlyBytes: number;
  pendingDeltas: Map<string, JsonRpcMessage[]>;
  pendingDeltaCount: number;
  pendingDeltaBytes: number;
  ignoredItems: Set<string>;
  resolvedRequests: Set<string>;
  messages: Map<string, string>;
  itemKinds: Map<string, string>;
  tools: Map<string, { name: string; output: string; ended: boolean; inputSignature: string }>;
};

export class MuseRuntimeDriver implements GuiRuntimeDriver {
  readonly runtimeId = 'muse-gui';
  readonly permissionStrategyHot = true;
  readonly supportsImages = true;
  readonly supportsSeed = false;
  readonly modelOverridePolicy = 'reconnect' as const;
  readonly thinkingPolicy = 'unsupported' as const;

  constructor(private readonly options: { getExecutable?: () => string | undefined } = {}) {}

  private configuredExecutable(): string | undefined {
    const value: unknown = this.options.getExecutable?.();
    if (value == null) return undefined;
    if (typeof value !== 'string') throw new Error('Muse 手动路径配置无效');
    return value.trim() || undefined;
  }

  get connectionVersion(): string { return this.configuredExecutable() ?? ''; }
  nativeConfigVersion(): string { return nativeExecutableVersion(musePath(this.configuredExecutable()), 'muse-msp'); }

  async validateModelOverride(input: { cwd: string; model: NonNullable<GuiDriverConnectInput['modelOverride']> }): Promise<void> {
    const modelId = input.model.modelId?.trim() ?? '';
    if (!modelId || modelId === 'default') return;
    if (input.model.providerId !== 'muse-gui' && input.model.providerId !== 'muse') throw new Error('Muse 模型必须来自 Muse 自己的模型目录');
    const executableOverride = this.configuredExecutable();
    const catalog = await listMuseModels({ cwd: input.cwd, executableOverride });
    if (this.configuredExecutable() !== executableOverride) throw new Error('Muse 程序路径在模型验证期间变化，请重试');
    if (!catalog.ok) throw new Error(`无法读取 Muse 模型目录：${catalog.error}`);
    if (!catalog.items.some(item => item.id === modelId)) throw new Error(`Muse 未声明模型 ${modelId}；请刷新模型目录或使用引擎默认模型`);
  }

  async probe() {
    const preferred = this.configuredExecutable();
    const invalidLaunch = (error: unknown, executable?: string) => ({ status: 'not_configured' as const,
      ...(executable ? { executable } : {}), problems: [{ code: 'config_missing' as const,
        message: error instanceof Error ? error.message : 'Muse 启动配置无效',
        fix: '请使用不含 % 的 Muse 可执行路径，然后重新检测' }] });
    if (preferred) {
      try { museLaunch(preferred, ['serve']); }
      catch (error) { return invalidLaunch(error); }
    }
    const executable = musePath(preferred);
    if (!executable) return { status: 'not_installed' as const, problems: [{ code: 'cli_missing' as const,
      message: preferred ? '指定的 Muse 可执行文件不存在或不可用' : '未找到 Muse Code 命令；请先安装并在 Muse CLI 中登录',
      fix: preferred ? '请修正或清除手动路径后重新检测' : '安装 Muse Code 并将 muse 加入 PATH，然后运行 muse login' }] };
    try {
      museLaunch(executable, ['serve']);
      return { status: 'available' as const, executable, problems: [] };
    } catch (error) {
      return invalidLaunch(error, executable);
    }
  }

  async describeNativeConfig({ cwd, refresh }: { cwd: string; refresh?: boolean }): Promise<NativeConfigState> {
    const catalog = await listMuseModels({ cwd, executableOverride: this.configuredExecutable(), refresh });
    if (catalog.ok) return catalog.nativeConfig ?? museNativeConfig();
    return refresh ? { status: 'error', options: museNativeConfig().options, error: catalog.error } : museNativeConfig();
  }

  async connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    const preferred = this.configuredExecutable();
    const executable = musePath(preferred);
    if (!executable) throw new Error(preferred ? '指定的 Muse 可执行路径无效，请修正或清除设置' : '未找到 Muse Code，请安装并运行 muse login');
    try { if (!fs.statSync(input.cwd).isDirectory()) throw new Error('not a directory'); }
    catch { throw new Error('Muse 工作目录不存在或不可访问'); }
    if (!input.getTurnId) throw new Error('宿主未提供回合身份，无法安全连接 Muse');
    if (input.hasPriorConversation && !input.resumeToken && !input.forkTranscriptPending) throw new Error('Muse 历史缺少原生会话标识，无法安全恢复；请保留历史并新建会话');

    const queue = new AsyncEventQueue<GuiDriverStreamEvent>({ maxBuffered: 512 });
    let closed = false;
    let remoteSession = input.resumeToken;
    let active: ActiveTurn | undefined;
    let poison: Error | undefined;
    let pendingReclaim: { owner: OwnedProcess<ChildProcessWithoutNullStreams>; turn: ActiveTurn } | undefined;
    let permanentCleanupFailure: Error | undefined;
    let closing: Promise<void> | undefined;
    let policyPrefix = firstGuiUserMessageContext(input);
    let contextUsage: { tokens: number | null; contextWindow: number } | null = null;
    let pendingMode: string | undefined;
    let pendingProfile: string | undefined;
    for (const { id, value } of input.nativeConfig?.selections ?? []) {
      if (id === 'approvalMode' && isMuseApprovalMode(value)) pendingMode = value;
      else if (id === 'permissionProfile' && typeof value === 'string') pendingProfile = value;
      else throw new Error(`Invalid Muse setting ${id}.`);
    }
    let nativeState = museNativeConfig();
    let nativeLimits: unknown;
    let nativeProfiles: NativeConfigChoice[] | undefined;
    let nativePermission: unknown;
    let nativeMode: unknown;
    const publishNativeConfig = () => {
      nativeState = museNativeConfig(nativeMode, nativeLimits, nativeProfiles, nativePermission);
      queue.push({ type: 'native-config', state: nativeState });
    };
    const modelId = input.modelOverride?.providerId === 'muse-gui' || input.modelOverride?.providerId === 'muse'
      ? input.modelOverride.modelId?.trim() : undefined;
    const secrets = collectEnvSecrets(process.env);
    const diagnostic = (error: unknown, t?: ActiveTurn): string => redactSafetyText(error instanceof Error ? error.message : String(error), [...secrets, ...(t?.mcp ? [t.mcp.token] : [])]).slice(0, 1200);
    const live = (t: ActiveTurn): boolean => !closed && active === t && !t.signal.aborted && input.getTurnId?.() === t.hostTurnId;
    const assertLive = (t: ActiveTurn): void => { if (!live(t)) throw new Error('Muse 回合已结束或取消'); };
    const applyMode = async (t: ActiveTurn, mode: string) => {
      assertLive(t);
      const command = commandId();
      const result = record(await boundedAcpRequest(t.rpc!.request('session/setApprovalMode', {
        commandId: command, sessionId: t.remoteSession, mode
      }), REQUEST_TIMEOUT, 'Muse 审批模式设置', t.signal));
      assertLive(t);
      if (result.commandId !== command || !['completed', 'noop'].includes(String(result.applyOutcome)) || record(result.effectiveMode).mode !== mode) {
        throw new Error('Muse did not confirm the selected approval mode.');
      }
      nativeMode = mode;
      publishNativeConfig();
    };
    const applyProfile = async (t: ActiveTurn, profileId: string) => {
      assertLive(t);
      const command = commandId();
      const result = record(await boundedAcpRequest(t.rpc!.request('session/setPermissionProfile', {
        commandId: command, sessionId: t.remoteSession, profileId
      }), REQUEST_TIMEOUT, 'Muse 权限配置设置', t.signal));
      assertLive(t);
      if (result.commandId !== command || result.status !== 'accepted' ||
          !['completed', 'noop'].includes(String(result.applyOutcome)) || record(result.permissionState).profileId !== profileId) {
        throw new Error('Muse did not confirm the selected permission profile.');
      }
      nativePermission = result.permissionState;
      publishNativeConfig();
    };

    const handleRequest = (t: ActiveTurn, message: JsonRpcMessage, p: Record<string, unknown>): void => {
      const id = message.id;
      if (id == null || !t.rpc) return;
      if (!live(t) || !t.startSubmitted || !t.remoteTurn || string(p.sessionId) !== t.remoteSession || p.turnId !== t.remoteTurn) {
        t.rpc.respondError(id, 'The originating session or turn has ended.');
        return;
      }
      if (message.method !== 'approval/request' && message.method !== 'userInput/request') {
        t.rpc.respondError(id, 'Unsupported MSP request', -32601);
        return;
      }
      t.rpc.respond(id, {});
      const requestId = string(message.method === 'approval/request' ? p.approvalId : p.userInputId);
      if (!requestId) { t.fail(new Error('Muse 返回的交互请求缺少标识')); return; }
      const current = (): boolean => live(t) && !t.resolvedRequests.has(requestId);
      void (async () => {
        if (message.method === 'approval/request') {
          const choices = Array.isArray(p.availableChoices) ? p.availableChoices.map(record) : [];
          let rawArgs: unknown;
          try { rawArgs = JSON.parse(string(p.rawArgs)); }
          catch { throw new Error('Muse 审批请求缺少可校验的工具参数'); }
          if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new Error('Muse 审批请求的工具参数无效');
          const args = rawArgs as Record<string, unknown>;
          const options: NativeApprovalChoice[] = choices.slice(0, 64).filter(choice => typeof choice.choiceId === 'string' && choice.choiceId.length <= 512)
            .map(choice => ({ id: string(choice.choiceId), name: string(choice.label) || string(choice.choiceId),
              description: string(choice.rulePreview) || undefined, kind: string(choice.decision),
              scope: choice.scope === 'localPersistent' ? 'persistent' : choice.scope === 'session' ? 'session' : choice.scope === 'once' ? 'once' : undefined }));
          const toolName = string(p.toolName) || 'Muse tool';
          const evaluate = () => evaluateNativeToolBoundary({ cwd: input.cwd, workspaceContext: input.workspaceContext,
            engineToolName: toolName, input: args, hostToolIds: input.hostTools.map(tool => tool.id),
            hostClassOf: name => input.hostTools.find(tool => tool.id === name)?.permissionClass ?? 'status' }, false);
          const initial = evaluate();
          const safe = initial.decision !== 'deny' && JSON.stringify(initial.updatedInput) === JSON.stringify(args);
          const decision = safe && options.length ? await input.requestApproval({
            toolCallId: string(p.toolCallId) || requestId, toolName, input: args, nativeChoices: options,
            nativeSource: 'Muse Code', reason: string(p.reason) || initial.ruleReason
          }, t.signal) : undefined;
          if (!current()) return;
          const confirmed = JSON.stringify(evaluate()) === JSON.stringify(initial);
          const chosen = confirmed && decision?.nativeChoiceId
            ? choices.find(choice => choice.choiceId === decision.nativeChoiceId)
            : choices.find(choice => choice.decision === 'abort' || (choice.decision === 'denied' && choice.scope === 'once'));
          if (!chosen) throw new Error('Muse 审批选项已失效');
          await boundedAcpRequest(t.rpc!.request('approval/decide', { commandId: commandId(), sessionId: t.remoteSession,
            approvalId: requestId, choiceId: chosen.choiceId, requirementId: p.currentRequirementId }), REQUEST_TIMEOUT, 'Muse 审批', t.signal);
          return;
        }
        const questions = Array.isArray(p.questions) ? p.questions.map(record) : [];
        if (!input.requestUserQuestion || !questions.length) {
          await boundedAcpRequest(t.rpc!.request('userInput/cancel', { commandId: commandId(), sessionId: t.remoteSession, userInputId: requestId }), REQUEST_TIMEOUT, 'Muse 取消提问', t.signal);
          return;
        }
        const result = await input.requestUserQuestion({ questions: questions.map(q => ({ id: string(q.id), question: string(q.question),
          header: string(q.header), multiSelect: record(q.selection).mode === 'multiple',
          options: Array.isArray(q.options) ? q.options.map(record).map(o => ({ label: string(o.label), description: string(o.description) })) : [] })) });
        if (!current()) return;
        if (result.kind === 'aborted') {
          await boundedAcpRequest(t.rpc!.request('userInput/cancel', { commandId: commandId(), sessionId: t.remoteSession, userInputId: requestId }), REQUEST_TIMEOUT, 'Muse 取消提问', t.signal);
          return;
        }
        const answers = result.answers.map(answer => {
          const question = questions.find(q => q.id === answer.id);
          if (!question) throw new Error('Muse 提问的答案包含未知问题');
          const offered = new Set((Array.isArray(question.options) ? question.options.map(record) : []).map(o => string(o.label)));
          const labels = answer.selected.filter(s => offered.has(s));
          const unknown = answer.selected.filter(s => !offered.has(s));
          const free = [answer.custom, ...unknown].filter((s): s is string => !!s?.trim());
          const selection = record(question.selection);
          const count = labels.length + free.length;
          const min = typeof selection.minSelections === 'number' ? Math.max(1, selection.minSelections) : 1;
          const max = typeof selection.maxSelections === 'number' ? selection.maxSelections : selection.mode === 'multiple' ? Infinity : 1;
          if (free.length > 1 || count < min || count > max) throw new Error('Muse 提问的答案不符合选项数量要求');
          return { questionId: answer.id, ...(selection.mode === 'multiple' ? (labels.length ? { selectedLabels: labels } : {}) : labels.length ? { selectedLabel: labels[0] } : {}),
            ...(free.length ? { freeText: free[0] } : {}) };
        });
        if (answers.length !== questions.length) throw new Error('Muse 提问需要回答所有问题');
        await boundedAcpRequest(t.rpc!.request('userInput/answer', { commandId: commandId(), sessionId: t.remoteSession, userInputId: requestId, answers }), REQUEST_TIMEOUT, 'Muse 提问', t.signal);
      })().catch(error => { if (current()) t.fail(new Error(`Muse 交互失败：${diagnostic(error, t)}`)); });
    };

    const bindTurn = (t: ActiveTurn, id: string): void => {
      if (!t.startSubmitted || !id || (t.remoteTurn && t.remoteTurn !== id)) throw new Error('Muse 回合身份不一致');
      if (t.remoteTurn) return;
      t.remoteTurn = id;
      const early = t.earlyMessages.splice(0);
      t.earlyBytes = 0;
      for (const message of early) onMessage(t, message);
    };

    const onMessage = (t: ActiveTurn, message: JsonRpcMessage): void => {
      const p = record(message.params);
      if (!live(t) || !t.remoteSession || p.sessionId !== t.remoteSession) {
        if (message.id != null) t.rpc?.respondError(message.id, 'The originating session or turn has ended.');
        else if (live(t) && t.remoteSession && !p.sessionId &&
          /^(?:turn|item|approval|userInput|session)\//.test(message.method ?? '')) throw new Error('Muse 事件缺少会话标识，无法安全关联');
        return;
      }
      if (message.method === 'session/approvalModeChanged' && message.id == null) {
        if (isMuseApprovalMode(p.mode)) { nativeMode = p.mode; publishNativeConfig(); }
        return;
      }
      if (message.method === 'session/permissionProfileChanged' && message.id == null) {
        // The notification confirms only the profile ID. The axes belong to
        // the next complete native permission snapshot.
        if (typeof p.profileId === 'string' && p.profileId !== record(nativePermission).profileId) {
          nativePermission = { profileId: p.profileId };
          publishNativeConfig();
        }
        return;
      }
      if (!t.startSubmitted) {
        if (message.id != null) t.rpc?.respondError(message.id, 'No Muse turn has been submitted.');
        else if (message.method === 'session/closed') t.fail(new Error('Muse 已关闭会话'));
        return;
      }
      if (message.method === 'session/closed' && message.id == null) { t.fail(new Error('Muse 已关闭会话')); return; }
      if (message.method === 'turn/started') {
        if (p.commandId === t.startCommand && typeof p.turnId === 'string') bindTurn(t, p.turnId);
        return;
      }
      if (!t.remoteTurn) {
        // turn/started or the turn/start response may follow early item and
        // interaction frames. Keep them bounded until an authoritative ID is
        // known; never publish or approve a frame merely by session ID.
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (t.earlyMessages.length + t.pendingDeltaCount >= 256 || t.earlyBytes + t.pendingDeltaBytes + size > 8 * 1024 * 1024) throw new Error('Muse 早到事件超过缓冲上限');
        t.earlyMessages.push(message);
        t.earlyBytes += size;
        return;
      }
      if (message.id != null) { handleRequest(t, message, p); return; }
      if (message.method === 'approval/resolved') { t.resolvedRequests.add(string(p.approvalId)); return; }
      if (message.method === 'userInput/settled') { t.resolvedRequests.add(string(p.userInputId)); return; }
      if (message.method === 'turn/completed') {
        if (!p.turnId) throw new Error('Muse 回合完成事件缺少回合标识');
        if (p.turnId === t.remoteTurn) {
          if (t.pendingDeltaCount) throw new Error('Muse 输出无法关联到当前回合的消息项');
          t.finish(p);
        }
        return;
      }
      if (t.remoteTurn && p.turnId && p.turnId !== t.remoteTurn) return;
      if (message.method === 'session/contextUsage') {
        const usage = normalizeContextUsage(p.usedTokens, p.windowTokens);
        if (usage && usage.tokens !== null) {
          contextUsage = usage;
          queue.push({ type: 'context-usage', usage });
        }
        return;
      }
      if (message.method === 'item/delta') {
        const id = string(p.itemId), delta = string(p.delta);
        if (!id) throw new Error('Muse 消息增量缺少消息项标识');
        if (t.ignoredItems.has(id)) return;
        const tool = t.tools.get(id);
        if (!tool && !t.itemKinds.has(id)) {
          const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
          if (t.earlyMessages.length + t.pendingDeltaCount >= 256 || t.earlyBytes + t.pendingDeltaBytes + size > 8 * 1024 * 1024) throw new Error('Muse 早到消息增量超过缓冲上限');
          const pending = t.pendingDeltas.get(id) ?? [];
          pending.push(message);
          t.pendingDeltas.set(id, pending);
          t.pendingDeltaCount++;
          t.pendingDeltaBytes += size;
          return;
        }
        if (tool && delta) { tool.output = (tool.output + delta).slice(-100_000); queue.push({ type: 'tool-progress', toolCallId: id, delta }); }
        else if (p.field === 'text' && delta && t.itemKinds.get(id) === 'agentMessage') { t.messages.set(id, (t.messages.get(id) ?? '') + delta); queue.push({ type: 'text-delta', delta }); }
        return;
      }
      if (message.method !== 'item/started' && message.method !== 'item/updated' && message.method !== 'item/completed') return;
      const item = record(p.item), id = string(item.itemId), kind = string(item.kind);
      if (!id || !item.turnId || !kind) throw new Error('Muse 消息项缺少身份信息，无法安全关联');
      if (item.turnId !== t.remoteTurn) {
        if (t.itemKinds.has(id)) throw new Error('Muse 消息项跨回合复用了标识');
        t.ignoredItems.add(id);
        const pending = t.pendingDeltas.get(id) ?? [];
        for (const frame of pending) t.pendingDeltaBytes -= Buffer.byteLength(JSON.stringify(frame), 'utf8');
        t.pendingDeltaCount -= pending.length;
        t.pendingDeltas.delete(id);
        if (t.ignoredItems.size > 10_000) throw new Error('Muse 外部回合消息项过多');
        return;
      }
      if (t.ignoredItems.has(id)) throw new Error('Muse 消息项跨回合复用了标识');
      if (!t.itemKinds.has(id) && t.itemKinds.size >= 10_000) throw new Error('Muse 回合消息项过多');
      t.itemKinds.set(id, kind);
      const complete = message.method === 'item/completed';
      if (['toolCall', 'webSearch', 'subagent', 'userShell'].includes(kind) && !t.tools.has(id)) {
        const name = kind === 'toolCall' ? string(item.tool) || 'Muse tool' : kind === 'webSearch' ? 'Web search' : kind === 'subagent' ? 'Subagent' : 'Shell';
        let args: Record<string, unknown> = {};
        try { args = record(JSON.parse(string(item.args) || '{}')); } catch { args = { input: string(item.args) }; }
        if (item.commandText) args.command = item.commandText;
        if (item.objective) args.objective = item.objective;
        t.tools.set(id, { name, output: '', ended: false, inputSignature: JSON.stringify(args) });
        queue.push({ type: 'tool-start', toolCallId: id, toolName: name, input: args, ...(complete ? { reviewLate: true } : {}) });
      } else if (kind === 'toolCall' && typeof item.args === 'string' && item.args) {
        const tool = t.tools.get(id);
        if (tool && !tool.ended) {
          let args: Record<string, unknown> = {};
          try { args = record(JSON.parse(item.args)); } catch { args = { input: item.args }; }
          const signature = JSON.stringify(args);
          if (signature !== tool.inputSignature) {
            tool.inputSignature = signature;
            queue.push({ type: 'tool-update', toolCallId: id, toolName: tool.name, input: args, ...(complete ? { reviewLate: true } : {}) });
          }
        }
      }
      const pending = t.pendingDeltas.get(id) ?? [];
      t.pendingDeltas.delete(id);
      for (const frame of pending) {
        t.pendingDeltaCount--;
        t.pendingDeltaBytes -= Buffer.byteLength(JSON.stringify(frame), 'utf8');
        onMessage(t, frame);
      }
      if (kind === 'agentMessage' && complete) {
        const full = string(item.text), previous = t.messages.get(id) ?? '';
        if (full.startsWith(previous)) { const delta = full.slice(previous.length); if (delta) queue.push({ type: 'text-delta', delta }); }
        else if (full && !previous) queue.push({ type: 'text-delta', delta: full });
        else if (full !== previous) throw new Error('Muse 正文最终快照与已接收增量不一致，无法确认回复内容');
        t.messages.set(id, full);
      } else if (kind === 'reasoning' && complete && typeof item.text === 'string') queue.push({ type: 'thinking-delta', delta: item.text });
      else if (['toolCall', 'webSearch', 'subagent', 'userShell'].includes(kind)) {
        const tool = t.tools.get(id)!;
        if (complete && !tool.ended) {
          tool.ended = true;
          const output = string(item.visibleOutput) || string(item.finalSummary) || tool.output;
          queue.push({ type: 'tool-result', toolCallId: id, toolName: tool.name, ok: item.status === 'completed', output: output.slice(0, 100_000) });
        }
      }
    };

    const run = async (t: ActiveTurn, parts: unknown[]): Promise<void> => {
      let error: Error | undefined;
      try {
        t.mcp = await startMuseHostMcp(input, () => active === t ? t : undefined);
        assertLive(t);
        const cmd = museLaunch(executable, ['serve']);
        const env = { ...genericWorkerEnvironment(), MUSE_LOGIN: '0' };
        t.owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
          command: cmd.command,
          args: cmd.args,
          windows: { kind: 'taskkill' },
          spawnOptions: { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
            windowsVerbatimArguments: process.platform === 'win32' && path.basename(cmd.command).toLowerCase() === 'cmd.exe' }
        });
        const child = t.owner.child;
        t.rpc = new NdjsonRpc(child.stdin, child.stdout);
        child.on('error', cause => t.rpc?.failExternal(cause));
        child.stderr.resume();
        t.rpc.on('message', (message: JsonRpcMessage) => { try { onMessage(t, message); } catch (cause) { t.fail(cause as Error); } });
        t.rpc.on('parse-error', () => t.fail(new Error('Muse 返回无效 MSP 数据')));
        t.rpc.on('close', (cause: Error) => { if (!t.closing) t.fail(new Error(`Muse 连接已退出：${diagnostic(cause, t)}`)); });
        await boundedAcpRequest(t.owner.ready, REQUEST_TIMEOUT, 'Muse 进程启动', t.signal);
        assertLive(t);
        if (t.owner.state !== 'ready') throw new Error('Muse 进程已退出或正在回收');
        const request = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
          assertLive(t);
          const response = await boundedAcpRequest(t.rpc!.request(method, params), REQUEST_TIMEOUT, `Muse ${method}`, t.signal);
          assertLive(t);
          return record(response);
        };
        const init = await request('initialize', { clientInfo: { name: 'muster-workbench', title: 'muster Workbench', version: '0.1' }, capabilities: { experimentalApi: true, requestedCapabilities: ['sessionMcp'] } });
        if (!Array.isArray(init.grantedCapabilities) || !init.grantedCapabilities.includes('sessionMcp')) throw new Error('当前 Muse 版本不支持会话级 MCP，请升级 Muse 后重试');
        t.rpc.notify('initialized');
        const config = { mcpServers: { muster: { transport: 'streamableHttp', url: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` } } } };
        const resume = remoteSession;
        const desiredMode = automaticPermissions(input) ? undefined : pendingMode;
        const desiredProfile = automaticPermissions(input) ? undefined : pendingProfile;
        const profileSelection = desiredProfile ? { permissionProfile: desiredProfile } : {};
        const session = await request(resume ? 'session/resume' : 'session/start', resume
          ? { commandId: commandId(), sessionId: resume, excludeItems: true, ...profileSelection, config }
          : { commandId: commandId(), workspaceRoot: input.cwd, ...(desiredMode ? { approvalMode: desiredMode } : {}),
            ...(modelId && modelId !== 'default' ? { modelId } : {}), ...profileSelection, config });
        const nativeSession = record(session.session);
        const nativeId = string(nativeSession.sessionId);
        if (!nativeId || (resume && nativeId !== resume)) throw new Error('Muse 未确认原生会话标识，无法继续');
        remoteSession = t.remoteSession = nativeId;
        queue.push({ type: 'resume-token', token: nativeId });
        nativeLimits = nativeSession.currentLimits;
        nativePermission = nativeSession.permissionState;
        nativeMode = record(nativeSession.approvalMode).mode;
        if (desiredProfile && record(nativePermission).profileId !== desiredProfile) throw new Error('Muse did not confirm the selected permission profile.');
        if (pendingProfile === desiredProfile) pendingProfile = undefined;
        if (nativePermission !== undefined || desiredProfile || nativeProfiles !== undefined) {
          nativeProfiles = await readMuseProfiles(request, nativeId);
        }
        publishNativeConfig();
        if (desiredMode) {
          if (nativeMode !== desiredMode) {
            if (!resume) throw new Error('Muse did not confirm the initial approval mode.');
            await applyMode(t, String(desiredMode));
          }
          if (pendingMode === desiredMode) pendingMode = undefined;
        }
        await applyNativePermissionStrategy(input, () => nativeState,
          automaticNativeSelections(nativeState, [
            { id: 'permissionProfile', value: ':unrestricted' }, { id: 'approvalMode', value: 'allowAll' }
          ]),
          async (id, value) => {
            if (id === 'approvalMode') await applyMode(t, String(value));
            else if (id === 'permissionProfile') await applyProfile(t, String(value));
          });
        if (resume) {
          if (modelId && modelId !== 'default') await request('session/setModel', { commandId: commandId(), sessionId: nativeId, model: { modelId } });
        }
        // From this point a missing reply cannot prove whether Muse accepted
        // the input. A timeout is not permission to send it again.
        assertLive(t);
        t.startSubmitted = true;
        const started = await request('turn/start', { commandId: t.startCommand, sessionId: nativeId, input: parts });
        const startedId = string(started.turnId);
        if (started.status !== 'accepted' || started.commandId !== t.startCommand || !startedId || (t.remoteTurn && t.remoteTurn !== startedId)) {
          throw new Error('Muse 未确认本次命令及回合标识');
        }
        bindTurn(t, startedId);
        assertLive(t);
        policyPrefix = '';
        t.admitted = true;
        t.admit();
        const terminal = await Promise.race([t.completion, new Promise<never>((_, reject) => {
          if (t.signal.aborted) reject(new Error('Muse 回合已取消'));
          else t.signal.addEventListener('abort', () => reject(new Error('Muse 回合已取消')), { once: true });
        })]);
        if (terminal.terminal !== 'completed') {
          const detail = record(terminal.error);
          if (detail.kind === 'authRequired') throw new Error('Muse Code 未登录，请在终端运行 muse login 后重试');
          throw new Error(string(detail.message) || string(terminal.reason) || 'Muse 未能完成回合');
        }
      } catch (cause) { error = t.fatal ?? (cause instanceof Error ? cause : new Error(String(cause))); }
      t.ended = true;
      t.scope.close();
      t.controller.abort();
      t.closing = true;
      t.rpc?.close();
      try { if (t.owner) await t.owner.reclaim(); }
      catch (cause) {
        if (t.owner) pendingReclaim = { owner: t.owner, turn: t };
        error = new Error(`Muse 进程回收未确认：${diagnostic(cause, t)}`);
        poison = error;
      }
      try { if (t.mcp) await t.mcp.close(); }
      catch (cause) {
        permanentCleanupFailure = new Error(`Muse MCP 关闭失败：${diagnostic(cause, t)}`);
        error = pendingReclaim && error ? new Error(`${error.message}；${permanentCleanupFailure.message}`) : permanentCleanupFailure;
        poison = error;
      }
      if (active === t) active = undefined;
      if (!t.admitted) {
        const delivery = t.startSubmitted ? 'unknown' as const : 'not-submitted' as const;
        const detail = diagnostic(error ?? new Error('Muse 未确认消息'), t);
        t.rejectAdmission(new GuiDeliveryError(delivery === 'unknown'
          ? `Muse 消息的投递状态未知，请先检查原生会话后再决定是否重试：${detail}`
          : `Muse 消息尚未提交：${detail}`, delivery));
      } else if (!closed) {
        if (error) queue.push({ type: 'error', message: diagnostic(error, t) });
        else queue.push({ type: 'turn-complete' });
      }
    };

    return {
      events: queue,
      getNativeConfig: () => nativeState,
      async setNativeConfig(id, value) {
        if (closed) throw new Error('Muse connection closed.');
        if (id === 'approvalMode' && isMuseApprovalMode(value)) {
          if (active?.remoteSession) await applyMode(active, value);
          else pendingMode = nativeMode === value ? undefined : value;
        } else if (id === 'permissionProfile' && typeof value === 'string' &&
          nativeProfiles?.some(choice => choice.value === value && !choice.disabled)) {
          if (active?.remoteSession) await applyProfile(active, value);
          else pendingProfile = record(nativePermission).profileId === value ? undefined : value;
        } else throw new Error(`Invalid Muse setting ${id}.`);
      },
      async send(text, images, _parameters, authority) {
        if (closed) throw new Error('Muse 连接已关闭');
        if (poison) throw poison;
        if (active) throw new Error('Muse 仍有一个运行中的回合');
        const hostTurnId = input.getTurnId?.();
        if (!hostTurnId) throw new Error('宿主回合身份不可用，无法发送 Muse 消息');
        const body = appendGuiHostContext(text, policyPrefix);
        const parts = promptContent(body, images);
        const controller = new AbortController();
        let finish!: (value: Record<string, unknown>) => void;
        let fail!: (error: Error) => void;
        let admit!: () => void;
        let rejectAdmission!: (error: Error) => void;
        const completion = new Promise<Record<string, unknown>>((resolve, reject) => { finish = resolve; fail = reject; });
        const admission = new Promise<void>((resolve, reject) => { admit = resolve; rejectAdmission = reject; });
        const identity = authority?.forkIdentity;
        void completion.catch(() => {});
        const turn: ActiveTurn = { hostTurnId, scope: createPromptAuthorityScope(authority?.userText, !!input.nonUserTurns),
          signal: controller.signal, controller, completion, finish, admission, rejectAdmission, startSubmitted: false, admitted: false,
          admit: () => {
            if (identity?.userMessageId) queue.push({ type: 'engine-input', identity, text: body });
            admit();
          },
          fail: error => { turn.fatal ??= error; fail(error); controller.abort(); },
          startCommand: commandId(), closing: false, aborted: false, ended: false,
          earlyMessages: [], earlyBytes: 0, pendingDeltas: new Map(), pendingDeltaCount: 0, pendingDeltaBytes: 0,
          ignoredItems: new Set(), resolvedRequests: new Set(), messages: new Map(), itemKinds: new Map(), tools: new Map() };
        active = turn;
        turn.operation = run(turn, parts);
        void turn.operation.catch(cause => {
          poison = cause instanceof Error ? cause : new Error(String(cause));
          permanentCleanupFailure = poison;
          if (turn.owner && turn.owner.state !== 'released') pendingReclaim = { owner: turn.owner, turn };
          if (!turn.admitted) turn.rejectAdmission(new GuiDeliveryError(`Muse 资源收尾失败：${diagnostic(cause, turn)}`, turn.startSubmitted ? 'unknown' : 'not-submitted'));
          else queue.fail(cause);
        });
        await admission;
      },
      async receiveMessage() { return { status: 'unsupported', reason: 'Muse 的原生插话尚未完成可靠投递确认，请使用工作台队列' }; },
      redirect() { return false; },
      async abort() {
        const t = active;
        if (!t || t.ended) return;
        t.aborted = true;
        if (t.rpc && t.remoteSession && t.remoteTurn) {
          try { await boundedAcpRequest(t.rpc.request('turn/interrupt', { commandId: commandId(), sessionId: t.remoteSession, turnId: t.remoteTurn }), 3000, 'Muse 停止'); }
          catch (cause) { input.log('warn', `Muse 中止未确认，将回收进程：${diagnostic(cause, t)}`); }
        }
        t.controller.abort();
        await t.operation;
      },
      getContextUsage() { return contextUsage; },
      async close() {
        if (closing) return closing;
        const attempt = (async () => {
          if (!closed) {
            closed = true;
            const t = active;
            if (t) { t.controller.abort(); await t.operation; }
          }
          const pending = pendingReclaim;
          if (pending) {
            try {
              await pending.owner.reclaim();
              if (pendingReclaim === pending) pendingReclaim = undefined;
            } catch (cause) {
              const failure = new Error(`Muse 进程回收未确认：${diagnostic(cause, pending.turn)}`);
              poison = permanentCleanupFailure ? new Error(`${failure.message}；${permanentCleanupFailure.message}`) : failure;
              throw poison;
            }
          }
          if (permanentCleanupFailure) throw permanentCleanupFailure;
          queue.close();
          poison = undefined;
        })();
        closing = attempt;
        void attempt.catch(() => { if (closing === attempt) closing = undefined; });
        return attempt;
      }
    };
  }
}
