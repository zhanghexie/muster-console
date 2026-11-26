// Pure regression guards for real-performance tooling; does not connect to an application.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { describeApplicationTargets, evaluationErrorMessage, selectAppTarget } from '../.agents/skills/perf-trace/scripts/cdp-client.mjs';
import { compareCompatibility, compareStepResults, metricDelta, percentile, scrollComparisonIssues, summarize, summarizeFrames } from '../.agents/skills/perf-trace/scripts/metrics.mjs';
import { disposeOwnedProbe, installProbe, keyEventParameters, readyAssertionsMatch, revealElement, scenarioProvenance, stepError, validateScenario } from '../.agents/skills/perf-trace/scripts/real-bench.mjs';

const target = (id, url, type = 'page') => ({ id, url, type, webSocketDebuggerUrl: `ws://127.0.0.1/${id}` });
const bundle = target('bundle', 'file:///E:/Projects/metaagent-workbench/out/renderer/index.html');
assert.equal(selectAppTarget([bundle, target('preview', 'file:///tmp/preview.html')]).id, 'bundle', 'production bundle target must be discoverable');
assert.equal(selectAppTarget([target('installed', 'file:///C:/Programs/MetaAgent/resources/app.asar/out/renderer/index.html')]).id, 'installed');
assert.equal(selectAppTarget([target('dev', 'http://localhost:5188/')]).id, 'dev');
assert.throws(() => selectAppTarget([bundle, target('dev', 'http://localhost:5188/')]), /found 2/, 'ambiguous instances must not silently select the wrong one');
assert.equal(selectAppTarget([bundle, target('dev', 'http://localhost:5188/')], 'bundle').id, 'bundle');
assert.throws(() => selectAppTarget([bundle], 'missing'), /does not exist/);
assert.throws(() => selectAppTarget([target('browser', 'https://example.org/')]), /found 0/);
assert.throws(() => selectAppTarget([target('browser', 'https://example.org/app.asar/index.html')], 'browser'), /not a recognized application/);
const descriptions = describeApplicationTargets([bundle, target('external', 'https://example.org/private?token=DO_NOT_PRINT#secret'), target('dev', 'http://localhost:5188/?token=DO_NOT_PRINT#secret')]);
assert.equal(descriptions.length, 2);
assert.deepEqual(descriptions.find(item => item.id === 'dev'), { id: 'dev', kind: 'dev', origin: 'http://localhost:5188', entrypoint: '/' });
assert.equal(JSON.stringify(descriptions).includes('DO_NOT_PRINT'), false, 'discovery must not print query/hash secrets');
assert.equal(JSON.stringify(descriptions).includes('example.org'), false, 'external page URLs must not be printed');

// The measurement window must include a freeze before its FIRST animation-frame callback.
let clock = 10, queuedFrame, cancelledFrame;
const callbacks = new Map();
const probeWindow = {};
const probeContext = {
  window: probeWindow,
  performance: { now: () => clock },
  PerformanceObserver: class { static supportedEntryTypes = []; },
  requestAnimationFrame: callback => { queuedFrame = callback; return 7; },
  cancelAnimationFrame: id => { cancelledFrame = id; },
  addEventListener: (name, callback) => callbacks.set(name, callback),
  removeEventListener: name => callbacks.delete(name),
  document: { hidden: false, addEventListener() {}, removeEventListener() {} }
};
vm.runInNewContext(`(${installProbe.toString()})()`, probeContext);
probeWindow.__maRealPerf.start();
clock = 260; queuedFrame();
const firstWindow = probeWindow.__maRealPerf.stop();
assert.equal(firstWindow.frames[0], 250, 'a cold action freezing before its first rAF must not disappear from the capture');
clock = 300; probeWindow.__maRealPerf.start();
callbacks.get('wheel')({ type: 'wheel', timeStamp: 290 });
clock = 320; queuedFrame(275); // The shared rAF frame timestamp may predate receipt of this input.
const inputWindow = probeWindow.__maRealPerf.stop();
assert.equal(inputWindow.inputs[0].toNextRaf, 20, 'input-to-callback time must use callback performance.now, not an older frame timestamp');
probeWindow.__maRealPerf.dispose();
assert.equal(cancelledFrame, 7);
assert.equal(callbacks.size, 0, 'probe must clean up its input listeners');
assert.equal(probeWindow.__maRealPerf, undefined);
let disposedOwner;
const ownedContext = { window: { __maRealPerf: { ownerToken: 'other-benchmark', dispose: () => { disposedOwner = 'other-benchmark'; } } } };
assert.equal(vm.runInNewContext(`(${disposeOwnedProbe.toString()})('this-benchmark')`, ownedContext), 'different-owner');
assert.equal(disposedOwner, undefined, 'spawning a child never authorizes disposing a competing/new benchmark probe');
ownedContext.window.__maRealPerf = { ownerToken: 'this-benchmark', dispose: () => { disposedOwner = 'this-benchmark'; } };
assert.equal(vm.runInNewContext(`(${disposeOwnedProbe.toString()})('this-benchmark')`, ownedContext), 'disposed');
assert.equal(disposedOwner, 'this-benchmark');
delete ownedContext.window.__maRealPerf;
assert.equal(vm.runInNewContext(`(${disposeOwnedProbe.toString()})('this-benchmark')`, ownedContext), 'absent', 'normally cleaned child must not make cleanup fail');

assert.equal(percentile([], .5), null, 'missing observations must remain unavailable');
assert.deepEqual(summarize([1, 2, 3, Number.NaN]), { count: 3, p50: 2, p95: 3, p99: 3, max: 3, total: 6 });
const fastDisplay = summarizeFrames([8.33, 8.33, 16.66, 33.32, 110], 8.33);
assert.equal(fastDisplay.over1_5, 3, '120 Hz misses must not be accepted by a fixed 16.67ms threshold');
assert.equal(fastDisplay.over4, 1);
assert.equal(fastDisplay.over100ms, 1);
assert.equal(summarizeFrames([16.67, 16.67, 16.67], 16.67).estimatedMissedSlots, 0);
assert.throws(() => summarizeFrames([1], 0), /positive/);
const metrics = metricDelta([{ name: 'TaskDuration', value: 1 }, { name: 'JSHeapUsedSize', value: 100 }], [{ name: 'TaskDuration', value: 1.25 }, { name: 'JSHeapUsedSize', value: 120 }], 1000);
assert.equal(metrics.rendererMainThreadBusyPercent, 25);
assert.equal(metrics.gauges.JSHeapUsedSize.delta, 20);
assert.equal(metrics.gauges.Nodes.delta, null, 'unavailable metrics are not zero');

const valid = { id: 'scroll-v1', cacheState: 'warm', steps: [{ name: 'up', kind: 'scroll', selector: '.chat-list', deltaY: -120 }] };
const provenanceInput = { ...valid, build: 'before', targetId: 'runtime-target', prepare: [{ name: 'reveal', kind: 'click', selector: '[data-session-row="synthetic"]', revealTarget: true }] };
const provenance = scenarioProvenance(provenanceInput);
assert.equal(Object.hasOwn(provenance.scenarioDefinition, 'build'), false);
assert.equal(Object.hasOwn(provenance.scenarioDefinition, 'targetId'), false);
assert.equal(provenance.scenarioHash, createHash('sha256').update(JSON.stringify(provenance.scenarioDefinition)).digest('hex'), 'report hash must describe exactly the private snapshot that was persisted');
assert.equal(scenarioProvenance({ ...provenanceInput, build: 'after', targetId: 'new-runtime-target' }).scenarioHash, provenance.scenarioHash, 'runtime/build identity is recorded separately from scenario identity');
provenanceInput.prepare[0].revealTarget = false;
assert.equal(provenance.scenarioDefinition.prepare[0].revealTarget, true, 'saved input snapshot must be detached from later manifest/config edits');
assert.notEqual(scenarioProvenance(provenanceInput).scenarioHash, provenance.scenarioHash, 'preparation differences must remain identity changes, never be hidden to permit comparison');
assert.equal(validateScenario(valid), 3);
assert.throws(() => validateScenario({ ...valid, cacheState: 'first-entry' }), /one round/);
assert.throws(() => validateScenario({ ...valid, steps: [{ name: 'click', kind: 'click', selector: 'button', intent: 'navigate', ready: [] }] }), /nonempty/, 'empty readiness assertion must not produce a false pass');
assert.throws(() => validateScenario({ ...valid, steps: [{ name: 'click', kind: 'click', selector: 'button', intent: 'navigate', ready: {} }] }), /nonempty/);
assert.throws(() => validateScenario({ ...valid, steps: [{ ...valid.steps[0], deltaY: 0 }] }), /nonzero/);

const navigation = { name: 'close-settings', kind: 'click', selector: '.settings-back', intent: 'navigate', revealTarget: true, afterSelector: '.chrome-settings', ready: [{ selector: '.settings-modal', absent: true }] };
assert.equal(validateScenario({ ...valid, steps: [navigation] }), 3);
assert.throws(() => validateScenario({ ...valid, steps: [{ ...navigation, revealTarget: 'yes' }] }), /boolean/);
assert.throws(() => validateScenario({ ...valid, steps: [{ ...navigation, afterSelector: '' }] }), /nonempty/);
assert.throws(() => validateScenario({ ...valid, steps: [{ ...navigation, ready: [{ selector: '.modal', absent: 'true' }] }] }), /nonempty/);
assert.throws(() => validateScenario({ ...valid, steps: [{ ...navigation, ready: [{ selector: '.modal', absent: true, attribute: 'class', value: 'open' }] }] }), /nonempty/);
let revealOptions;
const revealed = { getBoundingClientRect: () => ({ width: 80, height: 24 }), scrollIntoView: options => { revealOptions = options; } };
vm.runInNewContext(`(${revealElement.toString()})('.clipped-row')`, { document: { querySelectorAll: () => [revealed] } });
assert.deepEqual(JSON.parse(JSON.stringify(revealOptions)), { block: 'nearest', inline: 'nearest', behavior: 'instant' }, 'explicit reveal must use nearest immediate scrolling outside the measurement window');
const readyElement = { getBoundingClientRect: () => ({ left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }), getAttribute: () => 'active', parentElement: null };
const checkReady = (assertions, element) => vm.runInNewContext(`(${readyAssertionsMatch.toString()})(${JSON.stringify(assertions)})`, { innerWidth: 1000, innerHeight: 800, getComputedStyle: item => ({ display: 'block', visibility: 'visible', overflowX: 'visible', overflowY: 'visible', ...item.testStyle }), document: { querySelectorAll: () => element == null ? [] : Array.isArray(element) ? element : [element] } });
assert.equal(checkReady([], null), false, 'empty readiness must never pass');
assert.equal(checkReady([{ selector: '.modal', absent: true }], null), true);
assert.equal(checkReady([{ selector: '.modal', absent: true }], readyElement), false, 'absent means removed, not merely a truthy assertion');
assert.equal(checkReady([{ selector: '.row', attribute: 'class', value: 'active' }], readyElement), true);
assert.equal(checkReady([{ selector: '.row' }], null), false);
assert.equal(checkReady([{ selector: '.row' }], { ...readyElement, testStyle: { visibility: 'hidden' } }), false);
assert.equal(checkReady([{ selector: '.row' }], [{ ...readyElement, testStyle: { visibility: 'hidden' } }, readyElement]), true, 'a hidden first match must not mask a later visible match');
assert.equal(checkReady([{ selector: '.row' }], { ...readyElement, parentElement: { ...readyElement, inert: true } }), false);
assert.equal(checkReady([{ selector: '.row' }], { ...readyElement, parentElement: { ...readyElement, getAttribute: key => key === 'aria-hidden' ? 'true' : null } }), false);
assert.equal(checkReady([{ selector: '.row' }], { ...readyElement, getBoundingClientRect: () => ({ left: 10, top: 900, right: 60, bottom: 920, width: 50, height: 20 }) }), false);
assert.equal(checkReady([{ selector: '.row' }], { ...readyElement, parentElement: { ...readyElement, getBoundingClientRect: () => ({ left: 0, top: 0, right: 80, bottom: 5, width: 80, height: 5 }), testStyle: { overflowY: 'hidden' } } }), false, 'a target completely clipped by a scroll ancestor is not ready');
assert.equal(checkReady([{ selector: '.row' }], { ...readyElement, testStyle: { opacity: '0' } }), true, 'readiness must not acquire a new wait-for-opacity-completion measurement contract');
const controlledDetails = { exception: { description: 'Error: Scenario target is obscured/offscreen\n at private-file-path' } };
assert.equal(evaluationErrorMessage(controlledDetails, ['Scenario target is obscured/offscreen']), 'Page evaluation failed: Scenario target is obscured/offscreen');
assert.equal(evaluationErrorMessage({ exception: { description: 'Error: private conversation body' } }, ['Scenario target is obscured/offscreen']), 'Page evaluation failed (application text deliberately omitted)');
assert.match(stepError(new Error('target missing'), { name: 'meta2' }, 2, 'inspect-before').message, /round=2 step="meta2" stage=inspect-before.*target missing/);
assert.equal(validateScenario({ ...valid, steps: [{ name: 'escape', kind: 'key', key: 'Escape', ready: [{ selector: '.quick-open', absent: true }] }] }), 3);
assert.equal(validateScenario({ ...valid, steps: [{ name: 'hover-vs', kind: 'hover', selector: '.vs-handle', ready: [{ selector: '.vs-expanded' }] }] }), 3);
assert.equal(keyEventParameters('Ctrl+P').modifiers, 2);
assert.equal(keyEventParameters('Ctrl+Shift+G').modifiers, 10);
assert.deepEqual(keyEventParameters('Ctrl+Shift+Backslash'), { key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220, modifiers: 10 });
assert.equal(validateScenario({ ...valid, steps: [{ name: 'vs-switch', kind: 'key', key: 'Ctrl+Shift+Backslash', ready: [{ selector: '.app-shell', attribute: 'data-dock', value: 'git' }] }] }), 3);
assert.throws(() => keyEventParameters('Enter'), /Only Escape/);
assert.throws(() => validateScenario({ ...valid, steps: [{ name: 'enter', kind: 'key', key: 'Enter', ready: [{ selector: '.sent' }] }] }), /Only Escape/, 'key automation must not acquire a text/submit route');
assert.throws(() => validateScenario({ ...valid, steps: [{ name: 'hover', kind: 'hover', selector: '.handle', ready: [] }] }), /nonempty/);

const capture = { schema: 1, toolRevision: 2, status: 'complete', scenarioHash: 'same', environment: { width: 1200 }, profileEnabled: false, calibration: { budgetMs: 8.33 }, results: [] };
assert.deepEqual(compareCompatibility(capture, structuredClone(capture)), []);
assert.ok(compareCompatibility(capture, { ...capture, status: 'incomplete' }).includes('incomplete capture'));
assert.ok(compareCompatibility(capture, { ...capture, scenarioHash: 'different' }).includes('scenario'));
assert.ok(compareCompatibility(capture, { ...capture, calibration: { budgetMs: 16.67 } }).some(reason => reason.includes('cadence')));
assert.ok(compareCompatibility(capture, { ...capture, profileEnabled: true }).includes('profiler overhead'));
const scrollSample = { name: 'scroll-up', kind: 'scroll', round: 1, durationMs: 1000, observedInput: { count: 20 }, dispatch: { roundtripMs: { count: 20 }, cadenceMs: { p50: 16, p95: 17 }, latenessMs: { p95: 1 } }, restoration: { method: 'absolute', actualTop: 246 }, before: { scrollTop: 1200, scrollHeight: 5000, witnessHash: 'content-a', witnessChars: 8000 }, frames: { p95: 16, p99: 17, over1_5: 0 }, longtasks: { total: 0 }, readyMs: null, metrics: { durationMs: { TaskDuration: 20 }, gauges: { JSHeapUsedSize: { after: 100 } } } };
assert.deepEqual(scrollComparisonIssues(scrollSample, structuredClone(scrollSample)), []);
assert.equal(compareStepResults(scrollSample, structuredClone(scrollSample)).comparable, true);
for (const mutate of [
  value => { value.dispatch.cadenceMs.p95 = 35; },
  value => { value.dispatch.latenessMs.p95 = 20; },
  value => { value.observedInput.count = 19; },
  value => { value.durationMs = 1600; },
  value => { value.restoration.method = 'clamped-absolute'; },
  value => { value.restoration.actualTop = 250; }
]) {
  const unequal = structuredClone(scrollSample); mutate(unequal);
  const row = compareStepResults(scrollSample, unequal);
  assert.equal(row.comparable, false);
  assert.equal(Object.hasOwn(row, 'rendererTaskMs'), false, 'unequal scroll loads must not produce absolute cost/benefit deltas');
  assert.equal(Object.hasOwn(row, 'frameP95'), false);
  assert.ok(row.reasons.length > 0);
}
assert.equal(compareStepResults({ ...scrollSample, kind: 'click', readyMs: 100 }, { ...scrollSample, kind: 'click', readyMs: 50 }, { readinessChanged: true }).readyMs, null, 'new visibility-policy captures must not imply directly comparable legacy readyMs');
console.log('perf-real-bench: target selection, high-refresh frame budgets, unavailable metrics, readiness, and comparable-capture guards passed');
