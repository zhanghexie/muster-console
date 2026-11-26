import type { SessionMeta } from '../../../shared/types';
import type { NativeConfigIdentity, NativeConfigSnapshot, NativeConfigState } from '../../../shared/nativeSessionConfig';
import { sameNativeConfigIdentity } from '../../../shared/nativeSessionConfig';
import { getDriver, push } from './base';
import type { HostCore, SessionEntry } from './internal';

let revision = 0;
export function nextNativeConfigRevision(): number { return ++revision; }

export function nativeConfigIdentity(host: HostCore, session: Pick<SessionMeta, 'runtime' | 'piModeId' | 'cwd' | 'workspaceId' | 'sourceRoot'>): NativeConfigIdentity {
  const runtimeId = session.runtime ?? '';
  return {
    runtimeId,
    ...(runtimeId === 'acp' && session.piModeId ? { presetId: session.piModeId } : {}),
    sourceKey: JSON.stringify([session.workspaceId ?? '', session.sourceRoot?.rootId ?? '', session.sourceRoot?.cwd ?? session.cwd ?? '']),
    version: getDriver(host, runtimeId)?.nativeConfigVersion?.(session.piModeId) ?? getDriver(host, runtimeId)?.connectionVersion
  };
}

export function publishNativeConfig(host: HostCore, entry: SessionEntry, state: NativeConfigState, requested = entry.nativeConfig?.requested): void {
  const session = host.ctx.sessions.get(entry.sessionId);
  if (!session || entry.runtimeId === 'pi' || host.entries.get(entry.sessionId) !== entry || entry.closed) return;
  const identity = entry.nativeConfigIdentity ?? nativeConfigIdentity(host, session);
  if (!sameNativeConfigIdentity(identity, nativeConfigIdentity(host, session))) return;
  const previous = entry.nativeConfig;
  const pending = state.status === 'ready' ? requested?.filter(selection =>
    state.options.some(option => option.id === selection.id && option.currentValue !== selection.value)) : undefined;
  const request = pending?.length ? pending : undefined;
  if (previous && sameNativeConfigIdentity(previous.identity, identity) &&
      JSON.stringify([previous.status, previous.options, previous.error, previous.requested]) === JSON.stringify([state.status, state.options, state.error, request])) return;
  const snapshot: NativeConfigSnapshot = { status: state.status, options: state.options, error: state.error, identity,
    revision: nextNativeConfigRevision(), source: state.catalogSource ?? 'session', requested: request };
  entry.nativeConfig = snapshot;
  push(host, { kind: 'native-config', sessionId: entry.sessionId, snapshot });
}
