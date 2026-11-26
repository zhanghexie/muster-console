import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'desktop-visible-epoch-'));
let runtime;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { SchedulerDesktopEpochRuntime } = await import(pathToFileURL(compile('main/desktop/schedulerEpochRuntime.ts')));
  const { VisibleSchedulerEpochs } = await import(pathToFileURL(compile('main/desktop/visibleSchedulerEpochs.ts')));
  let visible, prompts = 0;
  const ui = { async confirmWithReceipt() { prompts++; throw new Error('unexpected confirmation'); } };
  const data = path.join(temp, 'data'), owner = 'orchestrator:workspace';
  runtime = new SchedulerDesktopEpochRuntime(data, ui, () => visible);
  await assert.rejects(runtime.ensureCapture(owner, () => true), /indicator is not visible/);
  visible = 1;
  const first = await runtime.ensureCapture(owner, () => true);
  assert.match(first, /^scheduler:[a-f0-9]{64}$/);
  assert.equal(runtime.currentBinding(owner).epoch, first);
  visible = undefined;
  await assert.rejects(runtime.ensureCapture(owner, () => true), /indicator is not visible/);
  visible = 2;
  assert.equal(await runtime.ensureCapture(owner, () => true), first, 'hiding the indicator does not bypass an unresolved task');
  await assert.rejects(runtime.ensureCapture(owner, () => false), /no longer current/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runtime.ensureCapture(owner, () => true, aborted.signal));
  runtime.close();
  runtime = new SchedulerDesktopEpochRuntime(data, ui, () => visible);
  assert.equal(await runtime.ensureCapture(owner, () => true), first, 'restart preserves the task identity');
  runtime.closeSession(owner);
  assert.equal(runtime.currentBinding(owner), null);
  const next = await runtime.ensureCapture(owner, () => true);
  assert.notEqual(next, first, 'closing a scheduler session advances its identity generation');
  assert.equal(runtime.currentBinding(owner).generation, 1);
  assert.equal(prompts, 0, 'visible scheduler identity never requests a host approval');

  let generation = 0, callbackVisible = 5, owned = false, endFailure = false;
  const history = { generation: () => generation, owns: () => owned,
    record: () => { owned = true; callbackVisible = 6; },
    endSession: () => { if (endFailure) throw new Error('persistence failed'); generation++; owned = false; } };
  const epochs = new VisibleSchedulerEpochs(history, () => callbackVisible);
  await assert.rejects(epochs.ensureCapture(owner, () => true), /no longer current/,
    'a visibility change during identity persistence rejects the operation');
  assert.equal(epochs.currentBinding(owner), null);
  assert.ok(await epochs.ensureCapture(owner, () => true));
  endFailure = true;
  assert.throws(() => epochs.closeSession(owner), /persistence failed/);
  assert.equal(epochs.currentBinding(owner), null);
  endFailure = false;
  await assert.rejects(epochs.ensureCapture(owner, () => true), /no longer current/,
    'failed durable revocation cannot silently revive the identity');
  console.log('visible scheduler epochs: indicator, restart identity, revocation and no approval passed');
} finally { runtime?.close(); removeWorkspaceFixture(temp, 'desktop-visible-epoch-'); }
