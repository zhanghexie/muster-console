// Pure, testable statistics. rAF is renderer scheduling evidence, not proof of compositor presentation.
export function percentile(values, quantile) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  return ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] : null;
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  return { count: finite.length, p50: percentile(finite, .5), p95: percentile(finite, .95), p99: percentile(finite, .99), max: finite.length ? Math.max(...finite) : null, total: finite.reduce((a, b) => a + b, 0) };
}

export function summarizeFrames(gaps, budgetMs) {
  if (!(budgetMs > 0)) throw new Error('Frame budget must be positive');
  const frames = gaps.filter(value => Number.isFinite(value) && value > 0);
  const over = ratio => frames.filter(value => value > budgetMs * ratio + .5).length;
  return { ...summarize(frames), budgetMs, over1_25: over(1.25), over1_5: over(1.5), over2: over(2), over4: over(4), over50ms: frames.filter(value => value > 50).length, over100ms: frames.filter(value => value > 100).length, estimatedMissedSlots: frames.reduce((total, value) => total + Math.max(0, Math.round(value / budgetMs) - 1), 0) };
}

export function metricDelta(before, after, elapsedMs) {
  const get = list => Object.fromEntries(list.map(metric => [metric.name, metric.value]));
  const a = get(before), b = get(after);
  const seconds = elapsedMs / 1000;
  const durationNames = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
  const durationMs = Object.fromEntries(durationNames.map(name => [name, a[name] == null || b[name] == null ? null : (b[name] - a[name]) * 1000]));
  const gauges = Object.fromEntries(['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'JSEventListeners'].map(name => [name, { before: a[name] ?? null, after: b[name] ?? null, delta: a[name] == null || b[name] == null ? null : b[name] - a[name] }]));
  return { durationMs, rendererMainThreadBusyPercent: durationMs.TaskDuration == null || !(seconds > 0) ? null : durationMs.TaskDuration / (seconds * 10), gauges };
}

export function compareCompatibility(before, after) {
  const reasons = [];
  if (before.schema !== 1 || after.schema !== 1) reasons.push('schema');
  if (before.toolRevision !== 2 || after.toolRevision !== 2) reasons.push('measurement tooling revision');
  if (before.status !== 'complete' || after.status !== 'complete') reasons.push('incomplete capture');
  if (before.scenarioHash !== after.scenarioHash) reasons.push('scenario');
  if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) reasons.push('viewport/visibility/user agent');
  if (before.profileEnabled !== after.profileEnabled) reasons.push('profiler overhead');
  if (!(before.calibration?.budgetMs > 0) || !(after.calibration?.budgetMs > 0) || Math.abs(before.calibration.budgetMs / after.calibration.budgetMs - 1) > .1) reasons.push('rAF cadence changed >10%');
  if (before.results?.length !== after.results?.length) reasons.push('step count');
  return reasons;
}

export function scrollComparisonIssues(before, after) {
  const reasons = [];
  const changed = (a, b, floor) => !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > Math.max(floor, Math.abs(a) * .1);
  const inputCount = capture => capture.observedInput?.count;
  const dispatchCount = capture => capture.dispatch?.roundtripMs?.count;
  if (!Number.isInteger(inputCount(before)) || inputCount(before) < 1 || !Number.isInteger(inputCount(after)) || inputCount(after) < 1 || inputCount(before) !== inputCount(after)) reasons.push('received input counts differ or are unavailable');
  if (!Number.isInteger(dispatchCount(before)) || dispatchCount(before) < 2 || dispatchCount(before) !== dispatchCount(after)) reasons.push('dispatched wheel counts differ or are unavailable');
  if (changed(before.dispatch?.cadenceMs?.p50, after.dispatch?.cadenceMs?.p50, 2) || changed(before.dispatch?.cadenceMs?.p95, after.dispatch?.cadenceMs?.p95, 2)) reasons.push('actual dispatch cadence changed beyond 10%/2ms tolerance');
  if (changed(before.dispatch?.latenessMs?.p95, after.dispatch?.latenessMs?.p95, 2)) reasons.push('dispatch lateness changed beyond 10%/2ms tolerance');
  if (changed(before.durationMs, after.durationMs, 100)) reasons.push('observation duration changed beyond 10%/100ms tolerance');
  const a = before.restoration, b = after.restoration;
  if (!a || !b) reasons.push('reading-position restoration witness is unavailable');
  else if (!['absolute', 'bottom', 'visible-anchor'].includes(a.method) || !['absolute', 'bottom', 'visible-anchor'].includes(b.method)) reasons.push('reading-position restoration used clamping or an unverified method');
  else if (a.method !== b.method) reasons.push('reading-position restoration method changed');
  else if (a.method === 'bottom' && (!a.atBottom || !b.atBottom)) reasons.push('bottom-following restoration was not verified');
  else if (a.method === 'visible-anchor' && (!a.anchor || !b.anchor || a.anchor.value !== b.anchor.value || !Number.isFinite(a.anchor.offset) || !Number.isFinite(b.anchor.offset) || Math.abs(a.anchor.offset - b.anchor.offset) > 2)) reasons.push('restored visible reading anchor changed or is unavailable');
  else if (a.method === 'absolute' && (!Number.isFinite(a.actualTop) || !Number.isFinite(b.actualTop) || Math.abs(a.actualTop - b.actualTop) > 2)) reasons.push('restored absolute reading position changed or is unavailable');
  return reasons;
}

export function compareStepResults(before, after, { readinessChanged = false } = {}) {
  if (before.name !== after.name || before.round !== after.round || before.kind !== after.kind) throw new Error('Step sequence changed');
  if (before.kind === 'scroll') {
    const issues = scrollComparisonIssues(before, after);
    const a = before.before, b = after.before;
    if (!a || !b || !Number.isFinite(a.scrollTop) || !Number.isFinite(b.scrollTop) || !Number.isFinite(a.scrollHeight) || !Number.isFinite(b.scrollHeight) || Math.abs(a.scrollTop - b.scrollTop) > 2 || Math.abs(a.scrollHeight - b.scrollHeight) > 2 || typeof a.witnessHash !== 'string' || a.witnessHash !== b.witnessHash || !Number.isFinite(a.witnessChars) || a.witnessChars !== b.witnessChars) issues.push('scroll scene/content changed or witness is unavailable');
    if (issues.length) {
      const observation = capture => ({ durationMs: capture.durationMs, receivedInputCount: capture.observedInput?.count, dispatchedCount: capture.dispatch?.roundtripMs?.count, actualCadenceMs: capture.dispatch?.cadenceMs, latenessMs: capture.dispatch?.latenessMs, restorationMethod: capture.restoration?.method || 'unavailable' });
      return { name: before.name, round: before.round, comparable: false, reasons: issues, beforeObservation: observation(before), afterObservation: observation(after) };
    }
  }
  const delta = (a, b) => ({ before: a, after: b, delta: a == null || b == null ? null : b - a, percent: a > 0 && b != null ? (b / a - 1) * 100 : null });
  return { name: before.name, round: before.round, comparable: true, frameP95: delta(before.frames.p95, after.frames.p95), frameP99: delta(before.frames.p99, after.frames.p99), over1_5Budget: delta(before.frames.over1_5, after.frames.over1_5), longtaskTotalMs: delta(before.longtasks.total, after.longtasks.total), readyMs: readinessChanged && ['click', 'hover', 'key'].includes(before.kind) ? null : delta(before.readyMs, after.readyMs), rendererTaskMs: delta(before.metrics.durationMs.TaskDuration, after.metrics.durationMs.TaskDuration), heapBytes: delta(before.metrics.gauges.JSHeapUsedSize.after, after.metrics.gauges.JSHeapUsedSize.after) };
}
