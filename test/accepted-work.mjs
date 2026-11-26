import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-work-'));
try {
  const compile = createSharedCompiler(process.cwd(), fixture);
  const { AcceptedWork } = await import(pathToFileURL(compile('main/net/acceptedWork.ts')));
  const work = new AcceptedWork();
  let finish;
  const controller = new AbortController();
  work.attach(controller);
  const pending = work.run(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  let drained = false;
  const drain = work.drain().then(() => { drained = true; });
  assert.equal(controller.signal.aborted, true);
  await Promise.resolve();
  assert.equal(drained, false, 'transport cancellation is not accepted callback completion');
  await assert.rejects(work.run(async () => {}), /stopping/);
  const late = new AbortController(); work.attach(late);
  assert.equal(late.signal.aborted, true);
  finish(); await pending; await drain;
  assert.equal(drained, true);
  const failed = new AcceptedWork();
  await assert.rejects(failed.run(async () => { throw Error('request failed'); }), /request failed/);
  await failed.drain();
  console.log('accepted work cancellation/drain/admission passed');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
