import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function nativeHistoryPath(value: string): string {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); }
  catch { /* Archived worktrees and fresh profiles may be absent. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function nativeHistoryScope(provider: string, parts: readonly unknown[]): string {
  return provider + ':' + createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
