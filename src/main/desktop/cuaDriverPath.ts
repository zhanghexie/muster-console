import fs from 'node:fs';
import path from 'node:path';

export interface CuaDriverLocation {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  /** Electron app.getAppPath() in development, supplied by the host. */
  appPath: string;
  /** Electron process.resourcesPath, supplied by the host. */
  resourcesPath: string;
}

export class CuaDriverUnavailableError extends Error {
  readonly code = 'dependency_missing';
}

/** Resolve only the build-owned driver location; tool arguments cannot choose a binary. */
export function resolveCuaDriverPath(location: CuaDriverLocation): string {
  if (!location || !['win32', 'darwin', 'linux'].includes(location.platform) || !['x64', 'arm64'].includes(location.arch)) {
    throw new Error('No pinned desktop driver is available for this operating system and architecture');
  }
  if (typeof location.isPackaged !== 'boolean' || typeof location.appPath !== 'string' || typeof location.resourcesPath !== 'string' ||
      !path.isAbsolute(location.appPath) || !path.isAbsolute(location.resourcesPath)) {
    throw new Error('Desktop driver host paths are invalid');
  }
  const platform = location.platform === 'win32' ? 'win' : location.platform === 'darwin' ? 'mac' : 'linux';
  const root = location.isPackaged
    ? path.join(location.resourcesPath, 'desktop-driver', 'contents', 'driver')
    : path.join(location.appPath, '.tmp', 'desktop-driver', `${platform}-${location.arch}`, 'contents', 'driver');
  const binary = path.join(root, location.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  const missing = location.isPackaged
    ? 'Desktop driver is missing or inaccessible; repair or reinstall the application.'
    : `Desktop driver is missing or inaccessible for ${location.platform}/${location.arch}; prepare it with scripts/desktop-driver/prepare.mjs (see scripts/desktop-driver/README.md).`;
  try {
    const directory = fs.lstatSync(root), file = fs.lstatSync(binary);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()) throw new Error(missing);
    const realRoot = fs.realpathSync(root), realBinary = fs.realpathSync(binary);
    const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!samePath(path.dirname(realBinary), realRoot)) throw new Error(missing);
    if (location.platform !== 'win32') fs.accessSync(realBinary, fs.constants.X_OK);
    return realBinary;
  } catch { throw new CuaDriverUnavailableError(missing); }
}
