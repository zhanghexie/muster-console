import { getGroupHistoryStore } from '../../group-history-runtime.mjs';
import { rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { WhatsappConfigStore } from '../../../../src/channels/whatsapp/config-store.mjs';
import { WhatsappStateStore } from '../../../../src/channels/whatsapp/state-store.mjs';
import { WhatsappController } from '../../../../src/channels/whatsapp/whatsapp-controller.mjs';
import {
  WhatsappRuntime,
  whatsappAccessPolicyIdsEqual,
} from '../../../../src/channels/whatsapp/whatsapp-runtime.mjs';
import { createWhatsappWebSession } from '../../../../src/channels/whatsapp/whatsapp-web-session.mjs';
import {
  BotWorkspaceStore,
  createAccountIngress,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { prepareBotWorkspace } from '../../../../src/channels/shared/default-workspace.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createAnnouncedStateStore, createBindingAnnouncer } from '../shared/binding-events.mjs';
import { createTokenConnectionSupervisor } from '../shared/connection-supervisor.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

const AUTH_DIRECTORY_PATTERN = /^[a-f0-9-]{36}$/;

function pluginPaths(config) {
  const storageRoot = resolve(config.storageRoot ?? config.dataDir);
  const root = resolve(config.dataDir ?? join(storageRoot, 'integrations', 'dsh-whatsapp'));
  const authRoot = resolve(config.authDir ?? join(root, 'auth'));
  const authPath = (name) => {
    if (!AUTH_DIRECTORY_PATTERN.test(name ?? '')) throw new TypeError('Invalid WhatsApp auth directory');
    return resolve(authRoot, name);
  };
  return {
    config: resolve(config.configPath ?? join(root, 'config.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
    authPath,
  };
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-im:whatsapp') : (ctx.logger ?? console);
  const ConfigStore = internals.ConfigStore ?? WhatsappConfigStore;
  const StateStore = internals.StateStore ?? WhatsappStateStore;
  const Controller = internals.Controller ?? WhatsappController;
  const Runtime = internals.Runtime ?? WhatsappRuntime;
  const createSession = internals.createSession ?? createWhatsappWebSession;
  const createSupervisor = internals.createConnectionSupervisor ?? createTokenConnectionSupervisor;
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const { defaultWorkspace, ungroupedWorkspace } = await prepareBotWorkspace(config);
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace, ungroupedWorkspace, groupByAgentPreset: config.groupByAgentPreset }).load();
  const configuredBots = configStore.list();
  await workspaces.reconcile(configuredBots.map((bot) => bot.botId));
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('whatsapp', bot),
  })));
  const observedConfigStore = typeof configStore.remove === 'function'
    ? observeBotWorkspaceRemovals(configStore, { workspaces })
    : configStore;
  const stateStores = new Map();
  const statePath = (botId) => resolve(paths.bots, botId, 'state.json');
  /**
   * Every binding change is announced the moment it is written: a bind before the
   * Session exists, an unbind when the conversation moves to another session or
   * its binding is cleared. Listeners run synchronously.
   */
  const announcer = createBindingAnnouncer({
    channel: 'whatsapp',
    emit: (event, payload) => ctx.emit(event, payload),
    authorsOf: (botId) => (typeof stateStores.get(botId)?.snapshot === 'function'
      ? stateStores.get(botId).snapshot()?.authors ?? null
      : null),
  });
  const { stateFor, stateForSync, prime, forget } = createAnnouncedStateStore({
    announcer,
    StateStore,
    statePath,
    states: stateStores,
    logger,
  });
  // Warm the per-bot state memo now: the synchronous identity lookup can only
  // answer from state that is already loaded in this process, and the first prompt
  // of a session arrives long before any delivery call would load it.
  await prime(configuredBots.map((bot) => bot.botId));
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces,
    configStore: observedConfigStore,
    defaultWorkspace,
  });
  const coreController = new Controller({
    configStore: observedConfigStore,
    authPath: paths.authPath,
    createSession,
    logger,
    createRuntime: async ({ botId, config: botConfig, authDir }) => {
      const state = await stateFor(botId);
      await workspaces.ensure(botId, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: initialAccessPolicyFor('whatsapp', botConfig),
      });
      const receiveChannelMessage = createAccountIngress(internals.receiveChannelMessage, { botId, workspaces });
      return new Runtime({
        config: botConfig,
        authDir,
        receiveChannelMessage,
        state,
        groupHistory: internals.groupHistory ?? getGroupHistoryStore(ctx, config),
        contextEnhancement: { botId, getSettings: () => workspaces.contextEnhancementFor(botId) },
        accessPolicy: accessPolicyProvider(workspaces, botId, {
          channel: 'whatsapp', config: botConfig, equals: whatsappAccessPolicyIdsEqual,
        }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        connectTimeoutMs: config.connectTimeoutMs ?? 30_000,
        createSession,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteAuth: (authDirectory) => rm(paths.authPath(authDirectory), {
      recursive: true,
      force: true,
    }),
    deleteState: async ({ botId }) => {
      const state = stateForSync(botId);
      forget(botId);
      if (state && typeof state.remove === 'function') {
        await state.remove();
      } else {
        try {
          await unlink(statePath(botId));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
  });
  const controller = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor,
  });
  const supervisor = createSupervisor({
    channel: 'whatsapp',
    controller,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({       channel: 'whatsapp', workspaces, coreController, stateFor,
      // The same store, without the await: it is a memo of already loaded bots.
      stateForSync,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
    },
  };
}
