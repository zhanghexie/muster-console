import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { AgentAppsService, type AppActor, type AppConnectors } from './service';
import { AgentAppsSqliteStateStore } from './sqliteStateStore';
import { AppImageAssets } from './images';
import { CHANNEL_APP_ID, type AgentAppDefinition, type AppCall, type AppRecord } from '../../shared/agentApps';
import type { PhoneFeishuAccounts } from './feishuAccounts';
import type { AppChannelHost } from './appChannels';
import type { LogicalChannelLegacyAdapter } from '../../shared/messagingChannels';

if (!parentPort || !workerData || typeof workerData.root !== 'string' || !Array.isArray(workerData.workspaces)) throw new Error('Invalid app worker initialization');
const port = parentPort;
let workspaces: string[] = workerData.workspaces;
let hostSequence = 0;
const pendingHost = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
const running = new Map<number, AbortController>();
const ongoing = new Map<number, Promise<void>>();
const retiredWorkspaces = new Map<string, number>();
const pendingWorkspaceCloses = new Map<string, { generation: number; work: Promise<void> }>();
let retirementGeneration = 0;
let shuttingDown = false;

function host<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
  const id = ++hostSequence;
  return new Promise<T>((resolve, reject) => {
    const abort = () => port.postMessage({ kind: 'host-cancel', id });
    signal?.addEventListener('abort', abort, { once: true });
    pendingHost.set(id, { resolve: value => resolve(value as T), reject, cleanup: () => signal?.removeEventListener('abort', abort) });
    port.postMessage({ kind: 'host-call', id, method, args });
    if (signal?.aborted) abort();
  });
}
function syncHost<T>(method: string, args: unknown[]): T {
  const memory = new SharedArrayBuffer(1024 * 1024 + 8), state = new Int32Array(memory, 0, 2), bytes = new Uint8Array(memory, 8);
  port.postMessage({ kind: 'host-sync', method, args, memory });
  if (Atomics.wait(state, 0, 0, 30_000) === 'timed-out') throw new Error('App host operation timed out');
  const length = Atomics.load(state, 1);
  if (length < 0 || length > bytes.length) throw new Error('Invalid app host response');
  const reply = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))) as { value?: T; error?: string };
  bytes.fill(0);
  if (reply.error) throw new Error(reply.error);
  return reply.value as T;
}
const connectors: AppConnectors = {
  feed: (url, signal) => host('connectors.feed', [url], signal),
  sync: (connection, secret, cursor, signal, workspaceId) => host('connectors.sync', [connection, secret, cursor, workspaceId], signal),
  send: (connection, secret, values, requestId, signal) => host('connectors.send', [connection, secret, values, requestId], signal),
  test: (connection, secret, workspaceId, signal) => host('connectors.test', [connection, secret, workspaceId], signal),
  listFeishuChats: (identity, token, profile) => host('connectors.listFeishuChats', [identity, token, profile]),
  feishuBotId: profile => host('connectors.feishuBotId', [profile]),
  feishuConversationName: (chatId, messageId, type, profile) => host('connectors.feishuConversationName', [chatId, messageId, type, profile])
};
const feishu = workerData.feishu ? {
  get: (workspaceId: string) => host('feishu.get', [workspaceId]),
  start: (workspaceId: string) => host('feishu.start', [workspaceId]),
  ensureReceiving: (workspaceId: string) => host('feishu.ensureReceiving', [workspaceId]),
  beginBinding: (workspaceId: string) => host('feishu.beginBinding', [workspaceId]),
  cancel: (workspaceId: string) => syncHost('feishu.cancel', [workspaceId]),
  stopWorkspace: (workspaceId: string) => syncHost('feishu.stopWorkspace', [workspaceId]),
  stop: () => syncHost('feishu.stop', [])
} as unknown as PhoneFeishuAccounts : undefined;
const channels: AppChannelHost | undefined = workerData.channels ? {
  catalog: (ws, signal) => host('channels.catalog', [ws], signal),
  bindChannel: (ws, channelId, bound, signal) => host('channels.bind', [ws, channelId, bound], signal),
  legacyAccess: (ws, signal) => host('channels.legacyAccess', [ws], signal),
  captureLegacyNotices: (ws, notice, signal) => host('channels.captureLegacyNotices', [ws, notice], signal),
  listChannels: (ws, signal) => host('channels.list', [ws], signal),
  listMessages: (ws, channelId, query, signal) => host('channels.messages', [ws, channelId, query], signal),
  getMessage: (ws, channelId, messageId, signal) => host('channels.get', [ws, channelId, messageId], signal),
  reply: (input, signal) => host('channels.reply', [input], signal),
  send: (input, signal) => host('channels.send', [input], signal),
  setMessageState: input => host('channels.state', [input]),
  saveDraft: (input, signal) => host('channels.saveDraft', [input], signal)
} : undefined;
let store!: AgentAppsSqliteStateStore;
const service = new AgentAppsService({
  root: workerData.root, workspaces: () => workspaces,
  storeFactory: (root, seed) => (store = new AgentAppsSqliteStateStore(root, seed)),
  emit: (kind, value) => port.postMessage({ kind: 'emit', eventKind: kind, value }),
  encrypt: value => syncHost('encrypt', [value]), decrypt: value => syncHost('decrypt', [value]),
  confirmSend: (workspaceId, app, values, signal) => host('confirmSend', [workspaceId, app, values], signal),
  authorizeDefinition: (workspaceId, action, definition) => host('authorizeDefinition', [workspaceId, action, definition]),
  claimImapConsumer: workerData.claimImapConsumer ? (workspaceId, connection) => {
    const token = syncHost<number>('imap.claim', [workspaceId, connection]);
    return () => syncHost('imap.release', [token]);
  } : undefined,
  deliver: (workspaceId, event) => host('deliver', [workspaceId, event]), connectors, feishuAccounts: feishu, channels
});
const images = new AppImageAssets(path.join(path.dirname(workerData.root), 'agent-app-assets'), store);

/** Let requests, background jobs and image cleanup finish before closing a removed workspace. */
function updateWorkspaces(next: string[]): void {
  for (const ws of workspaces) if (!next.includes(ws)) retiredWorkspaces.set(ws, ++retirementGeneration);
  workspaces = next;
  for (const ws of next) retiredWorkspaces.delete(ws);
  service.refreshWorkspaces();
  for (const [ws, generation] of retiredWorkspaces) {
    if (pendingWorkspaceCloses.get(ws)?.generation === generation) continue;
    const requests = [...ongoing.values()];
    const work = Promise.allSettled([...requests, service.waitForIdle()]).then(() => {
      if (retiredWorkspaces.get(ws) !== generation || workspaces.includes(ws)) return;
      store.closeWorkspace(ws);
      retiredWorkspaces.delete(ws);
    }).catch(error => console.error('[agentApps] failed to release removed workspace', ws, error instanceof Error ? error.message : String(error)));
    pendingWorkspaceCloses.set(ws, { generation, work });
    void work.then(() => { if (pendingWorkspaceCloses.get(ws)?.work === work) pendingWorkspaceCloses.delete(ws); });
  }
}

function imageApp(workspaceId: string, appId: string): AgentAppDefinition {
  if (!workspaces.includes(workspaceId)) throw new Error('App workspace is unavailable');
  const installation = store.read(workspaceId).installations.find(item => item.definition.id === appId && item.enabled);
  if (!installation || !installation.definition.collections.some(collection => collection.fields.some(field => field.type === 'image'))) throw new Error('App is unavailable or does not support images');
  return installation.definition;
}
function imageIds(app: AgentAppDefinition, record?: AppRecord): string[] {
  if (!record) return [];
  const collection = app.collections.find(item => item.id === record.collection);
  return (collection?.fields ?? []).filter(field => field.type === 'image').flatMap(field => typeof record.values[field.id] === 'string' && record.values[field.id] ? [record.values[field.id] as string] : []);
}
async function executeWithImageCleanup(ws: string, call: AppCall, actor: AppActor) {
  const app = service.snapshot(ws).apps.find(item => item.definition.id === call.appId && item.enabled)?.definition;
  const command = app?.commands.find(item => item.id === call.commandId);
  let before: string[] = [];
  if (app && command && ['records.update', 'records.remove'].includes(command.handler) && app.collections.some(collection => collection.fields.some(field => field.type === 'image')) && typeof call.params?.id === 'string') {
    before = imageIds(app, service.query(ws, { appId: app.id, collection: command.collection, id: call.params.id }).record);
  }
  const result = await service.execute(ws, call, actor);
  if (app && before.length) {
    const remaining = new Set(imageIds(app, result.record));
    try { for (const id of before) if (!remaining.has(id)) await images.removeIfUnused(ws, app.id, id); }
    catch (error) { throw new Error(`Record was updated, but image cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}

port.on('message', (message: { kind: string; id?: number; method?: string; args?: unknown[]; workspaces?: string[]; result?: unknown; error?: string }) => {
  if (message.kind === 'host-result') {
    const pending = pendingHost.get(message.id!); if (!pending) return;
    pendingHost.delete(message.id!); pending.cleanup();
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    return;
  }
  if (message.kind === 'abort') { running.get(message.id!)?.abort(); return; }
  if (message.kind === 'workspaces' && Array.isArray(message.workspaces)) { updateWorkspaces(message.workspaces); return; }
  if (message.kind !== 'request') return;
  if (shuttingDown) { port.postMessage({ kind: 'result', id: message.id, error: 'App service worker is stopping' }); return; }
  if (Array.isArray(message.workspaces)) updateWorkspaces(message.workspaces);
  const id = message.id!, args = message.args ?? [], controller = new AbortController();
  if (message.method === 'stop') {
    shuttingDown = true;
    service.stop();
    for (const active of running.values()) active.abort();
  }
  running.set(id, controller);
  const invoke = async (): Promise<unknown> => {
    switch (message.method) {
      case 'start': {
        service.start();
        for (const ws of workspaces) try { await images.recover(ws); } catch (error) { console.error('[agentApps] image recovery failed', ws, error instanceof Error ? error.message : String(error)); }
        return null;
      }
      case 'prepareImapReservations': return service.refreshImapReservations();
      case 'stop': {
        const pending = [...ongoing.values()];
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...pending, service.waitForIdle()]),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('App service shutdown timed out; unfinished operations require reconciliation')), 10_000); })
          ]);
          service.store.close?.();
          return null;
        } finally { if (timeout) clearTimeout(timeout); }
      }
      case 'tick': return service.tick();
      case 'snapshot': return service.snapshot(args[0] as string);
      case 'describeApp': return service.describeApp(args[0] as string, args[1] as string);
      case 'query': {
        const [workspaceId, query] = args as Parameters<AgentAppsService['query']>;
        return query.appId === CHANNEL_APP_ID ? service.queryChannel(workspaceId, query, controller.signal) : service.query(workspaceId, query);
      }
      case 'legacyChannels.listSources': return service.listLegacyChannelSources(args[0] as string);
      case 'legacyChannels.listMessages': return service.listLegacyChannelMessages(...args as Parameters<LogicalChannelLegacyAdapter['listMessages']>);
      case 'legacyChannels.getMessage': return service.getLegacyChannelMessage(...args as Parameters<LogicalChannelLegacyAdapter['getMessage']>);
      case 'legacyChannels.send': return service.sendLegacyChannelMessage(args[0] as Parameters<AgentAppsService['sendLegacyChannelMessage']>[0], controller.signal);
      case 'legacyChannels.state': return service.setLegacyChannelMessageState(args[0] as Parameters<AgentAppsService['setLegacyChannelMessageState']>[0]);
      case 'legacyChannels.saveDraft': return service.saveLegacyChannelDraft(args[0] as Parameters<AgentAppsService['saveLegacyChannelDraft']>[0], controller.signal);
      case 'notification': return (await service.resolveNotifications(args[0] as string, [args[1] as string], args[2] as number | undefined, controller.signal))[0];
      case 'notifications': return service.resolveNotifications(args[0] as string, args[1] as string[], args[2] as number | undefined, controller.signal);
      case 'execute': return executeWithImageCleanup(args[0] as string, args[1] as AppCall, { ...args[2] as AppActor, signal: controller.signal });
      case 'install': return service.install(args[0] as string, args[1], args[2] as Parameters<AgentAppsService['install']>[2]);
      case 'uninstall': {
        const ws = args[0] as string, appId = args[1] as string, deleteData = args[2] as boolean;
        const result = service.uninstall(ws, appId, deleteData);
        if (deleteData) try { for (const asset of store.imageAssets(ws, appId)) await images.removeIfUnused(ws, appId, asset.id); }
        catch (error) { throw new Error(`App was uninstalled, but image cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
        return result;
      }
      case 'setEnabled': return service.setEnabled(args[0] as string, args[1] as string, args[2] as boolean, args[3] as 'human' | 'agent' | undefined);
      case 'listLibrary': return service.listLibrary(args[0] as string);
      case 'installFromLibrary': return service.installFromLibrary(args[0] as string, args[1] as string, args[2] as number | undefined, args[3] as 'human' | 'agent' | undefined);
      case 'publishToLibrary': return service.publishToLibrary(args[0] as string, args[1] as string);
      case 'setLibraryPrivate': return service.setLibraryPrivate(args[0] as string, args[1] as string, args[2] as boolean);
      case 'saveConnection': return service.saveConnection(args[0] as string, args[1] as Parameters<AgentAppsService['saveConnection']>[1], args[2] as boolean | undefined);
      case 'testConnection': return service.testConnection(args[0] as string, args[1] as string);
      case 'listFeishuChats': return service.listFeishuChats(args[0] as string, args[1] as 'bot' | 'user', args[2] as string | undefined);
      case 'feishuStatus': return service.feishuStatus(args[0] as string);
      case 'startFeishuSetup': return service.startFeishuSetup(args[0] as string);
      case 'cancelFeishuSetup': return service.cancelFeishuSetup(args[0] as string);
      case 'beginFeishuBinding': return service.beginFeishuBinding(args[0] as string);
      case 'pairedFeishuChats': return service.pairedFeishuChats(args[0] as string);
      case 'connectedFeishuPrivateChats': return service.connectedFeishuPrivateChats(args[0] as string);
      case 'rememberFeishuChat': return service.rememberFeishuChat(args[0] as string, args[1] as Parameters<AgentAppsService['rememberFeishuChat']>[1]);
      case 'receiveFeishuMessage': return service.receiveFeishuMessage(args[0] as string, args[1] as Parameters<AgentAppsService['receiveFeishuMessage']>[1], args[2] as Parameters<AgentAppsService['receiveFeishuMessage']>[2], args[3] as Parameters<AgentAppsService['receiveFeishuMessage']>[3]);
      case 'importImage': {
        const ws = args[0] as string, appId = args[1] as string;
        imageApp(ws, appId); return images.importFile(ws, appId, args[2] as string, () => { imageApp(ws, appId); });
      }
      case 'readImage': {
        const ws = args[0] as string, appId = args[1] as string;
        imageApp(ws, appId); const result = await images.read(ws, appId, args[2] as string, args[3] === true); imageApp(ws, appId); return result;
      }
      case 'imageInfo': imageApp(args[0] as string, args[1] as string); return store.imageAsset(args[0] as string, args[1] as string, args[2] as string) ?? null;
      case 'imagePath': {
        const ws = args[0] as string, appId = args[1] as string;
        imageApp(ws, appId); const result = await images.originalPath(ws, appId, args[2] as string); imageApp(ws, appId); return result;
      }
      case 'releaseImage': imageApp(args[0] as string, args[1] as string); return images.removeIfUnused(args[0] as string, args[1] as string, args[2] as string);
      default: throw new Error('Unknown app worker method');
    }
  };
  const work = invoke().then(result => port.postMessage({ kind: 'result', id, result }), error => port.postMessage({ kind: 'result', id, error: error instanceof Error ? error.message : String(error) })).finally(() => { running.delete(id); ongoing.delete(id); });
  ongoing.set(id, work);
});
