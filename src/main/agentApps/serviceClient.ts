import { Worker } from 'node:worker_threads';
import type { AgentAppDefinition, AppCall, AppCallResult, AppChanged, AppConnection, AppConnectionInput, AppFeishuChat, AppFeishuChatPage, AppImageAsset, AppLibraryItem, AppOperation, AppQuery, AppSnapshot, AppValues } from '../../shared/agentApps';
import type { AppActor, AgentAppsOptions, AgentAppsService, ConnectionSecret } from './service';
import type { PhoneFeishuConversation } from './feishuAccounts';
import type { AppChannelHost } from './appChannels';
import type { LogicalChannelLegacyAdapter } from '../../shared/messagingChannels';

/** Async boundary around the complete app service; the service and its SQLite store live in one worker. */
export class AgentAppsServiceClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private readonly hostCalls = new Map<number, AbortController>();
  private readonly hostPending = new Set<Promise<void>>();
  private readonly imapReservations = new Map<number, () => void>();
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private workspaceTimer?: ReturnType<typeof setInterval>;
  constructor(workerFile: string, private readonly options: AgentAppsOptions) {
    this.worker = new Worker(workerFile, { workerData: { root: options.root, workspaces: options.workspaces(), feishu: !!options.feishuAccounts, channels: !!options.channels, claimImapConsumer: !!options.claimImapConsumer } });
    this.worker.on('message', (message: { kind: string; id?: number; method?: string; args?: unknown[]; result?: unknown; error?: string; eventKind?: string; value?: unknown; memory?: SharedArrayBuffer }) => {
      if (message.kind === 'result') {
        const pending = this.pending.get(message.id!); if (!pending) return;
        this.pending.delete(message.id!); pending.cleanup();
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      } else if (message.kind === 'emit') {
        try { (this.options.emit as unknown as (kind: 'operation' | 'changed', value: AppOperation | AppChanged) => void)(message.eventKind as 'operation' | 'changed', message.value as AppOperation | AppChanged); }
        catch (error) { console.warn('[agentApps] UI subscriber failed', error instanceof Error ? error.message : String(error)); }
      } else if (message.kind === 'host-call') {
        const pending = this.hostCall(message.id!, message.method!, message.args ?? []);
        this.hostPending.add(pending);
        void pending.then(() => this.hostPending.delete(pending), error => {
          this.hostPending.delete(pending); console.error('[agentApps] host response failed', error);
        });
      }
      else if (message.kind === 'host-cancel') this.hostCalls.get(message.id!)?.abort();
      else if (message.kind === 'host-sync') this.hostSync(message.method!, message.args ?? [], message.memory!);
    });
    this.worker.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.worker.on('exit', code => { if (!this.stopped || this.pending.size) this.fail(new Error(`App service worker exited (${code})`)); });
  }
  private fail(error: Error): void {
    this.stopped = true;
    if (this.workspaceTimer) clearInterval(this.workspaceTimer);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const controller of this.hostCalls.values()) controller.abort();
    this.releaseImapReservations();
    this.options.feishuAccounts?.stop();
  }
  private releaseImapReservations(): void {
    for (const release of this.imapReservations.values()) release();
    this.imapReservations.clear();
  }
  private hostSync(method: string, args: unknown[], memory: SharedArrayBuffer): void {
    const state = new Int32Array(memory, 0, 2), bytes = new Uint8Array(memory, 8);
    let response: { value?: unknown; error?: string };
    try {
      switch (method) {
        case 'encrypt': response = { value: this.options.encrypt(args[0] as string) }; break;
        case 'decrypt': response = { value: this.options.decrypt(args[0] as string) }; break;
        case 'imap.claim': {
          const workspaceId = args[0] as string;
          if (!this.options.claimImapConsumer || this.stopped || this.closing || !this.options.workspaces().includes(workspaceId)) throw new Error('App workspace is unavailable');
          const token = ++this.sequence;
          this.imapReservations.set(token, this.options.claimImapConsumer(workspaceId, args[1] as Extract<AppConnection, { kind: 'imap-smtp' }>));
          response = { value: token }; break;
        }
        case 'imap.release': {
          const token = args[0] as number;
          this.imapReservations.get(token)?.(); this.imapReservations.delete(token); response = {}; break;
        }
        case 'feishu.cancel': this.options.feishuAccounts?.cancel(args[0] as string); response = {}; break;
        case 'feishu.stopWorkspace': this.options.feishuAccounts?.stopWorkspace(args[0] as string); response = {}; break;
        case 'feishu.stop': this.options.feishuAccounts?.stop(); response = {}; break;
        default: throw new Error('Unknown synchronous app host operation');
      }
    } catch (error) { response = { error: error instanceof Error ? error.message : String(error) }; }
    let encoded = new TextEncoder().encode(JSON.stringify(response));
    if (encoded.length > bytes.length) encoded = new TextEncoder().encode(JSON.stringify({ error: 'App host response is too large' }));
    bytes.set(encoded); Atomics.store(state, 1, encoded.length); Atomics.store(state, 0, 1); Atomics.notify(state, 0);
  }
  private async hostCall(id: number, method: string, args: unknown[]): Promise<void> {
    const controller = new AbortController(); this.hostCalls.set(id, controller);
    if (this.stopped || this.closing) controller.abort();
    try {
      if (controller.signal.aborted) throw new Error('App service worker is stopping');
      let result: unknown;
      switch (method) {
        case 'channels.catalog': result = await this.options.channels?.catalog(args[0] as string, controller.signal); break;
        case 'channels.bind': result = await this.options.channels?.bindChannel(args[0] as string, args[1] as string, args[2] === true, controller.signal); break;
        case 'channels.legacyAccess': result = await this.options.channels?.legacyAccess(args[0] as string, controller.signal); break;
        case 'channels.captureLegacyNotices': result = await this.options.channels?.captureLegacyNotices(args[0] as string, args[1] as Parameters<AppChannelHost['captureLegacyNotices']>[1], controller.signal); break;
        case 'channels.list': result = await this.options.channels?.listChannels(args[0] as string, controller.signal); break;
        case 'channels.messages': result = await this.options.channels?.listMessages(args[0] as string, args[1] as string, args[2] as Parameters<AppChannelHost['listMessages']>[2], controller.signal); break;
        case 'channels.get': result = await this.options.channels?.getMessage(args[0] as string, args[1] as string, args[2] as string, controller.signal); break;
        case 'channels.state': result = await this.options.channels?.setMessageState(args[0] as Parameters<AppChannelHost['setMessageState']>[0]); break;
        case 'channels.reply': result = await this.options.channels?.reply(args[0] as Parameters<AppChannelHost['reply']>[0], controller.signal); break;
        case 'channels.send': result = await this.options.channels?.send(args[0] as Parameters<AppChannelHost['send']>[0], controller.signal); break;
        case 'channels.saveDraft': result = await this.options.channels?.saveDraft(args[0] as Parameters<AppChannelHost['saveDraft']>[0], controller.signal); break;
        case 'connectors.feed': result = await this.options.connectors.feed(args[0] as string, controller.signal); break;
        case 'connectors.sync': result = await this.options.connectors.sync(args[0] as AppConnection, args[1] as ConnectionSecret | undefined, args[2] as Record<string, string | number>, controller.signal, args[3] as string | undefined); break;
        case 'connectors.send': result = await this.options.connectors.send(args[0] as AppConnection, args[1] as ConnectionSecret | undefined, args[2] as AppValues, args[3] as string, controller.signal); break;
        case 'connectors.test': result = await this.options.connectors.test(args[0] as AppConnection, args[1] as ConnectionSecret | undefined, args[2] as string | undefined, controller.signal); break;
        case 'connectors.listFeishuChats': result = await this.options.connectors.listFeishuChats(args[0] as 'bot' | 'user', args[1] as string | undefined, args[2] as string); break;
        case 'connectors.feishuBotId': result = await this.options.connectors.feishuBotId?.(args[0] as string); break;
        case 'connectors.feishuConversationName': result = await this.options.connectors.feishuConversationName?.(args[0] as string, args[1] as string, args[2] as 'p2p' | 'group', args[3] as string); break;
        case 'confirmSend': result = await this.options.confirmSend(args[0] as string, args[1] as string, args[2] as AppValues, controller.signal); break;
        case 'authorizeDefinition': result = await this.options.authorizeDefinition?.(args[0] as string, args[1] as string, args[2] as AgentAppDefinition, controller.signal) ?? false; break;
        case 'deliver': result = await this.options.deliver(args[0] as string, args[1] as Parameters<AgentAppsOptions['deliver']>[1]); break;
        case 'feishu.get': result = await this.options.feishuAccounts?.get(args[0] as string); break;
        case 'feishu.start': result = await this.options.feishuAccounts?.start(args[0] as string); break;
        case 'feishu.ensureReceiving': result = await this.options.feishuAccounts?.ensureReceiving(args[0] as string); break;
        case 'feishu.beginBinding': result = await this.options.feishuAccounts?.beginBinding(args[0] as string); break;
        default: throw new Error('Unknown app host operation');
      }
      if (!this.stopped) this.worker.postMessage({ kind: 'host-result', id, result });
    } catch (error) { if (!this.stopped) this.worker.postMessage({ kind: 'host-result', id, error: error instanceof Error ? error.message : String(error) }); }
    finally { this.hostCalls.delete(id); }
  }
  private call<T>(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    if (this.stopped || this.closing) return Promise.reject(new Error('App service worker is stopped'));
    if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.worker.postMessage({ kind: 'abort', id });
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      try { this.worker.postMessage({ kind: 'request', id, method, args, workspaces: this.options.workspaces() }); if (signal?.aborted) abort(); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async start(): Promise<void> {
    await this.call('start');
    if (this.stopped || this.closing) return;
    this.workspaceTimer ??= setInterval(() => { if (!this.stopped && !this.closing) this.worker.postMessage({ kind: 'workspaces', workspaces: this.options.workspaces() }); }, 2000);
    this.workspaceTimer.unref?.();
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.workspaceTimer) { clearInterval(this.workspaceTimer); this.workspaceTimer = undefined; }
    const closing = this.stopped ? Promise.resolve() : this.call('stop');
    for (const controller of this.hostCalls.values()) controller.abort();
    this.options.feishuAccounts?.stop();
    this.closing = (async () => {
      const errors: unknown[] = [];
      try { await closing; } catch (error) { errors.push(error); }
      this.stopped = true;
      try { await this.worker.terminate(); } catch (error) { errors.push(error); }
      while (this.hostPending.size) await Promise.allSettled([...this.hostPending]);
      try { await this.options.connectors.closeImap?.(); } catch (error) { errors.push(error); }
      this.releaseImapReservations();
      try { await this.options.feishuAccounts?.stopAndWait(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'App service shutdown failed');
    })();
    void this.closing.catch(() => { this.closing = undefined; });
    return this.closing;
  }
  tick(): Promise<void> { return this.call('tick'); }
  prepareImapReservations(): Promise<void> { return this.call('prepareImapReservations'); }
  legacyFeishuReceiving(workspaceId: string): boolean { return this.options.feishuAccounts?.isReceiving(workspaceId) ?? false; }
  snapshot(ws: string): Promise<AppSnapshot> { return this.call('snapshot', [ws]); }
  describeApp(ws: string, appId: string): Promise<ReturnType<AgentAppsService['describeApp']>> { return this.call('describeApp', [ws, appId]); }
  query(ws: string, query: AppQuery): Promise<AppCallResult> { return this.call('query', [ws, query]); }
  readonly legacyChannels: LogicalChannelLegacyAdapter = {
    listSources: workspaceId => this.call('legacyChannels.listSources', [workspaceId]),
    listMessages: (workspaceId, channelId, sourceId, query) => this.call('legacyChannels.listMessages', [workspaceId, channelId, sourceId, query]),
    getMessage: (workspaceId, channelId, sourceId, messageId) => this.call('legacyChannels.getMessage', [workspaceId, channelId, sourceId, messageId]),
    send: (input, signal) => this.call('legacyChannels.send', [input], signal),
    reply: (input, signal) => this.call('legacyChannels.send', [input], signal),
    setMessageState: input => this.call('legacyChannels.state', [input]),
    saveDraft: (input, signal) => this.call('legacyChannels.saveDraft', [input], signal)
  };
  async notification(ws: string, id: string, budget?: number): Promise<Awaited<ReturnType<AgentAppsService['resolveNotifications']>>[number]> { return this.call('notification', [ws, id, budget]); }
  notifications(ws: string, ids: string[], budget?: number): ReturnType<AgentAppsService['resolveNotifications']> { return this.call('notifications', [ws, ids, budget]); }
  execute(ws: string, call: AppCall, actor: AppActor): Promise<AppCallResult> { const { signal, ...safeActor } = actor; return this.call('execute', [ws, call, safeActor], signal); }
  install(ws: string, definition: unknown, options?: Parameters<AgentAppsService['install']>[2]): Promise<AgentAppDefinition> { return this.call('install', [ws, definition, options]); }
  uninstall(ws: string, appId: string, deleteData = false): Promise<ReturnType<AgentAppsService['uninstall']>> { return this.call('uninstall', [ws, appId, deleteData]); }
  setEnabled(ws: string, appId: string, enabled: boolean, initiatedBy: 'human' | 'agent' = 'agent'): Promise<void> { return this.call('setEnabled', [ws, appId, enabled, initiatedBy]); }
  listLibrary(ws: string): Promise<AppLibraryItem[]> { return this.call('listLibrary', [ws]); }
  installFromLibrary(ws: string, catalogId: string, version?: number, initiatedBy: 'human' | 'agent' = 'agent'): Promise<AgentAppDefinition> { return this.call('installFromLibrary', [ws, catalogId, version, initiatedBy]); }
  publishToLibrary(ws: string, appId: string): Promise<{ catalogId: string; version: number }> { return this.call('publishToLibrary', [ws, appId]); }
  setLibraryPrivate(ws: string, appId: string, privateApp: boolean): Promise<void> { return this.call('setLibraryPrivate', [ws, appId, privateApp]); }
  saveConnection(ws: string, input: AppConnectionInput, validateOnly?: boolean): Promise<AppConnection> { return this.call('saveConnection', [ws, input, validateOnly]); }
  testConnection(ws: string, id: string): Promise<{ ok: true }> { return this.call('testConnection', [ws, id]); }
  listFeishuChats(ws: string, identity: 'bot' | 'user', token?: string): Promise<AppFeishuChatPage> { return this.call('listFeishuChats', [ws, identity, token]); }
  feishuStatus(ws: string): ReturnType<AgentAppsService['feishuStatus']> { return this.call('feishuStatus', [ws]); }
  startFeishuSetup(ws: string): ReturnType<AgentAppsService['startFeishuSetup']> { return this.call('startFeishuSetup', [ws]); }
  cancelFeishuSetup(ws: string): Promise<{ ok: boolean }> { return this.call('cancelFeishuSetup', [ws]); }
  beginFeishuBinding(ws: string): ReturnType<AgentAppsService['beginFeishuBinding']> { return this.call('beginFeishuBinding', [ws]); }
  pairedFeishuChats(ws: string): Promise<AppFeishuChat[]> { return this.call('pairedFeishuChats', [ws]); }
  connectedFeishuPrivateChats(ws: string): Promise<AppFeishuChat[]> { return this.call('connectedFeishuPrivateChats', [ws]); }
  rememberFeishuChat(ws: string, chat: AppFeishuChat): Promise<void> { return this.call('rememberFeishuChat', [ws, chat]); }
  receiveFeishuMessage(ws: string, message: AppValues, conversation: PhoneFeishuConversation, fields?: import('../../shared/agentApps').AppPlaceholderFields): Promise<void> { return this.call('receiveFeishuMessage', [ws, message, conversation, fields]); }
  importImage(ws: string, appId: string, source: string): Promise<AppImageAsset> { return this.call('importImage', [ws, appId, source]); }
  async importManagedImage(ws: string, appId: string, source: string): Promise<AppImageAsset> {
    if (!this.options.workspaces().includes(ws) || !this.options.resolveManagedImage) throw new Error('当前工作区的附件导入不可用');
    return this.importImage(ws, appId, await this.options.resolveManagedImage(ws, source));
  }
  readImage(ws: string, appId: string, id: string, thumbnail = false): Promise<{ mime: string; bytes: Uint8Array }> { return this.call('readImage', [ws, appId, id, thumbnail]); }
  imageInfo(ws: string, appId: string, id: string): Promise<AppImageAsset | null> { return this.call('imageInfo', [ws, appId, id]); }
  imagePath(ws: string, appId: string, id: string): Promise<{ path: string; asset: AppImageAsset }> { return this.call('imagePath', [ws, appId, id]); }
  releaseImage(ws: string, appId: string, id: string): Promise<boolean> { return this.call('releaseImage', [ws, appId, id]); }
}
