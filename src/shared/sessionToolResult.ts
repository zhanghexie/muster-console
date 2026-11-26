/** Model-only projection. Call after execution; internal, extension and CLI consumers keep their original results. */
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function omit(value: RecordValue, keys: readonly string[]): RecordValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function pick(value: RecordValue, keys: readonly string[]): RecordValue {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
const DIAGNOSTICS = ['ok', 'error', 'refused', 'message', 'escalate', 'warnings', 'warning', 'dirtyWorktree'] as const;

/** Writes acknowledge their effect; history is read through observe, never repeated here. */
function session(value: unknown, update?: 'name' | 'pinned'): unknown {
  if (!record(value) || typeof value.id !== 'string' || typeof value.type !== 'string' ||
      typeof value.name !== 'string' || typeof value.createdAt !== 'number') return value;
  // A write receipt is not a second restore/configuration snapshot. None of these
  // values is needed to address the new/current session, send mail, or inspect it.
  const rest = pick(value, update ? ['id', update, ...DIAGNOSTICS] : [
    'id', 'name', 'workspaceId', 'cwd', 'sourceRoot', 'runtime', 'launchKind', 'shellProfileId',
    'status', 'lifecycle', 'runtimePresence', 'archived', 'phase', 'liveStatus',
    'queuedInjects', 'parentSessionId', 'worktreePath', 'worktreeBranch',
    'worktreeBaseBranch', 'worktreeGroups', 'worktreeRepoSet', 'worktreeCleanupPending',
    'retainedWorktreeOnly', 'workerRouting', ...DIAGNOSTICS]);
  // The store removes the flag on unpin. Report the effective boolean.
  if (update === 'pinned') rest.pinned = value.pinned === true;
  if (!update && record(value.meta) && typeof value.meta.launchError === 'string') rest.launchError = value.meta.launchError;
  if (record(rest.workerRouting) && record(rest.workerRouting.plan) && Array.isArray(rest.workerRouting.attempts)) {
    // The untried candidate pool is host execution policy, not execution evidence.
    // Actual attempts and reasons stay, including unknown diagnostic fields.
    const requested = rest.workerRouting.plan.requested;
    rest.workerRouting = { ...omit(rest.workerRouting, ['plan']),
      requested: record(requested) && typeof requested.tierId === 'string' ? { tierId: requested.tierId } : { exact: true } };
  }
  return rest;
}

function sessionUpdate(args: Readonly<Record<string, unknown>>, value: unknown): unknown {
  // GUI's source rename/pin handler serializes before it is assembled into the
  // public combined result. Project that recognized SessionMeta before the size limit.
  if (!record(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.completed))
    return session(value, args.pinned !== undefined && args.name === undefined ? 'pinned' : 'name');
  let changed = false;
  const completed = value.completed.map(item => {
    if (!record(item) || !['sessions.rename', 'sessions.setPinned'].includes(String(item.tool)) || !record(item.result) || item.result.ok !== true) return item;
    const result = item.result;
    // Scheduler and PTY carry an ExecuteResult; GUI carries its serialized form in text.
    if ('result' in result) {
      const projected = session(result.result, item.tool === 'sessions.rename' ? 'name' : 'pinned');
      if (projected === result.result) return item;
      changed = true;
      return { ...item, result: { ...result, result: projected } };
    }
    if (typeof result.text !== 'string') return item;
    try {
      const parsed: unknown = JSON.parse(result.text);
      if (!record(parsed) || parsed.ok !== true || !('result' in parsed)) return item;
      const projected = session(parsed.result, item.tool === 'sessions.rename' ? 'name' : 'pinned');
      if (projected === parsed.result) return item;
      changed = true;
      return { ...item, result: { ...result, text: JSON.stringify({ ...parsed, result: projected }) } };
    } catch { return item; }
  });
  return changed ? { ...value, completed } : value;
}

function dispatch(args: Readonly<Record<string, unknown>>, value: unknown): unknown {
  if (!record(value) || !record(args.params) || typeof args.action !== 'string' ||
      typeof args.params.runId !== 'string' || value.runId !== args.params.runId || value.ok === false) return value;
  const params = args.params;
  // Store writes are synchronous. Their run view repeats the entire worker list
  // on every progress/ask/finalization. Read get when a fresh dependency view is
  // needed; retain failed creations because they identify resources to recover.
  if (!['progress', 'ask', 'deliver', 'fail'].includes(args.action) ||
      typeof value.state !== 'string' || typeof value.revision !== 'number') return value;
  const receipt = pick(value, ['runId', 'state', 'revision', 'question', 'result', 'error', ...DIAGNOSTICS]);
  if (Array.isArray(value.workers)) {
    const failedWorkers = value.workers.filter(worker => record(worker) && worker.creationFailed === true);
    if (failedWorkers.length) receipt.workers = failedWorkers;
  }
  if (args.action === 'ask' && value.state === 'waiting' && record(value.question) &&
      typeof value.question.id === 'string' && typeof params.question === 'string' && value.question.text === params.question) {
    const { text: _text, ...question } = value.question;
    return { ...receipt, question };
  }
  if (args.action === 'fail' && value.state === 'failed' && typeof params.error === 'string' && value.error === params.error) {
    const { error: _error, ...rest } = receipt;
    return rest;
  }
  if (args.action === 'deliver' && value.state === 'delivered' && record(value.result) &&
      typeof params.summary === 'string' && typeof params.verification === 'string' && Array.isArray(params.artifacts) &&
      Object.keys(value.result).length === 3 && value.result.summary === params.summary &&
      value.result.verification === params.verification && Array.isArray(value.result.artifacts) &&
      value.result.artifacts.length === params.artifacts.length &&
      value.result.artifacts.every((item, index) => item === (params.artifacts as unknown[])[index])) {
    const { result: _result, ...rest } = receipt;
    return rest;
  }
  return receipt;
}

/** Preserve envelopes and failures; the caller supplies the raw successful model-facing value. */
export function projectSessionToolResult(publicName: string, args: Readonly<Record<string, unknown>>, value: unknown): unknown {
  if (publicName === 'host.dispatch.run') return dispatch(args, value);
  if (publicName === 'host.sessions.update') return sessionUpdate(args, value);
  if (publicName === 'host.sessions.setStatus') {
    if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
        typeof value.type !== 'string' || typeof value.createdAt !== 'number' || value.ok === false || 'error' in value) return value;
    // Only the Worker handler returns a SessionMeta for a status write. Read the
    // actual phase: the user's sticky board state can override the request.
    const { id, phase, liveStatus, refused, message, escalate, warnings, dirtyWorktree } = value;
    return { id, ...(args.phase !== undefined ? { phase: record(phase) ? pick(phase, ['value', 'source']) : phase ?? null } : {}),
      ...(record(liveStatus) ? { liveStatus: { label: liveStatus.label, kind: liveStatus.kind } } : {}),
      ...(refused !== undefined ? { refused } : {}), ...(message !== undefined ? { message } : {}),
      ...(escalate !== undefined ? { escalate } : {}), ...(warnings !== undefined ? { warnings } : {}),
      ...(dirtyWorktree !== undefined ? { dirtyWorktree } : {}) };
  }
  if (['host.sessions.create', 'host.sessions.select', 'host.terminal.create'].includes(publicName)) {
    if (record(value) && record(value.session)) {
      const projected = session(value.session);
      if (projected === value.session) return value;
      const receipt = omit(value, ['notified', 'maxConcurrentWorkers', 'activeWorkers']);
      if (record(receipt.inject)) receipt.inject = omit(receipt.inject, ['briefChars']);
      return { ...receipt, session: projected };
    }
    if (record(value) && value.status === 'queued' && typeof value.queueId === 'string')
      return omit(value, ['notified', 'maxConcurrentWorkers', 'activeWorkers']);
    return session(value);
  }
  if (publicName === 'host.sessions.recover' && record(value) && record(value.session)) {
    const projected = session(value.session);
    return projected === value.session ? value : { ...value, session: projected };
  }
  return value;
}
