import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Windows may briefly deny replacing an open JSON (scanner/indexer/read handle).
 * Retry metadata only, asynchronously; never unlink the previous valid record. */
export async function writeRecord(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.promises.rename(temp, target); break; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }
  } finally { await fs.promises.unlink(temp).catch(() => {}); }
}
