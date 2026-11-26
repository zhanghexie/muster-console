import { authorizeSafetyOperation } from '../safety/bindings';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { confirmAppDefinition } from '../safety/humanConfirmation';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { AppContext } from '../context';
import { AgentAppsServiceClient } from './serviceClient';
import { attachmentDir } from '../attachments/service';
import { managedImageSource } from './managedImageSource';
import { createAppConnectors } from './connectors';
import { makeQrDataUrl, resolveCliExe, runCli, startConfigInitNew, startEventConsume } from '../feishu/larkCli';
import { PhoneFeishuAccounts, phoneFeishuAppBound, phoneFeishuProfile } from './feishuAccounts';
import { runOutsideAgentScope } from '../agent/agentScope';
import { agentMailIdForKey, deliverAgentMessage, readAgentLedgerFor } from '../messages/deliver';
import { getSubscriptionPolicyStore } from '../orchestrator/subscriptionPolicyStore';
import { decidePolicyAction, matchPolicyRule } from '../../shared/subscriptionPolicy';
import { controlRootFor } from '../workspacePaths';
import { assertCredentialStorage } from './credentialPolicy';
import { createSystemFeedProxy } from './feedProxy';
import { authorizeAppSend } from './sendAuthorization';
import type { LogicalChannelLegacyAdapter } from '../../shared/messagingChannels';
import { isLegacyChannelApp } from '../../shared/agentApps';
import { buildSendBotImageArgs, captureImageRelPath } from '../../shared/terminalCapture';
import { createHash } from 'node:crypto';
import { imapConsumerArbiter, legacyImapOwner } from '../messaging/imapConsumerArbiter';

export function createLogicalChannelLegacyAdapter(ctx: AppContext): LogicalChannelLegacyAdapter {
  const apps = () => { if (!ctx.agentApps) throw new Error('Existing Channel sources are unavailable'); return ctx.agentApps.legacyChannels; };
  return {
    listSources: async ws => (await apps().listSources(ws)).map(source => source.canRemote && !ctx.agentApps?.legacyFeishuReceiving(ws) ? { ...source, connected: false } : source),
    listMessages: (ws, channelId, sourceId, query) => apps().listMessages(ws, channelId, sourceId, query),
    getMessage: (ws, channelId, sourceId, messageId) => apps().getMessage(ws, channelId, sourceId, messageId),
    send: (input, signal) => apps().send(input, signal), reply: (input, signal) => apps().reply(input, signal),
    setMessageState: input => apps().setMessageState(input), saveDraft: (input, signal) => apps().saveDraft!(input, signal)
  };
}

export function createAgentAppsService(ctx: AppContext): AgentAppsServiceClient {
  const checkStorage = () => assertCredentialStorage(safeStorage.isEncryptionAvailable(), process.platform, process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined);
  const channels = () => { if (!ctx.messagingChannels) throw new Error('Channel service is unavailable'); return ctx.messagingChannels; };
  const connectors = createAppConnectors(runCli, createSystemFeedProxy(), (mailbox, owner) => imapConsumerArbiter.claim(mailbox, owner));
  const worker = path.join(__dirname, 'agentApps', 'service-worker.cjs').replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  const service: AgentAppsServiceClient = new AgentAppsServiceClient(worker, {
    root: userDataStorage(app.getPath('userData')).resolve('app', 'agent-apps'),
    workspaces: () => ctx.workspaces.list().map(w => w.id),
    emit: (kind, event) => { const win = ctx.getWindow(); if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(`agentApps:${kind}`, event); },
    encrypt: value => { checkStorage(); return safeStorage.encryptString(value).toString('base64'); },
    decrypt: value => { checkStorage(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
    connectors,
    claimImapConsumer: (ws, mailbox) => imapConsumerArbiter.claim(mailbox, legacyImapOwner(ws, mailbox.id)),
    channels: {
      catalog: (ws, signal) => channels().catalog(ws, signal),
      bindChannel: (ws, id, bound, signal) => channels().bindChannel(ws, id, bound, signal),
      legacyAccess: (ws, signal) => channels().legacyAccess(ws, signal),
      captureLegacyNotices: (ws, notice, signal) => {
        const existingId = agentMailIdForKey('host', `orchestrator:${ws}`, `app:${notice.eventId}`);
        const ownerAlreadyDelivered = readAgentLedgerFor(ctx, ws).messages.some(message => message.id === existingId);
        return channels().captureLegacyNotices(ws, notice, ownerAlreadyDelivered, signal);
      },
      listChannels: (ws, signal) => channels().listChannels(ws, signal),
      listMessages: (ws, channelId, query, signal) => channels().listMessages(ws, channelId, query, signal),
      getMessage: (ws, channelId, messageId, signal) => channels().getMessage(ws, channelId, messageId, signal),
      reply: (input, signal) => channels().reply(input, signal), send: (input, signal) => channels().send(input, signal),
      setMessageState: input => channels().setMessageState(input), saveDraft: (input, signal) => channels().saveDraft(input, signal)
    },
    authorizeDefinition: async (workspaceId, action, definition, signal) => (await authorizeSafetyOperation(ctx, {
      signal,
      workspaceId, action, args: { definition }, source: 'app', summary: `App ${definition.id}`,
      evidence: JSON.stringify(definition),
      humanConfirm: (reason, signal) => confirmAppDefinition(ctx, action, definition, reason, signal)
    })).allowed,
    feishuAccounts: new PhoneFeishuAccounts({
      available: () => !!resolveCliExe(), probe: profile => phoneFeishuAppBound(runCli, profile),
      start: (profile, onUrl) => startConfigInitNew(onUrl, profile), qr: makeQrDataUrl,
      listen: (profile, onLine, onExit, onReady) => startEventConsume('im.message.receive_v1', onLine, onExit, line => { if (line.startsWith('[event] ready ')) onReady(); }, true, profile, true),
      saveChat: (ws, chat) => service.rememberFeishuChat(ws, chat),
      botId: profile => connectors.feishuBotId!(profile),
      receive: (ws, message, conversation, fields) => service.receiveFeishuMessage(ws, message, conversation, fields),
      receiveRemote: async (ws, input) => {
        if (!ctx.messagingChannels || input.signal?.aborted) return false;
        const profile = phoneFeishuProfile(ws);
        const sendText = async (text: string, signal?: AbortSignal) => {
          signal?.throwIfAborted(); input.signal?.throwIfAborted();
          const key = createHash('sha256').update(JSON.stringify([input.messageId, text])).digest('hex').slice(0, 32);
          const result = await runCli(['im', '+messages-reply', '--message-id', input.messageId, '--as', 'bot', '--content', JSON.stringify({ text }), '--msg-type', 'text', '--idempotency-key', key], { profile });
          if (result.code !== 0) throw new Error('Legacy Feishu reply failed');
        };
        return ctx.messagingChannels.receiveLegacyRemote(ws, { ...input, onProgress: sendText,
          deliver: async (reply, signal) => {
            if (reply.text) await sendText(reply.text, signal);
            if (reply.image) {
              signal.throwIfAborted(); input.signal?.throwIfAborted();
              const file = reply.image.filePath;
              const result = await runCli(buildSendBotImageArgs(input.conversationId, captureImageRelPath(path.basename(file))), { cwd: path.dirname(file), profile });
              if (result.code !== 0) throw new Error('Legacy Feishu image reply failed');
            }
          }
        });
      },
      emit: status => { const win = ctx.getWindow(); if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('agentApps:feishuStatus', status); }
    }),
    resolveManagedImage: (ws, source) => managedImageSource(attachmentDir(app.getPath('userData'), `scheduler:${ws}`), source),
    confirmSend: (ws, appName, values, signal) => authorizeAppSend(ctx, ws, appName, values, signal),
    deliver: (workspaceId, event) => runOutsideAgentScope(async () => {
      const workspace = ctx.workspaces.list().find(w => w.id === workspaceId);
      if (!workspace) throw new Error('Workspace no longer exists');
      const policy = getSubscriptionPolicyStore().get(controlRootFor(workspace));
      if (event.kind === 'reminder.due') {
        if (!ctx.eventRouter) throw new Error('Event router is unavailable');
        const router = ctx.eventRouter;
        const subject = `system:reminder:${workspaceId}`;
        if (!router.log.subscriptions(subject).some(s => s.source === 'reminder')) router.log.subscribe({ subject, workspaceId,
          source: 'reminder', types: [], scope: '', mode: 'instant', createdAt: Date.now(), expiresAt: null });
        router.publish({ source: 'reminder', deliveryId: `${workspaceId}:${event.id}`, type: event.kind,
          scope: event.appId, workspaceId, receivedAt: Date.now(), summary: event.title.slice(0, 1000),
          payload: JSON.stringify({ id: event.id, appId: event.appId, kind: event.kind, title: event.title, action: event.action, createdAt: event.createdAt, occurrenceAt: event.occurrenceAt }) });
        let replayError: unknown;
        try { await router.replay(); } catch (error) { replayError = error; }
        const mailId = agentMailIdForKey('host', `orchestrator:${workspaceId}`, `app:${event.id}`);
        if (readAgentLedgerFor(ctx, workspaceId).messages.some(message => message.id === mailId)) return { messageId: mailId };
        const decision = decidePolicyAction({ kind: 'event.subscription', factKind: 'reminder', trigger: event.kind }, policy);
        const action = decision.ruleId === 'builtin.default'
          ? policy?.rules.find(rule => matchPolicyRule(rule.match, { kind: 'fact', factKind: `app.${event.kind}` }))?.action ?? event.action
          : decision.action;
        if (action === 'mute' || !await service.notification(workspaceId, event.id)) return { muted: true };
        throw replayError ?? new Error('Reminder event is queued for delivery');
      }
      const scopedNotice = event.channelMessage || isLegacyChannelApp(event.appId);
      const currentChannelNotice = scopedNotice ? await service.notification(workspaceId, event.id) : undefined;
      if (scopedNotice && !currentChannelNotice) return { muted: true };
      const action = policy?.rules.find(rule => matchPolicyRule(rule.match, { kind: 'fact', factKind: `app.${event.kind}` }))?.action ?? currentChannelNotice?.action ?? event.action;
      if (action === 'mute') return { muted: true };
      const saved = await deliverAgentMessage(ctx, {
        workspaceId, from: 'host', to: `orchestrator:${workspaceId}`, kind: 'notice',
        subject: event.title, idempotencyKey: `app:${event.id}`,
        text: event.title,
        meta: { hostNotification: { kind: 'app', appId: event.appId, eventId: event.id }, ...(action === 'digest' ? { digest: true } : {}), eventId: event.id, notificationKey: `app:${event.id}` }
      });
      return { messageId: saved.messageId };
    })
  });
  return service;
}
