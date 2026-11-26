import { APP_ID, CHANNEL_APP_ID, isLegacyChannelApp, type AppImageAsset, type AppInstallation, type AppOperation, type AppQuery, type AppRecord } from '../../shared/agentApps';
import type { AppJob, AppOutboxEvent, AppReceipt, AppWorkspaceState, StoredConnection } from './store';
import { produceAppDraft } from './draft';
import { AgentAppsSqliteRepository, type AppSqliteChange } from './sqliteRepository';

function imageIds(installations: AppInstallation[], appId: string, record: AppRecord): string[] {
  const collection = installations.find(app => app.definition.id === appId)?.definition.collections.find(item => item.id === record.collection);
  return (collection?.fields ?? []).filter(field => field.type === 'image').flatMap(field => typeof record.values[field.id] === 'string' && record.values[field.id] ? [record.values[field.id] as string] : []);
}

/** Synchronous facade for use inside a dedicated app worker, never in Electron's main thread. */
export class AgentAppsSqliteStateStore {
  private readonly repository: AgentAppsSqliteRepository;
  private readonly states = new Map<string, AppWorkspaceState>();
  private readonly initializedWorkspaces = new Set<string>();
  constructor(root: string, private readonly seed: () => AppInstallation[]) { this.repository = new AgentAppsSqliteRepository(root); }
  read(workspaceId: string): AppWorkspaceState {
    const cached = this.states.get(workspaceId); if (cached) return cached;
    let { revision } = this.repository.open(workspaceId);
    let installations = this.repository.list(workspaceId, 'installations') as AppInstallation[];
    if (!installations.length && revision === 0) {
      installations = this.seed();
      revision = this.repository.transact(workspaceId, revision, installations.map(value => ({ type: 'putInstallation', value }))).revision;
    }
    const records: Record<string, AppRecord[]> = {};
    for (const appId of this.repository.recordAppIds(workspaceId)) {
      if (!APP_ID.test(appId) || ['constructor', 'prototype'].includes(appId)) throw new Error('Invalid app record identity in SQLite');
      let loaded: AppRecord[] | undefined;
      Object.defineProperty(records, appId, { configurable: true, enumerable: true, get: () => loaded ??= this.repository.recordsForApp(workspaceId, appId) });
    }
    const extras = this.repository.extras(workspaceId);
    if (Object.keys(extras).some(key => !['feishuChats', 'feedSyncedAt', 'deletions', 'uninstalledApps', 'channelCursors'].includes(key))) throw new Error('Unknown app SQLite state field');
    const state: AppWorkspaceState = { schemaVersion: 1, workspaceId, revision, installations, records,
      jobs: this.repository.list(workspaceId, 'jobs') as AppJob[], outbox: this.repository.list(workspaceId, 'outbox') as AppOutboxEvent[],
      receipts: this.repository.list(workspaceId, 'receipts') as AppReceipt[], operations: this.repository.list(workspaceId, 'operations') as AppOperation[],
      connections: this.repository.list(workspaceId, 'connections') as StoredConnection[], ...extras };
    this.states.set(workspaceId, state);
    const builtinVersions = this.seed();
    const channel = builtinVersions.find(seed => seed.definition.id === CHANNEL_APP_ID);
    const migrateChannel = channel && !state.installations.some(installed => installed.definition.id === CHANNEL_APP_ID);
    const recoverInterrupted = !this.initializedWorkspaces.has(workspaceId);
    if (migrateChannel || (recoverInterrupted && (state.receipts.some(receipt => receipt.state === 'running') || state.operations.some(operation => operation.phase === 'running'))) ||
        builtinVersions.some(seed => state.installations.some(app => app.definition.id === seed.definition.id && app.definition.version < seed.definition.version))) {
      try { this.transact(workspaceId, draft => {
        for (const receipt of draft.receipts) if (recoverInterrupted && receipt.state === 'running') {
          receipt.state = 'uncertain';
          const record = draft.records[receipt.key.split(':')[0]]?.find(item => item.id === receipt.recordId);
          if (receipt.submitted && record?.values.status === 'sending') { record.values.status = 'uncertain'; record.revision++; record.updatedAt = Date.now(); }
        }
        for (const operation of draft.operations) if (recoverInterrupted && operation.phase === 'running') { operation.phase = 'failed'; operation.error = '应用重启，执行结果需要核对'; }
        if (migrateChannel) {
          const legacy = draft.installations.filter(app => isLegacyChannelApp(app.definition.id));
          draft.installations.push({ ...channel, enabled: !legacy.length || legacy.some(app => app.enabled) });
        }
        for (const seed of builtinVersions) {
          const installed = draft.installations.find(app => app.definition.id === seed.definition.id);
          if (installed && installed.definition.version < seed.definition.version) installed.definition = seed.definition;
        }
      }); } catch (error) { this.states.delete(workspaceId); throw error; }
    }
    this.initializedWorkspaces.add(workspaceId);
    return this.states.get(workspaceId)!;
  }
  transact<T>(workspaceId: string, fn: (draft: AppWorkspaceState) => T): T {
    const previous = this.read(workspaceId);
    const { next, result } = produceAppDraft(previous, draft => { const value = fn(draft); draft.revision++; return value; });
    const changes: AppSqliteChange[] = [];
    function diff<TItem>(before: TItem[], after: TItem[], key: (item: TItem) => string, put: (item: TItem) => AppSqliteChange, remove: (id: string) => AppSqliteChange): void {
      if (before === after) return;
      const previousById = new Map(before.map(item => [key(item), item]));
      const previousPositions = new Map(before.map((item, index) => [key(item), index]));
      const seen = new Set<string>();
      for (const item of after) { const id = key(item); if (!id || seen.has(id)) throw new Error('Duplicate app state identity'); seen.add(id); }
      for (const id of previousById.keys()) if (!seen.has(id)) changes.push(remove(id));
      let lastPosition = -1, append = false;
      for (const item of after) {
        const id = key(item), position = previousPositions.get(id);
        if (position === undefined) { append = true; changes.push(put(item)); continue; }
        if (append || position < lastPosition) { append = true; changes.push(remove(id), put(item)); }
        else if (previousById.get(id) !== item) changes.push(put(item));
        lastPosition = position;
      }
    }
    diff(previous.installations, next.installations, item => item.definition.id, value => ({ type: 'putInstallation', value }), id => ({ type: 'deleteInstallation', id }));
    for (const appId of new Set([...Object.keys(previous.records), ...Object.keys(next.records)])) {
      const before = Object.getOwnPropertyDescriptor(previous.records, appId), after = Object.getOwnPropertyDescriptor(next.records, appId);
      if (before && after && (('value' in before && 'value' in after && before.value === after.value) || (!('value' in before) && !('value' in after) && before.get === after.get && before.set === after.set))) continue;
      if (!before && after) changes.push({ type: 'putRecordGroup', appId });
      if (before && !after) { changes.push({ type: 'deleteRecordGroup', appId }); continue; }
      diff(previous.records[appId] ?? [], next.records[appId] ?? [], item => item.id, record => ({ type: 'putRecord', appId, record, assetIds: imageIds(next.installations, appId, record) }), id => ({ type: 'deleteRecord', appId, id }));
    }
    diff(previous.jobs, next.jobs, item => item.id, value => ({ type: 'putJob', value }), id => ({ type: 'deleteJob', id }));
    diff(previous.outbox, next.outbox, item => item.id, value => ({ type: 'putOutbox', value }), id => ({ type: 'deleteOutbox', id }));
    diff(previous.receipts, next.receipts, item => item.key, value => ({ type: 'putReceipt', value }), id => ({ type: 'deleteReceipt', id }));
    diff(previous.operations, next.operations, item => item.operationId, value => ({ type: 'putOperation', value }), id => ({ type: 'deleteOperation', id }));
    diff(previous.connections, next.connections, item => item.id, value => ({ type: 'putConnection', value }), id => ({ type: 'deleteConnection', id }));
    for (const id of ['feishuChats', 'feedSyncedAt', 'deletions', 'uninstalledApps', 'channelCursors'] as const) if (previous[id] !== next[id]) {
      if (next[id] === undefined) changes.push({ type: 'deleteExtra', id }); else changes.push({ type: 'putExtra', id, value: next[id] });
    }
    try { this.repository.transact(workspaceId, previous.revision, changes); }
    catch (error) { this.states.delete(workspaceId); throw error; }
    this.states.set(workspaceId, next);
    return structuredClone(result);
  }
  queryRecords(workspaceId: string, query: AppQuery): { records: AppRecord[]; total: number } {
    this.read(workspaceId);
    return this.repository.query(workspaceId, query);
  }
  updateRecord(workspaceId: string, appId: string, id: string, update: (record: AppRecord) => void): AppRecord {
    const state = this.read(workspaceId), record = this.repository.record(workspaceId, appId, id);
    if (!record) throw new Error('Record not found');
    update(record);
    try {
      const { revision } = this.repository.transact(workspaceId, state.revision, [{ type: 'putRecord', appId, record, assetIds: imageIds(state.installations, appId, record) }]);
      // Replace only the changed app's lazy collection without mutating loaded
      // arrays or deserializing unrelated apps on the next read.
      const records = Object.create(Object.getPrototypeOf(state.records), Object.getOwnPropertyDescriptors(state.records)) as AppWorkspaceState['records'];
      let loaded: AppRecord[] | undefined;
      Object.defineProperty(records, appId, { configurable: true, enumerable: true,
        get: () => loaded ??= this.repository.recordsForApp(workspaceId, appId) });
      this.states.set(workspaceId, { ...state, revision, records });
    }
    catch (error) { this.states.delete(workspaceId); throw error; }
    return structuredClone(record);
  }
  imageAsset(workspaceId: string, appId: string, id: string): AppImageAsset | undefined { this.read(workspaceId); return this.repository.imageAsset(workspaceId, appId, id); }
  imageAssets(workspaceId: string, appId: string): AppImageAsset[] { this.read(workspaceId); return this.repository.imageAssets(workspaceId, appId); }
  allImageAssets(workspaceId: string): AppImageAsset[] { this.read(workspaceId); return this.repository.allImageAssets(workspaceId); }
  imageReferenceCount(workspaceId: string, id: string): number { this.read(workspaceId); return this.repository.imageReferenceCount(workspaceId, id); }
  changeImageAsset(workspaceId: string, change: Extract<AppSqliteChange, { type: 'putImageAsset' | 'markImageDeleting' | 'deleteImageAsset' }>): void {
    const state = this.read(workspaceId);
    try {
      const { revision } = this.repository.transact(workspaceId, state.revision, [change]);
      // Image assets are queried separately and are not part of the workspace
      // snapshot. Preserve its lazy record groups and other unchanged data.
      this.states.set(workspaceId, { ...state, revision });
    }
    catch (error) { this.states.delete(workspaceId); throw error; }
  }
  closeWorkspace(workspaceId: string): void {
    this.repository.closeWorkspace(workspaceId);
    this.states.delete(workspaceId);
    this.initializedWorkspaces.delete(workspaceId);
  }
  close(): void { this.repository.close(); this.states.clear(); this.initializedWorkspaces.clear(); }
}
