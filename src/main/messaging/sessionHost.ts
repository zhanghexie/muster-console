import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppContext } from '../context';
import type { AgentSessionHost } from '../agentSession/host';
import type { GuiSendImage } from '../agentSession/types';
import { getConfiguredCoreReasoning, getConfiguredPiThinkingLevels, primePiCatalogSnapshot } from '../agent/piConfigSync';
import { describeCoreReasoning } from '../agent/piReasoning';
import { guiMessageText, type GuiChatMessage, type GuiWorkerPush } from '../../shared/guiWorker';
import type { SessionMeta, WorkspaceInfo } from '../../shared/types';
import { defaultCwdFor } from '../../shared/workspaceRoots';
import { isMessagingId, type MessagingAccountRef, type SessionAdapter, type SessionSubmission } from './contracts';
import { isMessagingAssistantMessageId, MESSAGING_SESSION_OWNER, messagingSessionOwner, messagingTurnIdentity, ownsMessagingSession } from './sessionAuthority';
import { observeMessagingInteractions, type MessagingInteractionCallbacks } from './sessionInteractions';
import { stageMessagingPrompt } from './sessionAttachments';
import { projectSessionMessage, SESSION_EVENT_STRIDE, type MessagingSessionEvent, type MessagingSessionEventListener } from './sessionEvents';
import { deliverMessagingArtifacts, type ArtifactFactory } from './sessionArtifacts';

type HarnessOptions = Readonly<{
  workspace?: string; ungroupedWorkspace?: string;
  imageInputPolicy?: () => unknown;
  createArtifact?: ArtifactFactory;
  releaseArtifact?: (artifact: unknown) => void;
}>;
type RequestOptions = Readonly<{ signal?: AbortSignal }>;
type Control = Readonly<{ owner: object; key: string }>;
type AskOptions = RequestOptions & MessagingInteractionCallbacks & Readonly<{
  timeoutMs?: number;
  requestId?: string;
  control?: Control;
  files?: readonly unknown[];
  images?: readonly unknown[];
  finalAnswerOnly?: boolean;
  reasoning?: boolean;
  progressMode?: 'live' | 'all' | 'latest';
  onUpdate?: (update: { type: 'text' | 'tool' | 'reasoning'; text?: string; name?: string }) => unknown;
  onArtifact?: (artifact: unknown) => unknown;
}>;
type ActiveTurn = { assistantId: string; owner: string; control?: Control };
type ModelSelection = Readonly<{ provider: string; model: string; reasoningEffort?: string }>;

function harnessError(code: string, message: string, submissionState: 'not-submitted' | 'accepted' | 'unknown' = 'not-submitted') {
  return Object.assign(new Error(message), { code, details: { submissionState }, promptAccepted: submissionState === 'accepted' });
}

function workspacePathKey(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasLocalMarkdownLink(text: string): boolean {
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g)) {
    const target = match[1] ?? match[2];
    if (target && !target.startsWith('#') && (/^(?:file:|muster-file:|[a-z]:[\\/])/i.test(target) || !/^[a-z][a-z0-9+.-]*:/i.test(target))) return true;
  }
  return false;
}

function promptContent(prompt: unknown): { text: string; images?: GuiSendImage[] } {
  if (typeof prompt === 'string') return { text: prompt };
  if (!Array.isArray(prompt) || prompt.length === 0 || prompt.length > 32) throw harnessError('invalid-prompt', 'Invalid messaging prompt content.');
  const text: string[] = [];
  const images: GuiSendImage[] = [];
  let imageBytes = 0;
  for (const part of prompt) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      text.push(part.text);
      continue;
    }
    if (part?.type === 'image' && typeof part.data === 'string' && images.length < 8 &&
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mediaType)) {
      imageBytes += part.data.length;
      if (imageBytes > 16 * 1024 * 1024 || part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) {
        throw harnessError('invalid-attachment', 'Invalid or oversized messaging image.');
      }
      images.push({ data: part.data, mimeType: part.mediaType, ...(typeof part.name === 'string' ? { name: part.name } : {}) });
      continue;
    }
    throw harnessError('unsupported-content', 'This messaging content type is unavailable.');
  }
  return { text: text.join('\n'), ...(images.length ? { images } : {}) };
}

/** Main-process bridge. Each upstream bot receives a distinct scoped client. */
export class MusterMessagingSessionHost implements SessionAdapter {
  private accepting = true;
  private readonly closing = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private readonly sessionEventCleanups = new Set<() => void>();
  readonly active = new Map<string, ActiveTurn>();

  constructor(readonly ctx: Pick<AppContext, 'sessions' | 'agentSessions' | 'config' | 'coreReasoningCatalog'>) {}

  createHarness(options: HarnessOptions, channelKey: string): MusterHarnessClient {
    if (!isMessagingId(channelKey)) throw harnessError('channel-invalid', 'Invalid messaging channel.');
    return new MusterHarnessClient(this, options, channelKey);
  }

  get gui(): AgentSessionHost {
    const gui = this.ctx.agentSessions;
    if (!gui) throw harnessError('harness-unavailable', 'The messaging Session service is unavailable.');
    return gui;
  }

  listAgentPresets(): Array<{ id: string; name: string }> {
    return (this.gui.listPiModes() ?? []).filter(preset => !preset.broken && /^[a-z0-9][a-z0-9-]*$/.test(preset.id))
      .map(preset => ({ id: preset.id, name: preset.name }));
  }

  assertAdmission(): void {
    if (!this.accepting) throw harnessError('harness-closing', 'The messaging Session service is closing.');
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(harnessError('harness-closing', 'The messaging Session service is closing.'));
    const work = Promise.resolve().then(operation);
    this.work.add(work);
    const release = () => this.work.delete(work);
    void work.then(release, release);
    return work;
  }

  get signal(): AbortSignal { return this.closing.signal; }

  stopAdmission(): void { this.accepting = false; }

  async stopAndWait(): Promise<void> {
    this.stopAdmission();
    this.closing.abort(new DOMException('Messaging Session service closed', 'AbortError'));
    for (const close of this.sessionEventCleanups) close();
    await Promise.allSettled(this.work);
  }

  subscribeSessionEvents(listener: MessagingSessionEventListener): () => void {
    this.assertAdmission();
    const gui = this.gui;
    const turns = new Map<string, string>();
    const unsubscribe = gui.onPush(event => {
      if (event.kind !== 'sync' || !this.ctx.sessions.get(event.sessionId)?.meta?.[MESSAGING_SESSION_OWNER]) return;
      const sessionId = event.sessionId;
      let assistantId = turns.get(sessionId);
      if (!assistantId && this.accepting) {
        const current = gui.currentAssistantMessageId(sessionId);
        if (!current?.startsWith('im-local-assistant-')) return;
        const userId = current.replace('im-local-assistant-', 'im-local-user-');
        const index = event.messages.findIndex(message => message.id === userId && message.role === 'user');
        if (index < 0) return;
        assistantId = current;
        turns.set(sessionId, current);
        for (const projected of projectSessionMessage(event.messages[index], (event.before ?? 0) + index)) listener({ id: sessionId }, projected);
      }
      if (!assistantId) return;
      const index = event.messages.findIndex(message => message.id === assistantId && message.role === 'assistant');
      if (index < 0 || !event.messages[index].finishedAt) return;
      turns.delete(sessionId);
      for (const projected of projectSessionMessage(event.messages[index], (event.before ?? 0) + index)) listener({ id: sessionId }, projected);
    });
    const close = () => { unsubscribe(); turns.clear(); this.sessionEventCleanups.delete(close); };
    this.sessionEventCleanups.add(close);
    return close;
  }

  async submit(request: SessionSubmission) {
    if (!this.accepting) return { status: 'retryable' as const };
    if (request.actor !== 'remote-human' || request.intent !== 'external-message' || request.message.attachments?.length) {
      return { status: 'rejected' as const };
    }
    const owner = messagingSessionOwner(request.origin);
    const session = this.ctx.sessions.get(request.binding.sessionId);
    if (!ownsMessagingSession(session, owner) || session.archived || session.workspaceId !== request.binding.workspaceId) {
      return { status: 'rejected' as const };
    }
    this.gui.open(session);
    return this.gui.sendMessagingInput(request.binding.sessionId, {
      owner, workspaceId: request.binding.workspaceId, requestId: request.requestId, text: request.message.plainText
    });
  }
}

/** Direct adapter for the reference transports; networking and platform state remain in their Runtime. */
class MusterHarnessClient {
  private readonly owner?: string;
  readonly canChooseSessionId = false;

  constructor(
    private readonly host: MusterMessagingSessionHost,
    private readonly options: HarnessOptions,
    private readonly channelKey: string,
    bot?: MessagingAccountRef
  ) {
    if (bot) this.owner = messagingSessionOwner(bot);
  }

  forBot(botId: string): MusterHarnessClient {
    if (this.owner || !isMessagingId(botId)) throw harnessError('account-invalid', 'Invalid messaging account scope.');
    return new MusterHarnessClient(this.host, this.options, this.channelKey, { channelKey: this.channelKey, botId });
  }

  async ensureRunning(options: RequestOptions = {}): Promise<true> {
    options.signal?.throwIfAborted();
    this.host.assertAdmission();
    if (!this.host.gui.getDriver('pi')) throw harnessError('harness-unavailable', 'The built-in Pi engine is unavailable.');
    return true;
  }

  async health(options: RequestOptions = {}): Promise<true> {
    return this.ensureRunning(options);
  }

  private workspace(input?: string): WorkspaceInfo {
    const config = this.host.ctx.config.get();
    const alias = input ?? this.options.workspace;
    const active = config.workspaces.find(workspace => workspace.id === config.activeWorkspaceId);
    if (!alias || (this.options.ungroupedWorkspace && workspacePathKey(alias) === workspacePathKey(this.options.ungroupedWorkspace))) {
      if (active) return active;
      throw harnessError('workspace-unavailable', 'Open a Muster workspace before using messaging.');
    }
    const workspace = config.workspaces.find(item => item.id === alias || workspacePathKey(defaultCwdFor(item)) === workspacePathKey(alias));
    if (!workspace) throw harnessError('workspace-not-found', 'The messaging workspace must be registered in Muster.');
    return workspace;
  }

  private requireOwner(): string {
    if (!this.owner) throw harnessError('account-scope-required', 'A messaging account must own the Session.');
    return this.owner;
  }

  private ownedSession(sessionId: string): SessionMeta | undefined {
    const session = this.host.ctx.sessions.get(sessionId);
    return this.owner && ownsMessagingSession(session, this.owner) ? session : undefined;
  }

  private requireSession(sessionId: string, allowArchived = false): SessionMeta & { workspaceId: string } {
    const session = this.ownedSession(sessionId);
    if (!session?.workspaceId) throw harnessError('session-not-found', 'The Session is unavailable to this messaging account.');
    if (!allowArchived && session.archived) throw harnessError('session-archived', 'The messaging Session is archived.');
    return session as SessionMeta & { workspaceId: string };
  }

  async createSession(options: RequestOptions & { workspace?: string; agentPreset?: string } = {}): Promise<string> {
    await this.ensureRunning(options);
    const preset = options.agentPreset;
    if (preset && !this.host.listAgentPresets().some(candidate => candidate.id === preset)) {
      throw harnessError('agent-preset-unavailable', 'The selected Muster preset is unavailable.');
    }
    const owner = this.requireOwner();
    const workspace = this.workspace(options.workspace);
    return this.host.run(async () => {
      this.host.assertAdmission();
      options.signal?.throwIfAborted();
      const session = await this.host.ctx.sessions.createTerminal({
        workspaceId: workspace.id, runtime: 'pi', activate: false, configurePermissions: true,
        injectHostIntro: false, inheritMeta: { guiMode: 'ask', ...(preset ? { piModeId: preset } : {}) }, meta: { [MESSAGING_SESSION_OWNER]: owner }
      });
      this.host.ctx.sessions.flushPersist();
      this.requireSession(session.id);
      this.host.assertAdmission();
      return session.id;
    });
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return !!this.ownedSession(sessionId);
  }

  async isSessionArchived(sessionId: string): Promise<boolean> { return this.ownedSession(sessionId)?.archived === true; }

  async isSessionRunning(sessionId: string): Promise<boolean> {
    return !!this.ownedSession(sessionId) && this.host.gui.isBusy(sessionId);
  }

  async adoptWorkspaceSession(sessionId: string) {
    const session = this.requireSession(sessionId);
    return { sessionId, workspace: defaultCwdFor(this.workspace(session.workspaceId)) };
  }

  async renameSession(sessionId: string, title: string): Promise<{ sessionId: string }> {
    this.host.assertAdmission();
    this.requireSession(sessionId);
    if (!isMessagingId(title)) throw harnessError('title-invalid', 'Invalid messaging Session title.');
    this.host.ctx.sessions.rename(sessionId, title);
    return { sessionId };
  }

  async archiveWorkspaceSession(sessionId: string) {
    this.host.assertAdmission();
    this.requireSession(sessionId);
    this.host.ctx.sessions.setArchived(sessionId, true);
    return { sessionId, archived: true };
  }

  async listWorkspaceEntries() {
    return this.host.ctx.config.get().workspaces.map(workspace => ({ path: defaultCwdFor(workspace), title: workspace.name }));
  }

  async listWorkspaces(): Promise<string[]> { return (await this.listWorkspaceEntries()).map(workspace => workspace.path); }

  async listWorkspaceSessions(workspace: string) {
    const selected = this.workspace(workspace);
    const sessions = this.host.ctx.sessions.list().filter(session => session.workspaceId === selected.id && !!this.ownedSession(session.id));
    return {
      workspace: defaultCwdFor(selected),
      sessions: sessions.map(session => ({ sessionId: session.id, title: session.name, archived: session.archived === true,
        blank: this.host.gui.messageCount(session.id) === 0, origin: null, summaryAvailable: true,
        time: session.lastUsedAt ?? session.createdAt }))
    };
  }

  async isUngroupedWorkspace(workspace: string): Promise<boolean> {
    return !!this.options.ungroupedWorkspace && workspacePathKey(workspace) === workspacePathKey(this.options.ungroupedWorkspace);
  }

  async listModels() {
    await primePiCatalogSnapshot();
    const providers = this.host.ctx.config.get().llm?.providers ?? [];
    return { groups: providers.filter(provider => provider.enabled !== false).map(provider => ({
      id: provider.id, name: provider.name || provider.id, models: provider.models.map(model => {
        const binding = getConfiguredCoreReasoning(this.host.ctx.coreReasoningCatalog?.snapshot, provider, model);
        const efforts = binding ? describeCoreReasoning(binding).options.map(option => ({ id: option.value, name: option.label }))
          : getConfiguredPiThinkingLevels(provider, model)?.map(id => ({ id, name: id })) ?? [];
        return { id: model.id, name: model.name || model.id, ...(efforts.length ? { reasoning: { efforts } } : {}) };
      })
    })), failures: [] };
  }

  async getSessionModels(sessionId: string) {
    const session = this.requireSession(sessionId);
    const config = this.host.ctx.config.get().llm;
    const catalog = await this.listModels();
    const provider = session.modelOverride?.providerId ?? config?.activeProviderId;
    const model = session.modelOverride?.modelId ?? config?.activeModelId;
    if (!provider || !model) throw harnessError('model-unavailable', 'Configure a Muster model before using the messaging Session.');
    const reasoningEffort = session.modelParameters?.reasoning ?? session.thinkingLevel;
    return { ...catalog, current: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
      routable: catalog.groups.some(group => group.id === provider && group.models.some(row => row.id === model)) };
  }

  async getSessionPermissions(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.guiMode !== 'ask') throw harnessError('permissions-unavailable', 'Messaging Session permission configuration changed.');
    return { currentValue: 'ask', options: [{ value: 'ask', name: 'Ask', description: 'Tool approval for messaging Sessions.' }] };
  }

  async selectSessionModel(sessionId: string, selection: ModelSelection, options: RequestOptions = {}) {
    this.host.assertAdmission();
    options.signal?.throwIfAborted();
    const session = this.requireSession(sessionId);
    const catalog = await this.getSessionModels(sessionId);
    const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(row => row.id === selection.model);
    if (!model) throw harnessError('model-unavailable', 'The selected model is unavailable.');
    const reasoning = selection.reasoningEffort;
    if (reasoning && !model.reasoning?.efforts.some(option => option.id === reasoning)) {
      throw harnessError('reasoning-unavailable', 'The requested effort is unavailable for this model.');
    }
    const identity = { providerId: selection.provider, modelId: selection.model };
    const gui = this.host.gui;
    await gui.validateLaunchModel('pi', session.cwd ?? defaultCwdFor(this.workspace(session.workspaceId)), identity, session.piModeId);
    const expected = JSON.stringify([session.workspaceId, session.piModeId, session.modelOverride, session.modelParameters]);
    await gui.commitPickerModelConfiguration(sessionId, identity, reasoning ? { reasoning } : {}, () => {
      this.host.assertAdmission();
      options.signal?.throwIfAborted();
      const current = this.requireSession(sessionId);
      if (expected !== JSON.stringify([current.workspaceId, current.piModeId, current.modelOverride, current.modelParameters])) {
        throw harnessError('model-selection-stale', 'The messaging Session configuration changed.');
      }
      gui.assertLaunchModelAllowed('pi', identity, current.piModeId);
    });
    return { selected: { provider: selection.provider, model: selection.model, ...(reasoning ? { reasoningEffort: reasoning } : {}) } };
  }

  async getImageInputLimits() {
    const megabyte = 1024 * 1024;
    const input = (await this.options.imageInputPolicy?.()) as Partial<Record<'maxDownloadMb' | 'maxImageMb' | 'maxTotalMb' | 'maxImages', number>> | undefined;
    const bound = (value: number | undefined, fallback: number) => Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, fallback) : fallback;
    const maxDownloadBytes = bound(input?.maxDownloadMb, 16) * megabyte;
    const maxTotalImageBytes = bound(input?.maxTotalMb, 32) * megabyte;
    const maxImageBytes = Math.min(bound(input?.maxImageMb, 16) * megabyte, maxDownloadBytes, maxTotalImageBytes);
    return { maxDownloadBytes, maxTotalImageBytes, maxImageBytes, maxImages: bound(input?.maxImages, 16) };
  }

  async readSessionHistory(sessionId: string, options: { maxMessages?: number; beforeSeq?: number } = {}) {
    this.requireSession(sessionId, true);
    if ((options.maxMessages !== undefined && (!Number.isSafeInteger(options.maxMessages) || options.maxMessages < 1)) ||
        (options.beforeSeq !== undefined && (!Number.isSafeInteger(options.beforeSeq) || options.beforeSeq < 0))) {
      throw harnessError('history-page-invalid', 'Invalid messaging Session history cursor.');
    }
    const limit = Math.min(120, Math.max(1, options.maxMessages ?? 50));
    const before = options.beforeSeq === undefined ? undefined : Math.floor(options.beforeSeq / SESSION_EVENT_STRIDE);
    const page = this.host.gui.getHistoryRange(sessionId, before, limit);
    if (!page) throw harnessError('session-history-unavailable', 'The messaging Session history is unavailable.');
    const offset = page.before ?? 0;
    return {
      events: page.messages.flatMap((message, index) => projectSessionMessage(message, offset + index).map(event => ({ event }))),
      hasMore: page.hasEarlier === true
    };
  }

  async rpc(method: string, payload: { sessionId?: string; maxMessages?: number; beforeSeq?: number } = {}, _timeoutMs?: number, options: RequestOptions = {}) {
    options.signal?.throwIfAborted();
    if (method === 'host.describe') {
      await this.ensureRunning(options);
      return { name: 'Muster' };
    }
    if (method === 'workspace.list') {
      const workspaces = this.host.ctx.config.get().workspaces;
      const sessions = this.host.ctx.sessions.list().filter(session => !!this.ownedSession(session.id));
      return { items: workspaces.map(workspace => ({ path: defaultCwdFor(workspace), title: workspace.name, workspaceId: workspace.id,
        sessionIds: sessions.filter(session => session.workspaceId === workspace.id).map(session => session.id) })),
        archivedSessionIds: sessions.filter(session => session.archived).map(session => session.id) };
    }
    if (method === 'session.list') return { items: this.host.ctx.sessions.list().filter(session => !!this.ownedSession(session.id)).map(session => ({
      sessionId: session.id, running: this.host.gui.isBusy(session.id), blank: this.host.gui.messageCount(session.id) === 0,
      projections: { values: { title: session.name, updatedAt: session.lastUsedAt ?? session.createdAt } }
    })) };
    if (method === 'session.history' && payload.sessionId) return this.readSessionHistory(payload.sessionId, payload);
    throw harnessError('harness-api-not-found', 'This Harness operation is unavailable in Muster.');
  }

  async hasActiveTurn(sessionId: string, control?: Control): Promise<boolean> {
    const active = this.host.active.get(sessionId);
    return !!active && active.owner === this.owner && active.control?.owner === control?.owner &&
      active.control?.key === control?.key && this.host.gui.currentAssistantMessageId(sessionId) === active.assistantId;
  }

  async stopActiveTurn(sessionId: string, control?: Control): Promise<boolean> {
    const active = this.host.active.get(sessionId);
    if (!active || active.owner !== this.owner || active.control?.owner !== control?.owner || active.control?.key !== control?.key ||
        this.host.gui.currentAssistantMessageId(sessionId) !== active.assistantId) return false;
    await this.host.gui.abort(sessionId, { holdQueue: true });
    return true;
  }

  async stopDeferredTurn(): Promise<boolean> { throw harnessError('deferred-turn-unavailable', 'Deferred turns are unavailable.'); }
  async steerActiveTurn(): Promise<boolean> { throw harnessError('turn-steer-unavailable', 'Remote turn steering is unavailable.'); }
  supportsSessionFork(): boolean { return !!this.owner; }

  async watchHarnessEvents(options: {
    signal: AbortSignal; onSessionEvent: (payload: { sessionId: string; event: MessagingSessionEvent }) => void;
    onReconnect?: () => void;
  }): Promise<void> {
    this.requireOwner();
    const signal = AbortSignal.any([options.signal, this.host.signal]);
    if (signal.aborted) return;
    const dispose = this.host.subscribeSessionEvents((session, event) => {
      if (!signal.aborted && this.ownedSession(session.id)) options.onSessionEvent({ sessionId: session.id, event });
    });
    try {
      options.onReconnect?.();
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally { dispose(); }
  }

  async forkSession(sessionId: string, options: RequestOptions & { atSeq?: number } = {}) {
    const session = this.requireSession(sessionId);
    const owner = this.requireOwner();
    return this.host.run(async () => {
      options.signal?.throwIfAborted();
      const gui = this.host.gui;
      const before = options.atSeq === undefined ? undefined : Math.floor(options.atSeq / SESSION_EVENT_STRIDE) + 1;
      const history = gui.getHistoryRange(sessionId, before, before === undefined ? 120 : 1);
      const cutoff = history?.messages.slice().reverse().find(message => message.role === 'assistant' &&
        isMessagingAssistantMessageId(message.id) && message.finishedAt && !message.error && !message.aborted);
      if (!cutoff) throw harnessError('fork-unavailable', 'No completed messaging turn is available to fork.');
      gui.open(this.requireSession(session.id));
      const result = await gui.forkSession(sessionId, cutoff.id, { activate: false, messagingOwner: owner });
      if (!result.ok || !result.sessionId) throw harnessError('fork-unavailable', 'Muster could not fork this messaging Session.');
      this.requireSession(result.sessionId);
      this.host.ctx.sessions.flushPersist();
      return { sessionId: result.sessionId };
    });
  }

  async executeCommand(sessionId: string, line: string, options: RequestOptions = {}) {
    this.host.assertAdmission();
    options.signal?.throwIfAborted();
    this.requireSession(sessionId);
    if (/^\/permission\s+ask\s*$/i.test(line)) return this.getSessionPermissions(sessionId);
    const compact = /^\/compact(?:\s+(.{1,4096}))?\s*$/i.exec(line);
    if (!compact) throw harnessError('commands-unavailable', 'This local Muster command is unavailable remotely.');
    const result = await this.host.gui.compactSession(sessionId, compact[1]);
    if (!result.ok) throw harnessError('compact-failed', 'Muster could not compact this messaging Session.');
    return { ok: true, message: 'The messaging Session context was compacted.' };
  }

  ask(sessionId: string, prompt: unknown, options: AskOptions | number = {}): Promise<string> {
    const request = typeof options === 'number' ? { timeoutMs: options } : options;
    return this.host.run(() => this.askOwned(sessionId, prompt, request));
  }

  private async askOwned(sessionId: string, prompt: unknown, options: AskOptions): Promise<string> {
    this.host.assertAdmission();
    options.signal?.throwIfAborted();
    const owner = this.requireOwner();
    const session = this.requireSession(sessionId);
    const gui = this.host.gui;
    if (this.host.active.has(sessionId)) throw harnessError('session-busy', 'The messaging Session already has an active turn.');
    const content = promptContent(prompt);
    const requestId = options.requestId ?? randomUUID();
    const { assistantMessageId } = messagingTurnIdentity(requestId);
    const active = { assistantId: assistantMessageId, owner, control: options.control };
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(30 * 60_000, options.timeoutMs) : 600_000;
    const signal = AbortSignal.any([this.host.signal, AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
    let unsubscribe = () => {};
    let abortListener = () => {};
    let latest: GuiChatMessage | undefined;
    let lastText = '';
    let progress = Promise.resolve();
    let reporting = false;
    const updates: Parameters<NonNullable<AskOptions['onUpdate']>>[0][] = [];
    const textParts = new Map<number, string>();
    const toolIds = new Set<string>();
    const interactions = observeMessagingInteractions(gui, sessionId, assistantMessageId, () => { this.requireSession(sessionId); }, options, signal);
    this.host.active.set(sessionId, active);
    try {
      const prepared = await stageMessagingPrompt({ ...content, fileSources: options.files, imageSources: options.images,
        session, userData: gui.semanticRoot, config: this.host.ctx.config.get(), signal });
      this.host.assertAdmission();
      this.requireSession(sessionId);
      const completion = new Promise<GuiChatMessage>((resolve, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener('abort', abortListener, { once: true });
        const report = (update: Parameters<NonNullable<AskOptions['onUpdate']>>[0]) => {
          if (!options.onUpdate) return;
          const tail = updates.at(-1);
          if (tail?.type === 'text' && update.type === 'text') tail.text = update.text;
          else if (tail?.type === 'reasoning' && update.type === 'reasoning' && (tail.text?.length ?? 0) < 16_384) {
            tail.text = `${tail.text ?? ''}${update.text ?? ''}`.slice(0, 16_384);
          } else if (updates.length < 64) updates.push(update);
          if (reporting) return;
          reporting = true;
          progress = Promise.resolve().then(async () => {
            while (updates.length && !signal.aborted) {
              const current = updates.shift()!;
              try { await options.onUpdate?.(current); } catch { /* Final delivery still runs. */ }
            }
          }).finally(() => { reporting = false; });
        };
        unsubscribe = gui.onPush((event: GuiWorkerPush) => {
          if (event.sessionId !== sessionId || signal.aborted) return;
          if (event.kind === 'part' && event.messageId === assistantMessageId && event.part.kind === 'tool') {
            const tool = event.part.tool;
            if (tool.name && toolIds.size < 512 && !toolIds.has(tool.id)) {
              toolIds.add(tool.id);
              report({ type: 'tool', name: tool.name });
            }
          }
          if (event.kind !== 'sync' && event.kind !== 'delta') return;
          if (event.kind === 'delta' && event.messageId !== assistantMessageId) return;
          if (event.kind === 'delta' && event.deltaKind === 'thinking' && options.reasoning) {
            report({ type: 'reasoning', text: event.delta });
            return;
          }
          if (event.kind === 'sync') {
            latest = event.messages.find(message => message.id === assistantMessageId && message.role === 'assistant') ?? latest;
            if (latest) {
              textParts.clear();
              latest.parts.forEach((part, index) => { if (part.kind === 'text') textParts.set(index, part.text); });
              interactions(latest);
            }
          }
          if (event.kind === 'delta' && event.deltaKind === 'text') {
            textParts.set(event.partIndex, `${textParts.get(event.partIndex) ?? ''}${event.delta}`);
          }
          if (!latest) return;
          const text = Array.from(textParts.values()).join('\n\n').trim();
          if (text && text !== lastText && !latest.finishedAt) {
            lastText = text;
            report({ type: 'text', text });
          }
          if (latest.finishedAt) resolve(latest);
        });
      });
      void completion.catch(() => {});
      signal.throwIfAborted();
      gui.open(session);
      const saved = gui.getHistoryRange(sessionId, undefined, 1, assistantMessageId)?.messages.find(message => message.id === assistantMessageId);
      const alreadyFinished = !!saved?.finishedAt;
      const receipt = gui.sendMessagingInput(sessionId, { owner, workspaceId: session.workspaceId, requestId, ...prepared });
      if (receipt.status === 'retryable') throw harnessError('session-busy', 'The messaging Session is not ready for a new turn.');
      if (receipt.status === 'rejected') throw harnessError('session-forbidden', 'The messaging Session rejected the input.');
      if (receipt.status !== 'accepted' || receipt.turnId !== assistantMessageId) {
        throw harnessError('submission-unknown', 'Muster could not confirm receipt of the messaging input.', 'unknown');
      }
      let settled;
      try {
        settled = saved?.finishedAt ? saved : await completion;
      } catch (error) {
        if (gui.currentAssistantMessageId(sessionId) === assistantMessageId) await gui.abort(sessionId, { holdQueue: true });
        if (options.signal?.aborted || this.host.signal.aborted) throw error;
        throw harnessError('turn-timeout', 'The accepted messaging turn exceeded its reply deadline.', 'accepted');
      }
      await progress;
      const current = this.requireSession(sessionId);
      if (current.workspaceId !== session.workspaceId || current.cwd !== session.cwd || current.guiMode !== 'ask') {
        throw harnessError('session-output-revoked', 'The messaging Session scope changed after accepting the input.', 'accepted');
      }
      if (settled.aborted) throw harnessError('turn-stopped', 'The messaging turn was stopped.', 'accepted');
      if (settled.error) throw harnessError('turn-failed', 'The messaging turn did not complete successfully.', 'accepted');
      let toolBoundary = -1;
      if (options.finalAnswerOnly) settled.parts.forEach((part, index) => { if (part.kind === 'tool') toolBoundary = index; });
      const answer = guiMessageText({ ...settled, parts: settled.parts.slice(toolBoundary + 1) });
      if (!alreadyFinished && this.options.createArtifact && options.onArtifact && hasLocalMarkdownLink(answer)) {
        const deadline = Date.now() + 1500;
        while ((latest ?? settled).turnChanges?.finalizing && Date.now() < deadline && !signal.aborted) {
          await sleep(25, undefined, { signal }).catch(() => {});
        }
        if (options.signal?.aborted || this.host.signal.aborted) signal.throwIfAborted();
        const finished = latest?.finishedAt ? latest : settled;
        if (finished.turnChanges?.finalizing || signal.aborted) return `${answer}\n\nResult files were still being prepared and were not attached.`;
        const current = this.requireSession(sessionId);
        const root = finished.turnChanges?.repository?.root;
        const workspace = session.cwd ?? defaultCwdFor(this.workspace(session.workspaceId));
        const relative = root && path.relative(workspace, root);
        if (current.workspaceId === session.workspaceId && current.cwd === session.cwd &&
            (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)))) {
          await deliverMessagingArtifacts({
            message: { ...finished, parts: finished.parts.slice(toolBoundary + 1) }, workspace: root ?? workspace,
            sessionId, turnId: assistantMessageId, signal,
            createArtifact: this.options.createArtifact, releaseArtifact: this.options.releaseArtifact, onArtifact: options.onArtifact
          });
        }
      }
      return answer;
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', abortListener);
      if (this.host.active.get(sessionId) === active) this.host.active.delete(sessionId);
    }
  }
}
