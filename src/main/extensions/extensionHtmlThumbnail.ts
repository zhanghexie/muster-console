import { BrowserWindow, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MUSTER_EXPORT_SCHEME } from '../../shared/protocolSchemes';
import { resolveRealPathInsideRoot } from '../workspacePaths';
import { serveWorkspaceFile } from '../workspaceFsServe';

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_CACHE = 64;
const MAX_PENDING = 32;
export type HtmlThumbnail = { dataUrl: string };
type ThumbnailInput = { html: string; file?: string };

/** One bounded, host-owned renderer; no extension bridge or persistent browser state. */
export class ExtensionHtmlThumbnail {
  private readonly cache = new Map<string, { result: HtmlThumbnail; expires: number }>();
  private readonly pending = new Map<string, Promise<HtmlThumbnail>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly render = renderHtmlThumbnail) {}

  async html(owner: string, html: unknown, file?: string): Promise<HtmlThumbnail> {
    if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('HTML thumbnail requires nonempty HTML of at most 8 MiB');
    const key = createHash('sha256').update(JSON.stringify([owner, html, file])).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return cached.result; }
    this.cache.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= MAX_PENDING) throw new Error('HTML thumbnail queue is full; retry later');
    const work = this.tail.catch(() => {}).then(async () => {
      const result = await this.render({ html, file });
      // Local CSS/images may change independently from the HTML source.
      this.cache.set(key, { result, expires: Date.now() + 30_000 });
      while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      return result;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, work); this.tail = work;
    return work;
  }

  async file(owner: string, file: string): Promise<HtmlThumbnail> {
    if (!/\.html?$/i.test(file)) throw new Error('Only HTML files can have a page thumbnail');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_HTML_BYTES) throw new Error('HTML thumbnail source is unavailable or exceeds 8 MiB');
    return this.html(owner, await fs.readFile(file, 'utf8'), file);
  }
}

async function renderHtmlThumbnail(input: ThumbnailInput): Promise<HtmlThumbnail> {
  const isolated = session.fromPartition(`thumbnail-${randomUUID()}`, { cache: false });
  const origin = `${MUSTER_EXPORT_SCHEME}://${randomUUID()}`;
  const name = input.file ? path.basename(input.file) : 'index.html';
  const url = `${origin}/${encodeURIComponent(name)}`;
  // Offline rendering prevents arbitrary HTML from contacting local services or leaking files.
  isolated.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !details.url.startsWith(`${origin}/`) && !/^(data:|blob:)/.test(details.url) });
  });
  isolated.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.protocol.handle(MUSTER_EXPORT_SCHEME, async request => {
    try {
      const requested = new URL(request.url);
      if (requested.origin !== new URL(origin).origin || requested.hostname !== new URL(origin).hostname || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
      const relative = decodeURIComponent(requested.pathname.slice(1));
      const headers = { 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'self'" };
      if (relative === name) return new Response(request.method === 'HEAD' ? null : input.html, { headers });
      if (!input.file) return new Response(null, { status: 404 });
      const file = await resolveRealPathInsideRoot(path.dirname(input.file), relative);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return new Response(null, { status: 413 });
      return serveWorkspaceFile(file, request);
    } catch { return new Response(null, { status: 404 }); }
  });
  const win = new BrowserWindow({ show: false, skipTaskbar: true, width: 1200, height: 750, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await win.loadURL(url);
        await win.webContents.executeJavaScript(`Promise.race([Promise.all([document.fonts.ready, ...Array.from(document.images, i => i.complete ? Promise.resolve() : new Promise(r => { i.onload=r; i.onerror=r; }))]), new Promise(r => setTimeout(r, 1200))]).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
        const image = await win.webContents.capturePage();
        if (image.isEmpty()) throw new Error('HTML thumbnail capture is empty');
        return { dataUrl: image.resize({ width: 480, height: 300 }).toDataURL() };
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('HTML thumbnail timed out after 8 seconds')), 8000); })
    ]);
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
    isolated.protocol.unhandle(MUSTER_EXPORT_SCHEME);
    isolated.webRequest.onBeforeRequest(null);
    await isolated.clearStorageData().catch(() => {});
  }
}
