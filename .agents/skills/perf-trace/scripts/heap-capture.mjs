// node heap-capture.mjs <port> <scenario.json> <new-output-prefix>
// Allocation diagnosis only: no force GC, HeapSnapshot, object values, or app APIs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp-client.mjs';
import { disposeOwnedProbe, validateScenario } from './real-bench.mjs';
import { HEAP_SAMPLING_PARAMETERS, parseHeapArguments, validateHeapProtocol, summarizeHeapProfile } from './heap-analysis.mjs';

const RUNNER_TIMEOUT_MS = 15 * 60 * 1000;
let cdp, child, samplerStarted = false, heapEnabled = false, probeOwned = false;
let summaryPath, outputs, samplingRequestedAt, runnerComplete = false, profileSaved = false;
let cancelRunner;
let interruptedFlag = false;
const abortController = new AbortController(), probeOwnerToken = randomUUID();
const summary = {
  schema: 1, status: 'incomplete', errors: [], samplingParameters: HEAP_SAMPLING_PARAMETERS,
  runnerTimeoutMs: RUNNER_TIMEOUT_MS, captureElapsedMs: null,
  warnings: [
    'Allocation sampling adds overhead. Do not compare sampled frame milliseconds with unsampled timing; use a separate formal benchmark.',
    'The estimate is cumulative allocation including objects collected by major/minor GC, not retained heap, live bytes, or proof of a leak. No forced GC, heap snapshot, or object values are requested.',
    'The whole runner calibration/preparation/actions/restoration is sampled. Raw profiles can contain source URLs/function names; keep them in private temporary storage. Summaries omit source URLs and object data.',
    'Run diagnostic samplers exclusively; this tool stops only sampling successfully started through its own CDP connection.'
  ]
};
const checkInterrupted = () => { if (interruptedFlag) throw new Error('Heap capture interrupted; retain incomplete artifacts'); };
const interrupted = () => {
  interruptedFlag = true;
  abortController.abort();
  cancelRunner?.(new Error('Heap capture interrupted; retain incomplete artifacts'));
};
process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);

try {
  checkInterrupted();
  const { port, scenarioPath, prefix } = parseHeapArguments(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  validateScenario(config);
  outputs = { profile: `${prefix}.heapprof`, benchmark: `${prefix}.bench.json`, summary: `${prefix}.summary.json` };
  for (const output of Object.values(outputs)) if (fs.existsSync(output)) throw new Error('Output exists; preserve the previous capture and choose a new prefix');
  fs.mkdirSync(path.dirname(path.resolve(prefix)), { recursive: true });
  summaryPath = outputs.summary; summary.outputs = outputs; summary.startedAt = new Date().toISOString();
  const response = await fetch(`http://127.0.0.1:${port}/json/protocol`, { signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(3000)]) });
  if (!response.ok) throw new Error(`Protocol inspection failed: HTTP ${response.status}`);
  validateHeapProtocol(await response.json());
  checkInterrupted();
  summary.protocolParametersVerified = true;
  cdp = await connectCdp(port, config.targetId);
  checkInterrupted();
  if (await cdp.evaluate('Boolean(window.__maRealPerf)')) throw new Error('A real-bench probe already exists; do not run concurrent benchmarks');
  checkInterrupted();
  await cdp.call('HeapProfiler.enable'); heapEnabled = true;
  checkInterrupted();
  samplingRequestedAt = performance.now();
  summary.captureTiming = { clock: 'performance.now', startBoundary: 'before HeapProfiler.startSampling request', endBoundary: 'after HeapProfiler.stopSampling acknowledgement', complete: false };
  await cdp.call('HeapProfiler.startSampling', HEAP_SAMPLING_PARAMETERS); samplerStarted = true;
  checkInterrupted();
  child = spawn(process.execPath, [fileURLToPath(new URL('./real-bench.mjs', import.meta.url)), String(port), scenarioPath, outputs.benchmark], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, METAAGENT_PERF_PROBE_OWNER: probeOwnerToken } });
  probeOwned = true;
  let stdoutBytes = 0, stderrBytes = 0;
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned benchmark exceeded the allocation capture timeout')), RUNNER_TIMEOUT_MS);
    cancelRunner = reject;
    child.once('error', () => { clearTimeout(timer); cancelRunner = null; reject(new Error('Could not spawn the owned benchmark runner')); });
    child.once('exit', (code, signal) => { clearTimeout(timer); cancelRunner = null; resolve({ code, signal }); });
  });
  summary.runner = { ...exit, stdoutBytes, stderrBytes };
  if (exit.code !== 0) throw new Error('Benchmark runner failed; inspect its incomplete report in private storage');
  const benchmark = JSON.parse(fs.readFileSync(outputs.benchmark, 'utf8'));
  if (benchmark.status !== 'complete') throw new Error('Benchmark did not produce a complete report');
  summary.scenarioHash = benchmark.scenarioHash; summary.scenarioId = benchmark.scenarioId;
  summary.runnerProfileEnabled = benchmark.profileEnabled;
  if (benchmark.profileEnabled) summary.warnings.push('The manifest also enabled CPU profiling. This combined diagnostic has extra overhead and is not equivalent to allocation-only sampling.');
  runnerComplete = true;
} catch (error) {
  summary.errors.push(error.message); console.error(`[heap-capture] FAILED: ${error.message}`); process.exitCode = 1;
} finally {
  // Only this spawned Node runner may be terminated; never the app or another process.
  if (child && child.exitCode == null && child.signalCode == null) {
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned benchmark cleanup timed out')), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
      summary.ownedRunnerTerminated = true;
    } catch (error) { summary.errors.push(error.message); process.exitCode = 1; }
  }
  if (samplerStarted && cdp) {
    try {
      const { profile } = await cdp.call('HeapProfiler.stopSampling', {}, 30000); samplerStarted = false;
      summary.captureElapsedMs = performance.now() - samplingRequestedAt;
      summary.captureTiming.complete = true;
      if (!profile) throw new Error('Heap sampling stopped without a profile');
      fs.writeFileSync(outputs.profile, JSON.stringify(profile), { flag: 'wx' }); profileSaved = true;
      summary.allocations = summarizeHeapProfile(profile);
    } catch (error) { summary.errors.push(`Sampling finalization failed: ${error.message}`); process.exitCode = 1; }
  }
  if (probeOwned && cdp) {
    try { summary.probeCleanup = await cdp.evaluate(`(${disposeOwnedProbe.toString()})(${JSON.stringify(probeOwnerToken)})`); }
    catch (error) { summary.errors.push(`Owned probe cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  if (heapEnabled && cdp) {
    try { await cdp.call('HeapProfiler.disable'); }
    catch (error) { summary.errors.push(`Heap domain cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  cdp?.close(); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  summary.finishedAt = new Date().toISOString();
  if (interruptedFlag && !summary.errors.some(message => message.includes('interrupted'))) summary.errors.push('Heap capture interrupted; retained artifacts are incomplete');
  if (runnerComplete && profileSaved && summary.errors.length === 0) summary.status = 'complete';
  if (summaryPath) {
    try { fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { flag: 'wx' }); }
    catch (error) { summary.status = 'incomplete'; summary.errors.push('Summary write failed'); console.error(`[heap-capture] Summary write failed: ${error.message}`); process.exitCode = 1; }
  }
  if (summary.status !== 'complete') process.exitCode = 1;
  console.log(JSON.stringify({ status: summary.status, profile: outputs?.profile, summary: summaryPath, captureElapsedMs: summary.captureElapsedMs,
    estimatedAllocatedBytes: summary.allocations?.estimatedAllocatedBytes ?? null,
    topSelf: summary.allocations?.topSelf.slice(0, 8) ?? [], warning: 'Cumulative sampled allocation estimate; not retained heap or a leak measurement.' }, null, 2));
}
