import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import * as acpAgents from './agents';

type Launch = { command: string; args: string[]; executable?: string };
const STORAGE_UNCONFIRMED = 'DeepSeek 模型探测未确认临时存储，请检查 DSH 版本与自定义配置后重试';

export interface DshModelDiscovery {
  readonly directory: string;
  readonly launch: Launch;
  verify(stderr: Readable): Promise<void>;
  /** Never delete storage while a failed process owner may still be using it. */
  dispose(reclaimed: boolean): void;
}

/**
 * Keep DSH's real profile, credentials and model providers. Its CLI overlay
 * redirects only discovery session logs and projection storage to a fresh tree.
 * DSH ignores unmatched overlay rows, so a tiny injected plugin must prove the
 * actual backend roots before the host may send session/new. No prompt is sent.
 */
export function createDshModelDiscovery(launch: Launch, rawArgs: string[], platform: NodeJS.Platform = process.platform): DshModelDiscovery {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-dsh-models-'));
  const sessions = path.join(directory, 'sessions');
  const storage = path.join(directory, 'storage');
  const marker = `muster-dsh-model-storage:${randomUUID()}`;
  const plugin = path.join(directory, 'storage-proof.mjs');
  const overlay = path.join(directory, 'discovery.patch.json');
  let command: Launch;
  try {
    // This is a configuration plugin, not model context. It contains no keys or
    // user config. Requiring the named backend service prevents a startup race.
    fs.writeFileSync(plugin, `import { resolve } from 'node:path';
export const inject = ['sessionPersistence', 'storage', 'storage.backend.json'];
export function apply(ctx) {
  try {
    if (resolve(ctx.sessionPersistence.root) !== ${JSON.stringify(sessions)} ||
        resolve(ctx.storage.backend.get('json').root) !== ${JSON.stringify(storage)}) throw Error('storage mismatch');
    process.stderr.write(${JSON.stringify(marker + ':ready\n')});
  } catch (error) {
    process.stderr.write(${JSON.stringify(marker + ':failed\n')});
    throw error;
  }
}
`, { mode: 0o600 });
    fs.writeFileSync(overlay, JSON.stringify([
      { id: 'session-persistence-jsonl', config: { root: sessions } },
      { id: 'storage-json', config: { root: storage } },
      { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
      { id: 'hmr', disabled: true },
      { insert: [{ id: 'muster-model-storage-proof', name: pathToFileURL(plugin).href }] }
    ]), { mode: 0o600 });
    // Rebuild argv from the executable and raw preset args. Appending to an
    // already wrapped Windows cmd /c string would drop or misquote the overlay.
    const wrapped = acpAgents.wrapCmdShimIfNeeded(launch.executable ?? launch.command, [...rawArgs, '--patch', overlay], platform);
    if ('error' in wrapped) throw new Error(wrapped.error);
    command = wrapped;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let detach: (() => void) | undefined;
  return {
    directory,
    launch: command,
    verify(stderr) {
      return new Promise<void>((resolve, reject) => {
        let tail = '', settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          stderr.off('data', data); stderr.off('end', end); stderr.off('error', end);
          if (ok) resolve(); else reject(new Error(STORAGE_UNCONFIRMED));
        };
        const data = (chunk: Buffer | string): void => {
          tail += chunk.toString();
          let newline: number;
          while ((newline = tail.indexOf('\n')) >= 0) {
            const line = tail.slice(0, newline).trim();
            tail = tail.slice(newline + 1);
            if (line === `${marker}:ready`) { finish(true); return; }
            if (line === `${marker}:failed`) { finish(false); return; }
          }
          tail = tail.slice(-4096);
        };
        const end = (): void => finish(false);
        stderr.on('data', data); stderr.once('end', end); stderr.once('error', end);
        detach = end;
      });
    },
    dispose(reclaimed) {
      detach?.();
      if (reclaimed) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  };
}
