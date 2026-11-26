import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppContext } from '../context';
import type { AgentSessionSummary, SessionMeta, WorkspaceInfo } from '../../shared/types';
import { guiMessageText, type GuiChatMessage } from '../../shared/guiWorker';
import { formatDoneText, formatSessionList, formatWorkspaceList, parseWorkbenchCommand, resolveListTarget } from '../../shared/workbenchCommands';
import { formatWorkbenchStatus } from '../../shared/workbenchStatus';
import { BIND_READY_POLL_MS, BIND_READY_TIMEOUT_MS, isBoundTerminalReady } from '../../shared/sessionBind';
import { t } from '../../shared/i18n';
import { terminalHost } from '../capabilities/hosts/terminal';
import { plainTextFromPtyBuffer } from '../detect/stripAnsi';
import { isMessagingId, conversationKey, type ConversationAddress } from './contracts';
import { messagingTurnIdentity } from './sessionAuthority';

export type WorkbenchRemoteInput = ConversationAddress & Readonly<{
  messageId: string;
  senderId: string;
  senderIsBot: boolean;
  conversationType: 'direct' | 'group';
  addressed: boolean;
  text: string;
  /** Desktop-owned pairing generation, never populated by a platform adapter. */
  authorizationId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => Promise<void>;
}>;

export type WorkbenchRemoteReply = Readonly<import('./messagingHost').WorkbenchRemoteReply>;
type RemoteRequest = {
  controller: AbortController;
  turnId: string;
  target?: { kind: 'scheduler' | 'gui' | 'terminal'; id: string };
  terminalSubmitted?: boolean;
  awaitCancellation?: () => Promise<void> | undefined;
};
type RemoteRoute = {
  authorizationId?: string;
  workspaceId?: string;
  boundSessionId?: string;
  schedulerSessionFile?: string;
  version: number;
  workspaces?: WorkspaceInfo[];
  scheduled?: { workspaceId: string; choices: AgentSessionSummary[] };
  workers?: { workspaceId: string; choices: SessionMeta[] };
  requests: Set<RemoteRequest>;
};

const MAX_CONVERSATIONS = 4096;
const MAX_REQUESTS = 256;
const MAX_REQUESTS_PER_CONVERSATION = 16;
const MAX_SEEN = 4096;
const WAIT_FOR_IDLE_MS = 600_000;
const reply = (text: string): WorkbenchRemoteReply => ({ text });
const failed = (text: string, failure: WorkbenchRemoteReply['failure'] = 'remote-target-unavailable'): WorkbenchRemoteReply => ({ text, failure });
const unavailable = () => failed(t('工作台远程连接暂不可用，请稍后再试。'));
const schedulerChanged = () => failed(t('所选调度会话已变更。请用 /s 重新选择，或用 /new 开始新会话。'));

function selectTarget<T extends { name?: string; title?: string }>(target: string, choices: readonly T[]): T | undefined {
  const requested = target.trim().toLowerCase();
  if (!requested) return undefined;
  if (/^\d+$/u.test(requested)) return choices[resolveListTarget(requested, choices)];
  const label = (choice: T) => (choice.name ?? choice.title ?? '').toLowerCase();
  const exact = choices.filter(choice => label(choice) === requested);
  const matches = exact.length ? exact : choices.filter(choice => label(choice).includes(requested));
  return matches.length === 1 ? matches[0] : undefined;
}

export class WorkbenchMessagingHost {
  private readonly closing = new AbortController();
  private readonly routes = new Map<string, RemoteRoute>();
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<WorkbenchRemoteReply>>();
  private readonly writingTerminals = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  /** This host accepts only events from the desktop-owned pairing admission. */
  handle(input: WorkbenchRemoteInput): Promise<WorkbenchRemoteReply> {
    if (this.closing.signal.aborted || input.signal?.aborted) return Promise.resolve(reply(''));
    if (![input.channelKey, input.botId, input.conversationId, input.senderId, input.messageId].every(isMessagingId) ||
        (input.threadId !== undefined && !isMessagingId(input.threadId)) ||
        (input.authorizationId !== undefined && !isMessagingId(input.authorizationId)) || input.senderIsBot !== false ||
        (input.conversationType !== 'direct' && !(input.conversationType === 'group' && input.addressed === true)) ||
        typeof input.text !== 'string' || input.text.length > 64 * 1024 || !input.text.trim()) return Promise.resolve(reply(''));
    const addressKey = conversationKey(input);
    const routeKey = JSON.stringify([addressKey, input.senderId, input.authorizationId]);
    const eventKey = JSON.stringify([addressKey, input.messageId]);
    if (this.seen.has(eventKey)) return Promise.resolve(reply(''));
    const command = input.text.trim() === '/clear' ? { type: 'newSession' as const } : parseWorkbenchCommand(input.text);
    if (command.type !== 'stop' && this.inFlight.size >= MAX_REQUESTS) return Promise.resolve(reply(t('远程请求过多，请稍后再试。')));
    let route = this.routes.get(routeKey);
    if (!route) {
      if (this.routes.size >= MAX_CONVERSATIONS) {
        const idle = [...this.routes].find(([, candidate]) => !candidate.workspaceId && !candidate.workspaces && !candidate.requests.size);
        if (!idle) return Promise.resolve(reply(t('远程会话过多，请稍后再试。')));
        this.routes.delete(idle[0]);
      }
      route = { authorizationId: input.authorizationId, version: 0, requests: new Set() };
    }
    if (command.type === 'plain' && route.requests.size >= MAX_REQUESTS_PER_CONVERSATION) {
      return Promise.resolve(reply(t('当前聊天排队消息过多，请稍后再试。')));
    }
    this.routes.delete(routeKey);
    this.routes.set(routeKey, route);
    this.seen.add(eventKey);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    const requestId = createHash('sha256').update(eventKey).digest('hex');
    const signal = AbortSignal.any([this.closing.signal, ...(input.signal ? [input.signal] : [])]);
    const currentRoute = route;
    const request = Promise.resolve().then(async () => {
      if (signal.aborted) return reply('');
      try { return await this.dispatch(currentRoute, command, requestId, signal, input.onProgress); }
      catch { return signal.aborted ? reply('') : unavailable(); }
    });
    this.inFlight.add(request);
    void request.then(() => this.inFlight.delete(request));
    return request;
  }

  stopAdmission(): void { this.closing.abort(); }

  releaseAuthorization(authorizationId: string): void {
    for (const [key, route] of this.routes) {
      if (route.authorizationId !== authorizationId) continue;
      this.changeRoute(route);
      this.routes.delete(key);
    }
  }

  async stopAndWait(): Promise<void> {
    this.stopAdmission();
    await Promise.allSettled(this.inFlight);
    this.routes.clear();
  }

  private activeWorkspace(route: RemoteRoute): string | undefined {
    const workspaces = this.ctx.workspaces.list();
    const chosen = route.workspaceId ?? this.ctx.config.get().activeWorkspaceId;
    return workspaces.find(workspace => workspace.id === chosen)?.id;
  }

  private changeRoute(route: RemoteRoute): void {
    route.version++;
    for (const request of route.requests) request.controller.abort();
  }

  private worker(workspaceId: string, sessionId: string): SessionMeta | undefined {
    const session = this.ctx.sessions.get(sessionId);
    return session?.type === 'terminal' && !session.archived && session.workspaceId === workspaceId ? session : undefined;
  }

  private workers(workspaceId: string): SessionMeta[] {
    return this.ctx.sessions.listForAgent(workspaceId).sessions.filter(session => session.type === 'terminal' && !session.archived);
  }

  private workerMenu(workers: SessionMeta[]): string {
    if (!workers.length) return t('当前工作区没有工作会话（终端）');
    return [t('工作会话'), ...workers.map((worker, index) => `[${index + 1}] ${worker.name} · ${worker.runtime ?? '—'}`),
      t('发送「/bind 序号或名称」绑定工作会话。')].join('\n');
  }

  private async dispatch(route: RemoteRoute, command: ReturnType<typeof parseWorkbenchCommand>, requestId: string, signal: AbortSignal,
    onProgress?: WorkbenchRemoteInput['onProgress']): Promise<WorkbenchRemoteReply> {
    const wsId = this.activeWorkspace(route);
    const orchestrator = this.ctx.orchestrator;
    if (command.type === 'help' || command.type === 'palette') return reply([
      t('可用命令：'), t('/ws · 工作区列表'), t('/ws <序号或名称> · 切工作区'), t('/s · 调度会话列表'), t('/s <序号或名称> · 切调度会话'),
      t('/new · 新调度会话'), t('/ts · 工作会话列表'), t('/bind <序号或名称> · 绑定工作会话'),
      t('/unbind · 退出绑定'), t('/status · 工作台状态'), t('/stop · 停止当前远程回合'),
      t('其它文字送到当前工作台调度。绑定工作会话后，文字送给该会话。')
    ].join('\n'));
    if (command.type === 'workspaces') {
      route.workspaces = this.ctx.workspaces.list();
      return reply(formatWorkspaceList(route.workspaces, wsId ?? ''));
    }
    if (command.type === 'useWorkspace') {
      const list = route.workspaces ?? this.ctx.workspaces.list();
      const selected = selectTarget(command.target, list);
      if (!selected || !this.ctx.workspaces.list().some(workspace => workspace.id === selected.id)) {
        return failed(t('无法确定工作区，请用 /ws 刷新列表，再按序号选择。'));
      }
      route.workspaceId = selected.id;
      route.boundSessionId = undefined;
      route.schedulerSessionFile = undefined;
      route.scheduled = undefined;
      route.workers = undefined;
      this.changeRoute(route);
      return reply(t('已切换到工作区「{{name}}」', { name: selected.name }));
    }
    if (command.type === 'unbind') {
      if (!route.boundSessionId) return reply(t('当前没有绑定工作会话'));
      route.boundSessionId = undefined;
      this.changeRoute(route);
      return reply(t('已退出绑定，消息将发给工作台调度。'));
    }
    if (command.type === 'stop') return this.stopRemote(route);
    if (!wsId) return failed(t('当前工作区不可用，请发送 /ws 并重新选择。'));
    if (!orchestrator) return unavailable();
    route.workspaceId ??= wsId;
    switch (command.type) {
      case 'sessions': {
        const version = route.version;
        const listed = await orchestrator.listSessions(wsId);
        if (route.version !== version || signal.aborted) return reply('');
        route.scheduled = { workspaceId: wsId, choices: listed.slice(0, 20) };
        return reply(formatSessionList(listed));
      }
      case 'useSession': {
        const listed = route.scheduled?.workspaceId === wsId ? route.scheduled.choices : undefined;
        if (!listed) return reply(t('先发「调度会话列表」或 /s 查看列表，再用序号切换'));
        const selected = selectTarget(command.target, listed);
        if (!selected) return failed(t('无法确定调度会话，请用 /s 刷新列表，再按序号选择。'));
        const version = route.version;
        const current = () => !signal.aborted && route.version === version && this.activeWorkspace(route) === wsId;
        const result = await orchestrator.openSession(wsId, selected.path, current);
        if (!current()) return reply('');
        if (!result.ok) return failed(t('当前无法切换调度会话，请稍后重试。'));
        route.schedulerSessionFile = selected.path;
        if (!route.boundSessionId) this.changeRoute(route);
        return reply(t('已切换调度会话「{{title}}」', { title: selected.title }));
      }
      case 'newSession':
        if (orchestrator.isBusy(wsId)) return reply(t('Agent 正忙，请等当前回合结束后再清空'));
        orchestrator.clearHistory(wsId);
        route.schedulerSessionFile = undefined;
        route.scheduled = undefined;
        if (!route.boundSessionId) this.changeRoute(route);
        return reply(t('已开始新调度会话（电脑端已同步），直接发消息即可'));
      case 'workSessions': {
        const workers = this.workers(wsId);
        route.workers = { workspaceId: wsId, choices: workers };
        return reply(this.workerMenu(workers));
      }
      case 'bind': {
        const workers = route.workers?.workspaceId === wsId ? route.workers.choices : this.workers(wsId);
        const selected = command.target ? selectTarget(command.target, workers) : workers.length === 1 ? workers[0] : undefined;
        if (!selected) {
          const choices = this.workers(wsId);
          route.workers = { workspaceId: wsId, choices };
          return reply(this.workerMenu(choices));
        }
        if (!this.worker(wsId, selected.id)) return reply(t('会话不存在'));
        route.workspaceId = wsId;
        route.boundSessionId = selected.id;
        this.changeRoute(route);
        return reply(t('已绑定工作会话「{{name}}」，发送 /unbind 恢复工作台调度。', { name: selected.name }));
      }
      case 'status': {
        const workspaces = this.ctx.workspaces.list();
        const bound = route.boundSessionId && this.worker(wsId, route.boundSessionId);
        return reply(formatWorkbenchStatus({ workspaceName: workspaces.find(item => item.id === wsId)?.name ?? '',
          workspaceCount: workspaces.length, agentBusy: orchestrator.isBusy(wsId), agentMode: orchestrator.getAgentMode(wsId),
          terminals: this.workers(wsId).map(session => ({ name: session.name, runtime: session.runtime, status: this.ctx.pty.getStatus(session.id),
            lifecycle: session.lifecycle, liveStatus: session.liveStatus?.label })), ...(bound ? { boundSession: { name: bound.name } } : {}) }, command.detail));
      }
      case 'plain': return this.plain(route, wsId, command.text, requestId, signal, onProgress);
    }
  }

  private async stopRemote(route: RemoteRoute): Promise<WorkbenchRemoteReply> {
    const request = [...route.requests].find(item => !!item.target) ?? route.requests.values().next().value;
    if (!request) return reply(t('当前没有进行中的回合'));
    const target = request.target;
    request.controller.abort();
    if (target?.kind === 'terminal' && request.terminalSubmitted) {
      return reply(t('终端消息已提交，可在工作台停止对应终端。'));
    }
    await request.awaitCancellation?.();
    if (target?.kind === 'terminal') return reply(t('已撤销终端消息提交。若终端输入框有残留文字，请在工作台清除。'));
    return reply(t('已请求停止当前回合'));
  }

  private async plain(route: RemoteRoute, wsId: string, text: string, requestId: string, signal: AbortSignal,
    onProgress?: WorkbenchRemoteInput['onProgress']): Promise<WorkbenchRemoteReply> {
    const version = route.version;
    const request: RemoteRequest = { controller: new AbortController(), turnId: messagingTurnIdentity(requestId).assistantMessageId };
    const turnSignal = AbortSignal.any([signal, request.controller.signal]);
    route.requests.add(request);
    const current = () => !turnSignal.aborted && route.version === version && this.activeWorkspace(route) === wsId;
    try {
      const bound = route.boundSessionId;
      if (onProgress && current()) {
        const busy = bound ? this.ctx.agentSessions?.isBusy(bound) || this.writingTerminals.has(bound) : this.ctx.orchestrator?.isBusy(wsId);
        try { await onProgress(busy ? t('已收到，正在等待工作台空闲。') : t('已收到，正在处理。')); }
        catch { /* The input may still be handled even when the acknowledgment could not be delivered. */ }
      }
      if (!current()) return reply(turnSignal.aborted ? '' : t('当前远程绑定已更改，请重新发送。'));
      if (bound) {
        const session = this.worker(wsId, bound);
        if (!session) {
          return failed(t('绑定的工作会话已不存在，请用 /bind 重新选择或用 /unbind 返回调度。'));
        }
        if (this.ctx.sessions.isChatRuntime(session.runtime)) return await this.workerTurn(wsId, session, text, requestId, request, turnSignal, current);
        return await this.terminalTurn(wsId, session, text, request, turnSignal, current);
      }
      const orchestrator = this.ctx.orchestrator;
      const chosenSession = route.schedulerSessionFile;
      const schedulerIsCurrent = () => !chosenSession || orchestrator?.getCurrentSessionFile(wsId) === chosenSession;
      const canSubmit = () => current() && schedulerIsCurrent();
      const deadline = Date.now() + WAIT_FOR_IDLE_MS;
      while (canSubmit() && orchestrator && Date.now() < deadline) {
        if (!orchestrator.isBusy(wsId)) {
          request.target = { kind: 'scheduler', id: wsId };
          const result = await orchestrator.sendWorkbenchRemote(text, wsId, requestId, turnSignal, canSubmit);
          if (turnSignal.aborted) return reply('');
          if (result.status === 'completed') return reply(formatDoneText(result.message));
          if (result.status === 'unknown') return failed(t('无法确认这条消息的调度结果，请在工作台核对。'), 'remote-result-unknown');
          if (result.status !== 'busy') return current() && !schedulerIsCurrent() ? schedulerChanged() : unavailable();
        }
        request.target = undefined;
        await delay(BIND_READY_POLL_MS, undefined, { signal: turnSignal });
      }
      if (current() && !schedulerIsCurrent()) return schedulerChanged();
      return failed(t('工作台仍忙碌，或当前远程绑定已更改。'));
    } catch (error) {
      if (turnSignal.aborted) return reply('');
      throw error;
    } finally { route.requests.delete(request); }
  }

  private async workerTurn(wsId: string, session: SessionMeta, text: string, requestId: string, request: RemoteRequest,
    signal: AbortSignal, current: () => boolean): Promise<WorkbenchRemoteReply> {
    const gui = this.ctx.agentSessions;
    if (!gui || !current()) return unavailable();
    gui.open(session);
    const id = session.id;
    let wrapped: GuiChatMessage | undefined;
    let resolveReply: (message: GuiChatMessage | undefined) => void = () => {};
    const finished = new Promise<GuiChatMessage | undefined>(resolve => { resolveReply = resolve; });
    let aborting: Promise<void> | undefined;
    const cancel = () => {
      if (!aborting && request.target?.id === id && gui.currentAssistantMessageId(id) === request.turnId) {
        aborting = Promise.resolve(gui.abort(id)).catch(() => {});
      }
      resolveReply(undefined);
    };
    request.awaitCancellation = () => aborting;
    const unsubscribe = gui.onPush(event => {
      if (event.sessionId !== id || event.kind !== 'sync') return;
      const message = event.messages.find(item => item.id === request.turnId && item.role === 'assistant');
      if (message?.finishedAt) resolveReply(message);
    });
    const deadline = Date.now() + WAIT_FOR_IDLE_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (current() && this.worker(wsId, id) && Date.now() < deadline) {
        if (!gui.isBusy(id)) {
          const previous = gui.getHistoryRange(id, undefined, 1, request.turnId)?.messages[0];
          request.target = { kind: 'gui', id };
          const receipt = gui.sendWorkbenchRemoteInput(id, { workspaceId: wsId, requestId, text });
          if (receipt.status === 'accepted' && receipt.turnId === request.turnId) {
            timeout = setTimeout(cancel, WAIT_FOR_IDLE_MS);
            wrapped = previous?.id === request.turnId && previous.finishedAt ? previous : await finished;
            break;
          }
          if (receipt.status === 'unknown') return failed(t('无法确认工作会话是否已处理这条消息，请在工作台核对。'), 'remote-result-unknown');
          if (receipt.status !== 'retryable') return unavailable();
          request.target = undefined;
        }
        await delay(BIND_READY_POLL_MS, undefined, { signal });
      }
      if (signal.aborted) return reply('');
      if (!wrapped) return failed(t('工作会话尚未返回结果，请在工作台查看。'), 'remote-result-unknown');
      return reply(formatDoneText({ content: guiMessageText(wrapped), aborted: wrapped.aborted, error: wrapped.error }));
    } finally {
      unsubscribe();
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      await aborting;
      delete request.awaitCancellation;
    }
  }

  private async terminalTurn(wsId: string, session: SessionMeta, text: string, request: RemoteRequest,
    signal: AbortSignal, current: () => boolean): Promise<WorkbenchRemoteReply> {
    const sessionId = session.id;
    // Line breaks are flattened by typed submission. Other control characters
    // could act as terminal keystrokes before the guarded Enter.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return reply(t('终端消息包含不支持的控制字符。'));
    if (this.writingTerminals.has(sessionId)) return reply(t('终端正在处理远程消息，请稍后再试。'));
    this.writingTerminals.add(sessionId);
    try {
      if (!this.ctx.pty.isRunning(sessionId)) await this.ctx.sessions.respawn(sessionId);
      const deadline = Date.now() + BIND_READY_TIMEOUT_MS;
      while (current() && Date.now() < deadline) {
        const fresh = this.worker(wsId, sessionId);
        if (!fresh) return failed(t('会话不存在'));
        if (!isBoundTerminalReady({ ptyRunning: this.ctx.pty.isRunning(sessionId), status: fresh.status, lifecycle: fresh.lifecycle })) {
          await delay(BIND_READY_POLL_MS, undefined, { signal });
          continue;
        }
        request.target = { kind: 'terminal', id: sessionId };
        const written = await terminalHost['terminal.write'](this.ctx, { sessionId, text, mode: 'typed', submit: true }, {
          signal,
          onFirstSubmit: () => { request.terminalSubmitted = true; }
        });
        if (signal.aborted) return reply('');
        try {
          const snapshot = await terminalHost['terminal.capture'](this.ctx, {
            sessionId, after: written.outputCursor, waitFor: { quietMs: 700, timeoutMs: 15_000 }
          }, { signal });
          const status = t('指令已提交到终端「{{name}}」。', { name: session.name });
          if (snapshot.previewPath) return { text: status, image: { filePath: snapshot.previewPath, mimeType: 'image/png' } };
          const output = this.ctx.pty.observeOutput(sessionId, () => {}, written.outputCursor);
          try {
            const text = plainTextFromPtyBuffer(output.backlog).text.trim().slice(-4000);
            return reply(text ? `${status}\n${text}` : status);
          } finally { output.dispose(); }
        } catch { return signal.aborted ? reply('') : reply(t('指令已提交，暂未取得终端截图。')); }
      }
      return failed(t('会话迟迟没有拉起'));
    } finally { this.writingTerminals.delete(sessionId); }
  }
}
