import fs from 'node:fs';
import path from 'node:path';
/** Check existing ancestors as well as logical paths before any config contents are read. */
export function assertHarnessMcpPublicPath(destination: string): void {
  const check = (value: string): void => {
    if (value.split(/[\\/]/).some(part => part.toLowerCase() === '.muster')) throw new Error('Harness MCP configuration cannot target private host storage');
  };
  check(destination);
  let ancestor = destination;
  while (true) {
    try { check(fs.realpathSync.native(ancestor)); return; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      const parent = path.dirname(ancestor); if (parent === ancestor) return; ancestor = parent;
    }
  }
}
