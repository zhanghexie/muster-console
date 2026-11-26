import type { AgentRuntimeEntry } from './types';

/** Historical identities only: never register an executable or offer these for creation. */
const retiredNames: Readonly<Record<string, string>> = Object.freeze({ glm: 'GLM Coding Plan', mimo: 'MiMo Token Plan', cursor: 'Cursor（旧会话）' });

export function historicalServiceRuntime(id: string | undefined): AgentRuntimeEntry | undefined {
  if (!id || !Object.hasOwn(retiredNames, id)) return undefined;
  return { id, label: retiredNames[id], surface: 'chat', enabled: false, builtin: true, script: '', updatedAt: 0 };
}

/** View-only lookup for saved chats. Existing user registrations always take precedence. */
export function sessionRuntimeLookup(runtimes: readonly AgentRuntimeEntry[]): Record<string, AgentRuntimeEntry> {
  const lookup = Object.fromEntries(runtimes.map(entry => [entry.id, entry]));
  for (const id of Object.keys(retiredNames)) {
    if (!Object.hasOwn(lookup, id)) lookup[id] = historicalServiceRuntime(id)!;
  }
  return lookup;
}
