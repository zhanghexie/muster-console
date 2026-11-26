import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-shutdown-'));
let pendingHost, releaseHost;
let kernel, validationLease;
const originalTerminate = Worker.prototype.terminate;
try {
  const compile = createSharedCompiler(process.cwd(), folder);
  const { WorkflowKernel, smokeImportWorkflow } = await import(pathToFileURL(compile('main/workflow/kernel.ts')));
  const script = path.join(folder, 'run.mjs');
  fs.writeFileSync(script, 'export default async wf => { wf.phase("queued"); return 42; };');
  pendingHost = new Promise(resolve => { releaseHost = resolve; });
  kernel = new WorkflowKernel({ runId: 'fixture', script, fingerprint: 'fixture', args: {}, state: {}, onCall: () => pendingHost });
  kernel.start();
  assert.equal((await kernel.done).result, 42);
  let released = false;
  const closing = kernel.release().then(() => { released = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false, 'business done and Worker termination do not erase an accepted host callback');
  releaseHost(); await closing;

  fs.writeFileSync(script, 'setInterval(()=>{},1000);export default () => null;');
  Worker.prototype.terminate = async function () { throw Error('fixture Worker termination denied'); };
  await assert.rejects(smokeImportWorkflow(script, 'failure', 2000, fs.readFileSync(script, 'utf8'), undefined, lease => { validationLease = lease; }), /termination denied/);
  assert.equal(validationLease.released, false);
  assert.ok(fs.readdirSync(folder).some(file => file.startsWith('.exec-validate-')), 'failed release retains its bound snapshot');
  Worker.prototype.terminate = originalTerminate;
  await validationLease.release();
  assert.equal(validationLease.released, true);
  assert.equal(fs.readdirSync(folder).some(file => file.startsWith('.exec-validate-')), false);

  const { WorkflowRuntime } = await import(pathToFileURL(compile('main/workflow/runtime.ts')));
  const definition = path.join(folder, '.muster', 'workflows', 'blocked'); fs.mkdirSync(definition, { recursive: true });
  fs.writeFileSync(path.join(definition, 'WORKFLOW.md'), '---\nname: blocked\ndescription: cancellation fixture\n---\nfixture');
  fs.writeFileSync(path.join(definition, 'run.mjs'), 'await new Promise(()=>{});export default ()=>null;');
  const runtime = new WorkflowRuntime({ workspaceIds: () => ['one'], workspaceRoot: () => folder, emit() {},
    ensureTrusted: async () => true, trustState: () => 'trusted', delegate: async () => ({}), executeTool: async () => ({ ok: true }) });
  const validating = runtime.validate('one', 'blocked');
  const deadline = Date.now() + 2000;
  while (!runtime.validationWorkers.size && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.validationWorkers.size, 1);
  await runtime.shutdown(); await validating;
  assert.equal(runtime.validationWorkers.size, 0, 'shutdown drains a validation import and its actual Worker lease');
  await assert.rejects(runtime.startRun('one', 'blocked', {}), /已关闭/);
  console.log('workflow shutdown: accepted host callbacks, validation Worker failure/retry and in-flight import cancellation passed');
} finally {
  Worker.prototype.terminate = originalTerminate;
  releaseHost?.(); await kernel?.release(); await validationLease?.release();
  fs.rmSync(folder, { recursive: true, force: true });
}
