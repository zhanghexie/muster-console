/** Declarative, JSON-only harness integration. No executable hooks or brand inference. */
export type HarnessPlatform = 'win32' | 'darwin' | 'linux';
export const HARNESS_MCP_DIALECTS = ['opencode', 'kimi', 'grok', 'commandcode', 'cline', 'kilo', 'copilot', 'devin', 'hermes', 'muse', 'zcode', 'mimo', 'qwen'] as const;
export type HarnessMcpDialect = typeof HARNESS_MCP_DIALECTS[number];
export interface HarnessPath {
  base: 'home' | 'workspace' | 'config';
  path: string;
  platformPaths?: Partial<Record<HarnessPlatform, string>>;
  /** Optional vendor config root and child path relative to it. */
  homeOverride?: { env: string; path: string };
}
export interface HarnessSkillDirectory extends HarnessPath {
  id: string;
  label?: string;
  targets?: string[];
}
export interface HarnessSkillTarget {
  id: string;
  label: string;
  kind: 'cli' | 'gui' | 'sdk';
  skillSupport: 'native-directory' | 'host-policy';
  /** Only these directories are write destinations. Other directories are discovery-only. */
  directoryIds?: string[];
}
export type HarnessMcpIntegration =
  | (HarnessPath & { strategy: 'config-file'; id?: string; format: 'json' | 'jsonc' | 'toml' | 'yaml'; serversKey?: string[]; dialect?: HarnessMcpDialect; fallbacks?: HarnessPath[] })
  | { strategy: 'native' | 'session' | 'unsupported'; reason?: string };
export interface HarnessIntegration {
  skillDirectories?: HarnessSkillDirectory[];
  skillTargets?: HarnessSkillTarget[];
  mcp?: HarnessMcpIntegration;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function assertHarnessRelativePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value) || /^(?:[\\/]|[A-Za-z]:)/.test(value)
    || value.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw new Error('Harness integration paths must be non-empty relative child paths without dot segments');
}
export function normalizeHarnessIntegration(value: unknown): HarnessIntegration | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(key => !['skillDirectories', 'skillTargets', 'mcp'].includes(key))) throw new Error('Invalid harness integrations declaration');
  const text = (item: unknown): item is string => typeof item === 'string' && !!item.trim() && item.length <= 256;
  const ids = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 128 && item.every(text) && new Set(item).size === item.length;
  const checkPath = (item: unknown): void => {
    if (!record(item) || !['home', 'workspace', 'config'].includes(String(item.base))) throw new Error('Invalid harness integration path base');
    assertHarnessRelativePath(item.path);
    if (item.homeOverride !== undefined) {
      const override = item.homeOverride;
      if (item.base !== 'home' || !record(override) || typeof override.env !== 'string' ||
        !/^[A-Z][A-Z0-9_]{1,63}$/.test(override.env) || Object.keys(override).some(key => !['env', 'path'].includes(key))) throw new Error('Invalid harness home override');
      assertHarnessRelativePath(override.path);
    }
    if (item.platformPaths !== undefined) {
      if (!record(item.platformPaths)) throw new Error('Invalid harness platform paths');
      for (const [platform, path] of Object.entries(item.platformPaths)) { if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('Invalid harness platform'); assertHarnessRelativePath(path); }
    }
  };
  if (value.skillDirectories !== undefined) {
    if (!Array.isArray(value.skillDirectories) || value.skillDirectories.length > 128) throw new Error('Invalid harness skill directories');
    const seen = new Set<string>();
    for (const directory of value.skillDirectories) {
      checkPath(directory);
      if (!record(directory) || !text(directory.id) || seen.has(directory.id) || (directory.label !== undefined && !text(directory.label)) || (directory.targets !== undefined && !ids(directory.targets))) throw new Error('Invalid or duplicate harness skill directory');
      seen.add(directory.id);
    }
  }
  if (value.skillTargets !== undefined) {
    if (!Array.isArray(value.skillTargets) || value.skillTargets.length > 128) throw new Error('Invalid harness skill targets');
    const seen = new Set<string>(), directories = new Set((value.skillDirectories as HarnessSkillDirectory[] ?? []).map(item => item.id));
    for (const target of value.skillTargets) {
      if (!record(target) || !text(target.id) || !text(target.label) || seen.has(target.id) || !['cli', 'gui', 'sdk'].includes(String(target.kind)) || !['native-directory', 'host-policy'].includes(String(target.skillSupport))
        || (target.directoryIds !== undefined && (!ids(target.directoryIds) || target.directoryIds.some(id => !directories.has(id))))) throw new Error('Invalid harness skill target or directory reference');
      seen.add(target.id);
    }
  }
  if (value.mcp !== undefined) {
    if (!record(value.mcp)) throw new Error('Invalid harness MCP declaration');
    if (value.mcp.strategy === 'config-file') {
      checkPath(value.mcp);
      if (value.mcp.fallbacks !== undefined) {
        if (!Array.isArray(value.mcp.fallbacks) || value.mcp.fallbacks.length > 4) throw new Error('Invalid MCP fallback paths');
        for (const candidate of value.mcp.fallbacks) {
          checkPath(candidate);
          if (!record(candidate) || candidate.base !== value.mcp.base || Object.keys(candidate).some(key => !['base', 'path', 'platformPaths', 'homeOverride'].includes(key))) throw new Error('Invalid MCP fallback path');
        }
      }
      if ((value.mcp.id !== undefined && (!text(value.mcp.id) || ['__proto__', 'constructor', 'prototype'].includes(value.mcp.id))) || !['json', 'jsonc', 'toml', 'yaml'].includes(String(value.mcp.format)) || (value.mcp.dialect !== undefined && !HARNESS_MCP_DIALECTS.includes(value.mcp.dialect as HarnessMcpDialect)) || (value.mcp.serversKey !== undefined && (!ids(value.mcp.serversKey) || !value.mcp.serversKey.length || value.mcp.serversKey.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))))) throw new Error('Invalid harness MCP format or servers key');
    } else if (!['native', 'session', 'unsupported'].includes(String(value.mcp.strategy)) || (value.mcp.reason !== undefined && !text(value.mcp.reason))) throw new Error('Invalid harness MCP strategy');
  }
  return JSON.parse(JSON.stringify(value)) as HarnessIntegration;
}

const pathProperties = { base: { type: 'string', enum: ['home', 'workspace', 'config'] }, path: { type: 'string' }, platformPaths: { type: 'object', properties: { win32: { type: 'string' }, darwin: { type: 'string' }, linux: { type: 'string' } }, additionalProperties: false },
  homeOverride: { type: 'object', properties: { env: { type: 'string' }, path: { type: 'string' } }, required: ['env', 'path'], additionalProperties: false } };
export const HARNESS_INTEGRATION_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  skillDirectories: { type: 'array', items: { type: 'object', properties: { ...pathProperties, id: { type: 'string' }, label: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } } }, required: ['id', 'base', 'path'] } },
  skillTargets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', enum: ['cli', 'gui', 'sdk'] }, skillSupport: { type: 'string', enum: ['native-directory', 'host-policy'] }, directoryIds: { type: 'array', items: { type: 'string' } } }, required: ['id', 'label', 'kind', 'skillSupport'] } },
  mcp: { oneOf: [{ type: 'object', properties: { ...pathProperties, strategy: { const: 'config-file' }, id: { type: 'string' }, format: { type: 'string', enum: ['json', 'jsonc', 'toml', 'yaml'] }, serversKey: { type: 'array', items: { type: 'string' } }, dialect: { type: 'string', enum: HARNESS_MCP_DIALECTS },
    fallbacks: { type: 'array', maxItems: 4, items: { type: 'object', properties: pathProperties, required: ['base', 'path'], additionalProperties: false } }
  }, required: ['strategy', 'format', 'base', 'path'] }, { type: 'object', properties: { strategy: { type: 'string', enum: ['native', 'session', 'unsupported'] }, reason: { type: 'string' } }, required: ['strategy'] }] }
} };
