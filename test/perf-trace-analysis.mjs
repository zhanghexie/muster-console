// Pure fixtures: no browser, profiler, real session, or external service.
import assert from 'node:assert/strict';
import { analyzeTrace, pairEventLatency } from '../.agents/skills/perf-trace/scripts/trace-analyze.mjs';
import { parseTraceArguments, traceCategories } from '../.agents/skills/perf-trace/scripts/trace-config.mjs';

const latency = (ph, pid, tid, ts, local, type) => ({ name: 'EventLatency', cat: 'latencyInfo', ph, pid, tid, ts, id2: { local }, args: type ? { event_latency: { event_type: type } } : {} });
const fixture = { traceEvents: [
  { name: 'thread_name', ph: 'M', pid: 1, tid: 10, args: { name: 'CrBrowserMain' } },
  { name: 'thread_name', ph: 'M', pid: 2, tid: 20, args: { name: 'CrRendererMain' } },
  { name: 'ThreadControllerImpl::RunTask', ph: 'X', pid: 1, tid: 10, ts: 1000, dur: 100000 },
  { name: 'FunctionCall', ph: 'X', pid: 1, tid: 10, ts: 1000, dur: 80000 },
  { name: 'RunTask', ph: 'X', pid: 2, tid: 20, ts: 1000, dur: 2000 },
  latency('b', 1, 10, 1000, 'same-id', 'MOUSE_WHEEL'),
  latency('b', 2, 20, 1200, 'same-id', 'GESTURE_SCROLL_UPDATE'),
  latency('e', 1, 99, 11000, 'same-id'), // Async completion may cross threads, but must not cross PIDs.
  latency('e', 2, 20, 21200, 'same-id'),
  latency('b', 1, 10, 30000, 0, 'MOUSE_WHEEL'),
  latency('e', 1, 10, 40000, 0),
  latency('b', 1, 10, 41000, 'unclosed', 'MOUSE_WHEEL'),
  latency('e', 1, 10, 42000, 'never-started'),
  { name: 'ScrollJankV4', ph: 'b', pid: 2, tid: 20, ts: 1000, args: { scroll_jank_v4: { is_janky: false } } },
  { name: 'ScrollJankV4', ph: 'e', pid: 2, tid: 20, ts: 2000, args: {} },
  { name: 'ScrollJankV4', ph: 'b', pid: 2, tid: 20, ts: 3000, args: { scroll_jank_v4: { is_janky: true } } },
  { name: 'PipelineReporter', ph: 'b', pid: 2, tid: 20, ts: 1000, args: { frame_reporter: { state: 'STATE_PRESENTED_PARTIAL' } } },
  { name: 'PipelineReporter', ph: 'e', pid: 2, tid: 20, ts: 2000, args: {} },
  { name: 'PipelineReporter', ph: 'b', pid: 2, tid: 20, ts: 3000, args: { frame_reporter: { state: 'STATE_PRESENTED_ALL' } } },
  { name: 'Presentation', ph: 'I', pid: 2, tid: 20, ts: 1000 },
  { name: 'Presentation', ph: 'I', pid: 2, tid: 20, ts: 999999 }
] };
const result = analyzeTrace(fixture);
assert.equal(result.eventLatency.paired, 3);
assert.equal(result.eventLatency.byEventType.MOUSE_WHEEL.count, 2);
assert.equal(result.eventLatency.byEventType.MOUSE_WHEEL.p95, 10);
assert.equal(result.eventLatency.byEventType.GESTURE_SCROLL_UPDATE.p95, 20);
assert.equal(result.eventLatency.unmatchedBegins, 1);
assert.equal(result.eventLatency.unmatchedEnds, 1);
assert.equal(result.longRunTasks.count, 1);
assert.equal(result.longRunTasks.top[0].thread, 'CrBrowserMain');
assert.equal(result.completeEventDurations.find(row => row.name === 'FunctionCall').totalMs, 80);
assert.ok(result.interpretation.some(note => note.includes('not additive')), 'nested X durations must not be presented as a summed CPU total');
assert.deepEqual(result.scrollJankV4, { available: true, recordsWithFlag: 2, isJankyCount: 1, notJankyCount: 1, beginsWithoutFlag: 0 });
assert.deepEqual(result.pipelineReporter.stateHistogram, { STATE_PRESENTED_PARTIAL: 1, STATE_PRESENTED_ALL: 1 });
assert.equal(Object.hasOwn(result, 'droppedFrames'), false, 'partial presentation states and large Presentation gaps must not fabricate dropped-frame counts');
assert.equal(analyzeTrace({ traceEvents: [] }).scrollJankV4.isJankyCount, null, 'no instrumentation must remain unavailable');
assert.equal(analyzeTrace({ traceEvents: [] }).pipelineReporter.available, false);
assert.throws(() => analyzeTrace({}), /traceEvents/);
assert.equal(pairEventLatency([latency('b', 1, 10, 1000, 'id'), { ...latency('e', 1, 20, 2000, 'id'), scope: 'other' }]).paired, 0, 'scope must participate in async identity');

const selector = '.app-shell:has(> .settings-page) > .main-view *';
const invalidationFixture = [
  { name: 'StyleInvalidatorInvalidationTracking', ph: 'I', args: { data: { reason: 'Invalidation set invalidates subtree', selectors: [{ selector, style_sheet_id: 'private-sheet' }, { selector }], nodeName: 'PRIVATE_BODY', stackTrace: [{ functionName: 'PRIVATE_STACK' }], extraData: 'PRIVATE_EXTRA' } } },
  { name: 'StyleInvalidatorInvalidationTracking', ph: 'I', args: { data: { reason: 'Invalidation set invalidates subtree', selectors: [selector, '.board-panel'], nodeName: 'PRIVATE_BODY' } } },
  { name: 'StyleInvalidatorInvalidationTracking', ph: 'I', args: { data: { reason: 'Invalidation set invalidates subtree', nodeName: 'PRIVATE_BODY', extraData: '.must-not-guess-selector' } } },
  { name: 'StyleInvalidatorInvalidationTracking', ph: 'I', args: { data: { reason: 'Invalidation set matched class', selectors: [{ selector: '.not-subtree' }] } } },
  { name: 'UpdateLayoutTree', ph: 'X', pid: 2, tid: 20, ts: 1000, dur: 75000, args: { elementCount: 18000, beginData: { elementCount: 999999, nodeName: 'PRIVATE_BODY' } } },
  { name: 'UpdateLayoutTree', ph: 'X', pid: 2, tid: 20, ts: 100000, dur: 12000, args: { elementCount: 400 } },
  { name: 'UpdateLayoutTree', ph: 'X', pid: 2, tid: 20, ts: 120000, dur: 1000, args: {} }
];
const invalidations = analyzeTrace(invalidationFixture);
assert.deepEqual(invalidations.styleInvalidations.subtreeSelectors, [{ selector, count: 2 }, { selector: '.board-panel', count: 1 }], 'deduplicate selectors within one record, count subtree events only');
assert.equal(invalidations.styleInvalidations.subtreeCount, 3);
assert.equal(invalidations.styleInvalidations.subtreeWithoutSelectors, 1);
assert.equal(invalidations.updateLayoutTree.count, 3);
assert.equal(invalidations.updateLayoutTree.recordsWithElementCount, 2);
assert.equal(invalidations.updateLayoutTree.durationMs.max, 75);
assert.equal(invalidations.updateLayoutTree.elementCount.max, 18000, 'read args.elementCount rather than unrelated nested fields');
assert.equal(/PRIVATE_|private-sheet|must-not-guess-selector/.test(JSON.stringify(invalidations)), false, 'summary must not retain node names, stack, extraData, or stylesheet identity');
assert.equal(analyzeTrace([]).styleInvalidations.available, false);
assert.equal(analyzeTrace([]).updateLayoutTree.elementCount.max, null);
assert.deepEqual(parseTraceArguments(['9333', 'scenario.json', 'new-prefix']), { port: '9333', scenarioPath: 'scenario.json', prefix: 'new-prefix', invalidationsEnabled: false });
assert.equal(parseTraceArguments(['9333', 'scenario.json', 'new-prefix', '--invalidations']).invalidationsEnabled, true);
assert.equal(traceCategories().includes('invalidationTracking'), false, 'expensive instrumentation must be opt-in');
assert.equal(traceCategories(true).split(',').filter(value => value === 'disabled-by-default-devtools.timeline.invalidationTracking').length, 1);
assert.throws(() => parseTraceArguments(['9333', 's', 'o', '--invalidations', '--invalidations']), /Usage/);
assert.throws(() => parseTraceArguments(['9333', 's', 'o', '--screenshots']), /Usage/);
assert.throws(() => parseTraceArguments(['9333', 's', 'o', 'extra']), /Usage/);

// Tracing.start can replay an async begin whose real timestamp predates capture.
// Preserve raw data while preventing that replay from becoming a capture duration
// or an ordinary in-window latency sample.
const replayed = analyzeTrace([
  { name: 'FrameSequenceTrackerV3', ph: 'b', pid: 2, tid: 20, ts: 14_000_000, id2: { local: 'old-frame' } },
  { name: 'RunTask', ph: 'X', pid: 2, tid: 20, ts: 300_000_000, dur: 12_000_000 },
  latency('b', 2, 20, 15_000_000, 'old-input', 'MOUSE_WHEEL'),
  latency('e', 2, 20, 300_001_000, 'old-input'),
  latency('b', 2, 20, 300_002_000, 'fresh-input', 'MOUSE_WHEEL'),
  latency('e', 2, 20, 300_004_000, 'fresh-input'),
  latency('b', 2, 20, 311_999_000, 'late-end', 'MOUSE_WHEEL'),
  latency('e', 2, 20, 312_100_000, 'late-end')
]);
assert.equal(replayed.rawTimestampSpanMs, 298100);
assert.equal(replayed.durationMs, replayed.rawTimestampSpanMs, 'deprecated field must remain a clearly documented raw-span compatibility alias');
assert.equal(replayed.observedSynchronousSpanMs, 12000);
assert.deepEqual(replayed.observedSynchronousWindowUs, { startUs: 300_000_000, endUs: 312_000_000 });
assert.deepEqual(replayed.asyncBoundaryRecords, { beforeSynchronousWindow: 2, afterSynchronousWindow: 1, beginsBeforeSynchronousWindow: 2 });
assert.equal(replayed.eventLatency.paired, 3, 'keep raw paired values for inspection and compatibility');
assert.equal(replayed.eventLatency.durationMs.max, 285001);
assert.equal(replayed.eventLatency.withinObservedSynchronousWindow.paired, 1);
assert.equal(replayed.eventLatency.withinObservedSynchronousWindow.durationMs.max, 2);
assert.equal(replayed.eventLatency.withinObservedSynchronousWindow.excludedPairs, 2);
assert.equal(replayed.eventLatency.withinObservedSynchronousWindow.beginRecordsOutsideWindow, 1);
assert.equal(replayed.eventLatency.withinObservedSynchronousWindow.endRecordsOutsideWindow, 1);
assert.ok(replayed.warnings.some(value => value.includes('not capture duration')));
assert.ok(replayed.warnings.some(value => value.includes('old replayed begins')));
assert.ok(replayed.warnings.some(value => value.includes('profiler setup/stop')));
const onlyAsync = analyzeTrace([latency('b', 1, 1, 1000, 'async'), latency('e', 1, 1, 2000, 'async')]);
assert.equal(onlyAsync.observedSynchronousSpanMs, null);
assert.equal(onlyAsync.eventLatency.withinObservedSynchronousWindow.available, false);
assert.equal(onlyAsync.eventLatency.paired, 1, 'missing synchronous instrumentation must not drop raw async pairs');
assert.ok(onlyAsync.warnings.some(value => value.includes('No synchronous X window')));
console.log('perf-trace-analysis: scoped timing with replayed async begins, thread/latency aggregation, jank, pipeline states, invalidations, private selectors, and layout scope passed');
