import type { AppConfig, SessionMeta } from '../../shared/types';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { captureWorkspaceExecutionContext } from '../workspaceExecutionContext';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { withHandoverReadAccess } from '../handover/paths';
import { withSessionCaptureReadAccess } from '../desktop/sessionCaptureAccess';

type Config = { get(): Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'> };
export interface CliWorkspaceContext {
  readonly workspaceContext?: WorkspaceExecutionContext;
  readonly directoryNote: string;
  /** Same module instance as the actual process launch; hot updates apply next launch. */
  readonly receiveMessage?: import('../runtime/types').RuntimeModule['receiveMessage'];
  readonly interruptInput?: string;
  readonly prepareInterrupt?: import('../runtime/types').RuntimeModule['prepareInterrupt'];
  readonly deliveryCapabilities?: import('../agentSession/delivery').DeliveryCapabilities;
}
const live = new WeakMap<object, Map<string, CliWorkspaceContext>>();

export function getCliWorkspaceContext(config: Config, sessionId: string): CliWorkspaceContext | undefined {
  return live.get(config)?.get(sessionId);
}

/** A lease belongs to one actual PTY process, including its asynchronous disposal. */
export function beginCliWorkspaceContext(config: Config, session: SessionMeta, registeredSessions: readonly SessionMeta[] = [], userData?: string): {
  workspaceContext?: WorkspaceExecutionContext;
  commit(note: string, receiveMessage?: import('../runtime/types').RuntimeModule['receiveMessage'], interruptInput?: string,
    prepareInterrupt?: import('../runtime/types').RuntimeModule['prepareInterrupt'], deliveryCapabilities?: import('../agentSession/delivery').DeliveryCapabilities): void;
  own(dispose?: () => void): void;
  dispose(): void;
  finishLaunch(): void;
} {
  const captured = captureWorkspaceExecutionContext(config.get(), session, registeredSessions);
  const context = userData ? withSessionCaptureReadAccess(withHandoverReadAccess(captured, userData, session.id), userData, session.id) : captured;
  const releases = context?.roots.map(root => workspaceRootUsesFor(config).acquire({
    workspaceId: context.workspaceId, rootId: root.rootId, kind: 'session',
    id: session.id, sessionId: session.id, label: session.name
  })) ?? [];
  let committed = false;
  let disposed = false;
  let record: CliWorkspaceContext | undefined;
  const cleanups: Array<() => void> = [];
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    let failure: unknown;
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch (error) { failure ??= error; }
    }
    for (const end of releases.splice(0)) end();
    const records = live.get(config);
    if (record && records?.get(session.id) === record) records.delete(session.id);
    if (failure) throw failure;
  };
  return {
    workspaceContext: context, dispose,
    own(cleanup) { if (cleanup) { if (disposed) cleanup(); else cleanups.push(cleanup); } },
    commit(note, receiveMessage, interruptInput, prepareInterrupt, deliveryCapabilities): void {
      if (disposed) return;
      committed = true;
      record = Object.freeze({ ...(context ? { workspaceContext: context } : {}), directoryNote: note,
        ...(receiveMessage ? { receiveMessage } : {}), ...(interruptInput ? { interruptInput } : {}),
        ...(prepareInterrupt ? { prepareInterrupt } : {}), ...(deliveryCapabilities ? { deliveryCapabilities } : {}) });
      const records = live.get(config) ?? new Map<string, CliWorkspaceContext>();
      records.set(session.id, record); live.set(config, records);
    },
    finishLaunch(): void { if (!committed) dispose(); }
  };
}
