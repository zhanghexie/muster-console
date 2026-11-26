import { migrateHostToolName } from './hostToolNames';

export interface ProjectedHostTool {
  name: string;
  /** Internal provenance for policy and schema projection; never a model-callable alias. */
  sources: string[];
  /** Restricted action set; absence means the original complete domain is present. */
  allowedActions?: string[];
}

const MERGES: Readonly<Record<string, readonly string[]>> = {
  'host.ask': ['askQuestion', 'ui.confirm', 'ui.prompt'],
  'host.sessions.update': ['sessions.run', 'sessions.rename', 'sessions.setPinned', 'sessions.setArchived', 'sessions.setModel', 'sessions.setThinking', 'sessions.setOrchestrated'],
  'host.sessions.review': ['sessions.review', 'sessions.completeAndArchive'],
  'host.sessions.select': ['sessions.run', 'sessions.select'],
  'host.sessions.recover': ['sessions.run', 'sessions.recoverInterrupted'],
  'host.sessions.restart': ['sessions.run', 'sessions.restartConversation'],
  'host.llm.run': ['llm.quota', 'llm.run']
};

/** Prepare, but do not register, the new roster. Policy still binds to the actual action. */
export function projectHostToolRoster(ids: readonly string[]): ProjectedHostTool[] {
  const entries = new Map<string, ProjectedHostTool>();
  const add = (name: string, source: string, action?: string): void => {
    const existing = entries.get(name);
    if (!existing) {
      entries.set(name, { name, sources: [source], ...(action ? { allowedActions: [action] } : {}) });
      return;
    }
    if (!existing.sources.includes(source) && (!MERGES[name]?.includes(source) || !existing.sources.every(item => MERGES[name]?.includes(item)))) {
      throw new Error(`Unexpected host tool projection collision: ${name}`);
    }
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (action && existing.allowedActions && !existing.allowedActions.includes(action)) existing.allowedActions.push(action);
    if (!action && name === 'host.llm.run') delete existing.allowedActions;
  };
  for (const id of ids) {
    const projected = migrateHostToolName(id);
    if (projected.kind === 'action-routing') {
      add('host.sessions.select', id);
      add('host.sessions.recover', id);
      add('host.sessions.restart', id);
      add('host.sessions.update', id);
    } else if (id === 'llm.quota') add(projected.name, id, 'quota');
    else add(projected.name, id);
  }
  return [...entries.values()];
}
