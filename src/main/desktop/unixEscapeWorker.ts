import { openMacEscapeNative } from './unixEscapeNativeMac';
import { openX11EscapeNative } from './unixEscapeNativeX11';
import type { UnixEscapeNative, X11EscapePeer } from './unixEscapeTypes';

type WorkerMessage = { kind: 'ready'; peer?: Readonly<X11EscapePeer> } | { kind: 'heartbeat' | 'escape' } | { kind: 'failure'; reason: string };

/** Polling stays inside the helper; other keyboard events never cross its IPC boundary. */
export function createUnixEscapeWorker(native: UnixEscapeNative, send: (message: WorkerMessage) => void) {
  let closed = false, signalled = false;
  return {
    tick(): void {
      if (closed) throw new Error('Unix Escape worker is closed');
      if (native.poll() && !signalled) { signalled = true; send({ kind: 'escape' }); }
      send({ kind: 'heartbeat' });
    },
    close(): void { if (!closed) { closed = true; native.close(); } }
  };
}

if (process.env.MUSTER_UNIX_ESCAPE_WORKER === '1' && typeof process.send === 'function') {
  let worker: ReturnType<typeof createUnixEscapeWorker> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, failed = false, heartbeatPending = false;
  const send = (message: WorkerMessage): void => {
    if (!process.connected || !process.send) throw new Error('Escape worker IPC disconnected');
    if (message.kind === 'heartbeat' && heartbeatPending) return;
    if (message.kind === 'heartbeat') heartbeatPending = true;
    try { process.send(message, error => {
      if (message.kind === 'heartbeat') heartbeatPending = false;
      if (error) process.exit(1);
    }); } catch (error) { heartbeatPending = false; throw error; }
  };
  // Keep the child alive after a reported failure until the owner reclaims its
  // process group; exiting first would make safe group reclamation ambiguous.
  process.once('disconnect', () => { try { worker?.close(); } finally { process.exit(0); } });
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    if (timer) clearInterval(timer);
    let reason = error instanceof Error ? error.message : String(error);
    try { worker?.close(); }
    catch (cleanup) { reason += `; listener cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`; }
    if (process.connected && process.send) process.send({ kind: 'failure', reason: reason.slice(0, 500) }, sendError => { if (sendError) process.exit(1); });
    else process.exit(1);
  };
  try {
    const native = process.platform === 'darwin' ? openMacEscapeNative() : process.platform === 'linux' ? openX11EscapeNative()
      : (() => { throw new Error('This platform has no Unix Escape listener'); })();
    worker = createUnixEscapeWorker(native, send);
    send({ kind: 'ready', ...(native.peer ? { peer: native.peer } : {}) });
    timer = setInterval(() => {
      try { worker!.tick(); }
      catch (error) { fail(error); }
    }, 75);
  } catch (error) { fail(error); }
}
