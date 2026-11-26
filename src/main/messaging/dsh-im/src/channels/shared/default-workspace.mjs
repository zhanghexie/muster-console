import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export function defaultImWorkspace(config = {}) {
  const storageRoot = config.storageRoot ?? config.dataDir;
  return resolve(storageRoot, 'im');
}

export async function sameWorkspacePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
    || !isAbsolute(left) || !isAbsolute(right)) return false;
  if (resolve(left) === resolve(right)) return true;
  try {
    return resolve(await realpath(left)) === resolve(await realpath(right));
  } catch {
    return false;
  }
}

export async function prepareBotWorkspace(config = {}) {
  const ungroupedWorkspace = defaultImWorkspace(config);
  const defaultWorkspace = resolve(config.workspace ?? ungroupedWorkspace);
  return { defaultWorkspace, ungroupedWorkspace };
}

export async function ensureImWorkspaceDirectory(workspace, ungroupedWorkspace) {
  if (await sameWorkspacePath(workspace, ungroupedWorkspace)) {
    await mkdir(workspace, { recursive: true });
  }
}
