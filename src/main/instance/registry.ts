import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INSTANCES_DIR_NAME,
  pruneDeadInstances,
  type AppInstanceInfo
} from '../../shared/appInstance';

function dir(): string {
  return path.join(os.tmpdir(), INSTANCES_DIR_NAME);
}

function fileFor(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return path.join(dir(), `${safe}.json`);
}

export function writeInstanceHeartbeat(info: AppInstanceInfo): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileFor(info.id), JSON.stringify(info, null, 2), 'utf8');
  } catch (e) {
    console.error('[instance] heartbeat write failed', e);
  }
}

export function removeInstanceHeartbeat(id: string): void {
  try {
    fs.unlinkSync(fileFor(id));
  } catch {
    /* already gone */
  }
}

export function listAppInstances(): AppInstanceInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return [];
  }
  const out: AppInstanceInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')) as AppInstanceInfo;
      if (raw && typeof raw.id === 'string' && typeof raw.pid === 'number') out.push(raw);
    } catch {
      /* skip */
    }
  }
  const live = pruneDeadInstances(out);
  for (const dead of out.filter((x) => !live.some((l) => l.id === x.id))) {
    removeInstanceHeartbeat(dead.id);
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}
