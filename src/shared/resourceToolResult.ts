import { RESULT_MAX_CHARS } from './toolResultBudget';

/** Model-only receipts. Code callers keep the original host values. */
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const omit = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

function runtimeSummary(value: unknown): unknown {
  if (!record(value) || typeof value.id !== 'string') return value;
  const manifest = value.manifest;
  const summary = omit(value, ['script', 'scriptSource', 'extraArgs', 'builtinScriptVersion', 'integrations', 'manifest']);
  if (record(manifest) && !Object.hasOwn(summary, 'declaredSurfaces')) {
    summary.declaredSurfaces = [
      ...(record(manifest.terminal) ? ['pty'] : []),
      ...(record(manifest.chat) ? ['chat'] : [])
    ];
  }
  return summary;
}

function runSummary(value: unknown): unknown {
  if (!record(value) || typeof value.runId !== 'string') return value;
  // get remains the explicit diagnostic read; preserve asks and failure information here.
  return omit(value, ['args', 'log', 'result', 'resumes', 'activeMinutes', 'updatedAt']);
}

export function projectResourceToolResult(
  publicName: string,
  args: Readonly<Record<string, unknown>>,
  value: unknown
): unknown {
  if (publicName === 'host.runtimes.run' && args.action === 'restoreBuiltins' && Array.isArray(value)) {
    return value.map(runtimeSummary);
  }
  if (!record(value)) return value;
  const result = value;
  if (result.ok === false || Object.prototype.hasOwnProperty.call(result, 'error')) return value;
  if (publicName === 'host.runtimes.run') {
    if (args.action === 'list' && Array.isArray(result.runtimes)) {
      // Fail open on an unfamiliar row or manifest; never hide a new error/result shape.
      const rows = result.runtimes;
      if (!rows.every(row => {
        if (!record(row) || typeof row.id !== 'string' || typeof row.label !== 'string' ||
            typeof row.builtin !== 'boolean' || typeof row.enabled !== 'boolean') return false;
        if (row.manifest === undefined) return true;
        if (!record(row.manifest)) return false;
        const { terminal, chat } = row.manifest;
        return (terminal === undefined || record(terminal)) && (chat === undefined || record(chat)) &&
          (record(terminal) || record(chat));
      })) return value;
      return { ...result, runtimes: rows.map(row => {
        // Legacy PTY get includes arbitrary launcher source and may exceed the result budget.
        // Keep its list metadata intact. Manifest/chat get has an empty scriptSource; check
        // the complete detail envelope before relying on that separate read.
        if (!record(row.manifest) && row.surface !== 'chat') return row;
        try {
          if (JSON.stringify({ ok: true, result: { ...row, scriptSource: '' } }).length > RESULT_MAX_CHARS) return row;
        } catch {
          return row;
        }
        return runtimeSummary(row);
      }) };
    }
    if (args.action === 'register' || args.action === 'update') return runtimeSummary(result);
  }
  if (publicName === 'host.automations.run' && ['create', 'update'].includes(String(args.action)) && record(result.task)) {
    // Retain normalized schedule, source root, permission/model configuration, enabled state and errors.
    return { ...result, task: omit(result.task, ['prompt']) };
  }
  if (publicName === 'host.llm.run' && args.action === 'upsertProvider' && record(result.provider)) {
    const { models, ...provider } = result.provider;
    if (!Array.isArray(models) || models.some(model => !record(model) || typeof model.id !== 'string')) return result;
    return { ...result, provider: {
      ...provider, modelCount: models.length, ...(models.length ? { firstModelId: models[0].id } : {})
    } };
  }
  if (publicName === 'host.workflow.run') {
    if (args.action === 'start') return runSummary(result);
    if (args.action === 'list' && Array.isArray(result.active)) return { ...result, active: result.active.map(runSummary) };
  }
  if (publicName === 'host.events.emit' && result.ok === true && record(result.fact)) {
    return { ...result, fact: omit(result.fact, ['data', 'paths']) };
  }
  if (result.ok !== true || !Array.isArray(result.subscriptions)) return value;
  if (publicName === 'host.events.subscribe') {
    if (!record(result.subscription) || typeof result.subscription.id !== 'string' || !result.subscription.id) return value;
  } else if (publicName === 'host.events.unsubscribe') {
    if (typeof result.id !== 'string' || !result.id) return value;
  } else {
    return value;
  }
  return omit(result, ['subscriptions']);
}
