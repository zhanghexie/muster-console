import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { WorkspaceFileRef } from '../shared/types';
import type { AppContext } from './context';
import { captureWorkspaceRoots, workspaceRootsAreCurrent, type WorkspaceRootsToken } from './workspacePaths';
import { withWorkspaceFileTarget } from './workspaceFileAccess';
import { serveWorkspaceFile } from './workspaceFsServe';
import { pathKey } from './pathKey';

const MAX_PREVIEWS = 64;
const TTL_MS = 60 * 60 * 1000;
type Preview = { ref: WorkspaceFileRef; snapshot: WorkspaceRootsToken; root: string; physical: string; inode: string; expiresAt: number };

/** Web 沙箱不携 SameSite Cookie；预览仅拿一份可撤销、只读且限定源根的地址。 */
export class WorkspacePreviews {
  private previews = new Map<string, Preview>();
  constructor(private readonly ctx: Pick<AppContext, 'config'>, private readonly now = Date.now) {}

  private current(preview: Preview): boolean {
    return this.now() < preview.expiresAt && workspaceRootsAreCurrent(this.ctx.config.get(), preview.snapshot);
  }

  async create(ref: WorkspaceFileRef): Promise<{ token: string; path: string }> {
    for (const [key, preview] of this.previews) if (!this.current(preview)) this.previews.delete(key);
    if (this.previews.size >= MAX_PREVIEWS) throw new Error('too many open file previews');
    const snapshot = captureWorkspaceRoots(this.ctx.config.get(), ref.workspaceId);
    const identity = await withWorkspaceFileTarget(() => this.ctx.config.get(), ref, '', async (root, _ref, absolute) => {
      if (!(await fs.stat(absolute)).isFile()) throw new Error('preview target is not a file');
      const physical = await fs.realpath(root);
      const stat = await fs.stat(physical, { bigint: true });
      return { root, physical, inode: `${stat.dev}:${stat.ino}` };
    });
    if (!workspaceRootsAreCurrent(this.ctx.config.get(), snapshot)) throw new Error('workspace source folders changed');
    if (this.previews.size >= MAX_PREVIEWS) throw new Error('too many open file previews');
    const token = randomBytes(24).toString('hex');
    this.previews.set(token, { ref: { ...ref }, snapshot, ...identity, expiresAt: this.now() + TTL_MS });
    const relativePath = ref.relativePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return { token, path: `/media/preview/${token}/${relativePath}` };
  }

  release(token: string): void { this.previews.delete(token); }

  async serve(token: string, relativePath: string, request: Request): Promise<Response> {
    const preview = this.previews.get(token);
    if (!preview || !this.current(preview)) { this.previews.delete(token); return new Response('Forbidden', { status: 403 }); }
    try {
      const physical = await fs.realpath(preview.root);
      const stat = await fs.stat(physical, { bigint: true });
      if (pathKey(physical) !== pathKey(preview.physical) || `${stat.dev}:${stat.ino}` !== preview.inode) throw new Error('source folder location changed');
      return await withWorkspaceFileTarget(() => this.ctx.config.get(), { ...preview.ref, relativePath }, '', async (_root, _ref, abs) => {
        if (!this.current(preview) || this.previews.get(token) !== preview) throw new Error('preview was revoked');
        const response = await serveWorkspaceFile(abs, request);
        if (!this.current(preview) || this.previews.get(token) !== preview) {
          await response.body?.cancel();
          throw new Error('preview was revoked');
        }
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers });
      });
    } catch { return new Response('Forbidden', { status: 403 }); }
  }
}

const services = new WeakMap<AppContext, WorkspacePreviews>();
export function workspacePreviewsFor(ctx: AppContext): WorkspacePreviews {
  let service = services.get(ctx);
  if (!service) { service = new WorkspacePreviews(ctx); services.set(ctx, service); }
  return service;
}
