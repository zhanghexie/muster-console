import { atConnectionStage, createConnectionDiagnostics } from './connection-error.mjs';
import { connectionTestMessage } from './connection-test.mjs';
import { t } from './i18n.mjs';
import { publicMessageFailure } from './message-failure.mjs';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeError(code, message) {
  return Object.freeze({ code, message });
}

export class TokenBotController {
  #descriptor;
  #credentials;
  #configStore;
  #inspectToken;
  #deriveIdentity;
  #maskPlatformId;
  #createRuntime;
  #deleteState;
  #logger;
  #diagnostics;
  #runtimes = new Map();
  #errors = new Map();
  #transitions = new Map();
  #revision = 0;
  #closed = false;

  constructor({
    descriptor,
    credentials,
    configStore,
    inspectToken,
    deriveIdentity,
    maskPlatformId,
    createRuntime,
    deleteState = async () => {},
    logger = console,
  }) {
    if (!descriptor?.key || !descriptor?.label || !descriptor?.connectionLabel) {
      throw new TypeError('TokenBotController requires a channel descriptor');
    }
    if (!credentials || typeof credentials.resolve !== 'function'
      || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
      throw new TypeError(`${descriptor.label} requires the Muster credential provider`);
    }
    if (!configStore || typeof configStore.list !== 'function'
      || typeof configStore.save !== 'function' || typeof configStore.remove !== 'function') {
      throw new TypeError(`${descriptor.label} requires a config store`);
    }
    if (typeof inspectToken !== 'function' || typeof deriveIdentity !== 'function'
      || typeof maskPlatformId !== 'function' || typeof createRuntime !== 'function') {
      throw new TypeError(`${descriptor.label} controller dependencies are incomplete`);
    }
    this.#descriptor = descriptor;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#inspectToken = inspectToken;
    this.#deriveIdentity = deriveIdentity;
    this.#maskPlatformId = maskPlatformId;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
    this.#diagnostics = createConnectionDiagnostics({ channel: descriptor.key, logger });
  }

  get diagnostics() { return this.#diagnostics; }

  #failure(error, code, message) {
    const stage = code.startsWith('qr-') ? 'qr.begin' : code === 'activation-failed' ? 'activation' : 'connection.start';
    return this.#diagnostics.report(error, { reuse: true, stage, publicError: { code, message } }).publicError;
  }

  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      await this.#withBotTransition(config.botId, async () => {
        if (this.#closed || this.#runtimes.get(config.botId)?.status?.ready) return;
        try {
          const token = await this.#resolveToken(config.tokenRef);
          if (!token) {
            this.#errors.set(config.botId, safeError(
              'missing-token',
              t('{label}机器人凭据缺失，请移除后重新接入。', {
                label: this.#descriptor.label,
              }),
            ));
            return;
          }
          await this.#startRuntime(config, token);
          this.#errors.delete(config.botId);
        } catch (error) {
          this.#errors.set(config.botId, this.#failure(error,
            'connection-failed',
            t('{label}连接未就绪，插件会自动重试。', {
              label: this.#descriptor.label,
            }),
          ));

        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }

  async bindCredentials({ token } = {}) {
    if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
    const normalizedToken = cleanString(token);
    if (!normalizedToken) throw new TypeError(`${this.#descriptor.label} Bot Token is required`);
    const inspected = await this.#inspectToken(normalizedToken);
    const platformId = cleanString(inspected?.platformId);
    const name = cleanString(inspected?.name);
    if (!platformId || !name) throw new Error(`${this.#descriptor.label} returned an invalid bot identity`);
    const identity = this.#deriveIdentity(platformId);
    await this.#withBotTransition(identity.botId, async () => {
      if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
      const previousConfig = this.#configStore.getByPlatformId(platformId);
      const previousToken = await atConnectionStage('credential.read', () => this.#credentials.resolve(identity.tokenRef), 'credential-store');
      const config = {
        botId: identity.botId,
        platformId,
        tokenRef: identity.tokenRef,
        name,
        username: cleanString(inspected.username),
        createdAt: previousConfig?.createdAt ?? new Date().toISOString(),
        connectedAt: new Date().toISOString(),
      };
      await atConnectionStage('credential.save', () => this.#credentials.set(identity.tokenRef, normalizedToken), 'credential-store');
      try {
        await atConnectionStage('account.save', () => this.#configStore.save(config), 'account-config');
      } catch (error) {
        await this.#restoreCredential(identity.tokenRef, previousToken);
        throw error;
      }
      try {
        await this.#startRuntime(config, normalizedToken);
        this.#errors.delete(identity.botId);
      } catch (error) {
        this.#errors.set(identity.botId, this.#failure(error,
          'connection-failed',
          t('{label}机器人已接入，消息连接暂未就绪。', {
            label: this.#descriptor.label,
          }),
        ));

      }
      this.#touch();
    });
    return this.status();
  }

  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error(`Unknown ${this.#descriptor.label} bot`);
    await this.#withBotTransition(botId, async () => {
      const token = await this.#resolveToken(config.tokenRef);
      if (!token) throw new Error(`${this.#descriptor.label} bot token is missing`);
      try {
        await this.#startRuntime(config, token);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, this.#failure(error,
          'connection-failed',
          t('{label}连接仍未就绪，请稍后重试。', {
            label: this.#descriptor.label,
          }),
        ));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }

  async updateBotConfig(botId, update) {
    if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
    if (typeof update !== 'function') throw new TypeError('Bot config update must be a function');
    await this.#withBotTransition(botId, async () => {
      if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
      const config = this.#configStore.get(botId);
      if (!config) throw new Error(`Unknown ${this.#descriptor.label} bot`);
      const token = await this.#resolveToken(config.tokenRef);
      if (!token) throw new Error(`${this.#descriptor.label} bot token is missing`);
      if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
      const nextConfig = update(config);
      const savedConfig = await atConnectionStage('account.save', () => this.#configStore.save(nextConfig), 'account-config');
      try {
        await this.#startRuntime(savedConfig, token);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, this.#failure(error,
          'connection-failed',
          t('{label}连接仍未就绪，请稍后重试。', {
            label: this.#descriptor.label,
          }),
        ));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }

  async sendConnectionTest(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error(`Unknown ${this.#descriptor.label} bot`);
    return this.#withBotTransition(botId, async () => {
      const runtime = this.#runtimes.get(botId);
      if (!runtime?.status?.ready || typeof runtime.sendConnectionTest !== 'function') {
        const error = new Error(t('{label}机器人尚未连接', {
          label: this.#descriptor.label,
        }));
        error.code = 'test-target-unavailable';
        throw error;
      }
      const cardLabel = t('{name}（{id}）', {
        name: config.name,
        id: this.#maskPlatformId(config.platformId),
      });
      await runtime.sendConnectionTest(connectionTestMessage(
        cardLabel,
        t('{label}机器人', { label: this.#descriptor.label }),
      ));
      return { sent: true };
    });
  }

  async sendProactiveText(botId, target, text, options = {}) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error(`Unknown ${this.#descriptor.label} bot`);
    return this.#withBotTransition(botId, async () => {
      const runtime = this.#runtimes.get(botId);
      if (!runtime?.status?.ready || typeof runtime.sendProactiveText !== 'function') {
        const error = new Error(t('{label}机器人尚未连接', {
          label: this.#descriptor.label,
        }));
        error.code = 'bot-not-connected';
        throw error;
      }
      return runtime.sendProactiveText(target, text, options);
    });
  }

  async deleteBot(botId) {
    const warnings = [];
    const config = this.#configStore.get(botId);
    if (!config) throw new Error(`Unknown ${this.#descriptor.label} bot`);
    await this.#withBotTransition(botId, async () => {
      const previous = await atConnectionStage('credential.read', () => this.#credentials.resolve(config.tokenRef), 'credential-store');
      await this.#stopRuntime(botId);
      try {
        await atConnectionStage('credential.remove', () => this.#credentials.unset(config.tokenRef), 'credential-store');
        await atConnectionStage('account.remove', () => this.#configStore.remove(botId), 'account-config');
      } catch (error) {
        if (!this.#configStore.get(botId)) {
          warnings.push(this.#diagnostics.report(error, { operation: 'bot.delete', stage: 'workspace.cleanup', warning: true,
            publicError: { code: 'workspace-cleanup-failed', message: '账号已移除，但本地状态清理失败。' } }).publicError);
        } else {
          if (previous?.value) {
            await atConnectionStage('credential.save', () => this.#credentials.set(config.tokenRef, previous.value), 'credential-store').catch(() => undefined);
            await this.#startRuntime(config, previous.value).catch(() => undefined);
          }
          throw new Error(`Unable to remove the ${this.#descriptor.label} bot safely.`, { cause: error });
        }
      }
      await this.#deleteState({ botId, config }).catch(error => { warnings.push(this.#diagnostics.report(error, { reuse: true, operation: 'bot.delete', stage: 'state.cleanup', resource: 'account-state', warning: true, publicError: { code: 'cleanup-failed', message: '账号已移除，但本地状态清理失败。' } }).publicError); });
      this.#errors.delete(botId);
      this.#touch();
    });
    return { ...this.status(), ...(warnings.length ? { warnings } : {}) };
  }

  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtimeStatus = this.#runtimes.get(config.botId)?.status ?? null;
      const connected = runtimeStatus?.ready === true
        && runtimeStatus.connectionState === 'connected';
      const state = connected ? 'connected'
        : runtimeStatus?.connectionState === 'connecting' ? 'connecting'
          : this.#errors.has(config.botId) || runtimeStatus?.connectionState === 'failed'
            ? 'error' : 'offline';
      return {
        botId: config.botId,
        state,
        connected,
        configured: true,
        bot: {
          name: config.name,
          username: config.username,
          idMasked: this.#maskPlatformId(config.platformId),
        },
        health: {
          status: connected ? 'healthy' : state === 'error' ? 'error' : 'offline',
          summary: connected ? t('{label}{connectionLabel}运行正常', {
            label: this.#descriptor.label,
            connectionLabel: t(this.#descriptor.connectionLabel),
          })
            : state === 'error' ? t('{label}连接未就绪，插件会自动重试', {
              label: this.#descriptor.label,
            })
              : t('{label}连接当前离线', { label: this.#descriptor.label }),
          lastCheckedAt: runtimeStatus?.lastCheckedAt ?? null,
          lastConnectedAt: runtimeStatus?.lastConnectedAt ?? null,
        },
        stats: {
          messagesReceived: runtimeStatus?.messagesReceived ?? 0,
          messagesReplied: runtimeStatus?.messagesReplied ?? 0,
        },
        lastMessageError: publicMessageFailure(runtimeStatus?.lastMessageError),
        error: structuredClone(runtimeStatus?.error ?? this.#errors.get(config.botId) ?? null),
      };
    });
    const connectedCount = bots.filter((bot) => bot.connected).length;
    return {
      schemaVersion: 1,
      revision: this.#revision,
      state: bots.length === 0 ? 'disconnected'
        : connectedCount === bots.length ? 'connected'
          : connectedCount > 0 ? 'degraded' : 'offline',
      bots,
      totals: { configured: bots.length, connected: connectedCount },
    };
  }

  async close() {
    this.#closed = true;
    const stopping = Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
    const [results] = await Promise.all([stopping, Promise.allSettled([...this.#transitions.values()])]);
    if (results.some(result => result.status === 'rejected')) throw new Error('IM bot cleanup failed');
  }

  async #startRuntime(config, token) {
    if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
    await this.#stopRuntime(config.botId);
    if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
    const runtime = await atConnectionStage('runtime.prepare', () => this.#createRuntime({ botId: config.botId, config, token }));
    if (!runtime || typeof runtime.start !== 'function' || typeof runtime.stop !== 'function') {
      throw new TypeError(`createRuntime returned an invalid ${this.#descriptor.label} runtime`);
    }
    if (this.#closed) throw new Error(`${this.#descriptor.label} controller is closed`);
    this.#runtimes.set(config.botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      try { await this.#stopRuntime(config.botId); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'IM bot startup and cleanup failed'); }
      throw error;
    }
  }

  #retiring = new Map();

  #stopRuntime(botId) {
    const pending = this.#retiring.get(botId);
    if (pending) return pending;
    const runtime = this.#runtimes.get(botId);
    if (!runtime) return Promise.resolve();
    const stopping = Promise.resolve().then(() => runtime.stop()).then(() => {
      if (this.#runtimes.get(botId) === runtime) this.#runtimes.delete(botId);
    }).finally(() => {
      this.#retiring.delete(botId);
    });
    this.#retiring.set(botId, stopping);
    return stopping;
  }

  async #resolveToken(ref) {
    const result = await atConnectionStage('credential.read', () => this.#credentials.resolve(ref), 'credential-store');
    return cleanString(result?.value);
  }

  async #restoreCredential(ref, previous) {
    if (previous?.value) await atConnectionStage('credential.save', () => this.#credentials.set(ref, previous.value), 'credential-store').catch(() => undefined);
    else await atConnectionStage('credential.remove', () => this.#credentials.unset(ref), 'credential-store').catch(() => undefined);
  }

  #withBotTransition(botId, operation) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }

  #touch() {
    this.#revision += 1;
  }
}
