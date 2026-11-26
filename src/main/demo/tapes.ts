import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DemoEvent { type: number; timestamp: number; data: unknown }
interface TapeInfo { format: 1; id: string; started: string; width: number; height: number }
export function startTape(dir: string, width: number, height: number) {
  const start = new Date();
  const id = start.toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const info: TapeInfo = { format: 1, id, started: start.toISOString(), width, height };
  const fd = fs.openSync(path.join(dir, id + '.jsonl'), 'wx', 0o600);
  let ready = false, closed = false;
  return {
    id,
    append(events: DemoEvent[]) {
      if (closed || !Array.isArray(events) || events.some(e => !Number.isInteger(e?.type) || !Number.isFinite(e.timestamp))) {
        throw new Error('无效回放数据。');
      }
      if (!events.length) return;
      fs.writeFileSync(fd, events.map(event => JSON.stringify(event) + '\n').join(''));
      // A killed builder can leave a file with only metadata. Never offer that take as playable.
      if (!ready && events.some(e => e.type === 2)) {
        const dest = path.join(dir, id + '.json');
        fs.writeFileSync(dest + '.tmp', JSON.stringify(info), { flag: 'wx', mode: 0o600 });
        fs.renameSync(dest + '.tmp', dest);
        ready = true;
      }
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } }
  };
}

export function listTapes(dir: string): TapeInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{8}T\d{9}Z-[a-f0-9]{8}\.json$/.test(f)).sort().reverse().map(f => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TapeInfo;
    if (meta.format !== 1 || meta.id + '.json' !== f) throw new Error('不支持的回放清单：' + f);
    return meta;
  });
}

export async function* readTape(dir: string, id: string) {
  const stream = fs.createReadStream(path.join(dir, id + '.jsonl'), { encoding: 'utf8' });
  let rest = '';
  try {
    for await (const chunk of stream) {
      rest += chunk;
      const end = rest.lastIndexOf('\n');
      if (end < 0) continue;
      yield rest.slice(0, end).split('\n').map(line => JSON.parse(line) as DemoEvent);
      rest = rest.slice(end + 1);
    }
    // Only the unfinished final line can be lost if the process was interrupted.
  } finally { stream.destroy(); }
}
