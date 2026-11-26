import type { ConversationRouteResult, MessagingAccountRef, NormalizedInboundMessage } from './contracts';

export type ConnectionInboundResult = ConversationRouteResult | {
  status: 'not-admitted';
  code: 'stale-connection' | 'account-mismatch' | 'router-unavailable';
};

export type ConnectionContext = {
  generation: number;
  signal: AbortSignal;
  receive(message: NormalizedInboundMessage): Promise<ConnectionInboundResult>;
  disconnected(): void;
};

export type MessagingConnection = {
  /** Settles once startup is complete and the handle is ready, or once startup has failed. */
  start(): void | Promise<void>;
  /** May run during start(). Fence pending acquisition and release all resources before resolving. */
  close(): void | Promise<void>;
};

type ConnectionDiagnostic =
  | { phase: 'start'; code: 'connection-start-failed' | 'connection-start-timeout' }
  | { phase: 'run'; code: 'connection-disconnected' }
  | { phase: 'close'; code: 'connection-close-failed' };

export type ConnectionSnapshot = {
  state: 'idle' | 'starting' | 'online' | 'stopping' | 'stopped' | 'failed';
  diagnostic?: ConnectionDiagnostic;
};

type ConnectionAttempt = {
  generation: number;
  controller: AbortController;
  initialization: Promise<void>;
  connection?: MessagingConnection;
  closing?: Promise<void>;
};

const START_TIMEOUT_MS = 30_000;

export class ConnectionSupervisor {
  private admitting = true;
  private generation = 0;
  private state: ConnectionSnapshot['state'] = 'idle';
  private diagnostic?: ConnectionDiagnostic;
  private owner?: ConnectionAttempt;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    private readonly account: MessagingAccountRef,
    private readonly createConnection: (context: ConnectionContext) => MessagingConnection,
    private readonly receive: (message: NormalizedInboundMessage) => Promise<ConnectionInboundResult>,
    private readonly startTimeoutMs = START_TIMEOUT_MS
  ) {}

  snapshot(): ConnectionSnapshot {
    return { state: this.state, ...(this.diagnostic && { diagnostic: { ...this.diagnostic } }) };
  }

  start(): Promise<void> {
    if (!this.admitting) return Promise.reject(new Error('connection-admission-closed'));
    if (this.starting) return this.starting;
    if (this.state === 'online') return Promise.resolve();

    // Publish the pending operation before any platform code can reenter it.
    this.starting = Promise.resolve().then(async () => {
      if (this.owner) await this.closeAttempt(this.owner);
      if (!this.admitting) throw new Error('connection-admission-closed');
      const attempt = this.openAttempt();
      await attempt.initialization;
      await attempt.closing;
      if (this.diagnostic) throw new Error(this.diagnostic.code);
      if (!this.admitting) throw new Error('connection-admission-closed');
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  stopAdmission(): void {
    if (!this.admitting) return;
    this.admitting = false;
    if (this.state === 'starting' && this.owner) {
      this.state = 'stopping';
      this.owner.controller.abort();
    }
  }

  stopAndWait(): Promise<void> {
    if (this.stopping) return this.stopping;
    const pendingStart = this.starting;
    this.stopping = Promise.resolve().then(async () => {
      const closing = this.owner && this.closeAttempt(this.owner);
      const [, result] = await Promise.allSettled([pendingStart, closing]);
      if (result.status === 'rejected') throw result.reason;
      this.state = 'stopped';
    }).finally(() => { this.stopping = undefined; });
    this.stopAdmission();
    return this.stopping;
  }

  private openAttempt(): ConnectionAttempt {
    this.state = 'starting';
    this.diagnostic = undefined;
    const attempt: ConnectionAttempt = {
      generation: ++this.generation,
      controller: new AbortController(),
      initialization: Promise.resolve().then(() => this.initialize(attempt))
    };
    this.owner = attempt;
    return attempt;
  }

  private accepts(attempt: ConnectionAttempt): boolean {
    return this.admitting && this.owner?.generation === attempt.generation && !attempt.controller.signal.aborted;
  }

  private async initialize(attempt: ConnectionAttempt): Promise<void> {
    if (!this.accepts(attempt)) return;
    const timeout = setTimeout(() => {
      this.fail(attempt, { phase: 'start', code: 'connection-start-timeout' });
    }, this.startTimeoutMs);
    timeout.unref?.();
    try {
      attempt.connection = this.createConnection({
        generation: attempt.generation,
        signal: attempt.controller.signal,
        receive: async message => {
          if (!this.accepts(attempt) || this.state !== 'online') {
            return { status: 'not-admitted', code: 'stale-connection' };
          }
          if (message.channelKey !== this.account.channelKey || message.botId !== this.account.botId) {
            return { status: 'not-admitted', code: 'account-mismatch' };
          }
          return this.receive(message);
        },
        disconnected: () => this.fail(attempt, { phase: 'run', code: 'connection-disconnected' })
      });
      if (!this.accepts(attempt)) return;
      await attempt.connection.start();
      if (this.accepts(attempt)) this.state = 'online';
    } catch {
      this.fail(attempt, { phase: 'start', code: 'connection-start-failed' });
    } finally {
      clearTimeout(timeout);
    }
  }

  private fail(attempt: ConnectionAttempt, diagnostic: ConnectionDiagnostic): void {
    if (!this.accepts(attempt)) return;
    this.state = 'failed';
    this.diagnostic = diagnostic;
    void this.closeAttempt(attempt).catch(() => {});
  }

  private closeAttempt(attempt: ConnectionAttempt): Promise<void> {
    if (attempt.closing) return attempt.closing;
    if (this.owner !== attempt) return Promise.resolve();
    // Some transports can only unblock start() by closing the acquired handle.
    const close = Promise.resolve().then(() => attempt.connection?.close());
    attempt.closing = Promise.allSettled([attempt.initialization, close]).then(([, result]) => {
      if (result.status === 'rejected') {
        this.state = 'failed';
        this.diagnostic = { phase: 'close', code: 'connection-close-failed' };
        throw new Error('connection-close-failed');
      }
      this.owner = undefined;
    }).finally(() => { attempt.closing = undefined; });
    if (this.state !== 'failed') this.state = 'stopping';
    // Abort dispatch is synchronous. Publish both owner and close promise first.
    attempt.controller.abort();
    return attempt.closing;
  }
}
