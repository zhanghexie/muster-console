import { desktopRuntime } from './runtime';

/** A short-lived Node child isolates native ABI failures from the Electron main process. */
async function main(): Promise<void> {
  const limit = Number(process.argv[2]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000 || typeof process.send !== 'function') throw new Error('Invalid inventory request');
  const runtime = desktopRuntime(process.platform, process.env);
  const result = runtime === 'windows' ? (await import('./win32Inventory')).enumerateWin32Windows(limit)
    : runtime === 'macos' ? (await import('./macInventory')).enumerateMacWindows(limit)
    : runtime === 'linux-x11' ? await (await import('./x11Inventory')).enumerateLinuxX11Windows({ limit })
    : null;
  if (!result) throw new Error(`Desktop window inventory is unavailable for ${runtime}`);
  await new Promise<void>((resolve, reject) => process.send!({ ok: true, runtime, result }, error => error ? reject(error) : resolve()));
}

void main().then(() => { process.disconnect?.(); }).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send && process.connected) process.send({ ok: false, error: message.slice(0, 1000) }, () => { process.exitCode = 1; process.disconnect?.(); });
  else process.exitCode = 1;
});
