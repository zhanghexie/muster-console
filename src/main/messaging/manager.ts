import type { ChannelRegistry } from './channelRegistry';
import {
  ConnectionSupervisor,
  type ConnectionContext,
  type ConnectionInboundResult,
  type ConnectionSnapshot,
  type MessagingConnection
} from './connectionSupervisor';
import {
  isMessagingId,
  messagingAccountKey,
  type ChannelDescriptor,
  type MessagingAccountConfig,
  type MessagingAccountRef,
  type NormalizedInboundMessage
} from './contracts';
import type { ConversationRouter } from './conversationRouter';

export type MessagingChannelDefinition = {
  descriptor: ChannelDescriptor;
  /** Construct a handle synchronously. Acquire resources only in the handle's start(). */
  createConnection(account: MessagingAccountConfig, context: ConnectionContext): MessagingConnection;
};

export type MessagingAccountSnapshot = MessagingAccountRef & ConnectionSnapshot & { enabled: boolean };

type RegisteredAccount = {
  ref: MessagingAccountRef;
  enabled: boolean;
  supervisor: ConnectionSupervisor;
};

type MessagingRouter = Pick<ConversationRouter, 'accept' | 'stopAdmission' | 'stopAndWait'>;

export class MessagingChannelManager {
  private readonly accounts = new Map<string, RegisteredAccount>();
  private phase: 'idle' | 'running' | 'closing' = 'idle';
  private stopping?: Promise<void>;
  private routerDrained = false;

  constructor(
    private readonly channels: ChannelRegistry<MessagingChannelDefinition>,
    private readonly router?: MessagingRouter
  ) {}

  registerAccount(config: MessagingAccountConfig): void {
    if (this.phase === 'closing') throw new Error('messaging-admission-closed');
    const channel = this.channels.get(config.channelKey);
    if (!channel) throw new Error('messaging-channel-missing');
    if (!isMessagingId(config.botId)) throw new Error('messaging-account-invalid');
    const key = messagingAccountKey(config);
    if (this.accounts.has(key)) throw new Error('messaging-account-duplicate');

    const { channelKey, botId, enabled, displayName, credentialRef, workspaceId } = config;
    const ref = { channelKey, botId };
    const account: MessagingAccountConfig = {
      ...ref, enabled, displayName, credentialRef: { provider: credentialRef.provider, id: credentialRef.id }, workspaceId
    };
    const supervisor = new ConnectionSupervisor(
      ref,
      context => channel.createConnection({ ...account, credentialRef: { ...account.credentialRef } }, context),
      message => this.receive(message)
    );
    const registered = { ref, enabled, supervisor };
    this.accounts.set(key, registered);
    if (this.phase === 'running') this.startEnabled(registered);
  }

  /** Domain startup publishes account owners without waiting for external connections. */
  start(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'running';
    for (const account of this.accounts.values()) this.startEnabled(account);
  }

  startAccount(ref: MessagingAccountRef): Promise<void> {
    if (this.phase !== 'running') return Promise.reject(new Error('messaging-admission-closed'));
    const account = this.accounts.get(messagingAccountKey(ref));
    if (!account) return Promise.reject(new Error('messaging-account-missing'));
    if (!account.enabled) return Promise.reject(new Error('messaging-account-disabled'));
    return account.supervisor.start();
  }

  snapshot(): { channels: readonly ChannelDescriptor[]; accounts: readonly MessagingAccountSnapshot[] } {
    return {
      channels: this.channels.list().map(channel => channel.descriptor),
      accounts: [...this.accounts.values()].map(({ ref, enabled, supervisor }) => ({
        ...ref, enabled, ...supervisor.snapshot()
      }))
    };
  }

  /** Existing sessions can finish while connected transports are still available. */
  stopAdmission(): void {
    if (this.phase === 'closing') return;
    this.phase = 'closing';
    for (const { supervisor } of this.accounts.values()) supervisor.stopAdmission();
    this.router?.stopAdmission();
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

  private startEnabled(account: RegisteredAccount): void {
    // Any failed cleanup is reflected in this account's snapshot.
    if (account.enabled) void account.supervisor.start().catch(() => {});
  }

  private async receive(message: NormalizedInboundMessage): Promise<ConnectionInboundResult> {
    if (this.phase !== 'running') return { status: 'not-admitted', code: 'stale-connection' };
    if (!this.router) return { status: 'not-admitted', code: 'router-unavailable' };
    return this.router.accept(message);
  }

  private async drain(): Promise<void> {
    const errors: unknown[] = [];
    if (this.router && !this.routerDrained) {
      try {
        await this.router.stopAndWait();
        this.routerDrained = true;
      } catch {
        errors.push(new Error('messaging-router-drain-failed'));
      }
    }
    const results = await Promise.allSettled([...this.accounts.values()].map(({ supervisor }) => supervisor.stopAndWait()));
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (errors.length) throw new AggregateError(errors, 'messaging-shutdown-failed');
  }
}
