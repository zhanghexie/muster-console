import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MUSTER_EXPORT_SCHEME } from '../../shared/protocolSchemes';
import { serveWorkspaceFile } from '../workspaceFsServe';
import { app } from 'electron';
import { revealPath } from '../shell/reveal';
import type { ExtensionMediaStore } from './extensionMediaStore';

const NAME = /^[^\\/:*?"<>|\0]{1,128}$/;
const MAX_FILES = 128;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const PROJECT_STATIC_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.ogv']);
const PRIVATE_SEGMENT = /^(?:\.|node_modules$|(?:package|tsconfig|jsconfig|credentials|secrets?)(?:\.|$)|(?:.*\.)?config\.[cm]?js$)/i;

export type ExtensionExportFile = { name: string; text?: string; assetId?: string };
export interface ExtensionExportResult { exportId: string; directory: string; files: string[] }

function safeName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) throw new Error('导出文件名不合法');
  return value;
}

export class ExtensionExportService {
  private readonly records = new Map<string, { owner: string; directory: string; files: Set<string> }>();
  private readonly projectPreviews = new Map<string, { directory: string; realDirectory: string; entry: string }>();
  constructor(private readonly media: ExtensionMediaStore, private readonly documents = app.getPath('documents')) {}

  async create(owner: string, rawFiles: unknown, title?: unknown): Promise<ExtensionExportResult> {
    if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_FILES) throw new Error('导出文件列表不合法');
    const label = typeof title === 'string' && title.trim() ? title.trim().slice(0, 80).replace(/[\\/:*?"<>|\0]/g, '_') : 'extension-export';
    const exportId = randomUUID();
    const parent = path.join(this.documents, 'Muster Extensions');
    const directory = path.join(parent, `${label}-${exportId.slice(0, 8)}`);
    const temporary = `${directory}.tmp-${randomUUID()}`;
    await fs.mkdir(temporary, { recursive: true });
    const files: string[] = [];
    try {
      for (const raw of rawFiles) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('导出文件项不合法');
        const item = raw as Record<string, unknown>;
        const name = safeName(item.name);
        const hasText = typeof item.text === 'string';
        const hasAsset = typeof item.assetId === 'string' && !!item.assetId;
        if (hasText === hasAsset) throw new Error(`导出文件 ${name} 必须且只能提供 text 或 assetId`);
        const target = path.join(temporary, name);
        if (hasText) {
          if (Buffer.byteLength(item.text as string, 'utf8') > MAX_TEXT_BYTES) throw new Error(`导出文件 ${name} 超过大小限制`);
          await fs.writeFile(target, item.text as string, { encoding: 'utf8', mode: 0o600 });
        } else {
          await this.media.copyTo(owner, item.assetId as string, target);
        }
        files.push(name);
      }
      await fs.mkdir(parent, { recursive: true });
      await fs.rename(temporary, directory);
      this.records.set(exportId, { owner, directory, files: new Set(files) });
      return { exportId, directory, files };
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async previewUrl(owner: string, exportId: string, name: string): Promise<string> {
    const record = this.records.get(exportId);
    if (!record || record.owner !== owner || !record.files.has(name) || !/\.html?$/i.test(name)) {
      throw new Error('请选择当前扩展已导出的 HTML 文件');
    }
    await this.registeredFile(record.directory, name);
    return `${MUSTER_EXPORT_SCHEME}://${exportId}/${encodeURIComponent(name)}`;
  }

  /** Caller must authorize the entry against its workspace/task before registering it. */
  async projectPreviewUrl(file: string): Promise<string> {
    if (!path.isAbsolute(file) || !/\.html?$/i.test(file)) throw new Error('请选择已授权的 HTML 作品文件');
    const directory = path.dirname(file), entry = path.basename(file);
    const realDirectory = await fs.realpath(directory);
    const record = { directory, realDirectory, entry };
    await this.projectFile(record, entry);
    const id = randomUUID();
    this.projectPreviews.set(id, record);
    return `${MUSTER_EXPORT_SCHEME}://${id}/${encodeURIComponent(entry)}`;
  }

  private async projectFile(record: { directory: string; realDirectory: string; entry: string }, name: string): Promise<string> {
    const segments = name.split('/');
    if (!name || segments.some(segment => !segment || segment === '..' || segment === '.' || PRIVATE_SEGMENT.test(segment) || /[\\:\0]/.test(segment)) ||
        (name !== record.entry && !PROJECT_STATIC_EXTENSIONS.has(path.extname(name).toLowerCase()))) throw new Error('作品资源不可预览');
    const file = path.join(record.directory, ...segments);
    const [root, realFile, stat] = await Promise.all([fs.realpath(record.directory), fs.realpath(file), fs.lstat(file)]);
    if (root !== record.realDirectory || path.relative(root, realFile) !== segments.join(path.sep) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('作品资源已移动、替换或超过大小限制');
    return file;
  }

  async servePreview(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    try {
      const url = new URL(request.url);
      const record = this.records.get(url.hostname);
      const project = this.projectPreviews.get(url.hostname);
      const name = decodeURIComponent(url.pathname.slice(1));
      if (url.protocol !== MUSTER_EXPORT_SCHEME + ':' || (!project && !record?.files.has(name))) return new Response(null, { status: 404 });
      const file = project ? await this.projectFile(project, name) : await this.registeredFile(record!.directory, name);
      const response = await serveWorkspaceFile(file, request);
      const headers = new Headers(response.headers);
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
      if (request.method === 'HEAD') await response.body?.cancel();
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  }

  private async registeredFile(directory: string, name: string): Promise<string> {
    const file = path.join(directory, safeName(name));
    const [directoryStat, fileStat, realParent, realFile] = await Promise.all([
      fs.lstat(directory), fs.lstat(file), fs.realpath(this.documents), fs.realpath(file)
    ]);
    if (!directoryStat.isDirectory() || !fileStat.isFile() ||
        path.relative(realParent, realFile) !== path.relative(this.documents, file)) throw new Error('导出文件已移动或替换');
    return file;
  }

  async reveal(owner: string, exportId: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.records.get(exportId);
    if (!record || record.owner !== owner) throw new Error('导出结果不存在或不属于当前扩展实例');
    return revealPath(record.directory);
  }
}
