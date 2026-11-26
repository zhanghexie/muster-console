import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-activity-runtime-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  let mount, mounted, monitorReady, monitorStarted, stopFromWindow, escape, failMonitor, stops = 0;
  const mountGate = new Promise(resolve => { mount = resolve; });
  const didMount = new Promise(resolve => { mounted = resolve; });
  const monitorGate = new Promise(resolve => { monitorReady = resolve; });
  const didStartMonitor = new Promise(resolve => { monitorStarted = resolve; });
  const snapshots = [];
  const runtime = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator(stop) { stopFromWindow = stop; return { show: async snapshot => {
      snapshots.push(snapshot); mounted(); await mountGate;
    }, close() {} }; },
    createEscapeMonitor(onEscape, onFailure) { escape = onEscape; failMonitor = onFailure; return {
      start: async () => { monitorStarted(); await monitorGate; }, stop: async () => { stops++; }
    }; }
  });
  runtime.turns.begin('worker', 'turn', () => true);
  let dispatched = false;
  const operation = runtime.turns.use('worker', 'turn', 'window', async () => { dispatched = true; return 4; });
  await didMount;
  assert.equal(dispatched, false, 'indicator must mount before the backend can run');
  assert.equal(runtime.isVisible(), false);
  assert.equal(snapshots[0].escapeAvailable, false, 'do not claim the hook is ready before startup');
  mount();
  await didStartMonitor;
  assert.equal(runtime.isVisible(), true);
  assert.equal(dispatched, false, 'wait until monitor startup has completed or failed');
  monitorReady();
  assert.equal(await operation, 4);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.at(-1).escapeAvailable, true);
  failMonitor('monitor disconnected');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.at(-1).escapeAvailable, false, 'failed hook must immediately fall back to the button');
  runtime.turns.end('worker', 'turn');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.dispose();
  assert.equal(runtime.isVisible(), false);
  assert.equal(stops, 1, 'the failed monitor is reclaimed only once');
  assert.equal(typeof escape, 'function');
  assert.equal(typeof stopFromWindow, 'function');

  let helperEntered, releaseHelper, indicatorClosed = false;
  const helperStopping = new Promise(resolve => { helperEntered = resolve; });
  const helperGate = new Promise(resolve => { releaseHelper = resolve; });
  const helperSnapshots = [];
  const helperRuntime = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    stopBackend: async () => { helperEntered(); await helperGate; },
    createIndicator: () => ({ show: async snapshot => { helperSnapshots.push(snapshot); }, close() { indicatorClosed = true; } })
  });
  helperRuntime.turns.begin('worker', 'turn', () => true);
  await helperRuntime.turns.use('worker', 'turn', 'window', async () => 1, false);
  const stoppingHelper = helperRuntime.stop();
  await helperStopping;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(indicatorClosed, false, 'indicator remains visible while backend cleanup is pending');
  assert.equal(helperSnapshots.at(-1).state, 'stopping');
  releaseHelper();
  await stoppingHelper;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(indicatorClosed, true, 'indicator closes after backend cleanup finishes');
  await helperRuntime.dispose();

  let report, failedStops = 0;
  const failureSnapshots = [];
  const degraded = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: () => ({ show: async snapshot => { failureSnapshots.push(snapshot); }, close() {} }),
    createEscapeMonitor: () => ({ start: async () => { throw new Error('no hook permission'); }, stop: async () => { failedStops++; } }),
    reportMonitorFailure: reason => { report = reason; }
  });
  degraded.turns.begin('worker', 'turn', () => true);
  assert.equal(await degraded.turns.use('worker', 'turn', 'window', async () => 7), 7);
  assert.equal(report, 'no hook permission');
  assert.equal(failureSnapshots.at(-1).escapeAvailable, false);
  degraded.turns.end('worker', 'turn');
  await new Promise(resolve => setImmediate(resolve));
  await degraded.dispose();
  assert.equal(failedStops, 1);

  let signalReady, finishAction, physicalEscape;
  const entered = new Promise(resolve => { signalReady = resolve; });
  const pending = new Promise(resolve => { finishAction = resolve; });
  const stopping = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: () => ({ show: async () => {}, close() {} }),
    createEscapeMonitor: onEscape => { physicalEscape = onEscape; return { start: async () => {}, stop: async () => {} }; }
  });
  stopping.turns.begin('worker', 'turn', () => true);
  const action = stopping.turns.use('worker', 'turn', 'window', async signal => { signalReady(signal); await pending; }).catch(error => error);
  const signal = await entered;
  physicalEscape();
  assert.equal(signal.aborted, true, 'the monitor callback must immediately interrupt in-flight work');
  finishAction();
  assert.ok(await action);
  await stopping.dispose();

  let restartEscape, firstActionEntered, finishFirstAction, starts = 0;
  const firstEntered = new Promise(resolve => { firstActionEntered = resolve; });
  const firstGate = new Promise(resolve => { finishFirstAction = resolve; });
  const restartSnapshots = [];
  const restarting = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: () => ({ show: async snapshot => { restartSnapshots.push(snapshot); }, close() {} }),
    createEscapeMonitor: onEscape => { restartEscape = onEscape; return { start: async () => { starts++; }, stop: async () => {} }; }
  });
  restarting.turns.begin('worker', 'old', () => true);
  const interrupted = restarting.turns.use('worker', 'old', 'window', async signal => { firstActionEntered(signal); await firstGate; }).catch(error => error);
  await firstEntered;
  restartEscape(); finishFirstAction();
  assert.ok(await interrupted);
  restarting.turns.end('worker', 'old');
  restarting.turns.noteUserInstruction('worker', 'new-user-message');
  restarting.turns.begin('worker', 'new', () => true, true, 'new-user-message');
  assert.equal(await restarting.turns.use('worker', 'new', 'window', async () => 3), 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2, 'a new explicit instruction must restart the stopped listener');
  assert.equal(restartSnapshots.at(-1).escapeAvailable, true);
  restarting.turns.end('worker', 'new');
  await restarting.dispose();

  let indicatorLost, retired = 0;
  const lost = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: (_stop, unavailable) => { indicatorLost = unavailable; return { show: async () => {}, close() {} }; },
    createEscapeMonitor: () => ({ start: async () => {}, stop: async () => { retired++; } })
  });
  lost.turns.begin('worker', 'turn', () => true);
  await lost.turns.use('worker', 'turn', 'window', async () => 1);
  assert.equal(lost.isVisible(), true);
  indicatorLost('indicator crashed');
  assert.equal(lost.isVisible(), false);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(lost.turns.use('worker', 'turn', 'window', async () => 2), /indicator crashed/);
  await lost.dispose();
  assert.equal(retired, 1, 'indicator loss must also retire the physical-key listener');

  let lateReady, lateLost, lateEntered;
  const lateGate = new Promise(resolve => { lateReady = resolve; });
  const lateMounted = new Promise(resolve => { lateEntered = resolve; });
  const late = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: (_stop, unavailable) => { lateLost = unavailable; return {
      show: async () => { lateEntered(); await lateGate; }, close() {}
    }; }
  });
  late.turns.begin('worker', 'turn', () => true);
  let lateDispatched = false;
  const lateAction = late.turns.use('worker', 'turn', 'window', async () => { lateDispatched = true; }).catch(error => error);
  await lateMounted;
  lateLost('indicator crashed before readiness');
  lateReady();
  assert.ok(await lateAction);
  assert.equal(lateDispatched, false);
  assert.equal(late.visibilityEpoch(), undefined, 'a late mount reply must not resurrect a failed indicator');
  await late.dispose();

  let disposeEntered, finishDisposeAction;
  const disposeStarted = new Promise(resolve => { disposeEntered = resolve; });
  const disposeGate = new Promise(resolve => { finishDisposeAction = resolve; });
  const disposing = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: () => ({ show: async () => {}, close() {} })
  });
  disposing.turns.begin('worker', 'turn', () => true);
  const disposeAction = disposing.turns.use('worker', 'turn', 'window', async signal => { disposeEntered(signal); await disposeGate; }).catch(error => error);
  await disposeStarted;
  let secondDisposeFinished = false;
  const disposeOne = disposing.dispose();
  const disposeTwo = disposing.dispose().then(() => { secondDisposeFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondDisposeFinished, false, 'concurrent disposal must wait for the same in-flight backend cleanup');
  finishDisposeAction();
  await Promise.all([disposeOne, disposeTwo]);
  assert.ok(await disposeAction);

  let failingStarted, finishFailingAction, failureCloses = 0;
  const failingEntered = new Promise(resolve => { failingStarted = resolve; });
  const failingGate = new Promise(resolve => { finishFailingAction = resolve; });
  const failedCleanup = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    createIndicator: () => ({ show: async () => {}, close() { failureCloses++; } }),
    createEscapeMonitor: () => ({ start: async () => {}, stop: async () => { throw new Error('monitor cleanup failed'); } })
  });
  failedCleanup.turns.begin('worker', 'turn', () => true);
  const failingAction = failedCleanup.turns.use('worker', 'turn', 'window', async signal => { failingStarted(signal); await failingGate; }).catch(error => error);
  await failingEntered;
  let failureStopSettled = false;
  const failingStop = failedCleanup.stop().then(() => { failureStopSettled = true; }, error => { failureStopSettled = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failureStopSettled, false, 'monitor failure cannot end the stop barrier while an action still runs');
  assert.equal(failureCloses, 0, 'the indicator must remain until in-flight work has settled');
  finishFailingAction();
  assert.match(String(await failingStop), /monitor cleanup failed/);
  assert.ok(await failingAction);
  await assert.rejects(failedCleanup.dispose(), /monitor cleanup failed/);

  let shutdownCloses = 0;
  const shutdownStates = [];
  const unconfirmed = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
    stopBackend: async () => { throw new Error('driver exit not confirmed'); },
    createIndicator: () => ({ show: async snapshot => { shutdownStates.push(snapshot); }, close() { shutdownCloses++; } })
  });
  unconfirmed.turns.begin('worker', 'turn', () => true);
  await unconfirmed.turns.use('worker', 'turn', 'window', async () => 1, false);
  await assert.rejects(unconfirmed.dispose(), /driver exit not confirmed/);
  assert.equal(shutdownCloses, 0, 'do not hide the indicator when backend cleanup is unconfirmed');
  assert.equal(shutdownStates.at(-1).state, 'unknown', 'show the uncertain shutdown outcome');
  assert.equal(shutdownStates.at(-1).escapeAvailable, false);
  assert.equal(unconfirmed.visibilityEpoch(), undefined, 'shutdown must still revoke the old visibility authority');
  console.log('desktop activity runtime: visibility, monitor lifecycle, fallback and stop passed');
} finally { removeWorkspaceFixture(temp, 'desktop-activity-runtime-'); }
