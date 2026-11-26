import fs from 'node:fs';
import { createHash } from 'node:crypto';

const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

// Internal helper: production calls this only with a catalog asset. An injected
// fetch implementation is useful for offline tests and cannot change the pin.
export async function downloadPinned(asset, target, fetchImpl = globalThis.fetch, timeoutMs = 300_000) {
  if (typeof fetchImpl !== 'function') throw new Error('Node.js fetch is unavailable; use a supported Node.js runtime or --archive');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) throw new Error('Invalid download timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    let url = new URL(asset.url);
    for (let count = 0; ; count++) {
      if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('Driver download redirected to an untrusted origin');
      }
      response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Muster-Desktop-Driver-Prep' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (count >= 5) throw new Error('Too many driver download redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Driver download redirect has no location');
      await response.body?.cancel();
      url = new URL(location, url);
    }
    if (response.status !== 200 || !response.body) throw new Error(`Driver download failed with HTTP ${response.status}`);
    const header = response.headers.get('content-length');
    if (header !== null && (!/^\d+$/.test(header) || Number(header) !== asset.size)) throw new Error('Driver download length does not match the pinned release');
    const hash = createHash('sha256');
    let size = 0;
    const output = fs.openSync(target, 'wx', 0o600);
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > asset.size) throw new Error('Driver download exceeds the pinned length');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(output, chunk, offset, chunk.length - offset);
      }
    } finally { fs.closeSync(output); }
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Driver download does not match the pinned SHA-256');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Driver download timed out', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    try { await response?.body?.cancel(); } catch { /* A consumed body is already closed. */ }
  }
}
