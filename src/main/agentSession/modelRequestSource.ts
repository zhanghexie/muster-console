import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { sourceText } from '../agent/coreContext';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { readCompressionTrace } from './modelRequestStore';
import { COMPRESSION_SOURCE_PAGE } from '../../shared/modelRequest';

/** Only sources attributed to this recorded call are addressable by the renderer. */
export async function readModelRequestSource(root: string, session: string, call: number, source: string, offset: number) {
  const trace = readCompressionTrace(root, session, call);
  if (!trace?.file || !trace.items.some(item => item.sources.some(s => s.id === source))) return null;
  const directory = userDataStorage(root).resolve('app', 'pi-native-sessions');
  const file = await fs.promises.realpath(path.resolve(directory, trace.file));
  const rel = path.relative(await fs.promises.realpath(directory), file);
  if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !file.endsWith('.jsonl')) return null;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let header = true;
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (header) {
        if (entry.type !== 'session' || entry.id !== trace.nativeId) return null;
        header = false;
      } else if (entry.id === source) {
        const text = sourceText(entry as SessionEntry);
        if (text === undefined || offset > text.length) return null;
        const end = Math.min(offset + COMPRESSION_SOURCE_PAGE, text.length);
        return { text: text.slice(offset, end), next: end < text.length ? end : null };
      }
    }
    return null;
  } finally { lines.close(); stream.destroy(); }
}
