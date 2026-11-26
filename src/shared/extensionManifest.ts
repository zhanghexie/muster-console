import { validateExtensionProjectBinding } from './extension';
import { EXTENSION_ID_RE, isSafeRelPath } from './extensions';
import { isValidExtensionIcon } from './extensionIcons';

export type ExtensionScope = 'global' | 'project';
export type ExtensionSurfaceKind = 'toolbar' | 'sidebar';
export type ExtensionAgentProfile = 'scheduler-pi';

export type ExtensionProjectBinding =
  | { kind: 'relative'; path: string }
  | { kind: 'mapped'; key: string };

export type ExtensionPermission =
  | 'data'
  | 'files'
  | 'media'
  | 'exports'
  | 'models'
  | 'project.tasks'
  | 'agent.state'
  | 'agent.commands'
  | 'agent.mcp'
  | 'theme'
  | 'native'
  | 'hostTools';

export interface ExtensionCommandDef {
  id: string;
  title: string;
  handler: string;
}

/** Host-owned command module used by toolbar surfaces. */
export interface ExtensionCommandRuntimeContext {
  workspaceId: string;
  extensionId: string;
  scope: ExtensionScope;
  sourceRootId?: string;
  /** Absolute path of the bound project, when a workspace binding is available. */
  sourceRoot?: string;
  rootsRevision?: number;
  requestId: string;
  signal: AbortSignal;
}

export interface ExtensionCommandRuntime {
  execute(input: { command: string; args: unknown; context: ExtensionCommandRuntimeContext }): Promise<unknown>;
  close?: () => Promise<void> | void;
}

export interface ExtensionToolbarMenuItem {
  id: string;
  label: string;
  command: string;
}

export interface ExtensionSurface {
  kind: ExtensionSurfaceKind;
  entry?: string;
  title?: string;
  icon?: string;
  command?: string;
  menu?: ExtensionToolbarMenuItem[];
}

export interface ExtensionDomainDef {
  entry: string;
  snapshot?: string;
  queries: string[];
  commands: string[];
  events: string[];
  queryDefs?: ExtensionOperationDef[];
  commandDefs?: ExtensionOperationDef[];
}

export type ExtensionOperationPermission = 'read' | 'edit' | 'dangerous';

export interface ExtensionOperationDef {
  id: string;
  title?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  permission?: ExtensionOperationPermission;
}

export interface ExtensionAgentDef {
  profile: ExtensionAgentProfile;
  systemPrompt?: string;
  skills: string[];
  mcp: string[];
}

export interface ExtensionThemeDef {
  accent?: string;
  tokens: Record<string, string>;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  icon?: string;
  scope: ExtensionScope;
  project?: ExtensionProjectBinding;
  surface: ExtensionSurface;
  domain?: ExtensionDomainDef;
  agent?: ExtensionAgentDef;
  commands?: ExtensionCommandDef[];
  commandEntry?: string;
  data: { workspace: true; shared: boolean };
  permissions: ExtensionPermission[];
  theme?: ExtensionThemeDef;
}

export type ExtensionManifestValidation =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; error: string };

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const HANDLER = /^[a-zA-Z][\w.-]{0,63}$/;
const OPERATION = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;
const KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const PERMISSIONS: readonly ExtensionPermission[] = ['data', 'files', 'media', 'exports', 'models', 'project.tasks', 'agent.state', 'agent.commands', 'agent.mcp', 'theme', 'native', 'hostTools'];
const MAX_DOMAIN_OPERATIONS = 128;
const MAX_THEME_TOKENS = 64;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && !!value.trim() && value.length <= max);
}

function sourcePath(value: unknown, extension?: string): value is string {
  if (typeof value !== 'string' || !isSafeRelPath(value)) return false;
  if (['data', 'cache', '.git'].includes(value.split('/')[0].toLowerCase())) return false;
  return extension === undefined || value.toLowerCase().endsWith(extension);
}



function validateOperationList(value: unknown, label: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DOMAIN_OPERATIONS || value.some(item => typeof item !== 'string' || !OPERATION.test(item) || item.length > 96)) {
    return `${label} 必须是合法的领域操作名数组`;
  }
  const list = value as string[];
  if (new Set(list).size !== list.length) return `${label} 不能重复`;
  return [...list];
}

function validateCommands(value: unknown): ExtensionCommandDef[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) return 'commands 必须是至多 64 项的数组';
  const commands: ExtensionCommandDef[] = [];
  for (const item of value) {
    if (!record(item) || !onlyKeys(item, ['id', 'title', 'handler']) || typeof item.id !== 'string' || !ID.test(item.id) ||
      typeof item.title !== 'string' || !item.title.trim() || item.title.length > 64 || typeof item.handler !== 'string' || !HANDLER.test(item.handler)) {
      return 'command 字段不合法';
    }
    commands.push({ id: item.id, title: item.title.trim(), handler: item.handler });
  }
  if (new Set(commands.map(command => command.id)).size !== commands.length) return 'command.id 重复';
  return commands;
}

function validateSurface(value: unknown): ExtensionSurface | string {
  if (!record(value) || !onlyKeys(value, ['kind', 'entry', 'title', 'icon', 'command', 'menu'])) return 'surface 不合法';
  if (value.kind !== 'toolbar' && value.kind !== 'sidebar') return 'surface.kind 必须是 toolbar 或 sidebar';
  if (value.entry !== undefined && !sourcePath(value.entry, '.html')) return 'surface.entry 必须是扩展包内 .html 相对路径';
  if (!optionalText(value.title, 64) || (value.icon !== undefined && !isValidExtensionIcon(value.icon))) return 'surface 标题或图标不合法';
  if (value.command !== undefined && (typeof value.command !== 'string' || !ID.test(value.command))) return 'surface.command 不合法';
  if (value.menu !== undefined) {
    if (!Array.isArray(value.menu) || value.menu.length === 0 || value.menu.length > 20) return 'surface.menu 必须是 1-20 项的数组';
    for (const item of value.menu) {
      if (!record(item) || !onlyKeys(item, ['id', 'label', 'command']) || typeof item.id !== 'string' || !ID.test(item.id) ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.length > 64 || typeof item.command !== 'string' || !ID.test(item.command)) return 'surface.menu 项不合法';
    }
    if (new Set((value.menu as Array<{ id: string }>).map(item => item.id)).size !== value.menu.length) return 'surface.menu.id 重复';
  }
  if (value.kind === 'toolbar' && !value.command && !value.menu) return 'toolbar surface 需要 command 或 menu';
  if (value.kind === 'sidebar' && !value.entry) return 'sidebar surface 需要 entry';
  return {
    kind: value.kind,
    ...(typeof value.entry === 'string' ? { entry: value.entry } : {}),
    ...(typeof value.title === 'string' ? { title: value.title.trim() } : {}),
    ...(typeof value.icon === 'string' ? { icon: value.icon.trim() } : {}),
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    ...(Array.isArray(value.menu) ? { menu: value.menu.map(item => ({ id: item.id, label: item.label.trim(), command: item.command })) } : {})
  };
}

function validateOperationDefs(value: unknown, operationNames: string[], label: string): ExtensionOperationDef[] | string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== operationNames.length) return `${label} 必须与对应操作列表一一对应`;
  const result: ExtensionOperationDef[] = [];
  for (const item of value) {
    if (!record(item) || !onlyKeys(item, ['id', 'title', 'description', 'parameters', 'permission']) || typeof item.id !== 'string' || !OPERATION.test(item.id) || !operationNames.includes(item.id)) return `${label} 含有未声明的操作`;
    if (item.title !== undefined && (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 96)) return `${label}.title 不合法`;
    if (item.description !== undefined && (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 500)) return `${label}.description 不合法`;
    if (item.parameters !== undefined && !record(item.parameters)) return `${label}.parameters 必须是对象`;
    if (item.permission !== undefined && !['read', 'edit', 'dangerous'].includes(item.permission as string)) return `${label}.permission 不合法`;
    result.push({ id: item.id, ...(typeof item.title === 'string' ? { title: item.title.trim() } : {}), ...(typeof item.description === 'string' ? { description: item.description.trim() } : {}), ...(record(item.parameters) ? { parameters: structuredClone(item.parameters) } : {}), ...(typeof item.permission === 'string' ? { permission: item.permission as ExtensionOperationPermission } : {}) });
  }
  if (new Set(result.map(item => item.id)).size !== result.length) return `${label}.id 重复`;
  return result;
}

function validateDomain(value: unknown): ExtensionDomainDef | string {
  if (!record(value) || !onlyKeys(value, ['entry', 'snapshot', 'queries', 'commands', 'events', 'queryDefs', 'commandDefs']) || !sourcePath(value.entry, '.mjs')) return 'domain.entry 必须是扩展包内 .mjs';
  if (value.snapshot !== undefined && (typeof value.snapshot !== 'string' || !HANDLER.test(value.snapshot))) return 'domain.snapshot 不合法';
  const queries = validateOperationList(value.queries, 'domain.queries');
  const commands = validateOperationList(value.commands, 'domain.commands');
  const events = validateOperationList(value.events, 'domain.events');
  if (typeof queries === 'string') return queries;
  if (typeof commands === 'string') return commands;
  if (typeof events === 'string') return events;
  const queryDefs = validateOperationDefs(value.queryDefs, queries, 'domain.queryDefs');
  const commandDefs = validateOperationDefs(value.commandDefs, commands, 'domain.commandDefs');
  if (typeof queryDefs === 'string') return queryDefs;
  if (typeof commandDefs === 'string') return commandDefs;
  return { entry: value.entry, ...(typeof value.snapshot === 'string' ? { snapshot: value.snapshot } : {}), queries, commands, events, ...(queryDefs ? { queryDefs } : {}), ...(commandDefs ? { commandDefs } : {}) };
}

function validateAgent(value: unknown): ExtensionAgentDef | string {
  if (!record(value) || !onlyKeys(value, ['profile', 'systemPrompt', 'skills', 'mcp']) || value.profile !== 'scheduler-pi') return 'agent.profile 必须是 scheduler-pi';
  if (value.systemPrompt !== undefined && !sourcePath(value.systemPrompt, '.md')) return 'agent.systemPrompt 必须是扩展包内 .md';
  const skills = value.skills === undefined ? [] : value.skills;
  const mcp = value.mcp === undefined ? [] : value.mcp;
  if (!Array.isArray(skills) || skills.length > 32 || skills.some(item => !sourcePath(item) || typeof item !== 'string')) return 'agent.skills 路径不合法';
  if (!Array.isArray(mcp) || mcp.length > 32 || mcp.some(item => !sourcePath(item, '.mjs') || typeof item !== 'string')) return 'agent.mcp 路径不合法';
  return { profile: 'scheduler-pi', ...(typeof value.systemPrompt === 'string' ? { systemPrompt: value.systemPrompt } : {}), skills: [...skills] as string[], mcp: [...mcp] as string[] };
}

function validateTheme(value: unknown): ExtensionThemeDef | string {
  if (!record(value) || !onlyKeys(value, ['accent', 'tokens'])) return 'theme 不合法';
  if (value.accent !== undefined && (typeof value.accent !== 'string' || !value.accent.trim() || value.accent.length > 64)) return 'theme.accent 不合法';
  if (value.tokens !== undefined && (!record(value.tokens) || Object.keys(value.tokens).length > MAX_THEME_TOKENS)) return 'theme.tokens 不合法';
  const tokens: Record<string, string> = {};
  for (const [key, token] of Object.entries((value.tokens ?? {}) as Record<string, unknown>)) {
    if (!KEY.test(key) || typeof token !== 'string' || !token.trim() || token.length > 128) return 'theme.tokens 含有不合法值';
    tokens[key] = token.trim();
  }
  return { ...(typeof value.accent === 'string' ? { accent: value.accent.trim() } : {}), tokens };
}

/** Validate the current extension manifest without reading package files. Package discovery validates file existence separately. */
export function validateExtensionManifest(raw: unknown, dirName: string): ExtensionManifestValidation {
  const fail = (error: string): ExtensionManifestValidation => ({ ok: false, error });
  if (!record(raw)) return fail('extension.json 必须是对象');
  if (!onlyKeys(raw, ['id', 'name', 'version', 'description', 'icon', 'scope', 'project', 'surface', 'domain', 'agent', 'commands', 'commandEntry', 'data', 'permissions', 'theme'])) return fail('包含未知字段或已移除的扩展接口');
  if (!EXTENSION_ID_RE.test(dirName) || dirName.startsWith('__') || raw.id !== dirName) return fail('扩展 ID 与目录名必须一致');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 64 || !optionalText(raw.version, 32) || !optionalText(raw.description, 500) || (raw.icon !== undefined && !isValidExtensionIcon(raw.icon))) return fail('扩展名称或描述不合法');
  if (raw.scope !== 'global' && raw.scope !== 'project') return fail('scope 必须是 global 或 project');
  if (raw.scope === 'project' ? !validateExtensionProjectBinding(raw.project) : raw.project !== undefined) return fail('项目扩展必须绑定项目，全局扩展不能绑定项目');
  const surface = validateSurface(raw.surface);
  if (typeof surface === 'string') return fail(surface);
  const commands = validateCommands(raw.commands);
  if (typeof commands === 'string') return fail(commands);
  if (raw.commandEntry !== undefined && !sourcePath(raw.commandEntry, '.mjs')) return fail('commandEntry 必须是扩展包内 .mjs');
  const domain = raw.domain === undefined ? undefined : validateDomain(raw.domain);
  if (typeof domain === 'string') return fail(domain);
  const agent = raw.agent === undefined ? undefined : validateAgent(raw.agent);
  if (typeof agent === 'string') return fail(agent);
  if (surface.kind === 'sidebar' && !domain) return fail('sidebar 扩展必须声明 domain');
  if (surface.kind === 'toolbar' && (domain || agent)) return fail('toolbar 扩展不能声明 domain 或 agent');
  if (surface.kind === 'toolbar' && commands.length && typeof raw.commandEntry !== 'string') return fail('toolbar 扩展声明 commands 时必须提供 commandEntry');
  if (surface.kind === 'sidebar' && raw.commandEntry !== undefined) return fail('sidebar 扩展不能声明 commandEntry');
  if (surface.command && !commands.some(command => command.id === surface.command)) return fail('surface.command 引用了未声明的 command');
  if (surface.menu?.some(item => !commands.some(command => command.id === item.command))) return fail('surface.menu 引用了未声明的 command');
  if (raw.data !== undefined && (!record(raw.data) || !onlyKeys(raw.data, ['workspace', 'shared']) || (raw.data.workspace !== undefined && raw.data.workspace !== true) || (raw.data.shared !== undefined && typeof raw.data.shared !== 'boolean'))) return fail('data 声明不合法');
  const data = (raw.data ?? {}) as { shared?: boolean };
  if (raw.scope === 'project' && data.shared) return fail('只有全局扩展可以声明共享数据');
  if (!Array.isArray(raw.permissions) || raw.permissions.some(item => !PERMISSIONS.includes(item as ExtensionPermission)) || new Set(raw.permissions).size !== raw.permissions.length) return fail('permissions 不合法');
  const permissions = raw.permissions as ExtensionPermission[];
  if (agent && !permissions.includes('agent.state')) return fail('声明 agent 时需要 agent.state 权限');
  if (agent && domain?.commands.length && !permissions.includes('agent.commands')) return fail('向 Agent 开放 domain.commands 时需要 agent.commands 权限');
  if (agent && agent.mcp.length && !permissions.includes('agent.mcp')) return fail('声明 agent.mcp 时需要 agent.mcp 权限');
  const theme = raw.theme === undefined ? undefined : validateTheme(raw.theme);
  if (typeof theme === 'string') return fail(theme);
  return {
    ok: true,
    manifest: {
      id: dirName,
      name: raw.name.trim(),
      scope: raw.scope,
      surface,
      data: { workspace: true, shared: data.shared === true },
      permissions,
      ...(typeof raw.version === 'string' ? { version: raw.version.trim() } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description.trim() } : {}),
      ...(typeof raw.icon === 'string' ? { icon: raw.icon.trim() } : {}),
      ...(raw.scope === 'project' ? { project: raw.project as ExtensionProjectBinding } : {}),
      ...(domain ? { domain } : {}),
      ...(agent ? { agent } : {}),
      ...(commands.length ? { commands } : {}),
      ...(typeof raw.commandEntry === 'string' ? { commandEntry: raw.commandEntry } : {}),
      ...(theme ? { theme } : {})
    }
  };
}
