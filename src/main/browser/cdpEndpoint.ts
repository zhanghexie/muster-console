import http from 'node:http';
import fs from 'node:fs';

const MAX_TARGET_LIST_BYTES = 1024 * 1024;

/** Chromium writes the actual port after binding; a stale file is not trusted. */
export function readDevToolsActivePort(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').split('\n', 1)[0].trim();
    const port = Number(raw);
    return /^\d+$/.test(raw) && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch { return null; }
}

export class CdpEndpointUnavailableError extends Error {
  constructor(public readonly port: number) {
    super(`CDP endpoint ${port} is unavailable or not owned by this app`);
    this.name = 'CdpEndpointUnavailableError';
  }
}

/** A listening port may belong to another app. Match our native window target. */
export function cdpEndpointHasTarget(port: number, targetId: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => { req?.destroy(); finish(false); }, timeoutMs);
    try {
      req = http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          finish(false);
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_TARGET_LIST_BYTES) {
            res.destroy();
            req?.destroy();
            finish(false);
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const targets: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(Array.isArray(targets) && targets.some((target: unknown) =>
              !!target && typeof target === 'object' && (target as { id?: unknown }).id === targetId));
          } catch { finish(false); }
        });
        res.on('error', () => finish(false));
        res.on('aborted', () => finish(false));
      });
      req.on('error', () => finish(false));
    } catch { finish(false); }
  });
}

/** Wait for Chromium startup without accepting an unrelated process on the port. */
export async function waitForOwnedCdpEndpoint(
  port: number | (() => number | null),
  getOwnerTargetId: () => string | null,
  options: { attempts?: number; intervalMs?: number; timeoutMs?: number } = {}
): Promise<number> {
  const attempts = options.attempts ?? 12;
  const intervalMs = options.intervalMs ?? 400;
  const timeoutMs = options.timeoutMs ?? 500;
  const owner = (): string | null => {
    try { return getOwnerTargetId() || null; } catch { return null; }
  };
  const candidatePort = (): number | null => {
    try {
      const value = typeof port === 'number' ? port : port();
      return value !== null && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
    } catch { return null; }
  };
  let lastPort = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = candidatePort();
    if (candidate !== null) lastPort = candidate;
    const targetId = owner();
    if (candidate !== null && targetId && await cdpEndpointHasTarget(candidate, targetId, timeoutMs)
      && owner() === targetId && candidatePort() === candidate) return candidate;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new CdpEndpointUnavailableError(lastPort);
}
