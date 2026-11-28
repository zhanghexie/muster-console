import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GuiDriverConnectInput, GuiUserQuestionRequest } from '../../types';
import type { CodexClientHandle, CodexInput, CodexThreadHandle, CodexThreadOptions, CodexTurnOptions } from './protocol';
import { challengeCodexWorker, codexWorkerAsset, type CodexWorkerLimits } from './workerProcess';
import { CodexProcessSupervisor } from './processSupervisor';
import { CodexRpcError, sameCodexHome, withCodexNativeRpc } from './nativeRpc';
import { spawnOwnedProcess } from '../../process/owner';
import { boundedAcpRequest } from '../../processReclamation';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { AsyncEventQueue } from '../eventQueue';
import { evaluateNativeToolBoundary } from '../../tools/policy';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { CodexAppServerEventMapper } from './appServerEvents';
import { normalizeContextUsage } from '../../../../shared/guiContextUsage';
import type { CodexDesktopDelivery } from './desktopDelivery';
import { applyNativePermissionStrategy, automaticNativeSelections } from '../nativePermissionPolicy';
import { codexNativeApproval, codexNativeConfig, codexNativeStartOverrides, codexWorkerPermissionSnapshot, readCodexConfigCatalog, type CodexConfigCatalog } from './nativeConfig';
import type { NativeConfigState, NativeConfigValue } from '../../../../shared/nativeSessionConfig';
import { assertWorktreeExecutionCurrent } from '../../../workspaceExecutionContext';
import { pathKey } from '../../../pathKey';
import { t } from '../../../../shared/i18n';

type Obj = Record<string, unknown>;
type RpcId = string | number;
type CodexRpcRequest = (method: string, params: Obj, timeoutMs?: number) => Promise<unknown>;
type ServerMessage = { id?: RpcId | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
type Interaction = { id: RpcId; method: string; params: Obj; hostTurn: string; controller: AbortController; settled: boolean };
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const keyOf = (id: RpcId): string => `${typeof id}:${String(id)}`;
const maxFrame = 1024 * 1024;
const maxPending = 64;

export interface CodexAppServerClientOptions {
  executable: string;
  env: Record<string, string>;
  host: GuiDriverConnectInput;
  hostMcpConfig: Record<string, unknown>;
  expectedTools: readonly string[];
  desktopDelivery?: CodexDesktopDelivery;
  /** Internal probe threads can opt out of persisting their native conversation. */
  ephemeral?: boolean;
  nativeSelections?: Array<{ id: string; value: NativeConfigValue }>;
  workerPermission?: GuiDriverConnectInput['workerPermission'];
  onNativeConfig?(state: NativeConfigState, catalog: CodexConfigCatalog): void;
  /** Bind the verified continuation to the workbench session before sending input. */
  onThreadRecovered?(sourceId: string, continuationId: string, stagingId?: string): Promise<void>;
}

async function forkLockedThread(request: CodexRpcRequest, sourceId: string, settings: Obj,
  created: (threadId: string) => void, warn: (error: unknown) => void): Promise<{ result: Obj; stagingId?: string }> {
  const latestTurn = async (threadId: string): Promise<Obj> => {
    const result = obj(await request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
    return Array.isArray(result.data) ? obj(result.data[0]) : {};
  };
  const savedTurn = await latestTurn(sourceId);
  if (savedTurn.status === 'inProgress') {
    throw new Error(t('Codex 正在处理原会话的回合。请等这轮结束后在集序重试。'));
  }
  const historyError = () => new Error(t('Codex 无法确认续聊线程的历史。请在集序重试。'));
  const lastTurnId = str(savedTurn.id);
  if (!lastTurnId || !['completed', 'failed', 'interrupted'].includes(str(savedTurn.status))) throw historyError();
  const result = obj(await request('thread/fork', {
    ...settings, threadId: sourceId, lastTurnId, excludeTurns: true, deferGoalContinuation: true
  }));
  const fork = obj(result.thread);
  const forkId = str(fork.id);
  if (!forkId || forkId === sourceId || fork.forkedFromId !== sourceId || fork.ephemeral !== false) throw historyError();
  created(forkId);
  const copied = await latestTurn(forkId);
  if (copied.id !== lastTurnId || copied.status !== savedTurn.status) throw historyError();
  if (fork.historyMode !== 'paginated' || fork.attachedToThreadId !== null) return { result };

  // Attaching requires writer ownership of the parent. Use the fork this
  // app-server just created, so the original can stay open in another client.
  let continuation: Obj;
  try {
    const goal = obj(await request('thread/goal/get', { threadId: forkId }, 5000));
    // Attached forks cannot defer automatic goal continuation.
    if (goal.goal !== null) return { result };
    continuation = obj(await request('thread/fork', {
      ...settings, threadId: forkId, lastTurnId, excludeTurns: true, attachToSource: true
    }, 10000));
  } catch (error) {
    warn(error);
    return { result };
  }
  const attached = obj(continuation.thread);
  const attachedId = str(attached.id);
  if (!attachedId || attachedId === sourceId || attachedId === forkId || attached.ephemeral !== false ||
      attached.forkedFromId !== forkId || attached.attachedToThreadId !== forkId) {
    warn('Codex did not confirm the attached continuation.');
    return { result };
  }
  created(attachedId);
  // Archiving the staging fork leaves its attached thread active in Codex.
  try { await request('thread/archive', { threadId: forkId }, 10000); }
  catch (error) { warn(error); }
  return { result: continuation, stagingId: forkId };
}

function translateInputs(input: CodexInput): Obj[] {
  if (typeof input === 'string') return [{ type: 'text', text: input, text_elements: [] }];
  return input.map(value => {
    if (value.type === 'text') return { type: 'text', text: value.text, text_elements: [] };
    if (value.type === 'local_image') return { type: 'localImage', path: value.path };
    throw new Error('Codex app-server 不支持此输入类型');
  });
}

function translateQuestions(params: Obj): GuiUserQuestionRequest | null {
  if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 16) return null;
  const questions: GuiUserQuestionRequest['questions'] = [];
  const ids = new Set<string>();
  for (const value of params.questions) {
    const q = obj(value), id = str(q.id), question = str(q.question);
    // The existing question card does not have a secret-input contract.
    if (!id || id.length > 128 || !question || question.length > 8000 || ids.has(id) || q.isSecret === true) return null;
    ids.add(id);
    const options = Array.isArray(q.options) ? q.options.slice(0, 50).map(value => obj(value))
      .map(option => ({ label: str(option.label), description: str(option.description) })).filter(option => option.label) : [];
    questions.push({ id, question, ...(str(q.header) ? { header: str(q.header) } : {}), ...(options.length ? { options } : {}) });
  }
  return { questions };
}

/** Each app-server turn owns its worker and process container. */
export function createCodexAppServerClient(options: CodexAppServerClientOptions, limits: CodexWorkerLimits = {}): CodexClientHandle {
  const workerPath = codexWorkerAsset('native-worker.mjs', limits.workerPath);
  const mcpEnv = obj(obj(obj(options.hostMcpConfig.mcp_servers).muster).env);
  const secrets = [...collectEnvSecrets(options.env), ...collectEnvSecrets(mcpEnv)];
  const clean = (value: unknown): string => redactSafetyText(value instanceof Error ? value.message : String(value), secrets).slice(0, 1600);
  const thread = (initialId: string | null, settings: CodexThreadOptions = {}): CodexThreadHandle => {
    let boundId = initialId;
    let supervisor: CodexProcessSupervisor | undefined;
    return {
      get id() { return boundId; },
      stop() { return supervisor?.stop() ?? Promise.resolve(); },
      async runStreamed(input: CodexInput, turn: CodexTurnOptions = {}) {
        return { events: (async function* () {
          let id = boundId;
          turn.signal?.throwIfAborted();
          const isolated = options.host.workspaceContext?.worktreeExecution;
          const assertIsolatedCwd = (value: unknown): void => {
            if (!isolated) return;
            if (typeof value !== 'string' || !path.isAbsolute(value) || pathKey(fs.realpathSync.native(value)) !== isolated.cwd.physicalPath) {
              throw new Error(`Codex did not confirm the isolated working directory: ${isolated.cwd.path}`);
            }
          };
          assertWorktreeExecutionCurrent(isolated);
          assertIsolatedCwd(settings.workingDirectory);
          const permissionTurn = options.workerPermission ? options.host.getTurnId?.() ?? '' : '';
          options.workerPermission?.assertCurrent(permissionTurn);
          let reader: ReadlineInterface | undefined;
          const owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
            command: process.execPath, args: [workerPath],
            spawnOptions: { env: genericWorkerEnvironment({ ELECTRON_RUN_AS_NODE: '1' }), stdio: 'pipe' },
            windows: { kind: 'job', jobPath: process.platform === 'win32' ? codexWorkerAsset('windows-job.ps1', limits.jobPath) : '' },
            monitor: {
              businessLabel: 'Codex 会话引擎',
              role: 'AI 会话工作进程',
              workspaceId: options.host.workspaceContext?.workspaceId,
              workspaceName: options.host.workspaceContext?.workspaceName,
              sessionId: options.host.sessionId,
              sessionName: options.host.sessionName,
              taskId: options.host.taskId
            },
            identityChallenge: (child, nonce, signal) => reader
              ? challengeCodexWorker(child, reader, nonce, signal)
              : Promise.reject(new Error('Codex 工作进程身份校验通道尚未初始化')),
            reclaimTimeoutMs: (limits.abortMs ?? 3000) * 2 + 100,
            spawnProcess: limits.spawnProcess,
            beforeReclaim: limits.terminate
          });
          const owned = new CodexProcessSupervisor(owner, turn.onExecution ?? (() => {}), limits);
          supervisor = owned;
          const child = owner.child;
          reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
          child.stdout.once('close', () => reader?.close());
          child.stderr.resume();
          const events = new AsyncEventQueue<unknown>({ maxBuffered: 512 });
          const mapper = new CodexAppServerEventMapper();
          const requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
          const interactions = new Map<string, Interaction>();
          const interactionQueue: Interaction[] = [];
          const childThreads = new Set<string>();
          const childTurns = new Map<string, string>();
          const childReviewMapper = new CodexAppServerEventMapper();
          let draining = false, finished = false, submitted = false, turnId = '', hostTurn = '';
          let nextId = 1, earlyBytes = 0;
          const early: ServerMessage[] = [];
          let bootstrap: Promise<void> | undefined;
          let bootstrapFailure: Error | undefined;
          let flushingEarly: Promise<void> | undefined;
          let configCatalog: CodexConfigCatalog | undefined;
          let nativeSettings: Obj = {};
          let unboundSource: string | undefined;
          const unboundForks: string[] = [];
          let configConfirmation: { matches(state: NativeConfigState): boolean; confirm(): void } | undefined;
          const observeSettings = (settings: Obj) => {
            nativeSettings = settings.runtimeWorkspaceRoots === undefined && nativeSettings.runtimeWorkspaceRoots !== undefined
              ? { ...settings, runtimeWorkspaceRoots: nativeSettings.runtimeWorkspaceRoots } : settings;
            if (!configCatalog) return;
            const state = codexNativeConfig(configCatalog, settings);
            if (!unboundSource) options.onNativeConfig?.(state, configCatalog);
            if (configConfirmation?.matches(state)) configConfirmation.confirm();
          };

          const fail = (error: unknown): void => {
            if (finished) return;
            // Invalidate delivery before notifying the consumer: it may not be
            // draining the event queue, while an acknowledgement is awaiting a lock.
            if (hostTurn) options.desktopDelivery?.end(hostTurn);
            finished = true;
            const message = clean(error);
            const err = new Error(submitted && !turnId ? `${message}；消息可能已经提交，请检查 Codex 会话后再重试` : message);
            for (const pending of requests.values()) pending.reject(err);
            requests.clear();
            for (const pending of interactions.values()) pending.controller.abort();
            interactions.clear(); interactionQueue.length = 0;
            owned.markResult('failed');
            events.failAfterBuffered(err);
          };
          // The normal frame pump can be waiting for a durable acknowledgement.
          // Observe process failure independently so a queued exit cannot leave
          // that acknowledgement live until the pump resumes.
          reader.on('line', line => {
            if (finished || Buffer.byteLength(line, 'utf8') > 4 * maxFrame) return;
            try {
              const wrapper = obj(JSON.parse(line));
              if (wrapper.type === 'app-error') fail(new Error(str(wrapper.error) || 'Codex app-server 连接错误'));
              else if (wrapper.type === 'app-exit') fail(new Error(`Codex app-server 在回合结束前退出${str(wrapper.stderr) ? `：${clean(wrapper.stderr)}` : ''}`));
            } catch { /* the frame pump reports malformed output */ }
          });
          child.once('exit', () => { if (!finished) fail(new Error('Codex 工作进程在回合结束前退出')); });
          reader.once('close', () => { if (!finished) fail(new Error('Codex 工作进程输出提前结束')); });
          const write = (value: Obj): void => {
            if (finished || child.stdin.destroyed || !child.stdin.writable) throw new Error('Codex app-server 连接已关闭');
            const line = JSON.stringify({ type: 'app-rpc', value }) + '\n';
            if (Buffer.byteLength(line) > maxFrame || child.stdin.writableLength + Buffer.byteLength(line) > 8 * maxFrame) throw new Error('Codex app-server 请求超限');
            child.stdin.write(line);
          };
          const request = (method: string, params: Obj, timeoutMs = 30_000): Promise<unknown> => {
            const requestId = nextId++;
            const promise = new Promise<unknown>((resolve, reject) => requests.set(requestId, { resolve, reject }));
            try { write({ id: requestId, method, params }); } catch (error) { requests.delete(requestId); throw error; }
            return boundedAcpRequest(promise, timeoutMs, `Codex ${method}`, turn.signal);
          };
          const respond = (serverId: RpcId, result: Obj): void => { write({ id: serverId, result }); };
          const respondError = (serverId: RpcId, message: string): void => { write({ id: serverId, error: { code: -32601, message } }); };
          const current = (it: Interaction): boolean => !finished && !it.settled && !it.controller.signal.aborted &&
            options.host.getTurnId?.() === it.hostTurn;
          const denied = (it: Interaction): Obj => it.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
            : it.method === 'item/tool/requestUserInput' ? { answers: {} }
              : it.method === 'mcpServer/elicitation/request' ? { action: 'cancel', content: null } : { decision: 'decline' };
          const processInteraction = async (it: Interaction): Promise<void> => {
            if (!current(it)) return;
            const p = it.params;
            if (it.method === 'item/tool/requestUserInput') {
              const questions = translateQuestions(p);
              if (!questions || !options.host.requestUserQuestion) { if (current(it)) respond(it.id, denied(it)); return; }
              const answer = await options.host.requestUserQuestion(questions, it.controller.signal);
              if (!current(it)) return;
              const answers: Obj = {};
              if (answer.kind === 'answered') for (const value of answer.answers) {
                if (!questions.questions.some(question => question.id === value.id)) continue;
                const selected = [...value.selected, ...(value.custom ? [value.custom] : [])].filter(Boolean);
                if (selected.length) answers[value.id] = { answers: selected };
              }
              respond(it.id, { answers }); return;
            }
            if (it.method === 'mcpServer/elicitation/request') { respond(it.id, denied(it)); return; }
            const isCommand = it.method === 'item/commandExecution/requestApproval';
            const isFile = it.method === 'item/fileChange/requestApproval';
            const toolName = isCommand ? 'bash' : isFile ? 'edit' : 'codex.request_permissions';
            const itemId = str(p.itemId);
            const details: Obj = { ...mapper.input(itemId), ...p };
            const evaluate = () => evaluateNativeToolBoundary({
                engineToolName: toolName, input: details, cwd: options.host.cwd, workspaceContext: options.host.workspaceContext,
                hostToolIds: options.host.hostTools.map(tool => tool.id),
                hostClassOf: name => options.host.hostTools.find(tool => tool.id === name)?.permissionClass ?? 'dynamic' }, false);
            const before = evaluate();
            // An app-server approval response cannot rewrite the original native call.
            if (before.decision === 'deny' || JSON.stringify(before.updatedInput) !== JSON.stringify(details)) { respond(it.id, denied(it)); return; }
            const choices = codexNativeApproval(it.method, p);
            if (!choices.length) { respond(it.id, denied(it)); return; }
            const decision = await options.host.requestApproval({ toolCallId: str(p.approvalId) || itemId || `codex-${randomUUID()}`, toolName, input: details,
              nativeSource: 'Codex', nativeChoices: choices.map(choice => choice.view),
              ...(str(p.reason) ? { reason: str(p.reason) } : {}) }, it.controller.signal);
            if (!current(it)) return;
            const after = evaluate();
            const selected = choices.find(choice => choice.view.id === decision.nativeChoiceId);
            respond(it.id, selected && JSON.stringify(after) === JSON.stringify(before) ? selected.result : denied(it));
          };
          const drainInteractions = (): void => {
            if (draining) return;
            draining = true;
            void (async () => {
              while (interactionQueue.length && !finished) {
                const it = interactionQueue.shift()!;
                if (!current(it)) {
                  // A queued request may become stale before its card opens. Do not
                  // leave it hanging on the server or retain it in our bounded map.
                  if (!it.settled && !it.controller.signal.aborted && !finished) {
                    try { respond(it.id, denied(it)); } catch (error) { fail(error); }
                  }
                  it.settled = true; interactions.delete(keyOf(it.id));
                  continue;
                }
                try { await processInteraction(it); }
                catch (error) {
                  options.host.log('warn', `Codex 交互失败：${clean(error)}`);
                  if (current(it)) { try { respond(it.id, denied(it)); } catch (cause) { fail(cause); } }
                } finally { it.settled = true; interactions.delete(keyOf(it.id)); }
              }
            })().finally(() => { draining = false; if (interactionQueue.length && !finished) drainInteractions(); });
          };
          const acceptInteraction = (message: ServerMessage): void => {
            const serverId = message.id, method = message.method ?? '', p = obj(message.params);
            if (typeof serverId !== 'number' && typeof serverId !== 'string') return;
            const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
              'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(method);
            if (!supported) { respondError(serverId, '此 Codex 交互请求尚不支持'); return; }
            const nativeThread = str(p.threadId), nativeTurn = str(p.turnId);
            const belongs = nativeThread === id ? nativeTurn === turnId : childThreads.has(nativeThread) && childTurns.get(nativeThread) === nativeTurn && !!nativeTurn;
            if (!submitted || !hostTurn || !belongs || interactions.has(keyOf(serverId)) || interactions.size >= maxPending) {
              respond(serverId, denied({ id: serverId, method, params: p, hostTurn, controller: new AbortController(), settled: false }));
              if (nativeThread && nativeThread !== id && !belongs) throw new Error('Codex 子线程交互无法关联到当前回合，已拒绝请求');
              return;
            }
            const it: Interaction = { id: serverId, method, params: p, hostTurn, controller: new AbortController(), settled: false };
            interactions.set(keyOf(serverId), it); interactionQueue.push(it); drainInteractions();
          };
          const handleNotification = async (message: ServerMessage): Promise<void> => {
            if (finished) return;
            const method = message.method ?? '', p = obj(message.params);
            if (method === 'thread/settings/updated') {
              if (id && p.threadId === id) observeSettings(obj(p.threadSettings));
              return;
            }
            if (!turnId && submitted && (/^(turn|item|mcpServer|serverRequest)\//.test(method) || method === 'thread/tokenUsage/updated')) {
              const size = Buffer.byteLength(JSON.stringify(message));
              if (early.length >= 512 || earlyBytes + size > 4 * maxFrame) throw new Error('Codex 回合关联缓冲超限');
              early.push(message); earlyBytes += size; return;
            }
            if (method === 'serverRequest/resolved') {
              const requestId = p.requestId;
              if (typeof requestId !== 'number' && typeof requestId !== 'string') return;
              const it = interactions.get(keyOf(requestId));
              if (it && str(p.threadId) === str(it.params.threadId)) { it.settled = true; it.controller.abort(); interactions.delete(keyOf(requestId)); }
              return;
            }
            if (message.id != null) { acceptInteraction(message); return; }
            const eventThread = str(p.threadId);
            if (/^(turn|item)\//.test(method) && !eventThread) throw new Error('Codex 回合事件缺少会话标识');
            if (eventThread && eventThread !== id && !childThreads.has(eventThread)) return;
            const eventTurn = str(p.turnId) || str(obj(p.turn).id);
            if (/^(turn|item)\//.test(method) && !eventTurn) throw new Error('Codex 回合事件缺少回合标识');
            if (eventThread === id && eventTurn && eventTurn !== turnId) return;
            if (eventThread && eventThread !== id && method === 'turn/started') childTurns.set(eventThread, eventTurn);
            const childCurrent = eventThread !== id && childTurns.get(eventThread) === eventTurn && !!eventTurn;
            if ((method === 'item/started' || method === 'item/completed') && eventThread && (eventThread === id || childCurrent)) {
              const item = obj(p.item);
              if (item.type === 'collabAgentToolCall' && str(item.senderThreadId) === eventThread && Array.isArray(item.receiverThreadIds)) {
                for (const target of item.receiverThreadIds) if (typeof target === 'string' && target && childThreads.size < 256) childThreads.add(target);
              }
            }
            // Child messages remain private to the child; only current-turn file
            // and shell events are projected into the parent's review collector.
            if (eventThread && eventThread !== id) {
              if (method === 'turn/completed' && childCurrent) {
                childTurns.delete(eventThread);
                return;
              }
              if (!childCurrent) return;
              const item = obj(p.item);
              const isFileOrShell = (method === 'item/started' || method === 'item/completed') &&
                (item.type === 'fileChange' || item.type === 'commandExecution');
              const isPatch = method === 'item/fileChange/patchUpdated';
              const rawItemId = isPatch ? str(p.itemId) : str(item.id);
              if ((!isFileOrShell && !isPatch) || !rawItemId) return;
              const itemId = `child-${createHash('sha256').update(eventThread).update('\0').update(eventTurn).update('\0').update(rawItemId).digest('hex')}`;
              const childParams = isPatch ? { ...p, itemId } : { ...p, item: { ...item, id: itemId } };
              for (const event of childReviewMapper.map(method, childParams)) {
                if (obj(event).type === 'app.review-warning') events.push(event);
                else events.push({ type: 'app.review-only', event });
              }
              return;
            }
            if (method === 'item/completed' && eventThread === id && eventTurn === turnId && options.desktopDelivery) {
              // Keep the native event and durable acknowledgement ordered before
              // a following turn/completed tears down the desktop lifetime.
              await boundedAcpRequest(options.desktopDelivery.observe(hostTurn, message), 5000, 'Codex 桌面投递', turn.signal);
            }
            if (method === 'thread/tokenUsage/updated') {
              if (!submitted || !turnId || eventThread !== id || eventTurn !== turnId) return;
              const usage = obj(p.tokenUsage);
              const snapshot = normalizeContextUsage(obj(usage.last).totalTokens, usage.modelContextWindow);
              if (snapshot && snapshot.tokens !== null) events.push({ type: 'app.context-usage', usage: snapshot });
              return;
            }
            if (method === 'turn/completed') {
              const result = obj(p.turn), status = str(result.status);
              for (const pending of interactions.values()) pending.controller.abort();
              interactions.clear(); interactionQueue.length = 0;
              if (hostTurn) options.desktopDelivery?.end(hostTurn);
              if (status === 'completed') { events.push({ type: 'app.turn-identity', turnId }); events.push({ type: 'turn.completed' }); owned.markResult('completed'); }
              else {
                const raw = obj(result.error);
                const error = { message: clean(str(raw.message) || (status === 'interrupted' ? 'Codex 回合已中断' : 'Codex 回合失败')),
                  ...(status === 'interrupted' ? {} : { codexErrorInfo: raw.codexErrorInfo, code: raw.code, status: raw.status }) };
                events.push({ type: 'turn.failed', error }); owned.markResult('failed');
              }
              finished = true; events.close(); return;
            }
            if (method === 'error' && p.willRetry !== true) {
              const messageText = clean(str(obj(p.error).message) || 'Codex 回合失败');
              if (hostTurn) options.desktopDelivery?.end(hostTurn);
              // An error notification is weaker evidence than turn/completed.
              events.push({ type: 'error', message: messageText }); owned.markResult('failed'); finished = true; events.close(); return;
            }
            for (const event of mapper.map(method, p)) events.push(event);
          };

          const abort = (): void => {
            if (hostTurn) options.desktopDelivery?.end(hostTurn);
            if (!finished) {
              finished = true;
              for (const it of interactions.values()) it.controller.abort();
              interactions.clear(); interactionQueue.length = 0;
              for (const pending of requests.values()) pending.reject(new Error('Codex 回合已取消'));
              requests.clear(); events.close();
            }
            void owned.stop().catch(() => {});
          };
          turn.signal?.addEventListener('abort', abort, { once: true });
          try {
            await owner.ready;
            if (turn.signal?.aborted || owner.state !== 'ready') throw new Error('Codex 工作进程已停止');
            assertWorktreeExecutionCurrent(isolated);
            child.stdin.write(JSON.stringify({ type: 'run-app-server', executable: options.executable, cwd: settings.workingDirectory, env: options.env }) + '\n');
            bootstrap = (async () => {
              const init = obj(await request('initialize', { clientInfo: { name: 'muster_workbench', title: 'muster Workbench', version: '0.1.31' },
                capabilities: { experimentalApi: true } }));
              if (!sameCodexHome(init.codexHome, options.env)) throw new Error('Codex 会话存储位置不一致，无法安全恢复');
              write({ method: 'initialized', params: {} });
              const fragment = options.hostMcpConfig, servers = obj(fragment.mcp_servers), muster = obj(servers.muster);
              if (!Object.keys(muster).length) throw new Error('Codex 宿主工具配置不可用');
              const config: Obj = { show_raw_agent_reasoning: true, 'mcp_servers.muster': { ...muster, required: true } };
              configCatalog = await readCodexConfigCatalog(request, settings.workingDirectory ?? options.host.cwd);
              const selections = options.nativeSelections ?? [];
              const nativeOverrides = codexNativeStartOverrides(configCatalog, selections);
              const base: Obj = { cwd: settings.workingDirectory, config, ...(id && options.workerPermission ? {} : nativeOverrides),
                ...(settings.model ? { model: settings.model } : {}) };
              const sourceId = id;
              const commitRecovery = options.onThreadRecovered;
              let threadResult: Obj;
              let stagingId: string | undefined;
              try {
                threadResult = obj(await request(sourceId ? 'thread/resume' : 'thread/start', sourceId ? { ...base, threadId: sourceId, excludeTurns: true }
                  : { ...base, ...(options.ephemeral ? { ephemeral: true } : {}) }));
              } catch (error) {
                if (!sourceId || !commitRecovery || !(error instanceof CodexRpcError) || error.code !== -32600 ||
                    !error.message.endsWith(`thread ${sourceId} already has an active writer`)) throw error;
                const recovery = await forkLockedThread(request, sourceId, base,
                  threadId => unboundForks.push(threadId),
                  error => options.host.log('warn', `Codex continuation visibility could not be confirmed: ${clean(error)}`));
                threadResult = recovery.result;
                stagingId = recovery.stagingId;
                unboundSource = sourceId;
              }
              const remote = str(obj(threadResult.thread).id);
              if (!remote || (sourceId && remote !== sourceId && !unboundSource)) throw new Error('Codex 恢复返回了不匹配的会话标识');
              assertIsolatedCwd(threadResult.cwd);
              id = remote;
              if (!unboundSource) boundId = remote;
              if (!options.workerPermission && !unboundSource) events.push({ type: 'thread.started', thread_id: remote });
              observeSettings(threadResult);
              const collaboration = selections.find(selection => selection.id === 'collaborationMode')?.value;
              if (typeof collaboration === 'string' && !obj(nativeSettings.collaborationMode).mode) {
                // thread/start omits collaborationMode. An already-selected
                // mode is a no-op and the setter does not send a notification.
                const attached = obj(await request('thread/resume', { threadId: id, excludeTurns: true }));
                if (str(obj(attached.thread).id) !== id) throw new Error('Codex did not return the current thread settings.');
                assertIsolatedCwd(attached.cwd);
                observeSettings(attached);
              }
              if (typeof collaboration === 'string' && obj(nativeSettings.collaborationMode).mode !== collaboration) {
                let confirm!: () => void;
                const confirmation = new Promise<void>(resolve => { confirm = resolve; });
                configConfirmation = { matches: state => state.options.some(option => option.id === 'collaborationMode' && option.currentValue === collaboration), confirm };
                try {
                  await request('thread/settings/update', { threadId: id, collaborationMode: { mode: collaboration, settings: {
                    model: str(nativeSettings.model), reasoning_effort: settings.modelReasoningEffort ?? nativeSettings.reasoningEffort ?? null,
                    developer_instructions: null
                  } } });
                  await boundedAcpRequest(confirmation, 5000, 'Codex 协作模式确认', turn.signal);
                } finally { configConfirmation = undefined; }
              }
              const observed = codexNativeConfig(configCatalog, nativeSettings);
              const confirmWorkerPermission = () => {
                if (!options.workerPermission) return;
                options.workerPermission.assertCurrent(permissionTurn);
                if (codexWorkerPermissionSnapshot(nativeSettings, settings.workingDirectory ?? options.host.cwd, selections) !== options.workerPermission.snapshot) {
                  throw new Error('Codex permissions changed after approval. Confirm the Worker candidate permissions in Settings.');
                }
              };
              confirmWorkerPermission();
              if (!options.workerPermission && selections.some(selection => observed.options.find(option => option.id === selection.id)?.currentValue !== selection.value)) {
                throw new Error('Codex did not confirm the selected native configuration.');
              }
              if (!options.workerPermission) {
                await applyNativePermissionStrategy(options.host, () => codexNativeConfig(configCatalog!, nativeSettings), automaticNativeSelections(observed, [
                  { id: 'permissions', value: ':danger-full-access' },
                  { id: 'approvalPolicy', value: 'never' }
                ]), async (setting, value) => {
                  const override = codexNativeStartOverrides(configCatalog!, [{ id: setting, value }]);
                  let confirm!: () => void;
                  const confirmation = new Promise<void>(resolve => { confirm = resolve; });
                  configConfirmation = { matches: state => state.options.some(option => option.id === setting && option.currentValue === value), confirm };
                  try {
                    await request('thread/settings/update', { threadId: id, ...override });
                    await boundedAcpRequest(confirmation, 5000, 'Codex 原生权限确认', turn.signal);
                  } finally { configConfirmation = undefined; }
                });
              }
              const deadline = Date.now() + 10_000;
              for (;;) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new Error('Codex 宿主工具连接超时，请检查 MCP 配置后重试');
                const statuses = obj(await request('mcpServerStatus/list', { threadId: id, serverName: 'muster', limit: 100 }, remaining));
                const status = Array.isArray(statuses.data) ? statuses.data.map(obj).find(entry => entry.name === 'muster') : undefined;
                const state = str(status?.runtimeStatus);
                if (state === 'connected') {
                  const tools = obj(status?.tools);
                  if (status?.toolsError || options.expectedTools.some(name => !(name in tools))) throw new Error('Codex 宿主工具目录不完整，请检查 MCP 配置后重试');
                  break;
                }
                if (state !== 'starting' && state !== 'notStarted') throw new Error(`Codex 宿主工具未连接（${state || '状态未知'}），请检查 MCP 配置后重试`);
                await boundedAcpRequest(new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remaining))), Math.max(1, remaining), 'Codex 宿主工具连接', turn.signal);
              }
              hostTurn = options.host.getTurnId?.() ?? '';
              if (!hostTurn || turn.signal?.aborted) throw new Error('Codex 回合已取消');
              const nativeInput = translateInputs(input);
              const recoveredSource = unboundSource;
              if (recoveredSource && commitRecovery) {
                await commitRecovery(recoveredSource, remote, stagingId);
                boundId = remote;
                unboundForks.length = 0;
                if (finished || turn.signal?.aborted || options.host.getTurnId?.() !== hostTurn) throw new Error('Codex 回合已取消');
                unboundSource = undefined;
                observeSettings(nativeSettings);
              }
              confirmWorkerPermission();
              assertWorktreeExecutionCurrent(isolated);
              if (options.workerPermission || recoveredSource) events.push({ type: 'thread.started', thread_id: remote });
              options.desktopDelivery?.begin(hostTurn, turn.signal);
              submitted = true;
              const startRequest = request('turn/start', { threadId: id, input: nativeInput,
                ...(isolated ? { cwd: isolated.cwd.path } : {}),
                ...(settings.model ? { model: settings.model } : {}), ...(settings.modelReasoningEffort ? { effort: settings.modelReasoningEffort } : {}) });
              turn.onSubmission?.();
              const start = obj(await startRequest);
              turnId = str(obj(start.turn).id);
              if (!turnId) throw new Error('Codex 未返回回合标识');
              options.desktopDelivery?.bind(hostTurn, id, turnId);
              events.push({ type: 'turn.started' });
              flushingEarly = (async () => { for (const message of early.splice(0)) await handleNotification(message); })();
              await flushingEarly;
              flushingEarly = undefined;
              earlyBytes = 0;
            })().catch(error => { bootstrapFailure = new Error(clean(error)); fail(bootstrapFailure); });
            const pump = (async () => {
              try {
                for await (const line of reader!) {
                  if (finished) break;
                  if (Buffer.byteLength(line, 'utf8') > 4 * maxFrame) throw new Error('Codex 工作进程输出超限');
                  let wrapper: Obj;
                  try { wrapper = obj(JSON.parse(line)); } catch { throw new Error('Codex 工作进程输出不是有效 JSON'); }
                  if (wrapper.type === 'ready') continue;
                  if (wrapper.type === 'app-error') throw new Error(str(wrapper.error) || 'Codex app-server 连接错误');
                  if (wrapper.type === 'app-exit') throw new Error(`Codex app-server 在回合结束前退出${str(wrapper.stderr) ? `：${clean(wrapper.stderr)}` : ''}`);
                  if (wrapper.type !== 'app-rpc') continue;
                  const message = obj(wrapper.value) as ServerMessage;
                  if (typeof message.method === 'string') {
                    if (flushingEarly) await flushingEarly;
                    await handleNotification(message);
                    continue;
                  }
                  if (typeof message.id !== 'number') continue;
                  const pending = requests.get(message.id);
                  if (!pending) continue;
                  requests.delete(message.id);
                  if (message.error) pending.reject(new CodexRpcError(str(message.error.message) || 'Codex 请求失败', message.error.code));
                  else pending.resolve(message.result);
                }
                if (!finished && !turn.signal?.aborted) throw new Error('Codex app-server 输出提前结束');
              } catch (error) { fail(error); }
            })();
            for await (const event of events) yield event;
            await bootstrap;
            if (bootstrapFailure && !turn.signal?.aborted) throw bootstrapFailure;
            void pump;
          } finally {
            if (hostTurn) options.desktopDelivery?.end(hostTurn);
            finished = true;
            for (const it of interactions.values()) it.controller.abort();
            for (const pending of requests.values()) pending.reject(new Error('Codex 连接已关闭'));
            requests.clear();
            turn.signal?.removeEventListener('abort', abort);
            try { await owned.release(); }
            finally { reader.close(); }
            // An EOF may end the event stream while the registry write is
            // still in flight. Its outcome decides whether the fork is ours
            // to archive or has become the current binding.
            await bootstrap;
            if (unboundForks.length) {
              // The original writer belongs to another client. Only archive
              // new forks whose ancestry we verified and never bound locally.
              try {
                await withCodexNativeRpc(settings.workingDirectory ?? options.host.cwd, options.executable, options.env, async request => {
                  for (const threadId of unboundForks.reverse()) {
                    try {
                      const result = await request('thread/archive', { threadId });
                      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid archive receipt');
                    }
                    catch (error) { options.host.log('warn', `Could not archive unused Codex continuation ${threadId}: ${clean(error)}`); }
                  }
                }, { workerPath, jobPath: limits.jobPath, timeoutMs: 5_000 });
              } catch (error) { options.host.log('warn', `Could not clean up unused Codex continuations: ${clean(error)}`); }
            }
          }
        })() };
      }
    };
  };
  return { startThread: settings => thread(null, settings), resumeThread: (id, settings) => thread(id, settings) };
}
