import type { GuiRuntimeConnection } from '../types';
import type { HostCore, SessionEntry } from './internal';
import { publishNativeConfig } from './nativeConfigState';

type Retirement = { ok: true } | { ok: false; error: string };

export class ConnectionCleanupError extends Error {}

// Keep retirements at host scope so closing and immediately reopening the same
// session cannot bypass the old connection's cleanup.
const byHost = new WeakMap<HostCore, Map<string, Promise<Retirement>>>();
const auxiliaryByHost = new WeakMap<HostCore, Map<string, Promise<Retirement>>>();
const detachedTurns = new WeakMap<GuiRuntimeConnection, { entry: SessionEntry; turnId?: string }>();

function retire(host: HostCore, sessionId: string, close: () => void | Promise<void>, owners=byHost): Promise<Retirement> {
  let sessions = owners.get(host);
  if (!sessions) {
    sessions = new Map();
    owners.set(host, sessions);
  }
  const previous = sessions.get(sessionId);
  const current = Promise.resolve().then(close).then<Retirement, Retirement>(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  const combined = previous
    ? Promise.all([previous, current]).then(([first, second]) => first.ok ? second : first)
    : current;
  sessions.set(sessionId, combined);
  void combined.then((result) => {
    // Keep failures as a barrier: starting a new writer would hide an uncertain
    // process cleanup. Successful barriers can be discarded.
    if (result.ok && sessions?.get(sessionId) === combined) sessions.delete(sessionId);
  });
  return combined;
}

/** Auxiliary resources participate in the same host-scoped reopen barrier. */
export function retireSessionResource(host:HostCore,sessionId:string,cleanup:()=>Promise<void>):void {
  retire(host,sessionId,cleanup,auxiliaryByHost);
}

export function retireConnection(host: HostCore, entry: SessionEntry): GuiRuntimeConnection | null {
  const connection = entry.connection;
  if (!connection) return null;
  detachedTurns.set(connection, { entry, turnId: entry.activeExecutionTurnId });
  entry.connection = null;
  if (entry.nativeConfig) publishNativeConfig(host, entry, { status: 'uninitialized', options: [] });
  retire(host, entry.sessionId, () => connection.close());
  return connection;
}

/** A retired pump can settle only the turn that owned it when detached. */
export function detachedConnectionOwnsTurn(connection: GuiRuntimeConnection, entry: SessionEntry): boolean {
  const detached = detachedTurns.get(connection);
  return detached?.entry === entry && detached.turnId === entry.activeExecutionTurnId;
}

/** Initialization failed and the driver could not prove it reclaimed the process. */
export function markRetirementFailure(host: HostCore, sessionId: string, error: ConnectionCleanupError): void {
  retire(host, sessionId, () => { throw error; });
}

/** Register an in-flight connection before the old entry can be removed. */
export function retirePendingConnection(
  host: HostCore,
  entry: SessionEntry,
  connecting: Promise<GuiRuntimeConnection> | null,
  alreadyRetired: GuiRuntimeConnection | null,
  options: { abortBeforeClose?: boolean } = {}
): void {
  if (!connecting) return;
  retire(host, entry.sessionId, async () => {
    let late: GuiRuntimeConnection;
    try {
      late = await connecting;
    } catch (error) {
      if (error instanceof ConnectionCleanupError) throw error;
      // Failed initialization is responsible for its own cleanup.
      return;
    }
    if (late !== alreadyRetired) {
      if (options.abortBeforeClose) await late.abort();
      await late.close();
    }
  });
}

type ProjectionRetirement={pending:boolean;error?:string};
const projections=new WeakMap<HostCore,Map<string,ProjectionRetirement>>();

/** Writer release owns a materialization barrier for recovery failure and archive. */
export function retireSessionWriter(host:HostCore,sessionId:string,cleanup:()=>Promise<void>):void {
  trackMaterializationRetirement(host,sessionId,cleanup);
}
function trackMaterializationRetirement(host:HostCore,sessionId:string,cleanup:()=>Promise<void>):void {
  let map=projections.get(host);if(!map){map=new Map();projections.set(host,map);}
  const state:ProjectionRetirement={pending:true};map.set(sessionId,state);
  const completion=retire(host,sessionId,cleanup);
  void completion.then(result=>{
    if(map?.get(sessionId)!==state)return;
    if(result.ok)map.delete(sessionId);
    else{state.pending=false;state.error=result.error;}
  });
}
export function hasMaterializationRetirement(host:HostCore,sessionId:string):boolean{return projections.get(host)?.has(sessionId)??false;}
export function assertMaterializationReady(host:HostCore,sessionId:string):void {
  const state=projections.get(host)?.get(sessionId);
  if(!state&&auxiliaryByHost.get(host)?.has(sessionId))throw new ConnectionCleanupError('上次会话的资源仍在清理或清理失败，请检查诊断后重试');
  if(!state)return;
  throw new ConnectionCleanupError(state.pending
    ? '上次会话的资源仍在清理，请稍后重试'
    : `上次会话的资源清理失败，已停止重新恢复；请检查诊断并重启工作台：${state.error}`);
}

/** Capture this before creating a new connecting promise to avoid a self-wait. */
export async function connectionRetirementBarrier(host: HostCore, sessionId: string): Promise<void> {
  await waitRetirement(byHost.get(host)?.get(sessionId));
}
export async function retirementBarrier(host: HostCore, sessionId: string): Promise<void> {
  const results=await Promise.allSettled([connectionRetirementBarrier(host,sessionId),waitRetirement(auxiliaryByHost.get(host)?.get(sessionId))]);
  const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,errors.map(String).join('; '));
}
async function waitRetirement(pending:Promise<Retirement>|undefined):Promise<void> {
  if (!pending) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('等待旧引擎回收超时；请检查残留进程后重试')), 30_000);
        timeout.unref?.();
      })
    ]);
    if (!result.ok) throw new Error(`无法确认旧引擎连接已关闭，请检查残留进程并重启工作台：${result.error}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Includes entries removed by a previous close while connect was in flight. */
export async function drainRetirements(host: HostCore): Promise<void> {
  const results = await Promise.allSettled([...new Set([...(byHost.get(host)?.keys() ?? []),...(auxiliaryByHost.get(host)?.keys() ?? [])])]
    .map(id => retirementBarrier(host, id)));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'GUI connection retirement failed');
}
