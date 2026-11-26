import fs from 'node:fs';
import path from 'node:path';
import { desktopRuntime } from './runtime';
import { WaylandStopIndicator, waylandStopHelperPath } from './waylandStopIndicator';
import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';

interface Indicator {
  show(snapshot: DesktopIndicatorSnapshot): Promise<void>;
  close(): void;
  isCurrent?(): boolean;
  whenClosed?(): Promise<void>;
}

/** Resolve a host executable without invoking a shell or searching relative PATH entries. */
export function findWaylandPython(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = ['/usr/bin/python3', ...String(env.PATH ?? '').split(':')
    .filter(entry => path.posix.isAbsolute(entry)).map(entry => path.posix.join(entry, 'python3')), '/usr/local/bin/python3'];
  for (const candidate of new Set(candidates)) {
    try {
      const file = fs.realpathSync(candidate);
      if (!path.posix.isAbsolute(file) || !fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* Try the next host-owned search location. */ }
  }
  throw new Error('Python 3 is required for the Wayland Stop control; install Python 3, GObject, GTK 3 and GTK Layer Shell');
}

/** Choose a platform indicator; callers still own registration and runtime lifecycle. */
export function createPlatformIndicator(options: {
  mainDir: string; preloadPath: string; rendererPath: string; rendererUrl?: string;
  stop(): Promise<void>; unavailable(reason: string): void;
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  resolvePython?: (env: NodeJS.ProcessEnv) => string;
  createWindow: (stop: () => Promise<void>, unavailable: (reason: string) => void,
    preloadPath: string, rendererPath: string, rendererUrl?: string) => Indicator & { registerIpc(): void };
  createWayland?: (input: ConstructorParameters<typeof WaylandStopIndicator>[0]) => Indicator;
}): Indicator {
  if (!options || !path.isAbsolute(options.mainDir) || typeof options.stop !== 'function' || typeof options.unavailable !== 'function') {
    throw new Error('Desktop indicator host dependencies are required');
  }
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  const runtime = desktopRuntime(platform, env);
  if (runtime === 'linux-wayland') {
    const pythonPath = (options.resolvePython ?? findWaylandPython)(env);
    return (options.createWayland ?? (input => new WaylandStopIndicator(input)))({
      pythonPath, helperPath: waylandStopHelperPath(options.mainDir), stop: options.stop, unavailable: options.unavailable, platform, env
    });
  }
  if (runtime !== 'windows' && runtime !== 'macos' && runtime !== 'linux-x11') {
    throw new Error('Desktop indicator requires a supported graphical session; check the active desktop session');
  }
  if (!path.isAbsolute(options.preloadPath) || !path.isAbsolute(options.rendererPath) || typeof options.createWindow !== 'function') {
    throw new Error('Desktop indicator assets are unavailable');
  }
  const window = options.createWindow(options.stop, options.unavailable, options.preloadPath, options.rendererPath, options.rendererUrl);
  window.registerIpc();
  return window;
}
