import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-human-handoff-'));
const compile = createSharedCompiler(process.cwd(), path.join(directory, 'compiled'));
const { createSafetyService } = await import(pathToFileURL(compile('main/safety/service.ts')));
const { localizeSafetyReason } = await import(pathToFileURL(compile('shared/safetyReason.ts')));
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
const services = [];
let serial = 0;
const create = (options = {}) => {
  const service = createSafetyService({ userDataPath: directory, ...options });
  services.push(service);
  return service;
};
const operation = (extra = {}) => ({
  workspaceId: `handoff-${++serial}`, source: 'catalog', action: 'extensions.trust',
  args: { name: 'fixture', content: 'return true' }, ...extra,
});
const receipt = (r, verdict = 'concern') => ({
  requestId: r.requestId, fingerprint: r.fingerprint, generation: r.generation,
  verdict, reason: 'fixture requires a human decision',
});
const until = async (predicate) => {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('fixture state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};
const writer = fs.writeFileSync;
// Keep Node alive when exercising production's deliberately unref'ed budgets.
const keepAlive = setInterval(() => {}, 1000);
try {
  // Minimal red/green case: reverting service.ts must fail here immediately,
  // rather than hang waiting for the old chat-only confirmation path.
  let minimalCalls = 0;
  const minimal = create({ reviewer: async r => receipt(r) });
  const minimalOp = operation({ humanConfirm: async () => { minimalCalls++; return true; } });
  const minimalTask = minimal.authorize(minimalOp);
  await until(() => minimal.snapshot(minimalOp.workspaceId).records[0]?.status !== 'reviewing');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(minimalCalls, 1, 'concern must immediately invoke the operation human-confirm callback');
  assert.equal((await minimalTask).allowed, true);

  for (const kind of ['concern', 'deny', 'failure', 'invalid', 'timeout']) {
    let reviews = 0, humanCalls = 0, humanSignal;
    const op = operation();
    const service = create({
      timeoutMs: 8,
      reviewer: async r => {
        reviews++;
        if (kind === 'failure') throw new Error('provider offline');
        if (kind === 'timeout') return new Promise(() => {});
        return { ...receipt(r, kind === 'deny' ? 'deny' : 'concern'), ...(kind === 'invalid' ? { fingerprint: 'wrong' } : {}) };
      },
      humanConfirm: async (target, reason, signal) => {
        humanCalls++;
        assert.equal(target, op);
        assert.ok(reason);
        if (kind === 'timeout') {
          assert.equal(reason, '审批模型失败：审批模型执行超过预算。请人工决定本次操作');
          applyLocaleSetting('en');
          assert.equal(localizeSafetyReason(reason), 'The approval model failed: The approval model exceeded its time budget. Decide this operation manually.');
          applyLocaleSetting('zh-CN');
        }
        humanSignal = signal;
        return true;
      },
    });
    let effects = 0;
    const perform = async () => { const d = await service.authorize(op); if (d.allowed) effects++; return d; };
    const result = await perform();
    assert.equal(result.allowed, true, kind);
    assert.equal(result.escalated, true, kind);
    assert.equal(humanCalls, 1, kind);
    assert.equal(reviews, 1, 'human approval does not ask a failed/concerned reviewer again');
    assert.equal(effects, 1);
    assert.equal(humanSignal.aborted, true, 'completed human decisions close their dialogs');
    const messages = service.snapshot(op.workspaceId).messages;
    assert.equal(messages[0].origin, 'approval_request');
    assert.ok(messages.some(m => m.role === 'system' && m.origin === 'human_decision' && m.requestId === result.requestId));
  }

  const cleanupReviewer = () => new Promise(() => {});
  cleanupReviewer.release = () => { throw new Error('上游清理错误'); };
  let cleanupReason;
  const cleanupFailure = create({ timeoutMs: 8, reviewer: cleanupReviewer, humanConfirm: async (_op, reason) => { cleanupReason = reason; return false; } });
  await cleanupFailure.authorize(operation());
  assert.equal(cleanupReason, '审批模型失败：审批模型取消清理失败：上游清理错误。请人工决定本次操作');
  applyLocaleSetting('en');
  assert.equal(localizeSafetyReason(cleanupReason), 'The approval model failed: Could not clean up the cancelled approval model: 上游清理错误. Decide this operation manually.');
  applyLocaleSetting('zh-CN');

  for (const kind of ['concern', 'failure']) {
    const op = operation();
    const service = create({ reviewer: async r => { if (kind === 'failure') throw new Error('offline'); return receipt(r); } });
    const result = await service.authorize(op);
    assert.equal(result.allowed, false);
    assert.equal(result.escalated, true);
    assert.match(result.reason, /人工确认通道不可用/);
    assert.equal(service.snapshot(op.workspaceId).records[0].status, 'failed', 'no hidden chat-only wait remains');
  }

  // Operation-specific UI overrides the default, and a human rejection is final.
  let fallbackCalls = 0, operationCalls = 0;
  const override = create({ reviewer: async r => receipt(r), humanConfirm: async () => { fallbackCalls++; return true; } });
  assert.equal((await override.authorize(operation({ humanConfirm: async (_reason, signal) => { operationCalls++; assert.ok(signal); return false; } }))).allowed, false);
  assert.equal(operationCalls, 1);
  assert.equal(fallbackCalls, 0);

  // Automatic approval messages have two forms; ordinary human chat stays natural.
  const formatted = create({
    reviewer: async r => ({ ...receipt(r, r.action === '__user_chat__' ? 'concern' : r.args.verdict), reason: r.action === '__user_chat__' ? '规则已说明。' : '权限范围尚未核实。\n需要核对扩展代码。' }),
    humanConfirm: async () => false,
  });
  const formattedOp = operation({ args: { verdict: 'allow' } });
  await formatted.authorize(formattedOp);
  await formatted.authorize({ ...formattedOp, args: { verdict: 'concern' } });
  assert.deepEqual(formatted.snapshot(formattedOp.workspaceId).messages.filter(m => m.role === 'assistant').map(m => m.text), ['通过', '需要人工审核：权限范围尚未核实。 需要核对扩展代码。']);
  await formatted.send(formattedOp.workspaceId, '说明放行规则');
  assert.equal(formatted.snapshot(formattedOp.workspaceId).messages.at(-1).text, '规则已说明。');

  // Waiting for a person releases the reviewer queue and ordinary chat stays chat.
  let decide, dialogSignal, reviewCount = 0, capturedHistory;
  const concurrent = create({
    reviewer: async r => { reviewCount++; capturedHistory = r.history; return receipt(r, r.action === '__user_chat__' || reviewCount > 1 ? 'allow' : 'concern'); },
    humanConfirm: async (_op, _reason, signal) => new Promise(resolve => { decide = resolve; dialogSignal = signal; }),
  });
  const op = operation();
  const first = concurrent.authorize(op);
  await until(() => decide);
  const requestId = concurrent.snapshot(op.workspaceId).records[0].requestId;
  const second = await concurrent.authorize(operation({ workspaceId: op.workspaceId }));
  assert.equal(second.allowed, true, 'human wait does not block another model request');
  await concurrent.send(op.workspaceId, '通过');
  assert.equal(concurrent.snapshot(op.workspaceId).records[0].status, 'needs_confirmation');
  const before = reviewCount;
  const status = await concurrent.send(op.workspaceId, '通过', requestId);
  assert.equal(reviewCount, before, 'legacy request-bound replies return status without model re-review');
  assert.match(status.messages.at(-1).text, /弹窗/);
  await assert.rejects(() => concurrent.send('other-workspace', 'yes', requestId), /不属于/);
  decide(true);
  assert.equal((await first).allowed, true);
  assert.equal(dialogSignal.aborted, true);
  await concurrent.send(op.workspaceId, 'What was decided?');
  assert.ok(capturedHistory.some(m => m.origin === 'human_decision' && m.role === 'system'));
  assert.equal(concurrent.snapshot(op.workspaceId).messages.at(-2).origin, 'user_chat');

  // Time spent behind a blocked model belongs to queue budget, then goes to UI.
  let releaseChat, modelCalls = 0, queueHumans = 0;
  const queued = create({
    queueTimeoutMs: 8, timeoutMs: 1000,
    reviewer: async r => { modelCalls++; if (r.action === '__user_chat__') return new Promise(resolve => { releaseChat = () => resolve(receipt(r, 'allow')); }); return receipt(r, 'allow'); },
    humanConfirm: async (_op, reason) => { queueHumans++; assert.match(reason, /排队/); return true; },
  });
  const chat = queued.send('queue', 'Hold model queue');
  await until(() => releaseChat);
  const queuedDecision = await queued.authorize(operation({ workspaceId: 'queue' }));
  assert.equal(queuedDecision.allowed, true);
  assert.equal(queueHumans, 1);
  releaseChat(); await chat;
  await until(() => !queued.snapshot('queue').busy);
  assert.equal(modelCalls, 1, 'expired queued review cannot re-run after human approval');

  for (const kind of ['stop', 'clear', 'abort', 'fingerprint', 'trusted', 'rule', 'invalidate', 'dispose', 'human-timeout']) {
    let confirm, signal, trusted = true;
    const abort = new AbortController();
    const target = operation({ signal: abort.signal });
    const service = create({
      confirmationTimeoutMs: kind === 'human-timeout' ? 8 : 1000,
      captureTrustedState: () => () => trusted,
      reviewer: async r => { if (r.action === '__user_chat__') { r.updateRule({ text: 'fixture rule', actions: ['extensions.trust'], enabled: true }); return receipt(r, 'allow'); } return receipt(r); },
      humanConfirm: async (_op, _reason, s) => new Promise(resolve => { confirm = resolve; signal = s; }),
    });
    if (kind === 'rule') await service.send(target.workspaceId, 'Set fixture rule');
    const task = service.authorize(target);
    await until(() => confirm);
    if (kind === 'stop') service.stop(target.workspaceId);
    if (kind === 'clear') service.clearConversation(target.workspaceId);
    if (kind === 'abort') abort.abort();
    if (kind === 'fingerprint') target.args.content = 'changed';
    if (kind === 'trusted') trusted = false;
    if (kind === 'rule') { const state = service.snapshot(target.workspaceId); service.setRuleEnabled(target.workspaceId, state.rules[0].id, false, state.ruleRevision); }
    if (kind === 'invalidate') service.invalidate(target.workspaceId);
    if (kind === 'dispose') service.dispose();
    const result = await task;
    assert.equal(result.allowed, false, kind);
    assert.equal(signal.aborted, true, `${kind} closes the corresponding dialog`);
    confirm(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.notEqual(service.snapshot(target.workspaceId).records[0].status, 'allowed', 'late human receipts cannot restore authorization');
  }

  // Late model output cannot override the human result after a timeout.
  let finishModel;
  const late = create({ timeoutMs: 8, reviewer: r => new Promise(resolve => { finishModel = () => resolve(receipt(r, 'allow')); }), humanConfirm: async () => false });
  const target = operation();
  assert.equal((await late.authorize(target)).allowed, false);
  finishModel();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(late.snapshot(target.workspaceId).records[0].status, 'denied');

  // An SDK may ignore abort and retain its active turn. Service must detach it
  // before releasing the logical queue so the next request can start cleanly.
  for (const ending of ['timeout', 'cancel', 'stop']) {
    let active = false, calls = 0, releases = 0, lateReceipt, humanCalls = 0;
    const controller = new AbortController();
    const target = operation({ signal: controller.signal });
    const reviewer = async r => {
      calls++;
      if (calls === 1) {
        active = true;
        return new Promise(resolve => { lateReceipt = () => resolve(receipt(r, 'allow')); });
      }
      assert.equal(active, false, 'old physical reviewer must detach before a new model turn');
      return receipt(r, 'allow');
    };
    reviewer.release = () => { releases++; active = false; };
    const service = create({
      reviewer, timeoutMs: ending === 'timeout' ? 8 : 1000,
      humanConfirm: async () => { humanCalls++; return false; },
    });
    const first = service.authorize(target);
    await until(() => lateReceipt);
    if (ending === 'cancel') controller.abort();
    if (ending === 'stop') service.stop(target.workspaceId);
    assert.equal((await first).allowed, false);
    assert.equal(releases, 1, 'abort detaches exactly the active reviewer');
    const next = await service.authorize(operation({ workspaceId: target.workspaceId }));
    assert.equal(next.allowed, true, 'same workspace recovers after a hung reviewer');
    assert.equal(humanCalls, ending === 'timeout' ? 1 : 0);
    lateReceipt();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(releases, 1, 'late receipts cannot release a fresh reviewer');
    assert.equal(service.snapshot(target.workspaceId).records[1].status, 'allowed');
  }

  for (const failureAt of ['handoff', 'decision']) {
    let humanCalls = 0, signal, confirm;
    const target = operation();
    const service = create({
      reviewer: async r => { if (failureAt === 'handoff') fs.writeFileSync = () => { throw new Error('audit unavailable'); }; return receipt(r); },
      humanConfirm: async (_op, _reason, s) => { humanCalls++; signal = s; return new Promise(resolve => { confirm = resolve; }); },
    });
    try {
      const task = service.authorize(target);
      if (failureAt === 'decision') {
        await until(() => confirm);
        fs.writeFileSync = () => { throw new Error('audit unavailable'); };
        confirm(true);
      }
      const result = await task;
      assert.equal(result.allowed, false);
      assert.match(result.reason, /审计写入失败/);
      assert.equal(service.snapshot(target.workspaceId).records[0].status, 'failed');
      assert.equal(humanCalls, failureAt === 'handoff' ? 0 : 1);
      if (signal) assert.equal(signal.aborted, true);
    } finally { fs.writeFileSync = writer; }
  }

  // A workspace audit failure must also end other human waits in that same
  // workspace, even though none of them occupies the model queue anymore.
  const auditSignals = [];
  const audit = create({
    reviewer: async r => receipt(r),
    humanConfirm: async (_op, _reason, signal) => { auditSignals.push(signal); return new Promise(() => {}); },
  });
  const auditOp = operation();
  const auditTasks = [audit.authorize(auditOp), audit.authorize(operation({ workspaceId: auditOp.workspaceId }))];
  await until(() => auditSignals.length === 2);
  const auditId = audit.snapshot(auditOp.workspaceId).records[0].requestId;
  try {
    fs.writeFileSync = () => { throw new Error('workspace audit unavailable'); };
    await assert.rejects(() => audit.send(auditOp.workspaceId, 'show status', auditId), /audit/);
    const results = await Promise.all(auditTasks);
    assert.ok(results.every(result => !result.allowed && /审计写入失败/.test(result.reason)));
    assert.ok(auditSignals.every(signal => signal.aborted), 'poisoned audit closes all pending human dialogs');
  } finally { fs.writeFileSync = writer; }
  console.log('safety human handoff regressions passed');
} finally {
  fs.writeFileSync = writer;
  clearInterval(keepAlive);
  for (const service of services) { try { service.dispose(); } catch {} }
  fs.rmSync(directory, { recursive: true, force: true });
}
