/** Supervise one Pi SDK process and bind every callback to its host session. */
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../../context';
import { createPromptAuthorityScope } from '../../../agent/turnScope';
import { hasSkillsManagementService, managedGlobalSkillPaths, managedSkillPaths, prepareManagedRuntimeSkillFilter } from '../../../capabilityManagement/runtimeSkills';
import { getMemoryService } from '../../../memory/serviceRef';
import { inboundMcpLaunch } from '../../../inboundMcp/launch';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { ConnectionCleanupError } from '../../host/retirement';
import { spawnOwnedProcess } from '../../process/owner';
import { createGuiHostToolGateway } from '../../tools/gateway';
import { turnChanges } from '../../../turnChanges/runtime';
import { GuiDeliveryError } from '../../types';
import type { GuiDriverConnectInput, GuiDriverStreamEvent, GuiRuntimeConnection, GuiSendImage } from '../../types';
import { AsyncEventQueue } from '../eventQueue';
import { toUnpackedAsarPath } from '../../../asarPaths';
import { HIDE_CONSOLE_PRELOAD, resolveConsolePreloadFile, withWin32HiddenConsole } from '../win32/harnessEnv';
import { redactSafetyText } from '../../../safety/redact';
import type { GuiContextUsage } from '../../types';
import type { ModelParameterValues } from '../../../../shared/modelParameters';
import type { RuntimeMessage } from '../../../../shared/runtimeCommunication';
import type { PlanStepView } from '../../../../shared/types';
import { isPlanToolName } from '../../../../shared/planExtract';
import type { GuiApprovalRequest } from '../../types';
import type { PiShellEnv } from './shellEnv';
import { GuiPiDesktopDelivery } from './desktopDelivery';
import { isDesktopLookCall } from '../../../desktop/lookInvocation';
import type { PiGlobalDeliveryAccess } from '../../piGlobalDelivery';
import { PI_WORKER_IMAGE_CHUNK_CHARS, PI_WORKER_MAX_IMAGE_CHARS, PI_WORKER_MAX_MESSAGE_BYTES, PI_WORKER_MAX_PENDING, type PiMemorySnapshot, type PiWorkerCreate, type PiWorkerModeState, type PiWorkerRequest, type PiWorkerResponse } from './workerProtocol';

interface PiWorkerHostOptions {
  ctx: AppContext;
  userDataDir: string;
  providerId: string;
  modelId: string;
  providerDefaultOutput?: import('../../../agent/piConfigSync').PiSyncResult['providerDefaultOutput'];
  shellEnv: PiShellEnv;
  secrets: string[];
  /** Private host composition; never sent over worker IPC. */
  globalDelivery?: PiGlobalDeliveryAccess;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Scope = ReturnType<typeof createPromptAuthorityScope>;
type RequestBody<T = PiWorkerRequest> = T extends { type: 'request'; id: number }
  ? Omit<T, 'type' | 'id'> : never;
interface PiLease { state: 'active' | 'retiring'; reclaim(): Promise<void> }
const leases = new Map<string, PiLease>();

export function resolvePiWorkerFile(): string | undefined {
  const candidates = [
    path.join(__dirname, 'worker.cjs'),
    path.join(__dirname, 'agentSession', 'drivers', 'pi', 'worker.cjs')
  ].map(toUnpackedAsarPath);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function windowsJobFile(): string {
  const candidates = [
    path.join(__dirname, '..', 'codex', 'worker', 'windows-job.ps1'),
    path.join(__dirname, 'agentSession', 'drivers', 'codex', 'worker', 'windows-job.ps1')
  ].map(toUnpackedAsarPath);
  const result = candidates.find(candidate => fs.existsSync(candidate));
  if (!result) throw new Error('未找到内置引擎进程树管理文件，请重新构建或重新安装工作台');
  return result;
}

function waitForWorkerReady(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => finish(new Error('内置引擎进程身份验证已取消'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    void ready.then(() => finish(), error => finish(error instanceof Error ? error : new Error(String(error))));
    if (signal.aborted) onAbort();
  });
}

/** Bind the opened Windows process handle to this still-unactivated IPC peer. */
function confirmWorkerIdentity(child: ChildProcess, nonce: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, response?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onDisconnect);
      if (error) reject(error); else resolve(response!);
    };
    const onAbort = (): void => finish(new Error('内置引擎进程身份验证已取消'));
    const onError = (error: Error): void => finish(new Error(`内置引擎进程身份验证失败：${error.message}`));
    const onExit = (): void => finish(new Error('内置引擎进程在身份验证时退出'));
    const onDisconnect = (): void => finish(new Error('内置引擎身份验证 IPC 已断开'));
    const onMessage = (raw: unknown): void => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const message = raw as Record<string, unknown>;
      if (message.type !== 'identity-response') return;
      if (typeof message.nonce !== 'string') finish(new Error('内置引擎身份验证响应无效'));
      else finish(undefined, message.nonce);
    };
    if (signal.aborted) { finish(new Error('内置引擎进程身份验证已取消')); return; }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('内置引擎进程身份验证超时')), 10_000);
    timer.unref?.();
    if (signal.aborted) { onAbort(); return; }
    if (!child.connected || !child.send) { onDisconnect(); return; }
    try {
      child.send({ type: 'identity-challenge', nonce } satisfies PiWorkerRequest, error => {
        if (error) onError(error);
      });
    } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
  });
}

function modeSnapshot(input: GuiDriverConnectInput): PiWorkerModeState {
  return {
    mode: input.modeController.mode,
    executing: input.modeController.executing,
    planSteps: input.modeController.planSteps.map(step => ({ ...step }))
  };
}

function serializableInput(input: GuiDriverConnectInput): PiWorkerCreate['dto'] {
  const dto = { ...input } as unknown as Record<string, unknown>;
  for (const key of ['modeController', 'hostTools', 'requestApproval', 'requestUserQuestion', 'getPolicyState', 'getTurnId', 'getDesktopTurnId', 'getThinkingLevel', 'log']) delete dto[key];
  return JSON.parse(JSON.stringify(dto)) as PiWorkerCreate['dto'];
}

function memorySnapshot(input: GuiDriverConnectInput): PiMemorySnapshot | undefined {
  if (!input.memoryInject) return undefined;
  const service = getMemoryService();
  if (!service) {
    throw new Error('MemoryService 未装配，无法安全地为内置引擎准备记忆注入');
  }
  const value = service.injectKnowledge(input.memoryInject.root, 'worker');
  return { text: value.text, versionToken: value.versionToken };
}

export async function createPiWorkerConnection(input: GuiDriverConnectInput, options: PiWorkerHostOptions): Promise<GuiRuntimeConnection> {
  if (!input.getTurnId) throw new Error('宿主未提供回合身份，无法安全连接内置引擎');
  while (true) {
    const previous = leases.get(input.sessionId);
    if (!previous) break;
    if (previous.state === 'active') throw new Error('内置引擎会话已有活动进程');
    try { await previous.reclaim(); }
    catch (error) { throw new ConnectionCleanupError(`内置引擎旧进程回收尚未确认：${(error as Error).message}`); }
    if (leases.get(input.sessionId) === previous) leases.delete(input.sessionId);
  }
  // Reject ambiguous dotted/underscore names before any tools are registered.
  createGuiHostToolGateway(input);
  const worker = resolvePiWorkerFile();
  if (!worker) throw new Error('未找到内置引擎 worker，请重新构建或重新安装工作台');
  const launch = inboundMcpLaunch({ script: worker });
  if (!launch) throw new Error('内置引擎 worker 启动路径为空');
  const jobFile = process.platform === 'win32' ? windowsJobFile() : undefined;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(genericWorkerEnvironment(launch.env)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  if (process.platform === 'win32') {
    const preload = resolveConsolePreloadFile(HIDE_CONSOLE_PRELOAD, __dirname);
    if (preload) Object.assign(env, withWin32HiddenConsole(env, { preloadPath: preload }));
  }
  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  // Ownership is reserved synchronously, before any startup await can allow
  // another connection for the same session to become a competing writer.
  const owner = spawnOwnedProcess({
    command: launch.command,
    args: launch.args,
    spawnOptions: { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    windows: { kind: 'job', jobPath: jobFile ?? '' },
    monitor: {
      businessLabel: 'Pi 会话引擎',
      role: 'AI 会话工作进程',
      workspaceId: input.workspaceContext?.workspaceId,
      workspaceName: input.workspaceContext?.workspaceName,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      taskId: input.taskId
    },
    identityChallenge: async (child, nonce, signal) => {
      // The worker's ready frame proves its IPC listener is installed; sending
      // before then could lose the private challenge during early startup.
      await waitForWorkerReady(ready, signal);
      return confirmWorkerIdentity(child, nonce, signal);
    },
    reclaimTimeoutMs: 14_000
  });
  const child = owner.child;
  let reclaimed = false;
  let lease!: PiLease;
  const reclaim = async (): Promise<void> => {
    if (reclaimed) return;
    await owner.reclaim();
    reclaimed = true;
    if (leases.get(input.sessionId) === lease) leases.delete(input.sessionId);
  };
  lease = { state: 'active', reclaim };
  leases.set(input.sessionId, lease);
  const queue = new AsyncEventQueue<GuiDriverStreamEvent>({ maxBuffered: 512 });
  const pending = new Map<number, Pending>();
  // Each send remains here until its RPC response is observed. Adjacent turns
  // may overlap briefly when a terminal event arrives before that response.
  const pendingAdmissions = new Map<number, boolean>();
  const hostCalls = new Map<number, AbortController>();
  const runningTools = new Set<string>();
  const runningHostTools = new Set<number>();
  let skillPolicy: { id: string; verify(): void } | undefined;
  let generation = 0;
  let turnActive = false;
  let hostTurnId: string | undefined;
  let humanWaitCount = 0;
  let turnWatchdog: NodeJS.Timeout | undefined;
  let scope: Scope | undefined;
  let nextId = 1;
  let outstandingBytes = 0;
  let outstandingMessages = 0;
  let closed = false;
  let intentionalClose = false;
  let terminationFailure: Error | undefined;
  let stoppingPromise: Promise<void> | undefined;
  let closingPromise: Promise<void> | undefined;
  let restoreModeTools = (): void => {};
  let contextUsage: GuiContextUsage | null = null;
  let compacting = false;
  let compactGeneration = 0;
  let initialResumeReceived = false;
  let diagnostics = '';
  const isHostTurnCurrent = (): boolean => !!hostTurnId && input.getTurnId?.() === hostTurnId;
  const readyTimer = setTimeout(() => readyReject(new Error('内置引擎 worker 启动超时')), 15_000);
  readyTimer.unref?.();
  const redact = (value: string): string => redactSafetyText(value, [...options.secrets]).slice(0, 3000);
  const desktopDelivery = new GuiPiDesktopDelivery(() => input.getTurnId?.(),
    () => !closed && child.connected && lease.state === 'active' && owner.state === 'ready',
    reason => input.log('warn', `内置引擎桌面动作送达未确认，请检查未决动作：${reason}`), 5000, options.globalDelivery);

  const stopWatchdog = (): void => {
    if (turnWatchdog) clearTimeout(turnWatchdog);
    turnWatchdog = undefined;
  };
  const startWatchdog = (): void => {
    stopWatchdog();
    if (!turnActive || closed || humanWaitCount || runningTools.size || runningHostTools.size) return;
    turnWatchdog = setTimeout(() => fail(new Error('内置引擎回合长时间无活动，进程已停止')), 10 * 60 * 1000);
    turnWatchdog.unref?.();
  };

  const stopTurn = (): void => {
    desktopDelivery.end();
    turnActive = false;
    hostTurnId = undefined;
    humanWaitCount = 0;
    runningTools.clear();
    runningHostTools.clear();
    stopWatchdog();
    scope?.close();
    scope = undefined;
    for (const call of hostCalls.values()) call.abort();
    hostCalls.clear();
  };
  const fail = (error: Error, afterBuffered = false): Error => {
    if (closed) return error;
    if (pendingAdmissions.size) {
      const delivery = (error instanceof GuiDeliveryError && error.delivery === 'unknown') ||
        [...pendingAdmissions.values()].some(requested => requested) ? 'unknown' : 'not-submitted';
      if (!(error instanceof GuiDeliveryError) || error.delivery !== delivery)
        error = new GuiDeliveryError(redact(error.message), delivery, error instanceof GuiDeliveryError ? error.partialSummary : undefined);
    }
    if (!intentionalClose && error instanceof GuiDeliveryError) error.reportedByStream = true;
    closed = true;
    lease.state = 'retiring';
    clearTimeout(readyTimer);
    readyReject(error);
    stopTurn();
    restoreModeTools();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    if (intentionalClose) {
      // Explicit stop/close owns cleanup. Publishing a dead stream here could
      // let the host start the next writer before the process tree is gone.
      terminationFailure ??= error;
      return error;
    }
    void reclaim().catch(failure => input.log('error', `内置引擎进程回收失败：${redact((failure as Error).message)}`));
    if (afterBuffered) queue.failAfterBuffered(error);
    else queue.fail(error);
    return error;
  };
  const post = (message: PiWorkerRequest): void => {
    if (closed || !child.connected || !child.send) throw new Error('内置引擎 IPC 已关闭');
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > PI_WORKER_MAX_MESSAGE_BYTES || outstandingBytes + bytes > PI_WORKER_MAX_MESSAGE_BYTES * 2 || outstandingMessages >= 128) {
      const error = new Error('内置引擎 IPC 发送缓冲超限');
      throw fail(error);
    }
    outstandingBytes += bytes;
    outstandingMessages++;
    try {
      child.send(message, error => {
        outstandingBytes -= bytes;
        outstandingMessages--;
        if (error) fail(new Error(`内置引擎 IPC 发送失败：${redact(error.message)}`));
      });
    } catch (error) {
      outstandingBytes -= bytes;
      outstandingMessages--;
      throw error;
    }
  };
  const request = (message: RequestBody, timeout = 30_000): Promise<unknown> => {
    if (pending.size >= PI_WORKER_MAX_PENDING) return Promise.reject(new Error('内置引擎请求过多'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`内置引擎 ${message.operation} 超时，连接状态未知`);
        reject(fail(error));
      }, timeout);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try { post({ type: 'request', id, ...message } as PiWorkerRequest); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error as Error); }
    });
  };
  const checkCurrent = (callGeneration: number | undefined, signal: AbortSignal): void => {
    if (signal.aborted || closed || !turnActive || callGeneration !== generation || !scope || !isHostTurnCurrent())
      throw new Error('内置引擎回合已结束或请求已取消');
  };
  const withinTurn = <T>(callGeneration: number | undefined, signal: AbortSignal, fn: () => T): T => {
    checkCurrent(callGeneration, signal);
    return scope!.run(fn);
  };
  const waitForHuman = async <T>(callGeneration: number | undefined, signal: AbortSignal, fn: () => Promise<T>): Promise<T> => {
    checkCurrent(callGeneration, signal);
    humanWaitCount++;
    stopWatchdog();
    try { return await withinTurn(callGeneration, signal, fn); }
    finally {
      if (turnActive && !closed && generation === callGeneration) {
        humanWaitCount = Math.max(0, humanWaitCount - 1);
        if (!humanWaitCount) startWatchdog();
      }
    }
  };
  const hostCall = async (message: Extract<PiWorkerResponse, { type: 'host-call' }>, signal: AbortSignal,
    capturedDesktopTurn?: string): Promise<unknown> => {
    const args = message.args && typeof message.args === 'object' ? message.args as Record<string, unknown> : {};
    switch (message.method) {
      case 'log': {
        const level = args.level === 'warn' || args.level === 'error' ? args.level : 'info';
        input.log(level, redact(String(args.message ?? '')));
        return undefined;
      }
      case 'skills.snapshot': {
        if (message.generation !== undefined) checkCurrent(message.generation, signal);
        const managed = hasSkillsManagementService();
        if (!managed) throw new Error('技能管理服务未装配，无法安全地准备内置引擎的技能目录');
        // 扩展 Agent 会话不发现托管技能库：技能面只来自 manifest.agent.skills 挂载。
        if (input.extensionAgentSkills) return { managed, paths: [], globalPaths: [] };
        return { managed,
          paths: managed ? managedSkillPaths(input.cwd, 'pi-gui', input.workspaceContext) : [],
          globalPaths: managed ? managedGlobalSkillPaths('pi-gui') : [] };
      }
      case 'skills.filter': {
        if (message.generation !== undefined) checkCurrent(message.generation, signal);
        const candidates = Array.isArray(args.candidates) ? args.candidates : [];
        if (candidates.length > 5000 || candidates.some(item => !item || typeof item.filePath !== 'string')) throw new Error('技能候选列表无效');
        if (input.extensionAgentSkills) {
          const emptyPolicyId = randomUUID();
          skillPolicy = { id: emptyPolicyId, verify: () => {} };
          return { allowed: [], policyId: emptyPolicyId };
        }
        const filter = await prepareManagedRuntimeSkillFilter(input.cwd, 'pi-gui', input.workspaceContext);
        if (signal.aborted || closed) throw new Error('技能策略请求已取消');
        if (message.generation !== undefined) checkCurrent(message.generation, signal);
        const allowed = filter(candidates as Array<{ filePath: string; name?: string }>).map(item => item.filePath);
        const id = randomUUID();
        skillPolicy = { id, verify: () => { filter([]); } };
        return { allowed, policyId: id };
      }
      case 'skills.verify':
        if (message.generation !== undefined) checkCurrent(message.generation, signal);
        if (!skillPolicy || args.policyId !== skillPolicy.id) throw new Error('技能策略快照已失效');
        skillPolicy.verify();
        return undefined;
      case 'policy':
        return withinTurn(message.generation, signal, () => input.getPolicyState());
      case 'approval': {
        const policyBefore = JSON.stringify(input.getPolicyState());
        const request = args as unknown as GuiApprovalRequest;
        const decision = await waitForHuman(message.generation, signal, () => input.requestApproval(request,
          typeof request.toolName === 'string' && isPlanToolName(request.toolName) ? undefined : signal));
        checkCurrent(message.generation, signal);
        if (policyBefore !== JSON.stringify(input.getPolicyState())) return { approved: false, reason: '审批期间会话策略发生变化，请重新调用' };
        return decision;
      }
      case 'question': {
        if (!input.requestUserQuestion) throw new Error('本会话没有提问通道');
        const outcome = await waitForHuman(message.generation, signal, () => input.requestUserQuestion!(args as never, signal));
        checkCurrent(message.generation, signal);
        return outcome;
      }
      case 'usage':
        checkCurrent(message.generation, signal);
        options.ctx.usage?.recordModelCall(args as never);
        return undefined;
      case 'review.start':
        return withinTurn(message.generation, signal, async () => {
          if (typeof args.toolCallId !== 'string' || typeof args.toolName !== 'string' || !args.input || typeof args.input !== 'object' || Array.isArray(args.input))
            throw new Error('文件审阅工具事件无效');
          const tracker = turnChanges().activeForOwner(`gui:${input.sessionId}`);
          if (!tracker) throw new Error('当前回合的文件审阅不可用');
          await tracker.toolStart(args.toolCallId, args.toolName, args.input as Record<string, unknown>, undefined, true);
        });
      case 'review.end':
        return withinTurn(message.generation, signal, async () => {
          if (typeof args.toolCallId !== 'string' || typeof args.ok !== 'boolean') throw new Error('文件审阅工具结果无效');
          const tracker = turnChanges().activeForOwner(`gui:${input.sessionId}`);
          if (!tracker) throw new Error('当前回合的文件审阅不可用');
          await tracker.toolEnd(args.toolCallId, args.ok, undefined, true);
        });
      case 'tool': {
        checkCurrent(message.generation, signal);
        const id = typeof args.id === 'string' ? args.id : '';
        const raw = args.args ?? {};
        const wantsImage = args.captureImages === true && isDesktopLookCall(id, raw);
        if (wantsImage && (!capturedDesktopTurn || input.getDesktopTurnId?.() !== capturedDesktopTurn))
          throw new Error('Desktop screenshot turn is unavailable');
        const gateway = createGuiHostToolGateway({ ...input,
          requestApproval: (req, approvalSignal) => waitForHuman(message.generation, signal, () => input.requestApproval(req, approvalSignal))
        }, { isCurrent: () => {
          try { checkCurrent(message.generation, signal); return true; } catch { return false; }
        }, captureImages: wantsImage });
        const callId = typeof args.toolCallId === 'string' ? args.toolCallId : `pi-${message.id}`;
        return await withinTurn(message.generation, signal, () => desktopDelivery.run({ generation: message.generation,
          id: callId, name: typeof args.toolCallId === 'string' && args.toolCallId.trim() ? id.replace(/\./g, '_') : undefined,
          signal, isCurrent: () => {
            try { checkCurrent(message.generation, signal); return true; } catch { return false; }
          } }, () => gateway.invoke(id, raw, { id: callId, signal })));
      }
      case 'desktop.deliveryAck': {
        checkCurrent(message.generation, signal);
        if (args.generation !== message.generation) throw new Error('内置引擎桌面回执代次无效');
        return await desktopDelivery.acknowledge(message.generation, args.toolCallId, args.proof, args.textDigest, signal);
      }
      case 'desktop.deliveryAbandon': {
        checkCurrent(message.generation, signal);
        if (args.generation !== message.generation) throw new Error('内置引擎桌面回执代次无效');
        desktopDelivery.abandon(message.generation, args.toolCallId, args.proof);
        return undefined;
      }
      default: throw new Error(`未知 Pi 宿主回调：${message.method}`);
    }
  };

  child.on('message', (raw: unknown) => {
    try {
      if (!raw || typeof raw !== 'object' || Buffer.byteLength(JSON.stringify(raw)) > PI_WORKER_MAX_MESSAGE_BYTES) throw new Error('内置引擎返回无效 IPC 消息');
      const message = raw as PiWorkerResponse;
      if (message.type === 'ready') { clearTimeout(readyTimer); readyResolve(); return; }
      // The owner validates this private startup frame with its own listener.
      if (message.type === 'identity-response') return;
      if (message.type === 'response') {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve(message.result); else waiter.reject(new Error(redact(message.error || '内置引擎操作失败')));
        return;
      }
      if (message.type === 'host-cancel') { hostCalls.get(message.id)?.abort(); hostCalls.delete(message.id); return; }
      if (message.type === 'host-call') {
        if (hostCalls.size >= PI_WORKER_MAX_PENDING) throw new Error('内置引擎宿主回调过多');
        if (!Number.isSafeInteger(message.id) || message.id < 1 || hostCalls.has(message.id)) throw new Error('内置引擎宿主回调身份无效');
        const abort = new AbortController();
        hostCalls.set(message.id, abort);
        const toolArgs = message.args && typeof message.args === 'object' ? message.args as Record<string, unknown> : undefined;
        const capturedDesktopTurn = message.method === 'tool' && toolArgs?.captureImages === true &&
          isDesktopLookCall(String(toolArgs.id ?? ''), toolArgs.args) ? input.getDesktopTurnId?.() : undefined;
        if (turnActive && message.generation === generation) {
          if (message.method === 'tool') runningHostTools.add(message.id);
          startWatchdog();
        }
        void hostCall(message, abort.signal, capturedDesktopTurn).then(result => {
          if (!abort.signal.aborted && !closed) {
            let wire = result;
            if (message.method === 'tool' && result && typeof result === 'object' && !Array.isArray(result)) {
              const { imageCurrent, ...publicResult } = result as { image?: unknown; imageCurrent?: () => boolean; desktopDeliveryProof?: unknown };
              wire = publicResult;
              if (publicResult.image !== undefined) {
                let authorized = false;
                try { checkCurrent(message.generation, abort.signal);
                  authorized = !!capturedDesktopTurn && input.getDesktopTurnId?.() === capturedDesktopTurn && imageCurrent?.() === true;
                } catch { /* revoked */ }
                if (!authorized || publicResult.desktopDeliveryProof !== undefined) {
                  wire = { ok: false, text: 'Desktop screenshot authorization changed or the result is invalid.' };
                } else {
                  // Check the entire envelope and queued bytes before post() can fail the connection.
                  const bytes = Buffer.byteLength(JSON.stringify({ type: 'host-result', id: message.id, ok: true, result: wire }));
                  if (bytes > PI_WORKER_MAX_MESSAGE_BYTES || outstandingBytes + bytes > PI_WORKER_MAX_MESSAGE_BYTES * 2 || outstandingMessages >= 128)
                    wire = { ok: false, text: 'Desktop screenshot exceeds the Pi IPC capacity.' };
                }
              }
            }
            post({ type: 'host-result', id: message.id, ok: true, result: wire });
          }
        }, error => {
          if (!abort.signal.aborted && !closed) post({ type: 'host-result', id: message.id, ok: false, error: redact((error as Error).message) });
        }).finally(() => {
          hostCalls.delete(message.id);
          if (runningHostTools.delete(message.id) && turnActive && message.generation === generation) startWatchdog();
        }).catch(error => { fail(new Error(`内置引擎宿主回调发送失败：${redact((error as Error).message)}`)); });
        return;
      }
      if (message.type === 'plan') {
        if (!turnActive || message.generation !== generation || !isHostTurnCurrent()) return;
        if (message.kind === 'extracted') {
          const value = message.value as { steps?: PlanStepView[] };
          if (Array.isArray(value?.steps)) input.modeController.planSteps = value.steps;
          input.modeController.onPlanExtracted?.(message.value as never);
        } else if (message.kind === 'updated') {
          if (Array.isArray(message.value)) input.modeController.planSteps = message.value as PlanStepView[];
          input.modeController.onPlanUpdated?.(input.modeController.planSteps);
        } else { input.modeController.executing = false; input.modeController.onPlanCompleted?.(); }
        return;
      }
      if (message.type === 'event') {
        const initialResume = message.generation === undefined && message.event?.type === 'resume-token' && !initialResumeReceived;
        const manualCompaction = message.generation === undefined && compacting && message.event?.type === 'compaction';
        if (initialResume) initialResumeReceived = true;
        if (!initialResume && !manualCompaction && (!turnActive || message.generation !== generation || !isHostTurnCurrent())) return;
        if (!initialResume && !manualCompaction) {
          if (message.event.type === 'tool-start') runningTools.add(message.event.toolCallId);
          else if (message.event.type === 'tool-result') runningTools.delete(message.event.toolCallId);
          startWatchdog();
        }
        if (message.contextUsage !== undefined) {
          const previous = contextUsage;
          contextUsage = message.contextUsage;
          if (contextUsage?.tokens !== previous?.tokens || contextUsage?.contextWindow !== previous?.contextWindow) {
            queue.push({ type: 'context-usage', usage: contextUsage });
          }
        }
        // An SDK error can race ahead of the send acknowledgement. Preserve its
        // summary and preceding buffered events while making the unknown
        // delivery explicit to the host.
        if (message.event.type === 'error' && message.generation !== undefined && pendingAdmissions.has(message.generation)) {
          fail(new GuiDeliveryError(redact(message.event.message), pendingAdmissions.get(message.generation) ? 'unknown' : 'not-submitted', message.event.summary), true);
          return;
        }
        queue.push(message.event);
        if (manualCompaction && message.event.type === 'compaction' && message.event.phase === 'end') compacting = false;
        if (message.event.type === 'turn-complete' || message.event.type === 'error') stopTurn();
        return;
      }
      throw new Error('内置引擎返回未知 IPC 消息');
    } catch (error) { fail(error as Error); }
  });
  child.once('error', error => fail(new Error(`内置引擎启动失败：${redact(error.message)}`)));
  child.once('disconnect', () => { if (!closed) fail(new Error('内置引擎 IPC 已断开')); });
  child.once('exit', (code, signal) => {
    if (intentionalClose) {
      if (!closed) fail(new Error(`内置引擎在停止过程中退出（code=${code}, signal=${signal}）`));
      return;
    }
    fail(new Error(`内置引擎进程退出（code=${code}, signal=${signal}）${diagnostics ? `：${diagnostics}` : ''}`));
  });
  // SDKs and user extensions may log arbitrary content. Surface only our own
  // bounded, redacted fatal diagnostic; never forward arbitrary stderr/stdout.
  child.stdout?.resume();
  let stderrTail = '';
  child.stderr?.on('data', chunk => {
    stderrTail = (stderrTail + String(chunk)).slice(-6000);
    const message = stderrTail.split(/\r?\n/).filter(line => line.startsWith('Pi worker: ')).at(-1);
    if (message) diagnostics = redact(message);
  });
  child.stdout?.on('error', error => fail(new Error(`内置引擎输出流失败：${redact(error.message)}`)));
  child.stderr?.on('error', error => fail(new Error(`内置引擎诊断流失败：${redact(error.message)}`)));

  try {
    await owner.ready;
    await ready;
    if (owner.state !== 'ready' || closed) throw new Error('内置引擎进程已退出或正在回收，无法启动');
    const create: PiWorkerCreate = {
      dto: serializableInput(input), userDataDir: options.userDataDir,
      providerId: options.providerId, modelId: options.modelId, shellEnv: options.shellEnv,
      providerDefaultOutput: options.providerDefaultOutput,
      tools: input.hostTools.map(({ id, label, description, argsHint, parameters, permissionClass }) => ({ id, label, description, argsHint, parameters, permissionClass })),
      supportsQuestions: !!input.requestUserQuestion,
      modeState: modeSnapshot(input)
    };
    const created = await request({ operation: 'create', create }, 60_000) as { engineCapture?: GuiRuntimeConnection['engineCapture'] };
    const previousApplyTools = input.modeController.applyTools;
    const applyTools = (): void => { if (!closed) post({ type: 'mode', state: modeSnapshot(input) }); };
    input.modeController.applyTools = applyTools;
    restoreModeTools = (): void => {
      if (input.modeController.applyTools === applyTools) input.modeController.applyTools = previousApplyTools;
    };
    const result: GuiRuntimeConnection = {
      events: queue,
      ...(created?.engineCapture ? { engineCapture: created.engineCapture } : {}),
      async send(text: string, images?: GuiSendImage[], parameters?: ModelParameterValues, authority?: import('../../types').GuiInputAuthority): Promise<void> {
        if (closed || lease.state !== 'active') throw new GuiDeliveryError('内置引擎会话正在停止或已关闭', 'not-submitted');
        if (turnActive) throw new GuiDeliveryError('内置引擎已有运行中的回合', 'not-submitted');
        stopTurn();
        generation++;
        hostTurnId = input.getTurnId?.();
        if (!hostTurnId) throw new GuiDeliveryError('宿主没有有效回合，无法启动内置引擎', 'not-submitted');
        try { desktopDelivery.begin(generation, hostTurnId); }
        catch (error) {
          hostTurnId = undefined;
          throw new GuiDeliveryError(redact((error as Error).message), 'not-submitted');
        }
        turnActive = true;
        scope = createPromptAuthorityScope(authority?.userText, input.nonUserTurns);
        startWatchdog();
        const turn = generation;
        let sendRequested = false;
        pendingAdmissions.set(turn, false);
        const requireCurrentTurn = (): void => {
          if (!turnActive || generation !== turn || closed || !isHostTurnCurrent())
            throw new GuiDeliveryError('内置引擎消息在提交前已中止', 'not-submitted');
        };
        try {
          applyTools();
          if ((images?.length ?? 0) > 4096 || (images ?? []).reduce((total, image) => total + image.data.length, 0) > PI_WORKER_MAX_IMAGE_CHARS)
            throw new Error('图片附件超过内置引擎传输上限');
          for (const [index, image] of (images ?? []).entries()) {
            const parts = Math.max(1, Math.ceil(image.data.length / PI_WORKER_IMAGE_CHUNK_CHARS));
            for (let part = 0; part < parts; part++) {
              requireCurrentTurn();
              await request({ operation: 'image', generation: turn, index, part, parts,
                data: image.data.slice(part * PI_WORKER_IMAGE_CHUNK_CHARS, (part + 1) * PI_WORKER_IMAGE_CHUNK_CHARS),
                mimeType: image.mimeType, name: image.name });
            }
          }
          requireCurrentTurn();
          const sendRequest = { operation: 'send' as const, generation: turn, text, imageCount: images?.length, parameters, memory: memorySnapshot(input), thinking: input.getThinkingLevel?.() ?? null, forkIdentity: authority?.forkIdentity, literalText: authority?.literalText };
          // Once sending begins, an IPC failure cannot prove whether the worker
          // received the prompt. Only a successful RPC response confirms it.
          sendRequested = true;
          pendingAdmissions.set(turn, true);
          await request(sendRequest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = error instanceof GuiDeliveryError
            ? error
            : new GuiDeliveryError(redact(message), sendRequested ? 'unknown' : 'not-submitted');
          // The stop/close path owns retirement after invalidating this turn;
          // do not make its event stream fail before process-tree reclamation.
          throw turnActive && generation === turn && !closed ? fail(failure) : failure;
        } finally {
          pendingAdmissions.delete(turn);
        }
      },
      async nativeFork(point) {
        if (closed || lease.state !== 'active' || turnActive) throw new Error('内置引擎忙碌或已关闭，无法分叉');
        return await request({ operation: 'fork', point }) as Awaited<ReturnType<NonNullable<GuiRuntimeConnection['nativeFork']>>>;
      },
      async receiveMessage(message: RuntimeMessage) {
        if (!turnActive || closed || !isHostTurnCurrent()) return { status: 'unsupported', reason: '当前没有可插话的回合' };
        if (message.idleOnly) return { status: 'deferred', reason: '等待当前回合结束后重新确认消息' };
        // Host notifications use the hidden custom-message channel. User
        // interrupt messages use Pi's native steer() path; ordinary mailbox
        // messages remain unsupported here and are handled by the host queue.
        if (!message.hostNotification && message.intent !== 'interrupt') {
          return { status: 'unsupported', reason: '普通消息不走 Pi 原生插话通道' };
        }
        const turn = generation;
        return await request({ operation: 'receive', generation: turn, message, memory: memorySnapshot(input) }) as
          Awaited<ReturnType<NonNullable<GuiRuntimeConnection['receiveMessage']>>>;
      },
      redirect(): boolean {
        // IPC acknowledgement is asynchronous, so a synchronous boolean cannot
        // establish delivery. Callers may use receiveMessage() or queue instead.
        return false;
      },
      async abort(): Promise<void> {
        if (closingPromise) {
          await closingPromise;
          if (terminationFailure) throw new Error(`内置引擎常规停止失败，但进程树已确认强制回收：${redact(terminationFailure.message)}`);
          return;
        }
        if (!stoppingPromise) {
          const attempt = (async () => {
            intentionalClose = true;
            lease.state = 'retiring';
            stopTurn(); generation++;
            let stopError: Error | undefined;
            if (!closed) {
              try { await request({ operation: 'abort' }, 10_000); }
              catch (error) { stopError = error instanceof Error ? error : new Error(String(error)); }
            }
            stopError ??= terminationFailure;
            if (stopError) terminationFailure ??= stopError;
            closed = true;
            restoreModeTools();
            for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('内置引擎连接正在关闭')); }
            pending.clear();
            try { await reclaim(); }
            catch (error) {
              const detail = redact((error as Error).message);
              const stopDetail = stopError ? `；常规停止失败：${redact(stopError.message)}` : '';
              throw new ConnectionCleanupError(`内置引擎进程回收未确认，请检查残留进程或重试停止：${detail}${stopDetail}`);
            }
            // No synthetic turn-complete: EOF follows only confirmed reclaim.
            queue.close();
            if (stopError) throw new Error(`内置引擎常规停止失败，但进程树已确认强制回收：${redact(stopError.message)}`);
          })();
          stoppingPromise = attempt;
          void attempt.finally(() => { if (stoppingPromise === attempt && !reclaimed) stoppingPromise = undefined; }).catch(() => {});
        }
        await stoppingPromise;
      },
      async compact(instructions?: string) {
        compacting = true;
        const compactTurn = ++compactGeneration;
        try {
          const compact = await request({ operation: 'compact', text: instructions }, 300_000) as Awaited<ReturnType<NonNullable<GuiRuntimeConnection['compact']>>> & { __contextUsage?: GuiContextUsage | null };
          if (compact.__contextUsage !== undefined) contextUsage = compact.__contextUsage;
          const result = { ...compact };
          delete result.__contextUsage;
          return result;
        } finally {
          // Allow the queued compaction-end IPC event to arrive after the RPC response.
          const timer = setTimeout(() => { if (compactGeneration === compactTurn) compacting = false; }, 1000);
          timer.unref?.();
        }
      },
      getContextUsage: () => contextUsage,
      async close(): Promise<void> {
        if (!closingPromise) {
          const attempt = (async () => {
            if (stoppingPromise) {
              try { await stoppingPromise; }
              catch (error) { if (!reclaimed) throw error; }
            }
            if (reclaimed) { queue.close(); return; }
            intentionalClose = true;
            lease.state = 'retiring';
            stopTurn(); generation++;
            restoreModeTools();
            if (!closed) {
              try { await request({ operation: 'close' }, 10_000); }
              catch (error) {
                terminationFailure ??= error instanceof Error ? error : new Error(String(error));
                input.log('warn', `内置引擎关闭失败：${redact(terminationFailure.message)}`);
              }
            }
            closed = true;
            await reclaim();
            queue.close();
          })();
          closingPromise = attempt;
          void attempt.finally(() => { if (closingPromise === attempt) closingPromise = undefined; }).catch(() => {});
        }
        await closingPromise;
      }
    };
    return result;
  } catch (error) {
    fail(error as Error);
    try { await reclaim(); }
    catch (cleanup) { throw new ConnectionCleanupError(`内置引擎连接失败，进程回收尚未确认：${redact((cleanup as Error).message)}`); }
    throw error;
  }
}
