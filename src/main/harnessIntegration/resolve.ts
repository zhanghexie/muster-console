import path from 'node:path';
import type { HarnessPath, HarnessPlatform } from '../../shared/harnessIntegration';
import { assertHarnessRelativePath } from '../../shared/harnessIntegration';
export interface HarnessPathContext {
  homeDir: string;
  workspaceDir?: string;
  configDir?: string;
  platform?: HarnessPlatform;
  env?: Record<string, string | undefined>;
}
export function getHarnessConfigDir(context: HarnessPathContext): string {
  if (context.configDir) return context.configDir;
  const platform = context.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const env = context.env ?? process.env;
  if (platform === 'win32') return env.APPDATA || paths.join(context.homeDir, 'AppData', 'Roaming');
  if (platform === 'darwin') return paths.join(context.homeDir, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || paths.join(context.homeDir, '.config');
}
export function resolveHarnessPath(declaration: HarnessPath, context: HarnessPathContext): string {
  const platform = context.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  assertHarnessRelativePath(declaration.path);
  for (const value of Object.values(declaration.platformPaths ?? {})) assertHarnessRelativePath(value);
  const override = declaration.homeOverride;
  const overrideValue = override && (context.env ?? process.env)[override.env]?.trim();
  if (override && overrideValue) {
    assertHarnessRelativePath(override.path);
    const overrideRoot = /^~[\\/]/.test(overrideValue) ? paths.join(context.homeDir, overrideValue.slice(2)) : overrideValue;
    if (!paths.isAbsolute(overrideRoot)) throw new Error(`${override.env} must be an absolute path`);
    return paths.join(overrideRoot, ...override.path.split(/[\\/]/));
  }
  const child = declaration.platformPaths?.[platform as HarnessPlatform] ?? declaration.path;
  const root = declaration.base === 'home' ? context.homeDir : declaration.base === 'config' ? getHarnessConfigDir(context) : context.workspaceDir;
  if (!root || !paths.isAbsolute(root)) throw new Error(`Harness integration root unavailable: ${declaration.base}`);
  return paths.join(root, ...child.split(/[\\/]/));
}
