import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { sourcePathKey } from '../workspacePaths';
import { pathKey } from '../pathKey';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function handoverSessionDirectory(userData: string, id: string): string {
  if (!UUID.test(id)) throw new Error('无效的交接会话标识');
  return path.join(userDataStorage(userData).resolve('app', 'session-handovers'), id);
}

export function existingHandoverDirectory(userData: string, id: string): string | undefined {
  if (!UUID.test(id)) return undefined;
  const dir = handoverSessionDirectory(userData, id);
  if (!fs.existsSync(dir)) return undefined;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('交接文档目录不是受管目录');
  const parent = fs.realpathSync(userDataStorage(userData).resolve('app', 'session-handovers'));
  const userRoot = fs.realpathSync(userData);
  if (pathKey(parent) !== pathKey(userDataStorage(userRoot).resolve('app', 'session-handovers'))) throw new Error('交接文档根目录已指向其他位置');
  const real = fs.realpathSync(dir);
  if (sourcePathKey(path.dirname(real)) !== sourcePathKey(parent)) throw new Error('交接文档目录已指向其他位置');
  const history = fs.lstatSync(path.join(real, 'history.md'));
  if (!history.isFile() || history.isSymbolicLink()) throw new Error('交接历史文档不存在或不是普通文件');
  return dir;
}

export async function deleteSessionHandover(userData: string, id: string): Promise<void> {
  const dir = handoverSessionDirectory(userData, id);
  const stat = await fs.promises.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('交接文档目录不是受管目录');
  const root = await fs.promises.realpath(userDataStorage(userData).resolve('app', 'session-handovers'));
  const userRoot = await fs.promises.realpath(userData);
  if (pathKey(root) !== pathKey(userDataStorage(userRoot).resolve('app', 'session-handovers'))) throw new Error('交接文档根目录已指向其他位置');
  const resolved = await fs.promises.realpath(dir);
  if (sourcePathKey(path.dirname(resolved)) !== sourcePathKey(root)) throw new Error('交接文档目录已指向其他位置');
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** The host grants read access only to the current session's document directory. */
export function withHandoverReadAccess(context: WorkspaceExecutionContext | undefined, userData: string, id: string): WorkspaceExecutionContext | undefined {
  if (!context) return context;
  const dir = existingHandoverDirectory(userData, id);
  if (!dir) return context;
  const physicalPath = sourcePathKey(fs.realpathSync(dir));
  const handoverDirectory = Object.freeze({ path: dir, physicalPath });
  return Object.freeze({ ...context, handoverDirectory, readableDirectories: Object.freeze([
    ...context.readableDirectories.filter(item => item.physicalPath !== physicalPath), handoverDirectory
  ]) });
}

/** Unclaimed drafts survive a crash briefly; live session documents never expire here. */
export async function sweepOrphanHandovers(userData: string, liveIds: ReadonlySet<string>, now = Date.now()): Promise<void> {
  const root = userDataStorage(userData).resolve('app', 'session-handovers');
  let names: string[];
  try { names = await fs.promises.readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const id of names) {
    if (!UUID.test(id) || liveIds.has(id)) continue;
    const dir = handoverSessionDirectory(userData, id);
    try {
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs <= 24 * 60 * 60 * 1000) continue;
      await deleteSessionHandover(userData, id);
    } catch (error) { console.warn('[handover] 清理遗留文档失败', id, error); }
  }
}
