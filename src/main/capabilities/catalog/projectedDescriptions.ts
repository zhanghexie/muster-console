import { RUN_TOOL_DOMAINS } from './runTools';
import type { ProjectedHostDefinition } from './hostProjection';
import type { ToolDef } from './types';

/** Rewrite only explanatory text; schema keys, constants and executable values stay unchanged. */
export function projectHostDescriptions(entries: readonly ProjectedHostDefinition[]): ProjectedHostDefinition[] {
  const replacements = new Map<string, string>();
  for (const entry of entries) for (const source of entry.sources) {
    if (source === 'sessions.run' || source.startsWith('ext.')) continue;
    const suffix = source === 'llm.quota' ? ' (action: quota)' : source === 'ui.confirm' ? ' (kind: confirm)'
      : source === 'ui.prompt' ? ' (kind: text)' : source === 'askQuestion' ? ' (kind: choice)' : '';
    replacements.set(source, `${entry.name}${suffix}`);
  }
  for (const domain of RUN_TOOL_DOMAINS) {
    const entry = entries.find(item => item.sources.includes(domain.runName));
    if (!entry) continue;
    for (const action of domain.actions) {
      if (!replacements.has(action.targetTool)) replacements.set(action.targetTool, `${entry.name} (action: ${action.action})`);
    }
  }
  const names = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const pattern = names.length ? new RegExp(`(?<![\\w./])(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w]|\\.[A-Za-z_])`, 'g') : null;
  const rewrite = (value: string): string => {
    const expanded = value.replace(/(?<![\w./])events\.list\/read(?![\w.])/g, 'events.list / events.read');
    return pattern ? expanded.replace(pattern, match => replacements.get(match)!) : expanded;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      (key === 'description' || key === 'summary') && typeof item === 'string' ? rewrite(item) : walk(item)]));
  };
  return entries.map(entry => ({ ...entry, def: { ...entry.def, description: rewrite(entry.def.description),
    ...(entry.def.summary ? { summary: rewrite(entry.def.summary) } : {}),
    parameters: walk(entry.def.parameters) as ToolDef['parameters'] } }));
}
