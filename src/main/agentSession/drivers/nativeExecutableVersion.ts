import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** A directory is reusable only for the same executable and adapter contract. */
export function nativeExecutableVersion(executable: string | null | undefined, contract: string): string {
  let identity: unknown = executable ?? '';
  if (executable) {
    try {
      const resolved = fs.realpathSync.native(executable);
      const stat = fs.statSync(resolved);
      identity = [resolved, stat.size, stat.mtimeMs];
    } catch { /* A missing program still invalidates a previously available directory. */ }
  }
  return createHash('sha256').update(JSON.stringify([contract, identity])).digest('hex');
}
