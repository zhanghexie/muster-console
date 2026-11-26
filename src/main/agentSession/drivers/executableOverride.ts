import fs from 'node:fs';
import path from 'node:path';

/** A configured path is authoritative: an invalid override never falls back to PATH. */
export function resolveExecutableOverride(value: string): string | null {
  const executable = value.trim();
  if (!executable || !path.isAbsolute(executable) || /[\u0000-\u001f\u007f]/.test(executable)) return null;
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable) && executable.includes('%')) return null;
  try {
    if (!fs.statSync(executable).isFile()) return null;
    if (process.platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch { return null; }
}
