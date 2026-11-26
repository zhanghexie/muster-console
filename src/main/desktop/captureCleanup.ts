import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sourcePathKey } from '../workspacePaths';
import { DesktopCaptureArtifacts } from './captureArtifacts';

/** Sweep known session directories. Never traverse links or erase unrecognized data. */
export async function sweepSessionCaptures(userData: string,
  decode: (png: Buffer) => Promise<{ width: number; height: number }>, now: () => number = Date.now
): Promise<{ removed: number; errors: string[] }> {
  if (!path.isAbsolute(userData)) throw new Error('Capture cleanup requires an absolute user data directory');
  const root = userDataStorage(userData).resolve('app', 'desktop-captures');
  let rootInfo;
  try { rootInfo = await fs.lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, errors: [] }; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || sourcePathKey(await fs.realpath(root)) !==
      sourcePathKey(userDataStorage(await fs.realpath(userData)).resolve('app', 'desktop-captures'))) throw new Error('Capture root is not a managed directory');
  const errors: string[] = [];
  let removed = 0;
  for (const name of await fs.readdir(root)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink() || sourcePathKey(path.dirname(await fs.realpath(dir))) !== sourcePathKey(await fs.realpath(root))) {
        throw new Error('Capture session directory is not managed');
      }
      const result = await new DesktopCaptureArtifacts(dir, decode, now).cleanupExpired();
      removed += result.removed;
      errors.push(...result.errors.map(error => `${name}: ${error}`));
    } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { removed, errors };
}

/** Startup and periodic cleanup without overlapping sweeps; the caller owns lifecycle and logging. */
export function startCaptureCleanup(sweep: () => Promise<{ removed: number; errors: string[] }>,
  report: (error: string) => void, intervalMs = 60 * 60 * 1000): { ready: Promise<void>; stop(): Promise<void> } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || typeof sweep !== 'function' || typeof report !== 'function') {
    throw new Error('Invalid capture cleanup configuration');
  }
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const run = async (): Promise<void> => {
    try {
      const result = await sweep();
      for (const error of result.errors) report(error);
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    if (!stopped) {
      timer = setTimeout(() => { running = run(); }, intervalMs);
      timer.unref?.();
    }
  };
  running = run();
  return { ready: running, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}

/** A cancelled quit leaves the application running and must not stop future cleanup. */
export function stopCaptureCleanupOnQuit(app: {
  on(event: 'before-quit', listener: (event: { defaultPrevented: boolean }) => void): unknown;
  removeListener(event: 'before-quit', listener: (event: { defaultPrevented: boolean }) => void): unknown;
}, cleanup: { stop(): Promise<void> }, report: (error: unknown) => void): void {
  const listener = (event: { defaultPrevented: boolean }): void => {
    if (event.defaultPrevented) return;
    app.removeListener('before-quit', listener);
    void cleanup.stop().catch(report);
  };
  app.on('before-quit', listener);
}
