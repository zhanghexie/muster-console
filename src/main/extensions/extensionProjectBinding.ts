import fs from 'node:fs';
import path from 'node:path';
import { registeredControlRootFor, sourceRootsFor } from '../../shared/workspaceRoots';
import { isPortableProjectPath, validateExtensionProjectBinding } from '../../shared/extension';
import type { ExtensionProjectBinding } from '../../shared/extension';
import type { WorkspaceInfo, WorkspaceRoot } from '../../shared/types';

export { isPortableProjectPath, validateExtensionProjectBinding } from '../../shared/extension';

/** Mappings live in the local profile, never in the extension's Git-tracked manifest. */
export interface ExtensionProjectMapping {
  key: string;
  workspaceId: string;
  rootId: string;
  realPath: string;
}

type PathOperations = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * A relative path is portable when both directories share a filesystem root.
 * A different Windows drive, or names that cannot be represented safely on all
 * supported platforms, require an explicit local mapping instead.
 */
export function portableProjectPath(controlRoot: string, sourceRoot: string, paths: PathOperations = path): string | null {
  const relative = paths.relative(controlRoot, sourceRoot);
  if (paths.isAbsolute(relative)) return null;
  const value = relative.split(paths.sep).join('/') || '.';
  return isPortableProjectPath(value) ? value : null;
}

function realDirectory(directory: string): string {
  const actual = fs.realpathSync(directory);
  if (!fs.statSync(actual).isDirectory()) throw new Error(`Project path is not a directory: ${directory}`);
  return actual;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Create a portable binding for a registered source root, without guessing a root. */
export function createExtensionProjectBinding(workspace: WorkspaceInfo, rootId: string): ExtensionProjectBinding | null {
  const roots = sourceRootsFor(workspace);
  const selected = roots.find(root => root.id === rootId);
  if (!selected) throw new Error('Project source root is not registered');
  const selectedPath = realDirectory(selected.path);
  const matching = roots.filter(root => {
    try { return samePath(realDirectory(root.path), selectedPath); } catch { return false; }
  });
  if (matching.length !== 1) throw new Error('Project source root is ambiguous');
  const relative = portableProjectPath(realDirectory(registeredControlRootFor(workspace)), selectedPath);
  return relative === null ? null : { kind: 'relative', path: relative };
}

/**
 * Resolve against registered roots only. Missing, changed or ambiguous bindings
 * are errors; the caller must never substitute the current/default project.
 */
export function resolveExtensionProjectBinding(workspace: WorkspaceInfo, binding: ExtensionProjectBinding, mappings: readonly ExtensionProjectMapping[] = []): WorkspaceRoot {
  if (!validateExtensionProjectBinding(binding)) throw new Error('Invalid project binding');
  const roots = sourceRootsFor(workspace);
  let target: string;
  let expectedRootId: string | undefined;
  if (binding.kind === 'relative') {
    target = realDirectory(path.resolve(realDirectory(registeredControlRootFor(workspace)), ...binding.path.split('/')));
  } else {
    const matches = mappings.filter(item => item.workspaceId === workspace.id && item.key === binding.key);
    if (matches.length !== 1) throw new Error('Project binding requires an explicit local mapping');
    expectedRootId = matches[0].rootId;
    target = realDirectory(matches[0].realPath);
  }
  const matches = roots.filter(root => {
    try { return samePath(realDirectory(root.path), target); } catch { return false; }
  });
  if (matches.length !== 1 || (expectedRootId !== undefined && matches[0].id !== expectedRootId)) {
    throw new Error(matches.length > 1 ? 'Project binding is ambiguous' : 'Bound project is no longer registered');
  }
  return matches[0];
}

/** Equivalent identity check for background verification without blocking the main loop. */
export async function resolveExtensionProjectBindingAsync(workspace: WorkspaceInfo, binding: ExtensionProjectBinding, mappings: readonly ExtensionProjectMapping[] = []): Promise<WorkspaceRoot> {
  if (!validateExtensionProjectBinding(binding)) throw new Error('Invalid project binding');
  const real = async (directory: string): Promise<string> => {
    const actual = await fs.promises.realpath(directory);
    if (!(await fs.promises.stat(actual)).isDirectory()) throw new Error(`Project path is not a directory: ${directory}`);
    return actual;
  };
  const roots = sourceRootsFor(workspace);
  let target: string, expectedRootId: string | undefined;
  if (binding.kind === 'relative') target = await real(path.resolve(await real(registeredControlRootFor(workspace)), ...binding.path.split('/')));
  else {
    const matches = mappings.filter(item => item.workspaceId === workspace.id && item.key === binding.key);
    if (matches.length !== 1) throw new Error('Project binding requires an explicit local mapping');
    expectedRootId = matches[0].rootId;
    target = await real(matches[0].realPath);
  }
  const candidates = await Promise.all(roots.map(async root => { try { return samePath(await real(root.path), target) ? root : null; } catch { return null; } }));
  const matches = candidates.filter((root): root is WorkspaceRoot => !!root);
  if (matches.length !== 1 || (expectedRootId !== undefined && matches[0].id !== expectedRootId)) throw new Error(matches.length > 1 ? 'Project binding is ambiguous' : 'Bound project is no longer registered');
  return matches[0];
}
