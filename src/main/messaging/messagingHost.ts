import type { ImapMailboxIdentity } from './imapConsumerArbiter';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MessagingChannelStatus, MessagingService, MessagingStatus } from '../../shared/messaging';
import type { LogicalChannelSource } from '../../shared/messagingChannels';

export interface MessagingCredentials {
  resolve(ref: string): Promise<{ value?: string; source?: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string }>;
  set(ref: string, value: string): Promise<unknown>;
  unset(ref: string): Promise<unknown>;
}

export type WorkbenchRemoteInput = {
  channelKey: string;
  botId: string;
  conversationId: string;
  threadId?: string;
  senderId: string;
  conversationType: 'direct' | 'group';
  addressed: boolean;
  senderIsBot: boolean;
  messageId: string;
  nativeMessageId?: string;
  conversationLabel?: string;
  senderLabel?: string;
  subject?: string;
  text: string;
  signal?: AbortSignal;
  onProgress?: (text: string, authorizationSignal?: AbortSignal) => Promise<void>;
  deliver?: (result: WorkbenchRemoteReply, authorizationSignal: AbortSignal) => Promise<void>;
};

export type WorkbenchRemoteReply = { text: string; image?: { filePath: string; mimeType: 'image/png' };
  failure?: 'remote-target-unavailable' | 'remote-result-unknown' };
type RemoteReplySink = (result: WorkbenchRemoteReply, authorizationSignal?: AbortSignal) => Promise<void>;
export type WorkbenchRemoteMethod = 'remote.status' | 'remote.begin' | 'remote.revoke';

type Effect = () => void | Promise<void>;
type Subscriber = (...args: unknown[]) => void;
type Route = (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
type LogicalAddress = Pick<LogicalChannelSource, 'provider' | 'botId' | 'conversationId' | 'threadId' | 'conversationType'>;
type LogicalDeliveryText = { text: string; subject?: string; nativeMessageId?: string; reply?: boolean };
type ChannelRuntime = {
  install(channel: string, context: HostContext, config: HostConfig): Promise<unknown>;
  sendLogicalText?(source: LogicalAddress, message: LogicalDeliveryText, signal: AbortSignal): Promise<void>;
};
type RuntimeModule = {
  createRuntime(): ChannelRuntime;
};
type HostConfig = {
  dataDir: string;
  createOfficeHarness(options: Record<string, unknown>): object;
  dispatchRemote(input: WorkbenchRemoteInput, reply: RemoteReplySink): Promise<void>;
  claimFeishuConsumer?: (appId: string, owner: string) => () => void;
  claimImapConsumer?: (mailbox: ImapMailboxIdentity, owner: string) => Promise<() => void>;
};
type HostContext = {
  root: object;
  admissionSignal: AbortSignal;
  credentials: MessagingCredentials;
  registerChannel(channel: string, route: Route): Effect;
  effect(install: () => Effect | undefined, description?: string): void;
  on(event: string, callback: Subscriber): Effect;
  emit(event: string, ...args: unknown[]): void;
  logger(name: string): { error: Subscriber; warn: Subscriber; info: Subscriber; debug: Subscriber };
};

type DiagnosticCode = 'startup-failed' | 'provider-warning' | 'provider-error';
type ConnectionEvidence = { referenceId?: string; reason?: string };

export type MessagingHostOptions = {
  dataDir: string;
  credentials: MessagingCredentials;
  createOfficeHarness?: HostConfig['createOfficeHarness'];
  handleRemote?: (input: WorkbenchRemoteInput) => Promise<WorkbenchRemoteReply>;
  beforeAccountRemoval?: (channel: string, botId: string, deleting: boolean) => void | Promise<void>;
  claimFeishuConsumer?: HostConfig['claimFeishuConsumer'];
  claimImapConsumer?: HostConfig['claimImapConsumer'];
  runtimeLoader?: () => Promise<RuntimeModule>;
  platform?: NodeJS.Platform;
  onDiagnostic?: (diagnostic: { channel: string; code: DiagnosticCode } & ConnectionEvidence) => void;
};

const CHANNELS = [
  ['feishu', '飞书'], ['weixin', '微信'], ['wecom', '企业微信'], ['wecom-app', '企业微信应用'],
  ['dingtalk', '钉钉'], ['qq', 'QQ'], ['slack', 'Slack'], ['telegram', 'Telegram'],
  ['discord', 'Discord'], ['whatsapp', 'WhatsApp'], ['imessage', 'iMessage'], ['matrix', 'Matrix'],
  ['email', 'Email'], ['office', 'AI Office']
] as const;
function isRemoteMethod(method: string): method is WorkbenchRemoteMethod {
  return method === 'remote.status' || method === 'remote.begin' || method === 'remote.revoke';
}
const LEGACY_BOT_SETTINGS = /^bot\.(?:workspace|model|preset|context-enhancement|access-policy|conversation-directory|session-binding|busy-message-mode|thinking-traces|thinking-cadence|step-push|step-push-mode)\./;
function validAccountId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
const CONNECTION_REASONS = new Set([
  'timeout', 'http-error', 'provider-rejected', 'invalid-response', 'invalid-json', 'invalid-config',
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC',
  'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'feishu-account-in-use', 'feishu-account-unverified', 'imap-mailbox-in-use', 'imap-mailbox-identity-invalid', 'imap-mailbox-close-unconfirmed', 'unknown'
]);

function failure(code: string) {
  return { ok: false, error: { code, message: code, details: {} } } as const;
}

function loadRuntime(): Promise<RuntimeModule> {
  const entry = pathToFileURL(path.join(__dirname, 'messaging', 'channel-runtime.mjs')).href;
  return import(/* @vite-ignore */ entry) as Promise<RuntimeModule>;
}

function connectionEvidence(values: unknown[]): ConnectionEvidence {
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 4096) continue;
    const body = /^\[dsh-[a-z-]+\] (\{.*\})$/.exec(value)?.[1];
    if (!body) continue;
    try {
      const record = JSON.parse(body) as Record<string, unknown>;
      if (typeof record.referenceId !== 'string' || !/^IM-[A-Z]{2,12}-[A-F0-9]{8}$/.test(record.referenceId)) continue;
      return {
        referenceId: record.referenceId,
        ...(typeof record.reason === 'string' && CONNECTION_REASONS.has(record.reason) && { reason: record.reason })
      };
    } catch { /* Ignore other provider log formats. */ }
  }
  return {};
}

/** Cordis-compatible services limited to this application's existing main-process authority. */
export class MessagingHost implements MessagingService {
  private readonly channels: MessagingChannelStatus[];
  private readonly routes = new Map<string, Route>();
  private readonly effects: Effect[] = [];
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly calls = new Set<Promise<unknown>>();
  private readonly remoteCalls = new Set<Promise<void>>();
  private readonly removingAccounts = new Set<string>();
  private readonly pendingChannels = new Set<string>();
  private readonly startupFailed = new Set<string>();
  private readonly admission = new AbortController();
  private phase: 'initializing' | 'ready' | 'failed' = 'initializing';
  private runtime?: ChannelRuntime;
  private readonly contextRoot = {};
  private startup?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(private readonly options: MessagingHostOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new TypeError('IM runtime requires a host-owned absolute data directory');
    const platform = options.platform ?? process.platform;
    this.channels = CHANNELS.map(([key, label]) => key === 'imessage' && platform !== 'darwin'
      ? { key, label, supported: false, reason: 'macos-required' }
      : { key, label, supported: true });
  }

  status(): MessagingStatus {
    return { state: this.phase, channels: this.channels.map(channel => ({ ...channel })) };
  }

  async accountConnected(channel: string, botId: string, signal: AbortSignal): Promise<boolean> {
    if (this.removingAccounts.has(JSON.stringify([channel, botId]))) return false;
    const response = await this.invoke(channel, 'connection.status', {}, signal) as {
      ok?: boolean;
      value?: { bots?: { botId?: string; connected?: boolean; ready?: boolean; state?: string;
        connection?: { ready?: boolean; connected?: boolean }; status?: { ready?: boolean } }[] };
    } | null;
    if (!response?.ok || !Array.isArray(response.value?.bots) || signal.aborted) return false;
    const account = response.value.bots.find(bot => bot.botId === botId);
    return !!account && (account.connected === true || account.ready === true || account.state === 'connected' ||
      account.connection?.ready === true || account.connection?.connected === true || account.status?.ready === true);
  }

  sendLogicalText(source: LogicalAddress, message: LogicalDeliveryText, signal: AbortSignal): Promise<void> {
    const current = AbortSignal.any([signal, this.admission.signal]);
    if (current.aborted || this.removingAccounts.has(JSON.stringify([source.provider, source.botId]))) {
      return Promise.reject(Object.assign(new Error('Account disconnected'), { code: 'bot-not-connected' }));
    }
    if (!this.runtime?.sendLogicalText) return Promise.reject(Object.assign(new Error('Delivery is unavailable'), { code: 'capability-unavailable' }));
    const work = this.runtime.sendLogicalText(source, message, current);
    this.remoteCalls.add(work);
    const release = () => { this.remoteCalls.delete(work); };
    void work.then(release, release);
    return work;
  }

  start(): void {
    if (this.startup || this.admission.signal.aborted) return;
    this.startup = Promise.resolve().then(() => this.initialize());
  }

  stopAdmission(): void {
    this.admission.abort();
  }

  stopAndWait(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(() => this.drain()).catch(error => {
      this.stopping = undefined;
      throw error;
    });
    this.stopAdmission();
    return this.stopping;
  }

  invoke(channel: string, method: string, payload: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.admission.signal.aborted || signal?.aborted) return Promise.resolve(failure('cancelled'));
    if (this.channels.find(entry => entry.key === channel && !entry.supported)) {
      return Promise.resolve(failure('macos-required'));
    }
    if (this.phase === 'failed' || this.startupFailed.has(channel)) return Promise.resolve(failure('channel-startup-failed'));
    const route = this.routes.get(channel);
    if (!route) {
      return Promise.resolve(failure(this.phase === 'initializing' || this.pendingChannels.has(channel)
        ? 'channel-initializing'
        : 'unknown-channel'));
    }
    const requestSignal = signal ? AbortSignal.any([signal, this.admission.signal]) : this.admission.signal;
    const pending = Promise.resolve().then(async () => {
      if (requestSignal.aborted) return failure('cancelled');
      const botId = payload && typeof payload === 'object' && 'botId' in payload && typeof payload.botId === 'string'
        ? payload.botId : undefined;
      const key = botId && JSON.stringify([channel, botId]);
      if (isRemoteMethod(method) || (channel !== 'office' && LEGACY_BOT_SETTINGS.test(method))) {
        return failure('remote-managed-by-workbench');
      }
      if (channel === 'feishu' && method === 'connection.disconnect') {
        if (!payload || typeof payload !== 'object' || Object.keys(payload).length !== 1 ||
            !('removeCredentials' in payload) || payload.removeCredentials !== true) return failure('invalid-remote-account-removal');
        const status = await this.dispatch(route, 'connection.status', {}, requestSignal) as {
          ok?: boolean; value?: { bots?: { botId?: unknown }[] };
        } | null;
        if (!status?.ok || !Array.isArray(status.value?.bots)) return failure('remote-account-not-found');
        const current = status.value.bots[0]?.botId;
        if (typeof current !== 'string' || !validAccountId(current)) return failure('remote-account-not-found');
        // The compatibility disconnect removes its primary bot. Resolve that
        // bot once and reuse the account-scoped revocation barrier.
        return this.invoke(channel, 'bot.delete', { botId: current, confirm: true }, requestSignal);
      }
      if (method === 'bot.delete' || method === 'bot.remove' || method === 'bot.disconnect') {
        const deleting = method !== 'bot.disconnect';
        if (method === 'bot.remove' || !botId || !key || !validAccountId(botId) || !payload || typeof payload !== 'object'
          || (deleting && (Object.keys(payload).length !== 2 || !('confirm' in payload) || payload.confirm !== true))) {
          return failure('invalid-remote-account-removal');
        }
        if (this.removingAccounts.has(key)) return failure('remote-account-removing');
        this.removingAccounts.add(key);
        try {
          try { await this.options.beforeAccountRemoval?.(channel, botId, deleting); }
          catch { return failure('remote-binding-revocation-failed'); }
          return await this.dispatch(route, method, payload, requestSignal);
        } finally { this.removingAccounts.delete(key); }
      }
      return this.dispatch(route, method, payload, requestSignal);
    });
    this.calls.add(pending);
    void pending.finally(() => { this.calls.delete(pending); });
    return pending;
  }

  private dispatchRemote(input: WorkbenchRemoteInput, reply: RemoteReplySink): Promise<void> {
    const handle = this.options.handleRemote;
    const key = JSON.stringify([input.channelKey, input.botId]);
    const canReply = (authorizationSignal?: AbortSignal) =>
      !input.signal?.aborted && !authorizationSignal?.aborted && !this.removingAccounts.has(key);
    if (!handle || this.admission.signal.aborted || input.signal?.aborted) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      if (this.admission.signal.aborted || !canReply()) return;
      let progress: Promise<void> | undefined;
      let delivered = false;
      const onProgress = (text: string, authorizationSignal?: AbortSignal): Promise<void> => {
        if (!canReply(authorizationSignal) || !text.trim()) return Promise.resolve();
        progress ??= Promise.resolve().then(async () => {
          if (canReply(authorizationSignal)) await reply({ text }, authorizationSignal);
        }).catch(() => this.report(input.channelKey, 'provider-warning'));
        return progress;
      };
      const deliver = async (result: WorkbenchRemoteReply, authorizationSignal: AbortSignal) => {
        delivered = true;
        await progress;
        if (!canReply(authorizationSignal)) return;
        try { await reply(result, authorizationSignal); }
        catch (error) {
          if (canReply(authorizationSignal)) this.report(input.channelKey, 'provider-error');
          throw error;
        }
      };
      const result = await handle({ ...input, onProgress, deliver });
      await progress;
      if (!delivered && canReply()) await reply(result);
    });
    this.remoteCalls.add(work);
    const release = () => { this.remoteCalls.delete(work); };
    void work.then(release, release);
    return work;
  }

  private async dispatch(route: Route, method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return failure('cancelled');
    try {
      const result = await route(method, payload, signal) as { ok?: unknown } | null;
      return typeof result?.ok === 'boolean' ? result : failure('invalid-channel-response');
    } catch {
      return failure(signal.aborted ? 'cancelled' : 'channel-request-failed');
    }
  }

  private async initialize(): Promise<void> {
    try {
      const module = await (this.options.runtimeLoader ?? loadRuntime)();
      if (this.admission.signal.aborted) return;
      const runtime = this.runtime = module.createRuntime();
      const config: HostConfig = {
        dataDir: this.options.dataDir,
        createOfficeHarness: this.options.createOfficeHarness ?? (() => { throw new Error('Office task host is unavailable'); }),
        dispatchRemote: this.dispatchRemote.bind(this),
        ...(this.options.claimFeishuConsumer && { claimFeishuConsumer: this.options.claimFeishuConsumer }),
        ...(this.options.claimImapConsumer && { claimImapConsumer: this.options.claimImapConsumer })
      };
      const install = async (channel: string): Promise<void> => {
        if (this.admission.signal.aborted) return;
        this.pendingChannels.add(channel);
        try {
          const dispose = await runtime.install(channel, this.makeContext(channel), config);
          if (typeof dispose === 'function') this.effects.push(dispose as Effect);
        } catch {
          this.startupFailed.add(channel);
          this.report(channel, 'startup-failed');
        } finally {
          this.pendingChannels.delete(channel);
        }
      };
      await Promise.all(this.channels.filter(channel => channel.supported).map(channel => install(channel.key)));
      this.phase = 'ready';
    } catch {
      this.phase = 'failed';
      this.report('host', 'startup-failed');
    }
  }

  private makeContext(channel: string): HostContext {
    const context: HostContext = {
      root: this.contextRoot,
      admissionSignal: this.admission.signal,
      credentials: this.options.credentials,
      registerChannel: (key, route) => {
        if (key !== channel || this.routes.has(key)) throw new Error('invalid-channel-route');
        this.routes.set(key, route);
        return () => {
          if (this.routes.get(key) === route) this.routes.delete(key);
        };
      },
      effect: install => {
        const dispose = install();
        if (dispose) this.effects.push(dispose);
      },
      on: (event, callback) => {
        const subscribers = this.subscribers.get(event) ?? new Set();
        subscribers.add(callback);
        this.subscribers.set(event, subscribers);
        const unregister = () => { subscribers.delete(callback); };
        this.effects.push(unregister);
        return unregister;
      },
      emit: (event, ...args) => {
        for (const callback of [...(this.subscribers.get(event) ?? [])]) callback(...args);
      },
      logger: () => ({
        error: (...values) => this.report(channel, 'provider-error', connectionEvidence(values)),
        warn: (...values) => this.report(channel, 'provider-warning', connectionEvidence(values)),
        info: () => {},
        debug: () => {}
      })
    };
    return context;
  }

  private report(channel: string, code: DiagnosticCode, evidence: ConnectionEvidence = {}): void {
    try { this.options.onDiagnostic?.({ channel, code, ...evidence }); }
    catch { /* Diagnostics must not change provider behavior. */ }
  }

  private async drain(): Promise<void> {
    await this.startup;
    await Promise.allSettled([...this.remoteCalls]);
    // Provider cleanup can unblock a provisioning call that is waiting on hardware or QR.
    const acceptedCalls = Promise.allSettled([...this.calls]);
    const failed: Effect[] = [];
    while (this.effects.length) {
      const dispose = this.effects.pop()!;
      try { await dispose(); }
      catch { failed.unshift(dispose); }
    }
    this.effects.push(...failed);
    await acceptedCalls;
    if (failed.length) throw new Error('IM provider shutdown failed');
    this.routes.clear();
    this.subscribers.clear();
  }
}
