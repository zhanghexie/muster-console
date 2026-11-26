import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { sourcePathKey } from '../workspacePaths';

/** A deterministic session directory, never a model-supplied path component. */
export function sessionCaptureDirectory(userData: string, sessionId: string): string {
  if (!path.isAbsolute(userData) || typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Capture directory requires an absolute user data path and session identity');
  }
  const root = userDataStorage(userData).resolve('app', 'desktop-captures');
  const id = createHash('sha256').update(sessionId).digest('hex');
  return path.join(root, id);
}

/** Create only under the actual managed root, rejecting substituted directories and links. */
export function prepareSessionCaptureDirectory(userData: string, sessionId: string): string {
  const dir = sessionCaptureDirectory(userData, sessionId), root = path.dirname(dir);
  const realUserData = fs.realpathSync(userData);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      sourcePathKey(fs.realpathSync(root)) !== sourcePathKey(userDataStorage(realUserData).resolve('app', 'desktop-captures'))) {
    throw new Error('Capture root is not a managed directory');
  }
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(dir), real = fs.realpathSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || sourcePathKey(path.dirname(real)) !== sourcePathKey(fs.realpathSync(root))) {
    throw new Error('Capture session directory is not managed');
  }
  return dir;
}

/** Read-only lookups do not create a capture directory. */
export function existingSessionCaptureDirectory(userData: string, sessionId: string): string | undefined {
  const dir = sessionCaptureDirectory(userData, sessionId), root = path.dirname(dir);
  let rootInfo: fs.Stats, info: fs.Stats;
  try { rootInfo = fs.lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || sourcePathKey(fs.realpathSync(root)) !==
      sourcePathKey(userDataStorage(fs.realpathSync(userData)).resolve('app', 'desktop-captures'))) throw new Error('Capture root is not a managed directory');
  try { info = fs.lstatSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || sourcePathKey(path.dirname(fs.realpathSync(dir))) !== sourcePathKey(fs.realpathSync(root))) {
    throw new Error('Capture session directory is not managed');
  }
  return dir;
}

/** Only the bound session gains host-mediated read access; writable roots remain unchanged. */
export function withSessionCaptureReadAccess(context: WorkspaceExecutionContext | undefined, userData: string,
  sessionId: string, create = true): WorkspaceExecutionContext | undefined {
  if (!context) return context;
  const dir = create ? prepareSessionCaptureDirectory(userData, sessionId) : existingSessionCaptureDirectory(userData, sessionId);
  if (!dir) return context;
  const physicalPath = sourcePathKey(fs.realpathSync(dir));
  if (context.readableDirectories.some(item => item.physicalPath === physicalPath)) return context;
  return Object.freeze({ ...context, readableDirectories: Object.freeze([
    ...context.readableDirectories, Object.freeze({ path: dir, physicalPath })
  ]) });
}
