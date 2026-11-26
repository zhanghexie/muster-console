import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateAppDefinition, type AgentAppDefinition } from '../../shared/agentApps';
import { builtInAgentApps } from '../../shared/agentAppsBuiltins';
import { photoAlbumExample } from '../../shared/agentAppsExamples';
import { writeJsonAtomicSync } from '../atomicJson';

type LibraryVersion = { fingerprint: string; definition: AgentAppDefinition; publishedAt: number };
type LibraryEntry = { catalogId: string; appId: string; ownerWorkspaceId: string; private: boolean; versions: LibraryVersion[] };
type LibraryState = { schemaVersion: 1; entries: LibraryEntry[] };
const PHOTO_TEMPLATE = 'template:photo-album';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function appDefinitionFingerprint(definition: AgentAppDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex');
}
function bundledTemplates(): LibraryEntry[] {
  const definition = photoAlbumExample();
  return [{ catalogId: PHOTO_TEMPLATE, appId: definition.id, ownerWorkspaceId: '', private: false,
    versions: [{ fingerprint: appDefinitionFingerprint(definition), definition, publishedAt: 0 }] }];
}
const bundledFingerprints = new Set([
  ...builtInAgentApps(), ...bundledTemplates().map(entry => entry.versions[0]!.definition)
].map(appDefinitionFingerprint));

/** Only exact definitions shipped by the host qualify; IDs alone do not confer trust. */
export function isBundledAppDefinition(definition: AgentAppDefinition): boolean {
  return bundledFingerprints.has(appDefinitionFingerprint(definition));
}

/** Local immutable definition snapshots; workspace records and credentials never enter this store. */
export class AgentAppLibrary {
  private file: string;
  constructor(root: string, private readonly clock: () => number) { this.file = path.join(root, 'catalog.json'); }
  private read(): LibraryState {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, entries: [] }; throw error; }
    const state = JSON.parse(raw) as LibraryState;
    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.entries) || state.entries.some(entry => !entry.catalogId || !entry.appId || !entry.ownerWorkspaceId || typeof entry.private !== 'boolean' || !Array.isArray(entry.versions) || !entry.versions.length)) throw new Error('App library data is invalid');
    if (new Set(state.entries.map(entry => entry.catalogId)).size !== state.entries.length) throw new Error('App library contains duplicate identities');
    for (const entry of state.entries) {
      let previous = 0;
      for (const version of entry.versions) {
        const definition = validateAppDefinition(version.definition);
        if (definition.id !== entry.appId || definition.version <= previous || version.fingerprint !== appDefinitionFingerprint(definition) || !Number.isFinite(version.publishedAt)) throw new Error('App library version is invalid');
        previous = definition.version;
      }
    }
    return state;
  }
  private write(state: LibraryState): void { writeJsonAtomicSync(this.file, state); }
  list(workspaceId: string): LibraryEntry[] {
    return structuredClone([...bundledTemplates(), ...this.read().entries.filter(entry => !entry.private || entry.ownerWorkspaceId === workspaceId)]);
  }
  register(workspaceId: string, input: AgentAppDefinition, privateApp: boolean): { catalogId: string; fingerprint: string } {
    const definition = validateAppDefinition(input), fingerprint = appDefinitionFingerprint(definition), state = this.read();
    const match = state.entries.find(entry => entry.appId === definition.id && entry.private === privateApp && (!privateApp || entry.ownerWorkspaceId === workspaceId) && entry.versions.some(version => version.fingerprint === fingerprint));
    if (match) return { catalogId: match.catalogId, fingerprint };
    const catalogId = randomUUID();
    state.entries.push({ catalogId, appId: definition.id, ownerWorkspaceId: workspaceId, private: privateApp, versions: [{ fingerprint, definition, publishedAt: this.clock() }] });
    this.write(state); return { catalogId, fingerprint };
  }
  get(workspaceId: string, catalogId: string, version?: number): LibraryVersion & { catalogId: string; private: boolean } {
    const entry = this.list(workspaceId).find(item => item.catalogId === catalogId);
    if (!entry) throw new Error('App library entry is unavailable or private');
    const found = version === undefined ? entry.versions.at(-1) : entry.versions.find(item => item.definition.version === version);
    if (!found) throw new Error('App library version not found');
    return structuredClone({ ...found, catalogId, private: entry.private });
  }
  publish(workspaceId: string, catalogId: string, input: AgentAppDefinition, baseFingerprint: string): string {
    const definition = validateAppDefinition(input), fingerprint = appDefinitionFingerprint(definition), state = this.read();
    const entry = state.entries.find(item => item.catalogId === catalogId && (!item.private || item.ownerWorkspaceId === workspaceId));
    if (!entry || entry.appId !== definition.id) throw new Error('App library entry is unavailable or has a different identity');
    const latest = entry.versions.at(-1)!;
    if (latest.fingerprint === fingerprint) return fingerprint;
    if (latest.fingerprint !== baseFingerprint) throw new Error('App library version conflict; inspect the latest version before publishing');
    if (definition.version <= latest.definition.version) throw new Error('Publishing requires a higher app version');
    entry.versions.push({ fingerprint, definition, publishedAt: this.clock() });
    this.write(state); return fingerprint;
  }
  setPrivate(workspaceId: string, catalogId: string, privateApp: boolean): void {
    if (typeof privateApp !== 'boolean') throw new Error('private must be boolean');
    const state = this.read(), entry = state.entries.find(item => item.catalogId === catalogId);
    if (!entry || entry.ownerWorkspaceId !== workspaceId) throw new Error('Only the originating workspace may change app visibility');
    entry.private = privateApp; this.write(state);
  }
}
