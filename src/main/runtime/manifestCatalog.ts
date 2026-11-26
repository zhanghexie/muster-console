import path from 'node:path';
import type { RuntimeManifest } from '../../shared/runtimeManifest';
import type { AgentRuntimeEntry } from '../../shared/types';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

const manifests = new Map<string, RuntimeManifest[]>();

export function publishRuntimeManifests(runtimeRoot: string, entries: AgentRuntimeEntry[]): void {
  manifests.set(path.resolve(runtimeRoot), entries.flatMap(entry => entry.manifest && (entry.manifest.terminal || entry.enabled)
    ? [{ ...structuredClone(entry.manifest), label: entry.label }] : []));
}

export function registeredRuntimeManifests(userDataDir?: string): RuntimeManifest[] {
  if (!userDataDir) return [];
  const root = userDataStorage(userDataDir).resolve('app', 'agent-runtimes');
  return structuredClone(manifests.get(path.resolve(root)) ?? []);
}
