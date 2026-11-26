// node main-profiler.mjs <node-inspector-port> <new-output-prefix> [durationSec=12]
// Attach only to the authorized Electron main process; never starts/reloads/kills a process.
import fs from 'node:fs';
import path from 'node:path';
import { connectInspector, sleep } from './cdp-client.mjs';
import { summarize } from './metrics.mjs';

const [port, outputPrefix, durationArg = '12'] = process.argv.slice(2);
let cdp, probeInstalled = false, profilerStarted = false, stopped = false;
const summary = { schema: 1, status: 'incomplete', samplingIntervalUs: 1000, errors: [], warnings: ['CPU profiler and a 25ms diagnostic timer add overhead. Timer lateness measures main-process callback scheduling, not renderer/compositor frames. No console output, environment, user content, keys, or process argv are collected.'] };
try {
  const durationSec = Number(durationArg);
  if (!port || !outputPrefix || !(durationSec >= 1 && durationSec <= 1800)) throw new Error('Usage: node main-profiler.mjs <node-inspector-port> <new-output-prefix> [durationSec=12, 1..1800]');
  if (fs.existsSync(`${outputPrefix}.cpuprofile`) || fs.existsSync(`${outputPrefix}.summary.json`)) throw new Error('Output exists; preserve baseline and choose a new prefix');
  fs.mkdirSync(path.dirname(path.resolve(outputPrefix)), { recursive: true });
  cdp = await connectInspector(port);
  await cdp.call('Runtime.enable');
  const identity = await cdp.evaluate('({pid:process.pid,type:process.type,node:process.versions.node,electron:process.versions.electron})');
  if (identity.type !== 'browser' || !identity.electron) throw new Error('Inspector is not the intended Electron main process');
  summary.identity = identity;
  summary.startedAt = new Date().toISOString();
  await cdp.evaluate(`(()=>{if(globalThis.__maMainPerf)throw new Error('Probe already exists');const start=performance.now();const state={start,last:start,gaps:[],late:[],cpu:process.cpuUsage(),memory:process.memoryUsage()};state.timer=setInterval(()=>{const now=performance.now();const gap=now-state.last;state.gaps.push(gap);state.late.push(Math.max(0,gap-25));state.last=now},25);state.timer.unref();globalThis.__maMainPerf=state;return true})()`);
  probeInstalled = true;
  await cdp.call('Profiler.enable'); await cdp.call('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.call('Profiler.start'); profilerStarted = true;
  process.on('SIGINT', () => { stopped = true; });
  const start = performance.now();
  while (!stopped && performance.now() - start < durationSec * 1000) await sleep(Math.min(250, durationSec * 1000 - (performance.now() - start)));
  const profile = (await cdp.call('Profiler.stop')).profile; profilerStarted = false;
  fs.writeFileSync(`${outputPrefix}.cpuprofile`, JSON.stringify(profile), { flag: 'wx' });
  const observation = await cdp.evaluate(`(()=>{const s=globalThis.__maMainPerf;if(!s)throw new Error('Probe missing');clearInterval(s.timer);const result={durationMs:performance.now()-s.start,gaps:s.gaps,late:s.late,cpuUs:process.cpuUsage(s.cpu),memoryBefore:s.memory,memoryAfter:process.memoryUsage()};delete globalThis.__maMainPerf;return result})()`);
  probeInstalled = false;
  summary.status = 'complete'; summary.reason = stopped ? 'sigint' : 'duration';
  summary.durationMs = observation.durationMs;
  summary.mainEventLoop = { intervalMs: 25, gapMs: summarize(observation.gaps), latenessMs: summarize(observation.late), over10ms: observation.late.filter(value => value > 10).length, over50ms: observation.late.filter(value => value > 50).length, over100ms: observation.late.filter(value => value > 100).length, over250ms: observation.late.filter(value => value > 250).length, rawGapMs: observation.gaps, rawLatenessMs: observation.late };
  summary.cpu = { ...observation.cpuUs, coreBusyPercent: (observation.cpuUs.user + observation.cpuUs.system) / (observation.durationMs * 10) };
  summary.memoryBefore = observation.memoryBefore; summary.memoryAfter = observation.memoryAfter;
  console.log(`[main-profiler] pid=${identity.pid} loop lateness p95=${summary.mainEventLoop.latenessMs.p95?.toFixed(2)}ms max=${summary.mainEventLoop.latenessMs.max?.toFixed(2)}ms cpu=${summary.cpu.coreBusyPercent.toFixed(1)}% of one core`);
} catch (error) { summary.errors.push(error.message); console.error(`[main-profiler] FAILED: ${error.message}`); process.exitCode = 1; }
finally {
  try {
    if (profilerStarted) await cdp.call('Profiler.stop');
    if (probeInstalled) await cdp.evaluate("(()=>{const s=globalThis.__maMainPerf;if(s){clearInterval(s.timer);delete globalThis.__maMainPerf}return true})()");
  } catch (error) { summary.status = 'incomplete'; summary.errors.push(`Cleanup failed: ${error.message}`); process.exitCode = 1; }
  cdp?.close(); summary.finishedAt = new Date().toISOString();
  if (outputPrefix && !fs.existsSync(`${outputPrefix}.summary.json`)) {
    try { fs.writeFileSync(`${outputPrefix}.summary.json`, JSON.stringify(summary, null, 2), { flag: 'wx' }); }
    catch (error) { console.error(`[main-profiler] Summary write failed: ${error.message}`); process.exitCode = 1; }
  }
}
