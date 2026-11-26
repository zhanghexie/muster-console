import { captureExtensionPackageAsync, validateExtensionPackage } from './extensionPackageSnapshot';
import path from 'node:path';
import { EXTENSION_ID_RE } from '../../shared/extensions';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

/**
 * Extension source layout.
 *
 * Global packages have one source directory owned by the application profile.
 * A workspace only supplies an instance binding and never receives a source
 * copy. Project packages keep the existing workspace-management location.
 */
export type ExtensionSourceScope = 'global' | 'project';

export interface ExtensionSourceDescriptor {
  scope: ExtensionSourceScope;
  extensionId: string;
  directory: string;
  controlRoot?: string;
  copiedPerWorkspace: boolean;
}

export interface ExtensionSourceLayoutOptions {
  userData: string;
  globalRoot?: string;
}

export interface ExtensionSourcePackage {
  descriptor: ExtensionSourceDescriptor;
  manifest: ExtensionManifest;
  fingerprint: string;
  files: string[];
}

function extensionId(id: string): string {
  if (typeof id !== 'string' || !EXTENSION_ID_RE.test(id)) throw new Error('Invalid extension id');
  return id;
}

function root(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return path.resolve(value);
}

function child(rootDirectory: string, id: string): string {
  const resolvedRoot = root(rootDirectory, 'source root');
  const directory = path.resolve(resolvedRoot, extensionId(id));
  const relative = path.relative(resolvedRoot, directory);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Extension source escaped its root');
  return directory;
}

export class ExtensionSourceLayout {
  readonly globalRoot: string;

  constructor(options: ExtensionSourceLayoutOptions) {
    this.globalRoot = root(options.globalRoot ?? userDataStorage(root(options.userData, 'userData')).manifestPath('extension-source'), 'global source root');
  }

  global(id: string): ExtensionSourceDescriptor {
    return { scope: 'global', extensionId: extensionId(id), directory: child(this.globalRoot, id), copiedPerWorkspace: false };
  }

  project(controlRoot: string, id: string): ExtensionSourceDescriptor {
    const managementRoot = root(controlRoot, 'control root');
    return { scope: 'project', extensionId: extensionId(id), directory: child(path.join(managementRoot, '.muster', 'extensions'), id), controlRoot: managementRoot, copiedPerWorkspace: true };
  }

  resolve(input: { scope: ExtensionSourceScope; extensionId: string; controlRoot?: string }): ExtensionSourceDescriptor {
    if (input.scope === 'global') return this.global(input.extensionId);
    if (!input.controlRoot) throw new Error('Project extensions require a control root');
    return this.project(input.controlRoot, input.extensionId);
  }

  /** Read and validate one package at its resolved source root without copying it. */
  async discover(input: { scope: ExtensionSourceScope; extensionId: string; controlRoot?: string }): Promise<ExtensionSourcePackage> {
    const descriptor = this.resolve(input);
    const snapshot = await captureExtensionPackageAsync(descriptor.directory);
    const manifest = validateExtensionPackage(snapshot, descriptor.extensionId);
    if (manifest.scope !== descriptor.scope) throw new Error('Extension manifest scope does not match its source root');
    return { descriptor, manifest, fingerprint: snapshot.fingerprint, files: snapshot.files.map(file => file.path) };
  }
}

export function extensionGlobalSourceDirectory(userData: string, extensionId: string, globalRoot?: string): string {
  return new ExtensionSourceLayout({ userData, ...(globalRoot ? { globalRoot } : {}) }).global(extensionId).directory;
}

