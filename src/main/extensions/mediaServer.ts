import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Opaque owned URLs, streaming and Range requests; no large IPC/base64 payloads. */
export class ExtensionMediaServer {
  private server: http.Server | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private files = new Map<string, { owner: string; path: string; contentType?: string }>();
  private responses = new Map<http.ServerResponse, string>();
  async register(owner: string, file: string, contentType?: string): Promise<string> {
    if (!fs.statSync(file).isFile()) throw new Error('媒体不是文件');
    await this.start();
    const token = randomUUID(); this.files.set(token, { owner, path: file, ...(contentType ? { contentType } : {}) });
    return `http://127.0.0.1:${this.port}/media/${token}`;
  }
  releaseAsset(owner: string, url: string): void {
    const token = url.split('/').pop() ?? '';
    const file = this.files.get(token);
    if (file?.owner === owner) this.files.delete(token);
  }
  release(owner: string): void {
    for (const [token, file] of this.files) if (file.owner === owner) this.files.delete(token);
    for (const [response, heldBy] of this.responses) if (heldBy === owner) { response.destroy(); this.responses.delete(response); }
  }
  stop(): void { this.files.clear(); this.server?.closeAllConnections(); this.server?.close(); this.server = null; this.port = 0; this.starting = null; }
  private async start(): Promise<void> {
    if (this.port) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        const file = this.files.get((request.url ?? '').replace(/^\/media\//, ''));
        if (!file || !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')) { response.writeHead(404).end(); return; }
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'Range');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
        if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
        try {
          const size = fs.statSync(file.path).size;
          const mime: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf' };
          response.setHeader('Content-Type', file.contentType ?? mime[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream');
          response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Cache-Control', 'no-store');
          let start = 0, end = size - 1;
          if (request.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
            if (match && (match[1] || match[2])) {
              start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
              end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
            }
            if (!match || (!match[1] && !match[2]) || start >= size || start > end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
            response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          }
          response.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);
          if (request.method === 'HEAD' || size === 0) { response.end(); return; }
          const stream = fs.createReadStream(file.path, { start, end });
          this.responses.set(response, file.owner);
          stream.on('error', () => response.destroy()); response.on('close', () => { this.responses.delete(response); stream.destroy(); }); stream.pipe(response);
        } catch { response.writeHead(404).end(); }
      });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { this.port = (server.address() as import('node:net').AddressInfo).port; resolve(); });
    });
    try { await this.starting; } catch (error) { this.starting = null; throw error; }
  }
}
