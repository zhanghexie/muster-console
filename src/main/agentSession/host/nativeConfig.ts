import type { SessionMeta } from '../../../shared/types';
import type { NativeConfigChange, NativeConfigSnapshot } from '../../../shared/nativeSessionConfig';
import { nativeOptionAccepts, parseNativeConfigIntent, sameNativeConfigIdentity } from '../../../shared/nativeSessionConfig';
import { t } from '../../../shared/i18n';
import { getDriver } from './base';
import { nativeConfigIdentity, nextNativeConfigRevision, publishNativeConfig } from './nativeConfigState';
import { ensureConnection } from './connection';
import type { HostCore } from './internal';
import { isOpen, materializeForExecution } from './lifecycle';

export async function describeNativeConfig(host: HostCore, target: Pick<SessionMeta, 'runtime' | 'piModeId' | 'cwd' | 'workspaceId' | 'sourceRoot'>, refresh = false): Promise<NativeConfigSnapshot> {
  const identity = nativeConfigIdentity(host, target);
  const driver = getDriver(host, identity.runtimeId);
  const state = driver?.describeNativeConfig && target.cwd
    ? await driver.describeNativeConfig({ cwd: target.cwd, piModeId: target.piModeId, refresh })
    : { status: 'uninitialized' as const, options: [] };
  if (!sameNativeConfigIdentity(identity, nativeConfigIdentity(host, target)) || driver !== getDriver(host, identity.runtimeId)) {
    throw new Error('Native configuration source changed. Refresh and try again.');
  }
  return { ...state, options: state.options.map(option => ({ ...option, currentValue: undefined })), identity,
    revision: nextNativeConfigRevision(), source: state.catalogSource ?? 'catalog' };
}

export async function validateNativeConfigIntent(host: HostCore, target: Parameters<typeof describeNativeConfig>[1], raw: unknown) {
  const intent = parseNativeConfigIntent(raw);
  if (!intent) return undefined;
  const catalog = await describeNativeConfig(host, target);
  const accepts = (snapshot: NativeConfigSnapshot) => snapshot.status === 'ready' && sameNativeConfigIdentity(snapshot.identity, intent.identity) &&
      intent.selections.every(selection => {
        const option = snapshot.options.find(option => option.id === selection.id);
        return !!option && option.changePolicy !== 'read-only' && nativeOptionAccepts(option, selection.value);
      });
  const hasLiveDirectory = catalog.status === 'uninitialized' && [...host.entries.values()].some(entry =>
    entry.connection && entry.nativeConfig && accepts(entry.nativeConfig));
  if (!sameNativeConfigIdentity(catalog.identity, intent.identity) || (!accepts(catalog) && !hasLiveDirectory)) {
    throw new Error('Native settings changed. Refresh the engine settings and choose again.');
  }
  return intent;
}

export async function captureWorkerPermission(host: HostCore, target: Parameters<typeof describeNativeConfig>[1], raw: unknown): Promise<string> {
  const intent = parseNativeConfigIntent(raw);
  const identity = nativeConfigIdentity(host, target);
  const driver = getDriver(host, identity.runtimeId);
  if (!intent || !identity.version || !sameNativeConfigIdentity(intent.identity, identity) || !driver?.captureWorkerPermission || !target.cwd) {
    throw new Error('This Harness or source cannot confirm native permissions for Worker handoff. Refresh its settings.');
  }
  const snapshot = await driver.captureWorkerPermission({ cwd: target.cwd, nativeConfig: intent });
  if (!sameNativeConfigIdentity(identity, nativeConfigIdentity(host, target)) || driver !== getDriver(host, identity.runtimeId)) {
    throw new Error('Native permission source changed. Refresh and choose again.');
  }
  return snapshot;
}

export function getNativeConfig(host: HostCore, sessionId: string): NativeConfigSnapshot | null {
  const session = host.ctx.sessions.get(sessionId);
  if (!session || session.runtime === 'pi' || !isOpen(host, sessionId)) return null;
  const identity = nativeConfigIdentity(host, session);
  const entry = host.entries.get(sessionId);
  if (entry?.nativeConfig && (entry.connection || entry.nativeConfig.status === 'uninitialized') &&
      sameNativeConfigIdentity(entry.nativeConfig.identity, identity)) return entry.nativeConfig;
  return { identity, revision: nextNativeConfigRevision(), source: 'session', status: 'uninitialized', options: [] };
}

export async function refreshNativeConfig(host: HostCore, sessionId: string): Promise<NativeConfigSnapshot | null> {
  const initial = getNativeConfig(host, sessionId);
  if (!initial) return null;
  try {
    const entry = materializeForExecution(host, sessionId);
    if (entry.busy || entry.nativeConfigPending) return getNativeConfig(host, sessionId);
    const conn = entry.connection ?? await ensureConnection(host, entry);
    const state = conn.refreshNativeConfig ? await conn.refreshNativeConfig() : conn.getNativeConfig?.();
    if (state && entry.connection === conn) publishNativeConfig(host, entry, state);
    return getNativeConfig(host, sessionId);
  } catch (error) {
    return { ...initial, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setNativeConfig(host: HostCore, sessionId: string, change: NativeConfigChange) {
  const stale = { ok: false, error: t('会话或引擎设置已变更，请刷新后重试') };
  const entry = host.entries.get(sessionId);
  const snapshot = getNativeConfig(host, sessionId);
  const session = host.ctx.sessions.peek(sessionId);
  if (session?.configurePermissions !== true || session.archived || !entry || !snapshot || !change?.identity || !sameNativeConfigIdentity(snapshot.identity, change.identity) ||
      snapshot.revision !== change.revision || snapshot.status !== 'ready' || entry.nativeConfigPending || entry.permissionStrategySwitch) return stale;
  const conn = entry.connection;
  const option = snapshot.options.find(item => item.id === change.id);
  if (!conn?.setNativeConfig || !option || !nativeOptionAccepts(option, change.value) ||
      option.changePolicy === 'read-only' || option.changePolicy === 'launch-only') return stale;
  if ((entry.busy && option.changePolicy !== 'live') || entry.connecting || entry.clearing || entry.closed) return stale;
  const restore = session.nativePermissionRestore;
  const restorePending = restore && sameNativeConfigIdentity({ ...restore.identity, version: snapshot.identity.version }, snapshot.identity)
    ? restore.selections.find(item => item.id === change.id) : undefined;
  if (!restorePending && option.currentValue === change.value && !snapshot.requested?.some(item => item.id === change.id)) return { ok: true, snapshot };
  entry.nativeConfigPending = true;
  try {
    if (option.currentValue !== change.value || snapshot.requested?.some(item => item.id === change.id)) {
      await conn.setNativeConfig(change.id, change.value);
    }
    if (host.ctx.sessions.peek(sessionId) !== session || session.archived || session.configurePermissions !== true ||
        host.entries.get(sessionId) !== entry || entry.closed || entry.clearing || entry.connection !== conn) return stale;
    const state = conn.getNativeConfig?.();
    const requested = (entry.nativeConfig?.requested ?? []).filter(item => item.id !== change.id);
    requested.push({ id: change.id, value: change.value });
    const confirmed = state?.options.find(item => item.id === change.id)?.currentValue === change.value;
    if (restore && restorePending) {
      const selections = confirmed ? restore.selections.filter(item => item.id !== change.id)
        : restore.selections.map(item => item.id === change.id ? { ...item, value: change.value } : item);
      await host.ctx.sessions.updateNativePermissionRestore(sessionId, selections.length ? { ...restore, selections } : undefined, () => {
        if (host.ctx.sessions.peek(sessionId) !== session || session.nativePermissionRestore !== restore || entry.connection !== conn || entry.closed) {
          throw new Error('Permission configuration changed while applying a native setting.');
        }
      });
    }
    if (state) publishNativeConfig(host, entry, state, requested);
    const observed = getNativeConfig(host, sessionId);
    if (!observed || !sameNativeConfigIdentity(observed.identity, change.identity)) return stale;
    return { ok: true, snapshot: observed, ...(observed.options.find(item => item.id === change.id)?.currentValue === change.value
      ? {} : { pending: true as const }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    entry.nativeConfigPending = false;
  }
}
