// Real application only: node real-bench.mjs <port> <scenario.json> <new-output.json>
// Does not reload, seed data, call window.api, write drafts, collect conversation text, or kill processes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { connectCdp, sleep } from './cdp-client.mjs';
import { metricDelta, summarize, summarizeFrames } from './metrics.mjs';

function installProbe(ownerToken = null) {
  if (window.__maRealPerf) throw new Error('Another real performance probe is active');
  let active = false, start = 0, lastFrame = null, raf;
  let frames = [], longtasks = [], events = [], inputs = [], visibility = [];
  const observers = [];
  const supported = PerformanceObserver.supportedEntryTypes || [];
  const observe = (type, callback, options = {}) => {
    if (!supported.includes(type)) return;
    const observer = new PerformanceObserver(list => { if (active) callback(list.getEntries()); });
    observer.observe({ type, ...options }); observers.push(observer);
  };
  observe('longtask', entries => { for (const entry of entries) longtasks.push({ start: entry.startTime, duration: entry.duration }); });
  observe('event', entries => { for (const entry of entries) events.push({ start: entry.startTime, duration: entry.duration, inputDelay: entry.processingStart - entry.startTime, processing: entry.processingEnd - entry.processingStart, name: entry.name }); }, { durationThreshold: 16 });
  const frame = () => {
    const now = performance.now();
    if (active) { if (lastFrame != null && now >= lastFrame) frames.push(now - lastFrame); lastFrame = now; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const onInput = event => {
    if (!active) return;
    const windowStart = start, received = performance.now();
    const inputDelay = Math.max(0, received - event.timeStamp);
    requestAnimationFrame(() => { const callbackAt = performance.now(); if (active && start === windowStart) inputs.push({ type: event.type, inputDelay, toNextRaf: callbackAt - received }); });
  };
  for (const type of ['wheel', 'pointerdown', 'keydown']) addEventListener(type, onInput, { passive: true, capture: true });
  const onVisibility = () => { if (active) visibility.push({ at: performance.now(), hidden: document.hidden }); };
  document.addEventListener('visibilitychange', onVisibility);
  window.__maRealPerf = {
    ownerToken,
    start() { frames = []; longtasks = []; events = []; inputs = []; visibility = []; start = performance.now(); lastFrame = start; active = true; return start; },
    stop() { const end = performance.now(); active = false; return { start, end, frames, longtasks: longtasks.filter(entry => entry.start + entry.duration > start && entry.start < end), events: events.filter(entry => entry.start >= start && entry.start < end), inputs, visibility, hidden: document.hidden }; },
    dispose() { active = false; cancelAnimationFrame(raf); for (const observer of observers) observer.disconnect(); for (const type of ['wheel', 'pointerdown', 'keydown']) removeEventListener(type, onInput, true); document.removeEventListener('visibilitychange', onVisibility); delete window.__maRealPerf; }
  };
  return { supported };
}

function disposeOwnedProbe(ownerToken) {
  const probe = window.__maRealPerf;
  if (!probe) return 'absent';
  if (probe.ownerToken !== ownerToken) return 'different-owner';
  probe.dispose(); return 'disposed';
}

function inspectElement(selector, index = 0, witnessSelector) {
  const elements = [...document.querySelectorAll(selector)].filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
  const element = elements[index];
  if (!element) throw new Error('Visible scenario target missing');
  const rect = element.getBoundingClientRect();
  const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(element === hit || element.contains(hit))) throw new Error('Scenario target is obscured/offscreen');
  const witness = witnessSelector ? document.querySelector(witnessSelector) : element;
  if (!witness) throw new Error('Scenario witness missing');
  // Hash locally. Never return content, titles, message text, aria labels, or file contents over CDP.
  const text = witness.textContent || '';
  let signature = 2166136261;
  for (let i = 0; i < text.length; i++) signature = Math.imul(signature ^ text.charCodeAt(i), 16777619);
  let anchor = null;
  // Inspect at most three hit-tested visible rows. Measuring every offscreen row defeats content-visibility.
  for (const ratio of [.2, .5, .8]) {
    const atY = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height * ratio));
    const row = document.elementFromPoint(x, atY)?.closest('[data-mid],[data-message-id]');
    if (row && element.contains(row)) {
      const attribute = row.hasAttribute('data-mid') ? 'data-mid' : 'data-message-id';
      anchor = { attribute, value: row.getAttribute(attribute), offset: row.getBoundingClientRect().top - rect.top }; break;
    }
  }
  return { x, y, visibleMatches: elements.length, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, atBottom: element.scrollHeight - element.clientHeight - element.scrollTop <= 2, anchor, childCount: witness.childElementCount, witnessChars: text.length, witnessHash: (signature >>> 0).toString(16), nodes: witness.getElementsByTagName('*').length, codeBlocks: witness.querySelectorAll('pre').length, tables: witness.querySelectorAll('table').length, images: witness.querySelectorAll('img').length };
}

function revealElement(selector, index = 0) {
  const elements = [...document.querySelectorAll(selector)].filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
  const element = elements[index];
  if (!element) throw new Error('Visible scenario target missing');
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  return true;
}

function readyAssertionsMatch(assertions) {
  if (!Array.isArray(assertions) || !assertions.length) return false;
  const visible = element => {
    if (element.isConnected === false) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (current !== element) {
        const clip = current.getBoundingClientRect();
        if (style.overflowX && style.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
        if (style.overflowY && style.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
      }
    }
    // Opacity transitions remain part of the measured window; readiness does not wait for animation completion.
    return right > left && bottom > top;
  };
  return assertions.every(assertion => {
    const elements = [...document.querySelectorAll(assertion.selector)];
    if (assertion.absent === true) return elements.length === 0;
    return elements.some(element => visible(element) && (!assertion.attribute || element.getAttribute(assertion.attribute) === String(assertion.value)));
  });
}

function keyEventParameters(key) {
  const allowed = {
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 },
    'Ctrl+P': { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 2 },
    'Ctrl+Shift+G': { key: 'G', code: 'KeyG', windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71, modifiers: 10 },
    'Ctrl+Shift+Backslash': { key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220, modifiers: 10 }
  };
  if (!Object.hasOwn(allowed, key)) throw new Error('Only Escape, Ctrl+P, Ctrl+Shift+G, and Ctrl+Shift+Backslash navigation keys are allowed');
  return allowed[key];
}

function stepError(error, step, round, stage) {
  return new Error(`[round=${round} step=${JSON.stringify(step.name)} stage=${stage}] ${error.message}`);
}

function validateScenario(config) {
  if (!config.id || typeof config.id !== 'string') throw new Error('Scenario needs a stable id');
  if (!['first-entry', 'warm', 'mixed'].includes(config.cacheState)) throw new Error('Declare cacheState: first-entry, warm, or mixed (never claim cache clearing)');
  if (!Array.isArray(config.steps) || !config.steps.length) throw new Error('Scenario needs steps');
  const rounds = config.rounds ?? 3;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('rounds must be 1..20');
  if (config.cacheState === 'first-entry' && rounds !== 1) throw new Error('first-entry must have one round; record warm repetitions separately');
  for (const step of [...(config.prepare || []), ...config.steps]) {
    if (!step.name || !['idle', 'scroll', 'click', 'key', 'hover'].includes(step.kind)) throw new Error('Every step needs a name and idle/scroll/click/key/hover kind');
    if (!['idle', 'key'].includes(step.kind) && !step.selector) throw new Error('Interactive step needs selector');
    if (['click', 'key', 'hover'].includes(step.kind)) {
      const ready = Array.isArray(step.ready) ? step.ready : [step.ready];
      if ((step.kind === 'click' && step.intent !== 'navigate') || !ready.length || ready.some(assertion => !assertion || typeof assertion.selector !== 'string' || !assertion.selector.trim() || (assertion.attribute && assertion.value == null) || (assertion.absent != null && typeof assertion.absent !== 'boolean') || (assertion.absent === true && assertion.attribute))) throw new Error('Navigation needs nonempty readiness assertions; clicks require intent:navigate');
      if (step.revealTarget != null && typeof step.revealTarget !== 'boolean') throw new Error('revealTarget must be a boolean');
      if (step.afterSelector != null && (typeof step.afterSelector !== 'string' || !step.afterSelector.trim())) throw new Error('afterSelector must be a nonempty selector');
      if (step.kind === 'key') keyEventParameters(step.key);
    }
    if (step.kind === 'scroll') {
      if (!Number.isFinite(step.deltaY) || step.deltaY === 0) throw new Error('Scroll needs a nonzero deltaY');
      if (!Number.isInteger(step.count ?? 30) || (step.count ?? 30) < 1 || (step.count ?? 30) > 300) throw new Error('Scroll count must be 1..300');
      if (!Number.isInteger(step.maxInFlight ?? 1) || (step.maxInFlight ?? 1) < 1 || (step.maxInFlight ?? 1) > 16) throw new Error('maxInFlight must be 1..16');
      if (step.startRatio != null && (!(step.startRatio >= 0) || !(step.startRatio <= 1))) throw new Error('startRatio must be 0..1');
    }
  }
  return rounds;
}

// Copy the exact JSON input used for identity, detached from later config edits.
// Keep private selectors/IDs in the report file; never print this snapshot.
export function scenarioProvenance(config) {
  const scenarioDefinition = JSON.parse(JSON.stringify(config));
  delete scenarioDefinition.build; delete scenarioDefinition.targetId;
  return { scenarioDefinition, scenarioHash: createHash('sha256').update(JSON.stringify(scenarioDefinition)).digest('hex') };
}

export { disposeOwnedProbe, installProbe, keyEventParameters, readyAssertionsMatch, revealElement, stepError, validateScenario };

async function main() {
  const [port, scenarioPath, outputPath] = process.argv.slice(2);
  if (!port || !scenarioPath || !outputPath) throw new Error('Usage: node real-bench.mjs <port> <scenario.json> <new-output.json>');
  if (fs.existsSync(outputPath)) throw new Error('Output exists; use a new path to preserve baseline');
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const config = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const rounds = validateScenario(config);
  const report = { schema: 1, toolRevision: 2, readinessPolicy: 'visible-ancestors-viewport-v1', status: 'incomplete', ...scenarioProvenance(config), scenarioId: config.id, cacheState: config.cacheState, build: config.build || 'unrecorded', profileEnabled: Boolean(config.profile), startedAt: new Date().toISOString(), results: [], errors: [], warnings: [] };
  const probeOwnerToken = process.env.METAAGENT_PERF_PROBE_OWNER || null;
  const cdp = await connectCdp(port, config.targetId);
  let probeInstalled = false, profilerRunning = false, exceptionCount = 0, consoleErrorCount = 0;
  cdp.onEvent(message => { if (message.method === 'Runtime.exceptionThrown') exceptionCount++; if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) consoleErrorCount++; });
  const inspect = step => cdp.evaluate(`(${inspectElement.toString()})(${JSON.stringify(step.selector)},${JSON.stringify(step.index || 0)},${JSON.stringify(step.witnessSelector)})`, { allowedExceptionMessages: ['Visible scenario target missing', 'Scenario target is obscured/offscreen', 'Scenario witness missing'] });
  const waitReady = async ready => {
    const assertions = Array.isArray(ready) ? ready : [ready];
    const started = performance.now();
    while (performance.now() - started < (config.readyTimeoutMs || 10000)) {
      const matches = await cdp.evaluate(`(${readyAssertionsMatch.toString()})(${JSON.stringify(assertions)})`);
      if (matches) return performance.now() - started;
      await sleep(20);
    }
    throw new Error('Navigation readiness timed out');
  };
  const position = async (step, top) => cdp.evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(step.selector)})].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})[${step.index || 0}];if(!el)throw new Error('Scroller missing');el.scrollTop=${JSON.stringify(top)};return el.scrollTop})()`);
  const runStep = async (step, round, record = true) => {
    let originalPosition = null, profile = null, profileStarted = false, result = null, stage = 'prepare-target', failure = null;
    try {
      if (step.kind === 'click' && step.revealTarget === true) {
        stage = 'reveal-target';
        await cdp.evaluate(`(${revealElement.toString()})(${JSON.stringify(step.selector)},${JSON.stringify(step.index || 0)})`, { allowedExceptionMessages: ['Visible scenario target missing'] });
      }
      if (step.kind === 'scroll') {
        stage = 'prepare-scroll';
        const original = await inspect(step); originalPosition = original;
        if (original.scrollHeight <= original.clientHeight) throw new Error('Scenario target is not scrollable');
        if (step.startRatio != null) await position(step, (original.scrollHeight - original.clientHeight) * step.startRatio);
      }
      stage = 'pre-settle'; await sleep(step.beforeMs ?? config.settleMs ?? 500);
      stage = 'inspect-before';
      const before = step.kind === 'idle' || !step.selector ? null : await inspect(step);
      const errorStart = { exceptionCount, consoleErrorCount };
      stage = 'start-profile';
      if (record && config.profile) { await cdp.call('Profiler.start'); profilerRunning = profileStarted = true; }
      stage = 'metrics-before';
      const metricsBefore = (await cdp.call('Performance.getMetrics')).metrics;
      stage = 'probe-start';
      await cdp.evaluate('window.__maRealPerf.start()');
      const actionStart = performance.now(), dispatchMs = [], dispatchAtMs = [], dispatchLatenessMs = [];
      let readyMs = null;
      if (step.kind === 'click') {
        stage = 'check-navigation';
        // Navigation only. Refuse common content-mutating controls even if a selector was misconfigured.
        const forbidden = await cdp.evaluate(`(()=>{const el=document.elementFromPoint(${before.x},${before.y});const control=el?.closest('button,a,[role="button"],.session-item,[data-session-row],[role="tab"]');if(!control)return true;if(control.matches('.session-item,[data-session-row],[role="tab"]'))return false;const text=[control.getAttribute('aria-label'),control.getAttribute('title'),control.textContent].join(' ');return /删除|发送|重启|清空|新建|创建|关闭会话|确认|批准|提交|delete|send|restart|clear|create|submit|approve/i.test(text) || control.matches('[type="submit"]')})()`);
        if (forbidden) throw new Error('Refusing a non-navigation or mutating click target');
        stage = 'dispatch-click';
        for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, x: before.x, y: before.y, button: 'left', clickCount: 1 });
        stage = 'wait-ready';
        await waitReady(step.ready);
        readyMs = performance.now() - actionStart;
      } else if (step.kind === 'key' || step.kind === 'hover') {
        if (step.kind === 'key') {
          stage = 'dispatch-key';
          const parameters = keyEventParameters(step.key);
          for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, ...parameters });
        } else {
          stage = 'dispatch-hover';
          await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y, button: 'none' });
        }
        stage = 'wait-ready'; await waitReady(step.ready);
        readyMs = performance.now() - actionStart;
      } else if (step.kind === 'scroll') {
        stage = 'dispatch-wheel';
        const interval = step.intervalMs ?? 16;
        const inflight = new Set(), requests = [], dispatchErrors = [];
        for (let i = 0; i < (step.count ?? 30); i++) {
          while (inflight.size >= (step.maxInFlight ?? 1)) await Promise.race(inflight);
          if (dispatchErrors.length) break;
          await sleep(Math.max(0, actionStart + i * interval - performance.now()));
          const at = performance.now(); dispatchAtMs.push(at - actionStart);
          dispatchLatenessMs.push(Math.max(0, at - (actionStart + i * interval)));
          const request = cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: step.deltaY }).then(() => { dispatchMs.push(performance.now() - at); }, error => { dispatchErrors.push(error); }).finally(() => inflight.delete(request));
          inflight.add(request); requests.push(request);
        }
        await Promise.all(requests);
        if (dispatchErrors.length) throw dispatchErrors[0];
      } else { stage = 'idle'; await sleep(step.durationMs ?? 1500); }
      stage = 'post-settle'; await sleep(step.afterMs ?? config.settleMs ?? 500);
      stage = 'probe-stop';
      const probe = await cdp.evaluate('window.__maRealPerf.stop()');
      stage = 'metrics-after';
      const metricsAfter = (await cdp.call('Performance.getMetrics')).metrics;
      stage = 'profile-stop';
      if (profileStarted) { profile = (await cdp.call('Profiler.stop')).profile; profilerRunning = profileStarted = false; }
      stage = 'inspect-after';
      const afterTarget = step.afterSelector ? { ...step, selector: step.afterSelector, index: 0 } : step;
      const after = step.kind === 'idle' || !afterTarget.selector ? null : await inspect(afterTarget);
      stage = 'validate-result';
      if (probe.hidden || probe.visibility.some(change => change.hidden)) throw new Error('Application became hidden during measurement');
      if (probe.frames.length < 5) throw new Error('Too few renderer frames; result is invalid');
      if (step.kind === 'scroll' && Math.sign(after.scrollTop - before.scrollTop) !== Math.sign(step.deltaY)) throw new Error('Wheel did not move the intended scroller in the requested direction');
      if (step.assertStableWitness && (before.witnessHash !== after.witnessHash || before.witnessChars !== after.witnessChars)) throw new Error('Content witness changed; performance comparison cannot imply equivalent output');
      if (exceptionCount > errorStart.exceptionCount || consoleErrorCount > errorStart.consoleErrorCount) throw new Error('Renderer emitted an exception/error during the action (text omitted)');
      result = { name: step.name, round, kind: step.kind, durationMs: probe.end - probe.start, readyMs, before, after, frames: summarizeFrames(probe.frames, report.calibration.budgetMs), firstFrameDelayMs: probe.frames[0] ?? null, longtasks: summarize(probe.longtasks.map(entry => Math.min(probe.end, entry.start + entry.duration) - Math.max(probe.start, entry.start))), eventTiming: { duration: summarize(probe.events.map(entry => entry.duration)), inputDelay: summarize(probe.events.map(entry => entry.inputDelay)), processing: summarize(probe.events.map(entry => entry.processing)) }, observedInput: { clock: 'performance.now-at-callback', count: probe.inputs.length, inputDelay: summarize(probe.inputs.map(input => input.inputDelay)), receivedToNextRaf: summarize(probe.inputs.map(input => input.toNextRaf)) }, dispatch: { requestedIntervalMs: step.kind === 'scroll' ? step.intervalMs ?? 16 : null, maxInFlight: step.kind === 'scroll' ? step.maxInFlight ?? 1 : null, roundtripMs: summarize(dispatchMs), latenessMs: summarize(dispatchLatenessMs), cadenceMs: summarize(dispatchAtMs.slice(1).map((time, index) => time - dispatchAtMs[index])) }, metrics: metricDelta(metricsBefore, metricsAfter, probe.end - probe.start), raw: probe };
      if (step.kind === 'scroll' && result.dispatch.latenessMs.p95 > Math.max(2, (step.intervalMs ?? 16) * .25)) report.warnings.push(`Requested input cadence was not maintained for ${step.name}; use actual dispatch cadence and lateness, not the requested interval, when interpreting this capture`);
      if (record) {
        stage = 'write-result';
        report.results.push(result);
        if (profile) fs.writeFileSync(`${outputPath}.r${round}-s${report.results.length}.cpuprofile`, JSON.stringify(profile), { flag: 'wx' });
        console.log(`[real-bench] round ${round} ${step.name}: frame p95=${result.frames.p95?.toFixed(2)}ms p99=${result.frames.p99?.toFixed(2)}ms; >1.5 budget=${result.frames.over1_5}; longtasks=${result.longtasks.count}`);
      }
    } catch (error) { failure = stepError(error, step, round, stage); throw failure; }
    finally {
      try {
      stage = 'cleanup-profile';
      if (profileStarted) { await cdp.call('Profiler.stop'); profilerRunning = false; }
      if (originalPosition != null && step.restoreScroll !== false) {
        stage = 'restore-scroll';
        const restoration = await cdp.evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(step.selector)})].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})[${step.index || 0}];if(!el)throw new Error('Scroller missing');const original=${JSON.stringify(originalPosition)};let method='absolute';if(original.atBottom){el.scrollTop=el.scrollHeight;method='bottom'}else if(original.anchor){const anchor=el.querySelector('['+original.anchor.attribute+'="'+CSS.escape(original.anchor.value)+'"]');if(anchor){el.scrollTop+=anchor.getBoundingClientRect().top-el.getBoundingClientRect().top-original.anchor.offset;method='visible-anchor'}else{el.scrollTop=original.scrollTop;method='clamped-absolute'}}else{el.scrollTop=original.scrollTop;if(Math.abs(el.scrollTop-original.scrollTop)>1)method='clamped-absolute'}return {method,requestedTop:original.scrollTop,actualTop:el.scrollTop}})()`);
        await sleep(config.settleMs ?? 500);
        // Intrinsic-size placeholders can change the max scroll range as real content becomes visible.
        if (originalPosition.atBottom) await position(step, Number.MAX_SAFE_INTEGER);
        const restored = await inspect(step);
        if (result) result.restoration = { ...restoration, actualTop: restored.scrollTop, scrollHeight: restored.scrollHeight, atBottom: restored.atBottom, anchor: restored.anchor };
        if (originalPosition.atBottom && !restored.atBottom) throw new Error('Failed to restore bottom-following position');
        if (restoration.method === 'visible-anchor' && (!restored.anchor || restored.anchor.value !== originalPosition.anchor.value || Math.abs(restored.anchor.offset - originalPosition.anchor.offset) > 2)) {
          // Verify the exact original visible row, not whichever row the post-restoration hit test selected.
          const offset = await cdp.evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(step.selector)})].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})[${step.index || 0}];const a=${JSON.stringify(originalPosition.anchor)};const row=el.querySelector('['+a.attribute+'="'+CSS.escape(a.value)+'"]');return row?row.getBoundingClientRect().top-el.getBoundingClientRect().top:null})()`);
          if (offset == null || Math.abs(offset - originalPosition.anchor.offset) > 2) throw new Error('Failed to restore original visible reading anchor');
        }
        if (restoration.method === 'absolute' && Math.abs(restored.scrollTop - originalPosition.scrollTop) > 1) throw new Error('Failed to restore original scroll position');
        if (restoration.method === 'clamped-absolute') report.warnings.push(`Scroll restoration used legal clamping for ${step.name}; review the reading position manually`);
      }
      } catch (error) {
        const cleanupFailure = stepError(error, step, round, stage);
        if (failure) failure.message += `; cleanup: ${cleanupFailure.message}`;
        else throw cleanupFailure;
      }
    }
  };
  try {
    await cdp.call('Runtime.enable'); await cdp.call('Performance.enable');
    report.environment = await cdp.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,hidden:document.hidden,userAgent:navigator.userAgent})');
    if (report.environment.hidden) throw new Error('Keep the actual application visible and unobscured');
    report.probe = await cdp.evaluate(`(${installProbe.toString()})(${JSON.stringify(probeOwnerToken)})`); probeInstalled = true;
    if (!report.probe.supported.includes('longtask')) report.warnings.push('Long Task API unavailable; count is not proof of no long tasks');
    if (!report.probe.supported.includes('event')) report.warnings.push('Event Timing API unavailable');
    report.warnings.push('rAF measures renderer callback scheduling; compositor presentation/GPU smoothness requires trace or visual evidence. Event Timing excludes short entries and does not cover wheel. Input-to-rAF is not input-to-presentation. Memory is an unforced-GC snapshot. Cache state and build identity are operator declarations.');
    await cdp.evaluate('window.__maRealPerf.start()');
    await sleep(config.calibrationMs ?? 1800);
    const calibration = await cdp.evaluate('window.__maRealPerf.stop()');
    const cadence = summarize(calibration.frames);
    if (calibration.hidden || calibration.visibility.some(change => change.hidden) || cadence.count < 30 || !(cadence.p50 > 0)) throw new Error('Invalid idle rAF calibration');
    report.calibration = { budgetMs: cadence.p50, observedRafHz: 1000 / cadence.p50, frames: cadence, displayHz: config.displayHz ?? null, source: 'visible idle rAF median; not monitor hardware refresh rate' };
    if (cadence.p95 > cadence.p50 * 1.5 + .5) report.warnings.push('Idle renderer cadence is unstable; investigate idle work and repeat calibration before interpreting small deltas');
    if (config.profile) { await cdp.call('Profiler.enable'); await cdp.call('Profiler.setSamplingInterval', { interval: 1000 }); }
    for (const step of config.prepare || []) await runStep(step, 0, false);
    for (let round = 1; round <= rounds; round++) for (const step of config.steps) await runStep(step, round);
    report.status = 'complete';
  } catch (error) { report.errors.push(error.message); throw error; }
  finally {
    try { if (profilerRunning) await cdp.call('Profiler.stop'); if (probeInstalled) await cdp.evaluate(`(${disposeOwnedProbe.toString()})(${JSON.stringify(probeOwnerToken)})`); }
    catch (error) { report.status = 'incomplete'; report.errors.push(`Probe cleanup failed: ${error.message}`); }
    cdp.close(); report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    if (report.status !== 'complete') process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`[real-bench] FAILED: ${error.message}`); process.exitCode = 1; });
