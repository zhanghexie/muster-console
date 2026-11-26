import { residentHostToolIds } from '../../../shared/toolDiscovery';
import { isToolDefHidden, type TurnHiddenTools } from '../../../shared/turnVisibility';
import { listResidentWorkerToolMetas, type HostToolPresetId } from '../../../shared/hostTools';
import { getToolDef } from './api';
import { projectHostDefinitions, type ProjectedHostDefinition } from './hostProjection';
import { projectHostDescriptions } from './projectedDescriptions';
import type { ToolDef } from './types';

/** Build from the same filtered source snapshot used by the scheduler registration. */
export function schedulerProjectedCatalog(hidden?: TurnHiddenTools): ProjectedHostDefinition[] {
  const ids = residentHostToolIds('scheduler').filter(id => {
    const def = getToolDef(id);
    if (!def) throw new Error(`Missing scheduler host tool schema: ${id}`);
    return !def.schedulerHidden && (!hidden || !isToolDefHidden(def, hidden));
  });
  return projectHostDescriptions(projectHostDefinitions('scheduler', ids, getToolDef));
}

/** The caller supplies the already permission-filtered, connection-specific Worker tool snapshot. */
export function workerProjectedCatalog(tools: readonly { id: string; description: string; parameters?: Record<string, unknown> }[],
  hasQuestionChannel: boolean): ProjectedHostDefinition[] {
  const byId = new Map<string, ToolDef>();
  for (const tool of tools) {
    if (byId.has(tool.id)) throw new Error(`Duplicate Worker host tool: ${tool.id}`);
    if (!tool.parameters || tool.parameters.type !== 'object' || (tool.parameters.properties !== undefined &&
        (!tool.parameters.properties || typeof tool.parameters.properties !== 'object' || Array.isArray(tool.parameters.properties)))) {
      throw new Error(`Missing Worker host tool schema: ${tool.id}`);
    }
    const original = getToolDef(tool.id);
    byId.set(tool.id, { ...original, name: tool.id, description: tool.description, dangerous: original?.dangerous ?? false,
      parameters: { properties: {}, ...tool.parameters } as ToolDef['parameters'] });
  }
  return projectHostDescriptions(projectHostDefinitions('worker', [...byId.keys()], id => byId.get(id) ?? getToolDef(id), { hasQuestionChannel }));
}

/** PTY schema and visibility are derived from the same preset as inbound MCP. */
export function ptyProjectedCatalog(hasQuestionChannel: boolean): ProjectedHostDefinition[] {
  return workerPresetProjectedCatalog('pty-allowlist', hasQuestionChannel);
}

export function workerPresetProjectedCatalog(preset: HostToolPresetId, hasQuestionChannel: boolean): ProjectedHostDefinition[] {
  return projectWorkerPreset(preset, hasQuestionChannel);
}

export function extensionWorkerProjectedCatalog(): ProjectedHostDefinition[] {
  return projectWorkerPreset(undefined, true);
}

function projectWorkerPreset(preset: HostToolPresetId | undefined, hasQuestionChannel: boolean): ProjectedHostDefinition[] {
  const metas = listResidentWorkerToolMetas(preset);
  const byId = new Map(metas.map(meta => [meta.id, meta]));
  const resolve = (id: string): ToolDef | undefined => {
    const def = getToolDef(id), meta = byId.get(id);
    if (!meta?.schema) return def;
    return { ...def, name: id, description: def?.description ?? id, dangerous: def?.dangerous ?? false,
      parameters: meta.schema as ToolDef['parameters'] };
  };
  return projectHostDescriptions(projectHostDefinitions('worker', metas.map(meta => meta.id), resolve, { hasQuestionChannel }));
}
