import { getGroupHistoryStore } from '../../group-history-runtime.mjs';
import { join, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import HttpsProxyAgent from 'https-proxy-agent';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';
import { verifyFeishuApp } from '../../../../src/channels/feishu/feishu-app.mjs';
import { FeishuRuntime } from '../../../../src/channels/feishu/feishu-runtime.mjs';
import {
  LEGACY_FEISHU_SECRET_REF,
  PluginConfigStore,
} from '../../../../src/channels/feishu/plugin-config-store.mjs';
import { MultiBotDshFeishuController } from '../../../../src/channels/feishu/multi-bot-controller.mjs';
import { StateStore } from '../../../../src/channels/feishu/state-store.mjs';
import {
  BotWorkspaceStore,
  createAccountIngress,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { prepareBotWorkspace } from '../../../../src/channels/shared/default-workspace.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createAnnouncedStateStore, createBindingAnnouncer } from '../shared/binding-events.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
  newBotAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

// The WebSocket agent built here is only used for the Feishu long connection,
// whose endpoint is open.feishu.cn (Feishu) or open.larksuite.com (Lark).
// Honor NO_PROXY/no_proxy for those hosts so users with blanket proxy
// environments exported in their shell (Clash/V2Ray etc.) keep a direct
// connection to Feishu instead of routing the WSS handshake through the proxy.
const LONG_CONNECTION_HOSTS = ['open.feishu.cn', 'open.larksuite.com'];

function hostExcludedByNoProxyEntry(host, entry) {
  if (entry === '*') return true;
  const bare = entry.startsWith('.') ? entry.slice(1) : entry;
  if (!bare) return false;
  return host === bare || host.endsWith(`.${bare}`);
}

function longConnectionExcludedByNoProxy(env) {
  for (const key of ['no_proxy', 'NO_PROXY']) {
    const value = env?.[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const entries = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (LONG_CONNECTION_HOSTS.some((host) => entries.some((entry) => hostExcludedByNoProxyEntry(host, entry)))) {
      return true;
    }
  }
  return false;
}

function webSocketProxyUrl(env) {
  if (longConnectionExcludedByNoProxy(env)) return undefined;
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function createFeishuWebSocketAgent(
  env,
  createAgent = (url) => new HttpsProxyAgent(url),
) {
  const proxyUrl = webSocketProxyUrl(env);
  return proxyUrl ? createAgent(proxyUrl) : undefined;
}

function pluginPaths(config) {
  const storageRoot = resolve(config.storageRoot ?? config.dataDir);
  const root = resolve(config.dataDir ?? join(storageRoot, 'integrations', 'dsh-feishu'));
  return {
    root,
    config: resolve(config.configPath ?? join(root, 'config.json')),
    legacyState: resolve(config.statePath ?? join(root, 'state.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
  };
}

/**
 * Assemble the production controller from DSH Host services and local plugin
 * classes. No bridge process or environment App credentials are required.
 */
export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-feishu requires ctx.credentials');

  const lark = internals.lark ?? Lark;
  const Controller = internals.Controller ?? MultiBotDshFeishuController;
  const ConfigStore = internals.ConfigStore ?? PluginConfigStore;
  const SessionStateStore = internals.StateStore ?? StateStore;
  const Runtime = internals.FeishuRuntime ?? FeishuRuntime;
  const verify = internals.verifyFeishuApp ?? verifyFeishuApp;
  const verifyApp = (options) => verify({
    ...options,
    httpInstance: lark.defaultHttpInstance,
  });
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-feishu')
    : (ctx.logger ?? console);
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const { defaultWorkspace, ungroupedWorkspace } = await prepareBotWorkspace(config);
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace, ungroupedWorkspace, groupByAgentPreset: config.groupByAgentPreset }).load();
  const canListConfiguredBots = typeof configStore.list === 'function';
  const listConfiguredBots = () => canListConfiguredBots ? configStore.list() : [];
  const configuredBots = listConfiguredBots();
  if (canListConfiguredBots) {
    await workspaces.reconcile(configuredBots.map((bot) => bot.id));
  }
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.id, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('feishu', bot),
  })));
  const observedConfigStore = typeof configStore.removeBot === 'function'
    ? observeBotWorkspaceRemovals(configStore, {
        workspaces,
        method: 'removeBot',
        botIdFromRemoved: (removed) => removed.id,
        saveMethod: 'saveBot',
        botIdFromSave: (bot) => bot?.id,
      })
    : configStore;
  // State is lazy per bot. A corrupt legacy file can therefore fail only the
  // migrated bot and cannot prevent healthy v2 bots from starting.
  const stateStores = new Map();
  const statePathFor = (botConfig) => !botConfig.id
    || !botConfig.secretRef
    || botConfig.secretRef === LEGACY_FEISHU_SECRET_REF
    ? paths.legacyState
    : resolve(paths.bots, botConfig.id, 'state.json');
  /**
   * Every binding change is announced the moment it is written: a bind before the
   * Session exists, an unbind when the conversation moves to another session or
   * its binding is cleared. Listeners run synchronously.
   */
  const announcer = createBindingAnnouncer({
    channel: 'feishu',
    emit: (event, payload) => ctx.emit(event, payload),
    authorsOf: (botId) => (typeof stateStores.get(botId)?.snapshot === 'function'
      ? stateStores.get(botId).snapshot()?.authors ?? null
      : null),
  });
  // The memo key is the bot id, and it is also the id the announcer puts into the
  // event, so a subject without one has to fail loudly: keying it as something
  // else would announce a bot no rule can match and answer `stateForSync` with
  // null. `normalizeBot` always assigns an id - the pre-v2 bot gets a derived one
  // - so this only fires on a programming mistake.
  const { stateFor, stateForSync, prime, forget } = createAnnouncedStateStore({
    announcer,
    StateStore: SessionStateStore,
    statePath: statePathFor,
    keyOf: (subject) => {
      const id = typeof subject === 'string' ? subject : subject?.id;
      if (typeof id !== 'string' || id === '') {
        throw new TypeError('a Feishu bot subject needs an id');
      }
      return id;
    },
    states: stateStores,
    logger,
  });
  // Warm the per-bot state memo now: the synchronous identity lookup can only
  // answer from state that is already loaded in this process, and the first prompt
  // of a session arrives long before any delivery call would load it.
  await prime(configuredBots);
  const stateForBotId = async (botId) => {
    const botConfig = listConfiguredBots().find((bot) => bot.id === botId);
    if (!botConfig) throw new Error('Unknown Feishu bot');
    return stateFor(botConfig);
  };
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces,
    configStore: observedConfigStore,
    defaultWorkspace,
    botIdFrom: (bot) => bot?.id,
  });
  const proxyEnv = internals.proxyEnv ?? process.env;
  const wsAgent = createFeishuWebSocketAgent(proxyEnv, internals.createProxyAgent);

  const coreController = new Controller({
    logger,
    registerApp: (options) => lark.registerApp(options),
    verifyApp,
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    createRuntime: async ({ botId, config: botConfig, appSecret, repair, acceptExternal }) => {
      const state = await stateFor(botConfig);
      const id = botId ?? botConfig.id ?? botConfig.appId;
      await workspaces.ensure(id, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: newBotAccessPolicyFor('feishu', botConfig),
      });
      const receiveChannelMessage = createAccountIngress(internals.receiveChannelMessage, { botId: id, workspaces });
      return new Runtime({
        lark,
        consumerMode: botConfig.consumerMode,
        acceptExternal,
        botId: id,
        repair,
        appId: botConfig.appId,
        claimConsumer: internals.claimFeishuConsumer
          ? () => internals.claimFeishuConsumer(botConfig.appId, `dsh:${id}`)
          : undefined,
        appSecret,
        domain: botConfig.domain,
        botOpenId: botConfig.botOpenId,
        groupResponseMode: botConfig.groupResponseMode,
        mentionTopicReply: botConfig.mentionTopicReply,
        stepPush: botConfig.stepPush,
        stepPushMode: botConfig.stepPushMode,
        stepCardPanels: botConfig.stepCardPanels,
        ownerOpenIds: botConfig.ownerOpenIds ?? [botConfig.ownerOpenId],
        receiveChannelMessage,
        state,
        groupHistory: internals.groupHistory ?? getGroupHistoryStore(ctx, config),
        contextEnhancement: { botId: id, getSettings: () => workspaces.contextEnhancementFor(id) },
        accessPolicy: accessPolicyProvider(workspaces, id, {
          channel: 'feishu', config: botConfig,
        }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        ...(wsAgent ? { wsAgent } : {}),
        logger: {
          error: (...args) => logger.error?.(`[${botId ?? botConfig.id}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId ?? botConfig.id}]`, ...args),
          info: (...args) => logger.info?.(`[${botId ?? botConfig.id}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId ?? botConfig.id}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId, config: botConfig }) => {
      forget(botId);
      try {
        await unlink(statePathFor(botConfig));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  });
  const controller = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor: stateForBotId,
  });

  const supervisor = createSupervisor({
    controller,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({       channel: 'feishu', workspaces, coreController, stateFor: stateForBotId,
      // The same store, without the await: it is a memo of already loaded bots.
      stateForSync,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      wsAgent?.destroy?.();
    },
  };
}
