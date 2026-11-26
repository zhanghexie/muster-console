// node trace-analyze.mjs <trace.json> [new-output.json]
// Aggregate metadata only. Does not infer dropped frames from presentation gaps or partial states.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize } from './metrics.mjs';

function asyncEventKey(event) {
  const id = event.id2 && Object.hasOwn(event.id2, 'local') ? ['local', event.id2.local]
    : event.id2 && Object.hasOwn(event.id2, 'global') ? ['global', event.id2.global]
      : event.id != null ? ['legacy', event.id] : null;
  return id ? JSON.stringify([event.pid, event.cat || '', event.scope || event.s || '', event.name, ...id]) : null;
}

export function pairEventLatency(events, synchronousWindow = null) {
  const pending = new Map(), durations = [], buckets = new Map(), withinDurations = [], withinBuckets = new Map();
  const windowAvailable = Number.isFinite(synchronousWindow?.startUs) && Number.isFinite(synchronousWindow?.endUs);
  const outside = ts => windowAvailable && (ts < synchronousWindow.startUs || ts > synchronousWindow.endUs);
  const summarizeBuckets = values => Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b)).map(([name, samples]) => [name, summarize(samples)]));
  let excludedPairs = 0, beginRecordsOutsideWindow = 0, endRecordsOutsideWindow = 0;
  let unmatchedEnds = 0, malformed = 0;
  const candidates = events.filter(event => event.name === 'EventLatency').map((event, order) => ({ event, order })).sort((a, b) => a.event.ts - b.event.ts || a.order - b.order);
  for (const { event } of candidates) {
    if (event.ph !== 'b' && event.ph !== 'e') continue;
    const key = asyncEventKey(event);
    if (!key || !Number.isFinite(event.ts)) { malformed++; continue; }
    if (outside(event.ts)) {
      if (event.ph === 'b') beginRecordsOutsideWindow++; else endRecordsOutsideWindow++;
    }
    if (event.ph === 'b') {
      const stack = pending.get(key) || []; stack.push(event); pending.set(key, stack);
      continue;
    }
    const stack = pending.get(key);
    const begin = stack?.pop();
    if (!begin) { unmatchedEnds++; continue; }
    if (!stack.length) pending.delete(key);
    const duration = (event.ts - begin.ts) / 1000;
    if (duration < 0) { malformed++; continue; }
    const type = begin.args?.event_latency?.event_type || begin.args?.data?.event_type || event.args?.event_latency?.event_type || 'UNKNOWN';
    const bucket = buckets.get(type) || []; bucket.push(duration); buckets.set(type, bucket); durations.push(duration);
    if (windowAvailable && !outside(begin.ts) && !outside(event.ts)) {
      withinDurations.push(duration);
      const within = withinBuckets.get(type) || []; within.push(duration); withinBuckets.set(type, within);
    } else if (windowAvailable) excludedPairs++;
  }
  return {
    // Compatibility fields retain all raw pairs. Never label these as action-only latency.
    paired: durations.length, durationMs: summarize(durations), byEventType: summarizeBuckets(buckets),
    unmatchedBegins: [...pending.values()].reduce((sum, stack) => sum + stack.length, 0), unmatchedEnds, malformed,
    withinObservedSynchronousWindow: { available: windowAvailable, paired: withinDurations.length, durationMs: summarize(withinDurations), byEventType: summarizeBuckets(withinBuckets), excludedPairs, beginRecordsOutsideWindow, endRecordsOutsideWindow }
  };
}

export function analyzeTrace(trace) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents;
  if (!Array.isArray(events)) throw new Error('Trace must contain a traceEvents array');
  const threads = new Map();
  for (const event of events) if (event.name === 'thread_name' && typeof event.args?.name === 'string') threads.set(`${event.pid}:${event.tid}`, event.args.name);
  const threadOf = event => threads.get(`${event.pid}:${event.tid}`) || `thread-${event.tid}`;
  const totals = new Map(), longRunTasks = [];
  let first = Infinity, last = -Infinity, syncFirst = Infinity, syncLast = -Infinity;
  const pipelineStates = {}, scrollFlags = [];
  const invalidationCounts = new Map(), subtreeSelectors = new Map(), layoutDurations = [], layoutElementCounts = [];
  let subtreeInvalidations = 0, subtreeWithoutSelectors = 0;
  let scrollBeginsWithoutFlag = 0;
  for (const event of events) {
    if (event.ph !== 'M' && Number.isFinite(event.ts) && event.ts > 0) { first = Math.min(first, event.ts); last = Math.max(last, event.ts + (Number.isFinite(event.dur) ? Math.max(0, event.dur) : 0)); }
    if (event.ph === 'X' && Number.isFinite(event.dur) && event.dur >= 0) {
      if (Number.isFinite(event.ts) && event.ts > 0) { syncFirst = Math.min(syncFirst, event.ts); syncLast = Math.max(syncLast, event.ts + event.dur); }
      const key = JSON.stringify([event.pid, event.tid, event.name]);
      const row = totals.get(key) || { pid: event.pid, tid: event.tid, thread: threadOf(event), name: event.name, count: 0, totalMs: 0, maxMs: 0 };
      const durationMs = event.dur / 1000;
      row.count++; row.totalMs += durationMs; row.maxMs = Math.max(row.maxMs, durationMs); totals.set(key, row);
      if (/(?:^|::)RunTask$/.test(event.name) && durationMs >= 50) longRunTasks.push({ pid: event.pid, tid: event.tid, thread: threadOf(event), name: event.name, startUs: event.ts, durationMs });
    }
    if (event.name === 'ScrollJankV4') {
      const flag = event.args?.scroll_jank_v4?.is_janky;
      if (typeof flag === 'boolean') scrollFlags.push(flag);
      else if (event.ph === 'b' || event.ph === 'X') scrollBeginsWithoutFlag++;
    }
    if (event.name === 'PipelineReporter' && typeof event.args?.frame_reporter?.state === 'string') {
      const state = event.args.frame_reporter.state; pipelineStates[state] = (pipelineStates[state] || 0) + 1;
    }
    if (/^(?:StyleRecalc|StyleInvalidator|ScheduleStyle|Layout)InvalidationTracking$/.test(event.name)) {
      invalidationCounts.set(event.name, (invalidationCounts.get(event.name) || 0) + 1);
      const data = event.args?.data;
      if (event.name === 'StyleInvalidatorInvalidationTracking' && /invalidates subtree/i.test(data?.reason || '')) {
        subtreeInvalidations++;
        // Only explicit CSS selector fields. Never serialize nodeName, nodeId,
        // stackTrace, arbitrary extraData, or any raw invalidation record.
        const selectors = Array.isArray(data.selectors) ? data.selectors.map(value => typeof value === 'string' ? value : value?.selector).filter(value => typeof value === 'string' && value.length > 0) : [];
        if (!selectors.length) subtreeWithoutSelectors++;
        for (const selector of new Set(selectors)) subtreeSelectors.set(selector, (subtreeSelectors.get(selector) || 0) + 1);
      }
    }
    if (event.name === 'UpdateLayoutTree' && event.ph === 'X' && Number.isFinite(event.dur) && event.dur >= 0) {
      layoutDurations.push(event.dur / 1000);
      // Chromium stores this on args, not beginData. Retain unavailable counts.
      if (Number.isFinite(event.args?.elementCount) && event.args.elementCount >= 0) layoutElementCounts.push(event.args.elementCount);
    }
  }
  const longTasksByThread = new Map();
  for (const task of longRunTasks) {
    const key = `${task.pid}:${task.tid}`;
    const row = longTasksByThread.get(key) || { pid: task.pid, tid: task.tid, thread: task.thread, count: 0, totalMs: 0, maxMs: 0 };
    row.count++; row.totalMs += task.durationMs; row.maxMs = Math.max(row.maxMs, task.durationMs); longTasksByThread.set(key, row);
  }
  const rawTimestampSpanMs = Number.isFinite(first) && Number.isFinite(last) ? (last - first) / 1000 : null;
  const synchronousWindow = Number.isFinite(syncFirst) && Number.isFinite(syncLast) ? { startUs: syncFirst, endUs: syncLast } : null;
  const observedSynchronousSpanMs = synchronousWindow ? (syncLast - syncFirst) / 1000 : null;
  const asyncBoundaryRecords = { beforeSynchronousWindow: 0, afterSynchronousWindow: 0, beginsBeforeSynchronousWindow: 0 };
  if (synchronousWindow) for (const event of events) {
    if ((event.ph !== 'b' && event.ph !== 'e') || !Number.isFinite(event.ts)) continue;
    if (event.ts < syncFirst) { asyncBoundaryRecords.beforeSynchronousWindow++; if (event.ph === 'b') asyncBoundaryRecords.beginsBeforeSynchronousWindow++; }
    if (event.ts > syncLast) asyncBoundaryRecords.afterSynchronousWindow++;
  }
  const eventLatency = pairEventLatency(events, synchronousWindow);
  const warnings = [
    'Timestamp spans are not capture duration. Async begins may be replayed from before Tracing.start; use the capture summary monotonic captureElapsedMs when available.',
    'This diagnostic trace includes runner calibration, preparation, profiler setup/stop, actions, and restoration. Whole-trace RunTask counts are not action-only app long tasks.'
  ];
  if (!synchronousWindow) warnings.push('No synchronous X window is available; async latency cannot be bounded to observed synchronous work. Raw pairs remain unfiltered.');
  if (asyncBoundaryRecords.beforeSynchronousWindow || asyncBoundaryRecords.afterSynchronousWindow) warnings.push('Async records extend beyond the observed synchronous X window; old replayed begins or boundary work can inflate raw timestamp span.');
  if (eventLatency.withinObservedSynchronousWindow.excludedPairs) warnings.push('EventLatency pairs crossing the observed synchronous window are excluded from window-filtered latency; compatibility fields retain their raw values. This filter does not identify the benchmark action window.');
  return {
    schema: 1, eventCount: events.length,
    durationMs: rawTimestampSpanMs, // Deprecated compatibility alias: NOT capture duration.
    rawTimestampSpanMs, observedSynchronousSpanMs, observedSynchronousWindowUs: synchronousWindow, asyncBoundaryRecords, warnings,
    threads: [...threads].map(([key, name]) => ({ key, name })),
    completeEventDurations: [...totals.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 80),
    longRunTasks: { count: longRunTasks.length, durationMs: summarize(longRunTasks.map(task => task.durationMs)), byThread: [...longTasksByThread.values()], top: longRunTasks.sort((a, b) => b.durationMs - a.durationMs).slice(0, 30) },
    eventLatency,
    scrollJankV4: { available: scrollFlags.length > 0, recordsWithFlag: scrollFlags.length, isJankyCount: scrollFlags.length ? scrollFlags.filter(Boolean).length : null, notJankyCount: scrollFlags.length ? scrollFlags.filter(value => !value).length : null, beginsWithoutFlag: scrollBeginsWithoutFlag },
    pipelineReporter: { available: Object.keys(pipelineStates).length > 0, stateHistogram: pipelineStates },
    styleInvalidations: { available: invalidationCounts.size > 0, countsByEvent: Object.fromEntries(invalidationCounts), subtreeCount: subtreeInvalidations, subtreeWithoutSelectors, subtreeSelectors: [...subtreeSelectors].map(([selector, count]) => ({ selector, count })).sort((a, b) => b.count - a.count || a.selector.localeCompare(b.selector)) },
    updateLayoutTree: { count: layoutDurations.length, durationMs: summarize(layoutDurations), recordsWithElementCount: layoutElementCounts.length, elementCount: summarize(layoutElementCounts) },
    interpretation: [
      'X durations include nested work. Totals across event names, threads, or processes are not additive CPU time.',
      'Long RunTask means an observed task of at least 50ms; it does not by itself identify the source function or prove a dropped presented frame.',
      'EventLatency b/e records are paired by PID, category, scope, name, and id2 (or legacy id), across threads. Buckets retain event_type; unmatched pairs remain visible.',
      'durationMs is a deprecated alias for rawTimestampSpanMs, not capture duration. observedSynchronousSpanMs spans complete X work, not the exact capture or benchmark action window. Raw EventLatency compatibility fields include all paired records; use withinObservedSynchronousWindow with its exclusions for bounded diagnostic statistics.',
      'ScrollJankV4 counts only explicit is_janky booleans. Missing instrumentation is unavailable, not zero jank.',
      'PipelineReporter is a raw state histogram. STATE_PRESENTED_PARTIAL and raw presentation-event gaps are not converted into dropped frames.',
      'Invalidation tracking is optional and expensive. Subtree selectors count records with an explicit selector, not affected DOM nodes. Missing selectors remain explicit; node names and stacks are excluded.',
      'UpdateLayoutTree elementCount is Chromium diagnostic scope, not a measured number of changed nodes. Missing counts remain unavailable; layout durations can be nested within RunTask.',
      'Inspect main, renderer, compositor, and GPU together. An idle renderer or smooth rAF does not rule out a blocked main process or delayed input.'
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [inputPath, outputPath] = process.argv.slice(2);
    if (!inputPath) throw new Error('Usage: node trace-analyze.mjs <trace.json> [new-output.json]');
    const result = analyzeTrace(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
    if (outputPath) {
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
      const countThreads = pattern => result.longRunTasks.byThread.filter(row => pattern.test(row.thread)).reduce((count, row) => count + row.count, 0);
      const boundedLatency = result.eventLatency.withinObservedSynchronousWindow;
      const latency = boundedLatency.available ? boundedLatency : result.eventLatency;
      console.log(JSON.stringify({
        output: path.resolve(outputPath), eventCount: result.eventCount,
        observedSynchronousSpanMs: result.observedSynchronousSpanMs, rawTimestampSpanMs: result.rawTimestampSpanMs,
        asyncBoundaryRecords: result.asyncBoundaryRecords, warnings: result.warnings,
        longRunTasks: { total: result.longRunTasks.count, main: countThreads(/^(?:Cr)?BrowserMain$/), renderer: countThreads(/^(?:Cr)?RendererMain$/) },
        eventLatency: { scope: boundedLatency.available ? 'within-observed-synchronous-window' : 'raw-unbounded', paired: latency.paired, p50Ms: latency.durationMs.p50, p95Ms: latency.durationMs.p95, p99Ms: latency.durationMs.p99, maxMs: latency.durationMs.max, excludedPairs: boundedLatency.excludedPairs, rawPaired: result.eventLatency.paired, unmatchedBegins: result.eventLatency.unmatchedBegins, unmatchedEnds: result.eventLatency.unmatchedEnds },
        scrollJankV4: result.scrollJankV4,
        updateLayoutTree: { count: result.updateLayoutTree.count, maxDurationMs: result.updateLayoutTree.durationMs.max, maxElementCount: result.updateLayoutTree.elementCount.max },
        styleInvalidations: { available: result.styleInvalidations.available, subtreeCount: result.styleInvalidations.subtreeCount, subtreeWithoutSelectors: result.styleInvalidations.subtreeWithoutSelectors, topSubtreeSelectors: result.styleInvalidations.subtreeSelectors.slice(0, 5) }
      }, null, 2));
    } else console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`[trace-analyze] FAILED: ${error.message}`); process.exitCode = 1; }
}
