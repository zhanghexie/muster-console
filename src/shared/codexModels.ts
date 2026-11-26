/** Codex CLI 的模型目录；候选项不代表当前账号已获模型使用权限。 */
export interface CodexModelListItem {
  id: string;
  displayName: string;
  description?: string;
  parameters?: import('./modelParameters').ModelParameterDescriptor[];
}

export type CodexModelListResult =
  | { ok: true; items: CodexModelListItem[]; defaultModelId: string; defaultParameters?: import('./modelParameters').ModelParameterValues; source: 'app-server' | 'config'; warning?: string }
  | { ok: false; error: string };

export function codexModelReasoningLevels(items: readonly CodexModelListItem[], modelId: string): string[] | undefined {
  const parameters = items.find(item => item.id === modelId)?.parameters;
  return parameters?.find(parameter => parameter.semantic === 'reasoning')?.options.map(option => option.value)
    ?? (parameters ? [] : undefined);
}

/** 只提取模型字段，不把 config/read 的凭证或其他配置传到渲染层。 */
export function configuredCodexModels(config: Record<string, any>): string[] {
  const values = [config.model, ...Object.values(config.profiles ?? {}).map((p: any) => p?.model)];
  return [...new Set(values.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()))];
}

export function codexModelItems(rows: unknown[]): CodexModelListItem[] {
  const items = new Map<string, CodexModelListItem>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.model === 'string' ? row.model.trim() : typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || row.hidden === true || items.has(id)) continue;
    const allowed = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
    const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.flatMap((raw): Array<{ value: string; label: string }> => {
      const effort = typeof raw === 'string' ? raw : raw?.reasoningEffort;
      return typeof effort === 'string' && allowed.has(effort) ? [{ value: effort, label: effort }] : [];
    }).filter((e, i, a) => a.findIndex(v => v.value === e.value) === i) : [];
    items.set(id, {
      id,
      displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName : id,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(efforts.length ? { parameters: [{ id: 'reasoning', semantic: 'reasoning' as const, label: 'Reasoning effort', options: efforts, apply: 'next-turn' as const, supportsDefault: true,
        ...(efforts.some(e => e.value === row.defaultReasoningEffort) ? { defaultValue: row.defaultReasoningEffort as string } : {}) }] }
        : Array.isArray(row.supportedReasoningEfforts) ? { parameters: [] } : {})
    });
  }
  return [...items.values()];
}
