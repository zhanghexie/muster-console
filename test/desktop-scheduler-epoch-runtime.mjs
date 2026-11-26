import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-scheduler-runtime-'));
let runtime, audit;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { SchedulerDesktopEpochRuntime } = await import(pathToFileURL(compile('main/desktop/schedulerEpochRuntime.ts')));
  const { DesktopAuditStore } = await import(pathToFileURL(compile('main/desktop/auditStore.ts')));
  let next = 'receipt-1', deny = false, confirmations = [];
  const ui = { async confirmWithReceipt(...args) { confirmations.push(args); return deny ? { decision: { confirmed: false } } :
    { approvalId: next, decision: { confirmed: true, kind: 'allowOnce' } }; } };
  runtime = new SchedulerDesktopEpochRuntime(path.join(temp, 'data'), ui);
  const owner = 'orchestrator:workspace';
  assert.equal(runtime.currentBinding(owner), null);
  assert.equal(await runtime.ensureCapture(owner, () => true), 'receipt-1');
  assert.equal(runtime.currentBinding(owner).epoch, 'receipt-1');
  assert.match(confirmations[0][1], /所有显示器/);
  assert.equal(runtime.consumeCaptureApproval('orchestrator:other', 'receipt-1'), false);
  assert.equal(runtime.consumeCaptureApproval(owner, 'receipt-1'), true);
  assert.equal(runtime.consumeCaptureApproval(owner, 'receipt-1'), false, 'the initial confirmation grants only one authority handoff');
  next = 'extension-receipt';
  assert.equal(await runtime.extendCapture(owner, () => true), true);
  assert.match(confirmations.at(-1)[0], /扩展当前桌面任务链/);
  assert.equal(runtime.currentBinding(owner).epoch, 'receipt-1', 'extension does not replace the task');
  audit = new DesktopAuditStore(path.join(temp, 'data/desktop/audit.sqlite'));
  const first = audit.list(owner)[0];
  assert.equal(first.action, 'look'); assert.equal(first.result, 'allowed');
  assert.equal(first.task_hash, createHash('sha256').update('receipt-1').digest('hex'));
  runtime.closeSession(owner);
  assert.equal(runtime.currentBinding(owner), null);
  next = 'receipt-2';
  assert.equal(await runtime.ensureCapture(owner, () => true), 'receipt-2');
  assert.equal(runtime.currentBinding(owner).generation, 1);
  runtime.closeSession(owner); deny = true;
  await assert.rejects(runtime.ensureCapture(owner, () => true), /declined/);
  assert.equal(audit.list(owner).at(-1).result, 'denied');
  const simultaneousOwner = 'orchestrator:simultaneous';
  const before = confirmations.length;
  const attempts = await Promise.allSettled([
    runtime.ensureCapture(simultaneousOwner, () => true),
    runtime.ensureCapture(simultaneousOwner, () => true),
  ]);
  assert.deepEqual(attempts.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(confirmations.length, before + 1, 'concurrent retries cannot prompt again after refusal');
  runtime.close();
  runtime = new SchedulerDesktopEpochRuntime(path.join(temp, 'data'), ui);
  await assert.rejects(runtime.ensureCapture(simultaneousOwner, () => true), /previously declined/);
  assert.equal(confirmations.length, before + 1, 'refusal survives restart');
  deny = false; next = 'different-owner-receipt';
  assert.equal(await runtime.ensureCapture('orchestrator:different', () => true), next, 'refusal belongs to its owner');
  const failingRuntime = new SchedulerDesktopEpochRuntime(path.join(temp, 'failure'), { async confirmWithReceipt() {
    const dir = path.join(temp, 'failure/desktop/dispatch/refusals');
    fs.rmdirSync(dir); fs.writeFileSync(dir, 'inject persistence failure');
    return { decision: { confirmed: false } };
  } });
  try {
    await assert.rejects(failingRuntime.ensureCapture('orchestrator:failure', () => true));
    const badDir = path.join(temp, 'failure/desktop/dispatch/refusals');
    fs.unlinkSync(badDir); fs.mkdirSync(badDir);
    await assert.rejects(failingRuntime.ensureCapture('orchestrator:failure', () => true), /previously declined/);
  } finally { failingRuntime.close(); }
  console.log('scheduler desktop epoch runtime: host receipt, durable audit and session revocation passed');
} finally { audit?.close(); runtime?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
