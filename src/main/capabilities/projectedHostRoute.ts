import { routeHostAsk, type HostAskRoute } from '../../shared/hostAsk';
import { buildHostLlmRun } from './catalog/hostLlmRun';
import { resolveRunToolCall } from './catalog/runFactory';
import type { ProjectedHostDefinition } from './catalog/hostProjection';
import { assertToolArguments } from './schemaValidation';
import { stripForgedIdentity } from './runRouter';

const SESSION_TARGETS: Readonly<Record<string, string>> = {
  'host.sessions.select': 'sessions.select', 'host.sessions.recover': 'sessions.recoverInterrupted',
  'host.sessions.restart': 'sessions.restartConversation', 'host.sessions.review': 'sessions.review'
};

/** A route plan is not an execution grant. The caller must apply policy to permissionSource,
 * and bind the authenticated actor to target before invoking the existing handler. */
export type ProjectedHostRoute =
  | { kind: 'direct'; target: string; permissionSource: string; args: Record<string, unknown> }
  | { kind: 'ask'; route: HostAskRoute; permissionSource: string }
  | { kind: 'session-update'; args: Record<string, unknown>; sources: readonly string[] };

/** API names are resolved from the exact projected roster, never by guessing dots from underscores. */
export function resolveProjectedHostApiName(entries: readonly Pick<ProjectedHostDefinition, 'name'>[], name: string): string | undefined {
  const matches = entries.filter(entry => entry.name === name || entry.name.replace(/\./g, '_') === name);
  if (matches.length > 1) throw new Error('Ambiguous host API tool name');
  return matches[0]?.name;
}

/** Staged router; only names in the supplied, role-filtered catalog can be addressed. */
export function routeProjectedHostCall(entries: readonly ProjectedHostDefinition[], role: 'scheduler' | 'worker',
  name: string, raw: unknown): ProjectedHostRoute {
  if (role !== 'scheduler' && role !== 'worker') throw new Error('Invalid host route role');
  const entry = entries.find(item => item.name === name);
  if (!entry || entry.def.name !== name) throw new Error('Unknown host tool');
  assertToolArguments(entry.def.parameters as Record<string, unknown>, raw, name);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Host tool parameters must be an object');
  const args = stripForgedIdentity(raw as Record<string, unknown>);
  if (name === 'host.ask') {
    const route = routeHostAsk(args);
    const permissionSource = role === 'worker' ? 'askQuestion' : route.tool;
    if (!entry.sources.includes(permissionSource)) throw new Error('Question source is not authorized');
    return { kind: 'ask', route, permissionSource };
  }
  if (name === 'host.sessions.update') return { kind: 'session-update', args, sources: entry.sources };
  if (name === 'host.llm.run') {
    const restricted = role === 'worker' || !!entry.allowedActions;
    const call = resolveRunToolCall(buildHostLlmRun(restricted ? 'worker' : 'scheduler', entry.sources.includes('llm.quota')), args);
    const permissionSource = call.targetTool === 'llm.quota' && entry.sources.includes('llm.quota') ? 'llm.quota' : 'llm.run';
    if (!entry.sources.includes(permissionSource)) throw new Error('LLM action source is not authorized');
    return { kind: 'direct', target: call.targetTool, permissionSource, args: stripForgedIdentity(call.args) };
  }
  const target = SESSION_TARGETS[name] ?? entry.sources[0];
  const permissionSource = entry.sources.includes(target) ? target
    : entry.sources.includes('sessions.run') && Object.hasOwn(SESSION_TARGETS, name) ? 'sessions.run' : '';
  if (!target || !permissionSource) throw new Error('Host tool source is not authorized');
  return { kind: 'direct', target, permissionSource, args };
}
