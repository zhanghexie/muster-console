// node trace-capture.mjs <port> <scenario.json> <new-output-prefix> [--invalidations]
// Diagnostic trace around the existing real-bench runner. No screenshots or extra CPU profiler.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp-client.mjs';
import { disposeOwnedProbe, validateScenario } from './real-bench.mjs';
import { parseTraceArguments, traceCategories } from './trace-config.mjs';

let port, scenarioPath, prefix;
let cdp, child, traceStarted = false, stream, traceFd, traceComplete, probeOwned = false;
let summaryPath;
let captureRequestedAt;
const probeOwnerToken = randomUUID();
const summary = { schema: 1, status: 'incomplete', errors: [], traceBytes: 0, screenshots: false, extraCpuProfiler: false, warnings: ['Diagnostic trace adds overhead; do not compare its milliseconds with untraced timing. The trace includes runner calibration, preparation, actions, and restoration. Raw traces can contain source URLs and process metadata; keep them in private temporary storage.'] };

const waitBounded = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

try {
  const options = parseTraceArguments(process.argv.slice(2));
  ({ port, scenarioPath, prefix } = options);
  summary.invalidationsEnabled = options.invalidationsEnabled;
  if (options.invalidationsEnabled) summary.warnings.push('Invalidation tracking adds substantial diagnostic overhead and may produce very large files. Use it for style/layout attribution; captures with different categories are not latency-equivalent.');
  const config = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  validateScenario(config);
  const outputs = { trace: `${prefix}.trace.json`, benchmark: `${prefix}.bench.json`, summary: `${prefix}.summary.json` };
  for (const outputPath of Object.values(outputs)) if (fs.existsSync(outputPath)) throw new Error('Output exists; preserve the old capture and choose a new prefix');
  fs.mkdirSync(path.dirname(path.resolve(prefix)), { recursive: true });
  summaryPath = outputs.summary; summary.outputs = outputs; summary.startedAt = new Date().toISOString();
  cdp = await connectCdp(port, config.targetId);
  if (await cdp.evaluate('Boolean(window.__maRealPerf)')) throw new Error('A real-bench probe already exists; do not record concurrent benchmarks');
  const completion = new Promise(resolve => cdp.onEvent(message => { if (message.method === 'Tracing.tracingComplete') resolve(message.params); }));
  captureRequestedAt = performance.now();
  summary.captureElapsedMs = null;
  summary.captureTiming = { clock: 'performance.now', startBoundary: 'before Tracing.start request', endBoundary: 'after Tracing.end acknowledgement', complete: false };
  await cdp.call('Tracing.start', {
    categories: traceCategories(options.invalidationsEnabled),
    options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream'
  });
  traceStarted = true;
  child = spawn(process.execPath, [fileURLToPath(new URL('./real-bench.mjs', import.meta.url)), String(port), scenarioPath, outputs.benchmark], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, METAAGENT_PERF_PROBE_OWNER: probeOwnerToken } });
  probeOwned = true;
  let stderrBytes = 0;
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; process.stderr.write(chunk); });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not spawn the owned benchmark runner')));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  summary.runner = { ...exit, stderrBytes };
  if (exit.code !== 0) throw new Error('Benchmark runner failed; retain its incomplete report and the diagnostic trace');
  const benchmark = JSON.parse(fs.readFileSync(outputs.benchmark, 'utf8'));
  if (benchmark.status !== 'complete') throw new Error('Benchmark did not produce a complete report');
  summary.scenarioHash = benchmark.scenarioHash; summary.scenarioId = benchmark.scenarioId;
  summary.runnerProfileEnabled = benchmark.profileEnabled;
  summary.status = 'complete';
  // Always end/read the trace in finally, including when the scenario failed.
  traceComplete = completion;
} catch (error) {
  summary.errors.push(error.message); console.error(`[trace-capture] FAILED: ${error.message}`); process.exitCode = 1;
} finally {
  if (traceStarted && cdp) {
    try {
      // Register a waiter if failure happened before the happy-path assignment.
      if (!traceComplete) traceComplete = new Promise(resolve => cdp.onEvent(message => { if (message.method === 'Tracing.tracingComplete') resolve(message.params); }));
      await cdp.call('Tracing.end');
      summary.captureElapsedMs = performance.now() - captureRequestedAt;
      summary.captureTiming.complete = true;
      const completed = await waitBounded(traceComplete, 30000, 'Trace completion');
      stream = completed.stream;
      if (!stream) throw new Error('Trace completed without a readable stream');
      if (completed.dataLossOccurred) { summary.status = 'incomplete'; summary.errors.push('Trace buffer reported data loss; retained stream is incomplete'); process.exitCode = 1; }
      traceFd = fs.openSync(`${prefix}.trace.json`, 'wx');
      while (true) {
        const chunk = await cdp.call('IO.read', { handle: stream, size: 1048576 });
        const bytes = Buffer.from(chunk.data || '', chunk.base64Encoded ? 'base64' : 'utf8');
        fs.writeSync(traceFd, bytes); summary.traceBytes += bytes.length;
        if (chunk.eof) break;
      }
      if (!summary.traceBytes) throw new Error('Trace stream was empty');
    } catch (error) {
      summary.status = 'incomplete'; summary.errors.push(`Trace finalization failed: ${error.message}`); console.error(`[trace-capture] ${summary.errors.at(-1)}`); process.exitCode = 1;
    }
  }
  if (traceFd != null) fs.closeSync(traceFd);
  if (stream && cdp) {
    try { await cdp.call('IO.close', { handle: stream }); }
    catch (error) { summary.status = 'incomplete'; summary.errors.push(`Trace stream cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  if (probeOwned && cdp) {
    try { await cdp.evaluate(`(${disposeOwnedProbe.toString()})(${JSON.stringify(probeOwnerToken)})`); }
    catch (error) { summary.status = 'incomplete'; summary.errors.push(`Owned probe cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  cdp?.close(); summary.finishedAt = new Date().toISOString();
  if (summaryPath) fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { flag: 'wx' });
  if (summary.status !== 'complete') process.exitCode = 1;
  else console.log(`[trace-capture] complete: ${summary.traceBytes} trace bytes; ${prefix}.trace.json`);
}
