import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Zip, ZipDeflate } from 'fflate';
import { visitModelRequests } from './modelRequestStore';
import type { ModelRequestExportManifest } from '../../shared/modelRequest';
import { t } from '../../shared/i18n';

/** Stream one body at a time to a sibling temp file; replace the chosen file only on success. */
export function writeModelRequestExport(root: string, sessionId: string, target: string, id?: number): { count: number; omitted: number } {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(fd!, chunk, offset, chunk.length - offset);
    });
    const add = (name: string, body: Uint8Array) => {
      const entry = new ZipDeflate(name, { level: 1 });
      zip.add(entry);
      entry.push(body, true);
    };
    const manifest: ModelRequestExportManifest = {
      format: 'muster-model-requests', version: 1, exportedAt: new Date().toISOString(), sessionId, requests: []
    };
    visitModelRequests(root, sessionId, id, (row, body, compression) => {
      const bodyFile = body === null ? null : 'requests/' + row.id + '.json';
      if (body !== null) add(bodyFile!, body);
      manifest.requests.push({ ...row, bodyFile, sha256: body === null ? null : createHash('sha256').update(body).digest('hex'), compression });
    });
    if (!manifest.requests.length) throw new Error(t('暂无模型请求记录'));
    add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    zip.end();
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    return { count: manifest.requests.length, omitted: manifest.requests.filter(row => row.omitted).length };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
