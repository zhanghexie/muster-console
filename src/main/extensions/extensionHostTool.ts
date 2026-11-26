import type { ExtensionManifest } from '../../shared/extensionManifest';
import { EXTENSION_BUILTIN_HOST_TOOLS, isExtensionHostTool } from '../../shared/extension';
import { isShellProfileId } from '../../shared/types';
import { resolveRunToolCall } from '../capabilities/catalog/runFactory';
import { runToolDomainOf } from '../capabilities/catalog/runTools';

export interface ExtensionToolContext {
  workspaceId: string;
  sourceRootId: string;
  sourceRoot: string;
  rootsRevision?: number;
  sessionId?: string;
  manifest: ExtensionManifest;
  assertCurrent(): void;
}

type Session = { id: string; workspaceId?: string };
const BUILTIN = new Set<string>(EXTENSION_BUILTIN_HOST_TOOLS);

export function isBuiltinExtensionHostTool(name: string): boolean {
  return BUILTIN.has(name);
}

export function assertExtensionToolScope(context: ExtensionToolContext, args: Readonly<Record<string, unknown>>): void {
  for (const key of ['__actorSessionId', '__browserOwner', 'from']) {
    if (Object.hasOwn(args, key)) throw new Error('Extension cannot supply a caller identity');
  }
  if (args.workspaceId !== undefined && args.workspaceId !== context.workspaceId) throw new Error('Host tool target is outside the bound workspace');
}

/** Reject forged caller identities and keep every host tool in the bound workspace. */
export function prepareExtensionHostToolCall(context: ExtensionToolContext, name: string, raw: unknown, resolveSession: (reference: string) => Session | undefined): Record<string, unknown> {
  context.assertCurrent();
  if (!isExtensionHostTool(name) || !context.manifest.permissions.includes('hostTools')) throw new Error('Extension did not declare this host tool');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Host tool arguments must be an object');
  const args = { ...(raw as Record<string, unknown>) };
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 128 * 1024) throw new Error('Host tool arguments are too large');
  assertExtensionToolScope(context, args);
  if (name === 'host.tasks.render') {
    const action = String(args.action ?? '');
    if (!['start', 'preview', 'validate', 'status', 'cancel'].includes(action)) throw new Error('tasks.render action is invalid');
    if (args.tabId !== undefined && (typeof args.tabId !== 'string' || args.tabId.length > 128)) throw new Error('Invalid browser tabId');
    if (args.url !== undefined && (typeof args.url !== 'string' || args.url.length > 4096)) throw new Error('Invalid render URL');
    if (args.renderId !== undefined && (typeof args.renderId !== 'string' || args.renderId.length > 128)) throw new Error('Invalid renderId');
    if (args.jobId !== undefined && (typeof args.jobId !== 'string' || args.jobId.length > 128)) throw new Error('Invalid jobId');
    if (action === 'status' || action === 'cancel') {
      const id = args.renderId ?? args.jobId;
      if (typeof id !== 'string' || !id.trim()) throw new Error('tasks.render status/cancel requires renderId');
      if (args.renderId !== undefined && args.jobId !== undefined && args.renderId !== args.jobId) throw new Error('Conflicting renderId and jobId');
      args.renderId = id;
    } else if (action === 'start' || action === 'preview' || action === 'validate') {
      if (args.tabId === undefined && args.url === undefined) throw new Error('tasks.render requires tabId or url');
      if (args.tabId !== undefined && args.url !== undefined) throw new Error('tasks.render cannot combine tabId and url');
    }
    if (args.times !== undefined && (!Array.isArray(args.times) || args.times.length < 1 || args.times.length > 1500 || args.times.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('Invalid render times');
    for (const key of ['width', 'height', 'durationMs', 'fps']) if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]))) throw new Error(`Invalid render ${key}`);
    args.workspaceId = context.workspaceId;
    args.__browserOwner = { workspaceId: context.workspaceId };
  } else if (name === 'host.runtimes.run') {
    if (!['list', 'preflight'].includes(String(args.action))) throw new Error('Extension may only list or preflight runtimes');
    if (!args.params || typeof args.params !== 'object' || Array.isArray(args.params)) throw new Error('Invalid runtime parameters');
    assertExtensionToolScope(context, args.params as Record<string, unknown>);
  } else if (name === 'host.sessions.create') {
    if ((args.rootId !== undefined && args.rootId !== context.sourceRootId) || (args.rootsRevision !== undefined && args.rootsRevision !== context.rootsRevision) || (args.cwd !== undefined && args.cwd !== context.sourceRoot) || (args.asSubagent === true && !context.sessionId) || !['shared', 'isolated'].includes(String(args.isolation))) throw new Error('Extension session creation must use its bound project and an explicit isolation mode');
    if (args.isolation === 'shared' && args.isolationGroups !== undefined) throw new Error('Shared checkout cannot declare isolated repositories');
    if (args.isolation === 'isolated' && (args.isolationGroups !== undefined || args.asSubagent !== true) &&
        (!Array.isArray(args.isolationGroups) || !args.isolationGroups.length || args.isolationGroups.some(item => !item || typeof item !== 'object' || (item as Record<string, unknown>).rootId !== context.sourceRootId))) throw new Error('Isolated repositories must belong to the bound project');
    args.workspaceId = context.workspaceId; args.rootId = context.sourceRootId; args.cwd = context.sourceRoot;
    if (context.rootsRevision !== undefined) args.rootsRevision = context.rootsRevision;
  } else if (name === 'host.terminal.create') {
    if ((args.rootId !== undefined && args.rootId !== context.sourceRootId) || (args.rootsRevision !== undefined && args.rootsRevision !== context.rootsRevision) || (args.cwd !== undefined && args.cwd !== context.sourceRoot)) throw new Error('Extension terminal creation must use its bound project');
    if (typeof args.shellProfileId !== 'string' || !isShellProfileId(args.shellProfileId)) throw new Error('A registered shellProfileId is required');
    if (args.name !== undefined && (typeof args.name !== 'string' || args.name.length > 60)) throw new Error('Terminal name must be a string of at most 60 characters');
    args.workspaceId = context.workspaceId; args.rootId = context.sourceRootId; args.rootsRevision = context.rootsRevision; args.cwd = context.sourceRoot;
  } else if (name === 'host.terminal.write') {
    if (typeof args.sessionId !== 'string' || !args.sessionId.trim()) throw new Error('Terminal sessionId is required');
    if (args.text !== undefined && (typeof args.text !== 'string' || Buffer.byteLength(args.text, 'utf8') > 8 * 1024)) throw new Error('Terminal text must be a string of at most 8 KiB');
    const session = resolveSession(args.sessionId.trim());
    if (!session || session.workspaceId !== context.workspaceId) throw new Error('Session is outside the bound workspace');
    args.sessionId = session.id;
  } else if (name === 'host.mail.send' || name === 'host.sessions.select' || name === 'host.sessions.observe') {
    if (name === 'host.mail.send' && args.interrupt === true && !context.sessionId) throw new Error('Extension cannot interrupt a session without its own Agent');
    const key = name === 'host.mail.send' ? 'to' : 'sessionId';
    if (name === 'host.sessions.observe' && args.sessionId !== undefined && args.externalSessionId !== undefined && args.sessionId !== args.externalSessionId) throw new Error('Conflicting session references');
    const rawReference = args[key] ?? (name === 'host.sessions.observe' ? args.externalSessionId : undefined);
    if (rawReference !== undefined) {
      if (typeof rawReference !== 'string' || !rawReference.trim()) throw new Error('Invalid session reference');
      const reference = rawReference.trim();
      if ((name === 'host.sessions.observe' || (name === 'host.mail.send' && context.sessionId)) &&
          (reference === 'scheduler' || reference === `orchestrator:${context.workspaceId}`)) args[key] = reference;
      else {
        const session = resolveSession(reference);
        if (!session || session.workspaceId !== context.workspaceId) throw new Error('Session is outside the bound workspace');
        args[key] = session.id;
      }
    } else if (name !== 'host.sessions.observe') throw new Error('Session reference is required');
    if (name === 'host.sessions.observe') { args.workspaceId = context.workspaceId; delete args.externalSessionId; }
  }
  context.assertCurrent(); return args;
}

/** Resolve only after the declared public name and workspace checks have succeeded. */
export function resolveExtensionHostToolTarget(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  if (name === 'host.runtimes.run') {
    const domain = runToolDomainOf('runtimes.run');
    if (!domain) throw new Error('Runtime tool domain is unavailable');
    const call = resolveRunToolCall(domain, args);
    if (!['runtimes.list', 'runtimes.preflight'].includes(call.targetTool)) throw new Error('Extension may only list or preflight runtimes');
    return { name: call.targetTool, args: call.args };
  }
  const targets: Record<string, string> = { 'host.sessions.create': 'sessions.create', 'host.mail.send': 'sessions.message',
    'host.sessions.select': 'sessions.select', 'host.sessions.observe': 'sessions.observe',
    'host.terminal.create': 'terminal.create', 'host.terminal.write': 'terminal.write', 'host.tasks.render': 'tasks.render' };
  const target = targets[name];
  if (!target) throw new Error('Unknown extension host tool');
  return { name: target, args };
}
