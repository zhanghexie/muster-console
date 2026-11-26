import { openX11OwnerNative, type X11OwnerNative, type X11OwnerObservation } from './x11OwnerNative';

type WorkerMessage = { id: number; op: 'probe'; nativeHandle: string };
type WorkerOutput = { kind: 'ready' } | { kind: 'result'; id: number; ok: true; observation: X11OwnerObservation } |
  { kind: 'result'; id: number; ok: false; error: string } | { kind: 'invalidated'; nativeHandle: string } | { kind: 'failure'; error: string };

/** The worker owns one XCB connection; native calls never run on Electron's main thread. */
export function createX11OwnerWorker(native: X11OwnerNative, send: (value: WorkerOutput) => void, intervalMs = 250) {
  if (!native || typeof native.probe !== 'function' || typeof native.destroyed !== 'function' || typeof native.close !== 'function' ||
      typeof send !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 5000) throw new Error('Invalid X11 owner worker');
  const watches = new Map<string, X11OwnerObservation>();
  let closed = false, scan = 0;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const invalidate = (id: string): void => { if (watches.delete(id)) send({ kind: 'invalidated', nativeHandle: id }); };
  const drain = (): void => { for (const id of native.destroyed()) invalidate(id); };
  const matches = (a: X11OwnerObservation, b: X11OwnerObservation): boolean =>
    (['nativeHandle', 'pid', 'processStart', 'workerPid', 'serverPid', 'serverStart', 'serverExecutable', 'namespace'] as const).every(key => a[key] === b[key]);
  const close = (): void => { if (closed) return; closed = true; clearInterval(timer); watches.clear(); native.close(); };
  const timer = setInterval(() => {
    if (closed) return;
    try {
      drain();
      const ids = [...watches.keys()];
      if (!ids.length) return;
      const id = ids[scan++ % ids.length]!;
      const prior = watches.get(id);
      try { if (prior && !matches(prior, native.probe(id))) invalidate(id); }
      catch { invalidate(id); }
      drain();
    } catch (error) { try { send({ kind: 'failure', error: describe(error) }); } finally { close(); } }
  }, intervalMs);
  timer.unref?.();
  return {
    receive(raw: unknown): void {
      if (closed) throw new Error('X11 owner worker is closed');
      const request = raw as Partial<WorkerMessage>;
      if (!request || !Number.isSafeInteger(request.id) || request.id! < 1 || request.op !== 'probe' ||
          typeof request.nativeHandle !== 'string' || !/^0x[0-9a-f]{1,8}$/i.test(request.nativeHandle) || Number.parseInt(request.nativeHandle.slice(2), 16) === 0) {
        throw new Error('Invalid X11 owner worker request');
      }
      const id = request.id!, nativeHandle = `0x${Number.parseInt(request.nativeHandle.slice(2), 16).toString(16)}`;
      try {
        drain();
        if (!watches.has(nativeHandle) && watches.size >= 128) throw new Error('X11 owner watch capacity reached');
        const observation = native.probe(nativeHandle), old = watches.get(nativeHandle);
        if (old && !matches(old, observation)) { invalidate(nativeHandle); throw new Error('X11 owner changed'); }
        watches.set(nativeHandle, observation);
        drain();
        if (!watches.has(nativeHandle)) throw new Error('X11 window was destroyed');
        send({ kind: 'result', id, ok: true, observation });
      } catch (error) {
        invalidate(nativeHandle);
        send({ kind: 'result', id, ok: false, error: describe(error) });
      }
    },
    close
  };
}

if (process.env.MUSTER_X11_OWNER_WORKER === '1' && typeof process.send === 'function') {
  let worker: ReturnType<typeof createX11OwnerWorker> | undefined;
  try {
    const native = openX11OwnerNative();
    const send = (value: WorkerOutput): void => {
      if (!process.connected || !process.send) throw new Error('X11 owner IPC is disconnected');
      process.send(value, error => { if (error) process.exit(1); });
    };
    worker = createX11OwnerWorker(native, send);
    process.on('message', value => { try { worker!.receive(value); } catch { worker!.close(); process.exit(1); } });
    process.once('disconnect', () => { worker!.close(); process.exit(0); });
    send({ kind: 'ready' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.connected && process.send) process.send({ kind: 'failure', error: message.slice(0, 500) }, () => process.exit(1));
    else process.exit(1);
  }
}
