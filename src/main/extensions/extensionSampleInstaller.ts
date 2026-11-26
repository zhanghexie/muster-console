import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureExtensionPackageAsync, publishExtensionPackageDirectory, validateExtensionPackage } from './extensionPackageSnapshot';
import { ExtensionSourceLayout } from './extensionSourceLayout';

/** Bundled samples that ship with the host and must stay discoverable together. */
export const SAMPLE_IDS = ['daily-report'] as const;

export interface ExtensionSampleInstallResult {
  sourceRoot: string;
  installed: string[];
  skipped: string[];
  errors: Array<{ extensionId: string; error: string }>;
}

export interface ExtensionSampleInstallOptions {
  /** Development-only refresh for bundled samples after source edits. */
  overwriteExisting?: boolean;
  installedFingerprint?: (id: string, fingerprint: string) => void;
}

function bundledRoots(): string[] {
  const roots = [path.join(process.cwd(), 'resources', 'extensions'), path.join(__dirname, '..', '..', 'resources', 'extensions')];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) roots.unshift(path.join(resourcesPath, 'extensions'), path.join(resourcesPath, 'resources', 'extensions'));
  return [...new Set(roots.map(root => path.resolve(root)))];
}

async function copyTree(source: string, target: string): Promise<void> {
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('Sample source contains a symbolic link');
  if (stat.isDirectory()) {
    await fs.promises.mkdir(target, { recursive: true });
    for (const entry of await fs.promises.readdir(source)) await copyTree(path.join(source, entry), path.join(target, entry));
    return;
  }
  if (!stat.isFile()) throw new Error('Sample source contains an unsupported file');
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
}

/** Install a user-selected global package without exposing a partially copied tree. */
export async function installLocalPackage(userData: string, globalRoot: string, directory: string): Promise<string> {
  const extensionId = path.basename(directory);
  const source = new ExtensionSourceLayout({ userData, globalRoot: path.dirname(directory) });
  const pkg = await source.discover({ scope: 'global', extensionId });
  const target = new ExtensionSourceLayout({ userData, globalRoot }).global(extensionId).directory;
  await fs.promises.mkdir(globalRoot, { recursive: true });
  const staging = path.join(globalRoot, '.install-' + randomUUID());
  try {
    const layout = new ExtensionSourceLayout({ userData, globalRoot: staging });
    const staged = layout.global(extensionId).directory;
    await copyTree(pkg.descriptor.directory, staged);
    const verified = await layout.discover({ scope: 'global', extensionId });
    if (verified.fingerprint !== pkg.fingerprint) throw new Error('Extension changed during installation');
    if (fs.existsSync(target)) throw new Error('Extension is already installed');
    await fs.promises.rename(staged, target);
    return extensionId;
  } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
}

export function bundledSampleRoot(): string | undefined {
  return bundledRoots().find(root => fs.existsSync(path.join(root, 'daily-report', 'extension.json')));
}

/**
 * 内置样例退役清单：这些 id 曾随发行版安装到应用 profile 的 extensions/global，
 * 已从内置目录移除。安装流程会把 profile 里残留的同名目录下线（目录删除后，
 * catalog 重扫即从登记与导航中消失）。新下线的样例往此列表追加。
 */
export const RETIRED_SAMPLE_IDS = ['bookshelf'] as const;

export async function installBundledSamples(
  userData: string,
  globalRoot: string,
  sourceRoot = bundledSampleRoot(),
  extensionIds: readonly string[] = SAMPLE_IDS,
  options: ExtensionSampleInstallOptions = {}
): Promise<ExtensionSampleInstallResult> {
  if (!sourceRoot) throw new Error('Bundled sample packages are unavailable');
  const sourceLayout = new ExtensionSourceLayout({ userData, globalRoot: sourceRoot });
  const targetLayout = new ExtensionSourceLayout({ userData, globalRoot });
  const result: ExtensionSampleInstallResult = { sourceRoot, installed: [], skipped: [], errors: [] };
  // 退役清理先于安装：旧内置样例在 profile 的残留目录不卸载会一直被 catalog 扫到。
  for (const retired of RETIRED_SAMPLE_IDS) {
    if ((extensionIds as readonly string[]).includes(retired)) continue;
    try {
      const directory = targetLayout.global(retired).directory;
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch (error) {
      result.errors.push({ extensionId: retired, error: `retired sample cleanup failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  for (const extensionId of extensionIds) {
    try {
      const source = await sourceLayout.discover({ scope: 'global', extensionId });
      const target = targetLayout.global(extensionId).directory;
      let targetExists = true;
      try { await fs.promises.lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') targetExists = false; else throw error; }
      if (targetExists) {
        if (options.overwriteExisting) {
          const targetStat = await fs.promises.lstat(target);
          if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('Sample target must be a real directory');
          const current = await captureExtensionPackageAsync(target);
          const snapshot = await captureExtensionPackageAsync(source.descriptor.directory);
          if (snapshot.fingerprint !== source.fingerprint) throw new Error('Bundled sample changed during installation');
          if (snapshot.fingerprint !== current.fingerprint) {
            await publishExtensionPackageDirectory(target, snapshot, { root: userData, expectedFingerprint: current.fingerprint });
          }
          options.installedFingerprint?.(extensionId, source.fingerprint);
          result.installed.push(extensionId);
          continue;
        }
        await targetLayout.discover({ scope: 'global', extensionId });
        result.skipped.push(extensionId);
        continue;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const snapshot = await captureExtensionPackageAsync(source.descriptor.directory);
      if (snapshot.fingerprint !== source.fingerprint) throw new Error('Bundled sample changed during installation');
      await publishExtensionPackageDirectory(target, snapshot, { root: userData });
      options.installedFingerprint?.(extensionId, source.fingerprint);
      result.installed.push(extensionId);
    } catch (error) {
      result.errors.push({ extensionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** A running dev host may see edits in either the repository sample or its installed copy. */
export async function refreshDevelopmentSample(userData: string, installed: string, id: string, baseline: string, sourceRoot = bundledSampleRoot()): Promise<string> {
  if (!sourceRoot) throw new Error('Bundled sample source directory is unavailable');
  const snapshot = await captureExtensionPackageAsync(path.join(sourceRoot, id));
  if (snapshot.fingerprint === baseline) return baseline;
  const manifest = validateExtensionPackage(snapshot, id);
  if (manifest.scope !== 'global') throw new Error('Bundled sample must be global');
  const current = await captureExtensionPackageAsync(installed);
  if (current.fingerprint === snapshot.fingerprint) return snapshot.fingerprint;
  if (current.fingerprint !== baseline) throw new Error(`Both sample directories changed. Reconcile the source and installed copies before reloading: ${path.join(sourceRoot, id)}, ${installed}`);
  await publishExtensionPackageDirectory(installed, snapshot, { root: userData, expectedFingerprint: baseline });
  return snapshot.fingerprint;
}

/**
 * Refresh a development package that lives in the repository but is installed
 * into the profile before it is opened. This keeps the normal extension
 * package boundary while making the toolbar reload reflect source edits.
 */
export async function refreshDevelopmentPackage(installed: string, source: string, id: string): Promise<string> {
  const snapshot = await captureExtensionPackageAsync(source);
  const manifest = validateExtensionPackage(snapshot, id);
  if (manifest.scope !== 'global') throw new Error('Development global extension must declare global scope');
  const current = await captureExtensionPackageAsync(installed);
  if (current.fingerprint === snapshot.fingerprint) return snapshot.fingerprint;
  await publishExtensionPackageDirectory(installed, snapshot, { root: path.dirname(installed), expectedFingerprint: current.fingerprint });
  return snapshot.fingerprint;
}
