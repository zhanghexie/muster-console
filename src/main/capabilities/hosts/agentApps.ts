import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context';
import { CHANNEL_APP_ID, isLegacyChannelApp, type AppQuery } from '../../../shared/agentApps';
import { currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { currentMemoryTurn } from '../../agent/turnScope';
import { prepareMailboxConnection } from '../../agentApps/mailboxConfiguration';
import { authorizeSafetyOperation } from '../../safety/bindings';
import { isConfirmed } from '../../../shared/confirmDialog';
import { t } from '../../../shared/i18n';
import { localizeSafetyReason } from '../../../shared/safetyReason';

export const agentAppsHost = {
  'apps.run': (ctx: AppContext, args: { action: string; appId?: string; commandId?: string; params?: Record<string, unknown>; requestId?: string; definition?: unknown; enabled?: boolean }, options?: { signal?: AbortSignal }) => {
    const workspaceId = currentAgentWorkspaceId();
    if (!isSchedulerInvocation() || !workspaceId) throw new Error('apps.run requires a bound scheduler invocation');
    const service = ctx.agentApps; if (!service) throw new Error('应用服务尚未就绪');
    options?.signal?.throwIfAborted();
    if (args.action === 'list') return (async () => { const snapshot = await service.snapshot(workspaceId); return { apps: snapshot.apps.map(a => ({ id: a.definition.id, name: a.definition.name, description: a.definition.description, enabled: a.enabled })), connections: snapshot.connections, errors: snapshot.errors }; })();
    if (args.action === 'install') return service.install(workspaceId, args.definition, { private: args.params?.private as boolean | undefined });
    if (args.action === 'listLibrary') return service.listLibrary(workspaceId);
    if (args.action === 'installFromLibrary') {
      const catalogId = args.params?.catalogId, version = args.params?.version;
      if (typeof catalogId !== 'string' || !catalogId.trim()) throw new Error('catalogId is required');
      if (version !== undefined && (!Number.isSafeInteger(version) || Number(version) <= 0)) throw new Error('version must be a positive integer');
      return service.installFromLibrary(workspaceId, catalogId, version as number | undefined);
    }
    if (args.action === 'saveMailbox') return (async () => {
      const connections = (await service.snapshot(workspaceId)).connections;
      const prepared = prepareMailboxConnection(args.params!, connections);
      const old = connections.find(connection => connection.id === prepared.id);
      await service.saveConnection(workspaceId, prepared, true);
      const canonicalGrants = (grants: typeof prepared.grants) => JSON.stringify(Object.entries(grants).sort(([a], [b]) => a.localeCompare(b)).map(([id, permissions]) => [id, [...permissions].sort()]));
      const sensitive = !old || prepared.password !== undefined || prepared.smtpPassword !== undefined || canonicalGrants(prepared.grants) !== canonicalGrants(old.grants) || !old.enabled && prepared.enabled || ['address', 'user', 'imapHost', 'smtpHost', 'mailbox', 'imapPort', 'smtpPort', 'imapTls', 'smtpTls'].some(key => prepared[key as keyof typeof prepared] !== old[key as keyof typeof old]);
      const configurationFingerprint = (connection: typeof old) => {
        if (!connection) return undefined;
        const { lastSyncAt: _lastSyncAt, lastError: _lastError, ...configuration } = connection;
        return JSON.stringify(configuration);
      };
      const before = configurationFingerprint(old);
      if (sensitive) {
        const decision = await authorizeSafetyOperation(ctx, { source: 'app', action: 'apps.saveMailbox', dangerous: true, args: { ...prepared }, summary: '配置邮箱连接', signal: options?.signal,
          humanConfirm: async (reason, signal) => isConfirmed(await ctx.ui.confirm(t('配置邮箱连接'), localizeSafetyReason(reason), { dangerous: true, signal })) });
        if (!decision.allowed) throw new Error(decision.reason || 'Mailbox configuration was denied');
      }
      options?.signal?.throwIfAborted();
      if (configurationFingerprint((await service.snapshot(workspaceId)).connections.find(connection => connection.id === prepared.id)) !== before) throw new Error('Connection changed during safety review; reload before saving');
      return service.saveConnection(workspaceId, prepared);
    })();
    if (args.action === 'testMailbox') return (async () => {
      const id = args.params?.id;
      if (typeof id !== 'string' || !id.trim()) throw new Error('Mailbox id is required');
      if (!(await service.snapshot(workspaceId)).connections.some(c => c.id === id && c.kind === 'imap-smtp')) throw new Error('Mailbox connection not found');
      return service.testConnection(workspaceId, id);
    })();
    if (!args.appId) throw new Error('appId is required');
    const appId = args.appId;
    if (args.action === 'importImage') {
      const source = args.params?.sourcePath;
      if (typeof source !== 'string' || !source) throw new Error('sourcePath is required');
      if (!('importManagedImage' in service) || typeof service.importManagedImage !== 'function') throw new Error('图片服务尚未就绪');
      return service.importManagedImage(workspaceId, appId, source);
    }
    if (args.action === 'imagePath') {
      const id = args.params?.assetId;
      if (typeof id !== 'string' || !id) throw new Error('assetId is required');
      if (!('imagePath' in service) || typeof service.imagePath !== 'function') throw new Error('图片服务尚未就绪');
      return service.imagePath(workspaceId, appId, id);
    }
    if (args.action === 'describe') return isLegacyChannelApp(appId) ? service.describeApp(workspaceId, appId) : (async () => {
      const app = (await service.snapshot(workspaceId)).apps.find(a => a.definition.id === appId);
      if (!app) throw new Error('Unknown app');
      return app;
    })();
    if (args.action === 'uninstall') return service.uninstall(workspaceId, args.appId, args.params?.deleteData === undefined ? false : args.params.deleteData as boolean);
    if (args.action === 'publish') return service.publishToLibrary(workspaceId, args.appId);
    if (args.action === 'setPrivate') return service.setLibraryPrivate(workspaceId, args.appId, args.params?.private as boolean);
    if (args.action === 'setEnabled') return service.setEnabled(workspaceId, args.appId, args.enabled!);
    // Tool queries are also operations; UI queries use a separate, side-effect-free IPC endpoint.
    if (args.action === 'query') return (async () => {
      if (appId === CHANNEL_APP_ID) {
        const { id, channelId, channelQuery, search, limit } = (args.params ?? {}) as Partial<AppQuery>;
        return service.execute(workspaceId, { appId, commandId: id ? 'get' : channelId ? 'list' : typeof search === 'string' && search.trim() ? 'search' : 'channels', params: { ...channelQuery, channelId, messageId: id, ...(search !== undefined ? { search } : {}), ...(limit !== undefined ? { limit } : {}) } },
          { kind: 'agent', runId: currentMemoryTurn()?.eventId ?? randomUUID(), signal: options?.signal });
      }
      const app = isLegacyChannelApp(appId) ? (await service.describeApp(workspaceId, appId)).definition
        : (await service.snapshot(workspaceId)).apps.find(a => a.definition.id === args.appId)?.definition;
      const params = args.params as AppQuery | undefined;
      const command = app?.commands.find(c => c.handler === (params?.id ? 'records.get' : 'records.list') && (!params?.collection || c.collection === params.collection));
      if (!command) throw new Error('No matching query command; use describe to select a command');
      return service.execute(workspaceId, { appId, commandId: command.id, params: args.params }, { kind: 'agent', runId: currentMemoryTurn()?.eventId ?? randomUUID(), signal: options?.signal });
    })();
    if (args.action !== 'call' || !args.commandId) throw new Error('Unknown action or missing commandId');
    return service.execute(workspaceId, { appId: args.appId, commandId: args.commandId, params: args.params, requestId: args.requestId }, { kind: 'agent', runId: currentMemoryTurn()?.eventId ?? randomUUID(), signal: options?.signal });
  }
};
