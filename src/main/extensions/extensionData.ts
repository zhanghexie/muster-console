import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionManifest } from '../../shared/extension';

const MAX_BYTES = 1024 * 1024;
const MAX_LIST = 1000;
type DataArea = 'workspace' | 'shared';

function encodedIdentity(value: string): string {
  if (!value || value.length > 1024) throw new Error('Invalid workspace identity');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function projectKey(manifest: ExtensionManifest): string {
  const binding = manifest.project;
  if (!binding) throw new Error('Project extension has no binding');
  const value = binding.kind === 'relative' ? ['relative', binding.path] : ['mapped', binding.key];
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Keep data identities separate even when extension IDs or project names overlap. */
export function extensionDataDirectory(userData: string, workspaceId: string, manifest: ExtensionManifest, area: DataArea = 'workspace'): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id)) throw new Error('Invalid extension identity');
  if (area === 'shared') {
    if (manifest.scope !== 'global' || !manifest.data.shared) throw new Error('Shared data was not declared by a global extension');
    return path.join(userDataStorage(userData).resolve('app', 'extension'), 'data', 'shared', 'global', manifest.id);
  }
  if (area !== 'workspace') throw new Error('Unknown extension data area');
  const workspace = encodedIdentity(workspaceId);
  return manifest.scope === 'global'
    ? path.join(userDataStorage(userData).resolve('app', 'extension'), 'data', 'workspaces', workspace, 'global', manifest.id)
    : path.join(userDataStorage(userData).resolve('app', 'extension'), 'data', 'workspaces', workspace, 'projects', projectKey(manifest), manifest.id);
}

function partsFor(value: unknown, allowRoot = false): string[] {
  if (allowRoot && (value === '' || value === undefined)) return [];
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) throw new Error('Invalid extension data path');
  const parts = value.split('/');
  if (parts.some((segment, index) => !segment || segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment) || (index === 0 && segment.toLowerCase() === '.host'))) throw new Error('Invalid extension data path');
  return parts;
}

/** Do not traverse symlinks/junctions inside the profile data subtree. */
function checkedPath(userData: string, root: string, parts: string[], createParents: boolean): string {
  fs.mkdirSync(userData, { recursive: true });
  const base = path.resolve(userData);
  const relativeRoot = path.relative(base, root);
  if (!relativeRoot || relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) throw new Error('Extension data root is outside the profile');
  let current = fs.realpathSync(base);
  const rootParts = relativeRoot.split(path.sep);
  const all = [...rootParts, ...parts];
  for (let i = 0; i < all.length; i++) {
    current = path.join(current, all[i]);
    const parent = i < all.length - 1 || i < rootParts.length;
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (i < rootParts.length || (parent && createParents)) {
        fs.mkdirSync(current);
        stat = fs.lstatSync(current);
      }
    }
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error('Links are not allowed in extension data');
    if (parent && !stat.isDirectory()) throw new Error('Extension data parent is not a directory');
  }
  return current;
}

/** Host-owned encrypted files are outside the extension's normal data API. */
export function extensionSecretPath(userData: string, workspaceId: string, manifest: ExtensionManifest, key: string, area: DataArea = 'workspace'): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) throw new Error('Invalid secret key');
  return checkedPath(userData, extensionDataDirectory(userData, workspaceId, manifest, area), ['.host', 'secrets', `${key}.bin`], true);
}

export class ExtensionDataStore {
  constructor(private userData: string, private workspaceId: string, private manifest: ExtensionManifest) {}

  read(relative: string, area: DataArea = 'workspace'): string | null {
    const file = checkedPath(this.userData, extensionDataDirectory(this.userData, this.workspaceId, this.manifest, area), partsFor(relative), false);
    if (!fs.existsSync(file)) return null;
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error('Extension data is not a readable file or exceeds the size limit');
    const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0));
    const fd = fs.openSync(file, flags);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) throw new Error('Extension data changed while opening');
      const text = fs.readFileSync(fd, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Extension data exceeds the size limit');
      return text;
    } finally { fs.closeSync(fd); }
  }

  write(relative: string, text: string, area: DataArea = 'workspace'): void {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Extension data exceeds the size limit');
    const file = checkedPath(this.userData, extensionDataDirectory(this.userData, this.workspaceId, this.manifest, area), partsFor(relative), true);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('Extension data target is not a file');
    const temporary = path.join(path.dirname(file), `.extension-write-${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
  }

  list(relative = '', area: DataArea = 'workspace'): Array<{ name: string; directory: boolean }> {
    const directory = checkedPath(this.userData, extensionDataDirectory(this.userData, this.workspaceId, this.manifest, area), partsFor(relative, true), false);
    if (!fs.existsSync(directory)) return [];
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Extension data path is not a directory');
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.name.toLowerCase() !== '.host' && !item.name.startsWith('.extension-write-'));
    if (entries.length > MAX_LIST) throw new Error('Extension data directory has too many entries');
    return entries.map(item => {
      if (item.isSymbolicLink()) throw new Error('Links are not allowed in extension data');
      if (!item.isFile() && !item.isDirectory()) throw new Error('Unsupported extension data entry');
      return { name: item.name, directory: item.isDirectory() };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
}
