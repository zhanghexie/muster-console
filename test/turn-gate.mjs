/**
 * O8 全局自治回合闸 + 回合租约（wmux globalTurnGate 原型）。
 *
 * 覆盖：
 *  1. TurnGate 纯逻辑矩阵（注入 clock）：获取/释放/满闸 null/双释放安全/
 *     租约超时回收/回收后可再获取/释放未知 token no-op/disabled 直通；
 *  2. TurnGateQueue（闸满暂存缓冲）：满闸 pending 不丢、释放即 FIFO drain、
 *     仍满闸时保底重试节奏、闸抛错 fail-open 放行；
 *  3. 闸 × 事件泵 flush 集成：事件先持久化为邮件，唤醒在满闸时排队，槽释放后
 *     drain 投递提醒；邮件正文不直接注入对话——与 main/agent/orchestrator.ts 的装配同构
 *     （真实 Orchestrator 依赖 electron/Pi 无法离线构造，装配胶水是
 *     send 的 host 分流 + releaseTurnGate 释放点，均被本测试的仿制实现逐行对应；
 *     装配正确性另由 typecheck + 代码走读保证——spec 允许的降级路径）。
 *
 * 运行: node test/turn-gate.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-gate-'));
const compile = createSharedCompiler(root, tmp);

const {
  ORCH_TURN_GATE_DEFAULTS,
  normalizeTurnGateConfig,
  TurnGate,
  TurnGateQueue,
  TURN_GATE_RETRY_MS
} = await import(pathToFileURL(compile('shared/turnGate.ts')).href);

// ---------- 1) TurnGate 纯逻辑矩阵 ----------
assert.equal(ORCH_TURN_GATE_DEFAULTS.cap, 4);
assert.equal(ORCH_TURN_GATE_DEFAULTS.leaseMs, 15 * 60_000);
assert.equal(ORCH_TURN_GATE_DEFAULTS.enabled, true);

// normalize：缺省/钳制/enabled 缺省 true
assert.deepEqual(normalizeTurnGateConfig(undefined), {
  enabled: true,
  cap: 4,
  leaseMs: 15 * 60_000
});
assert.deepEqual(normalizeTurnGateConfig({ enabled: false, cap: 0, leaseMs: 1 }), {
  enabled: false,
  cap: 1,
  leaseMs: 60_000
});
assert.deepEqual(normalizeTurnGateConfig({ cap: 99, leaseMs: 99 * 60_000 }), {
  enabled: true,
  cap: 32,
  leaseMs: 99 * 60_000
});
console.log('ok: ORCH_TURN_GATE_DEFAULTS / normalizeTurnGateConfig');

let clock = 1_000;
const cfg = { enabled: true, cap: 2, leaseMs: 15 * 60_000 };
const reclaims = [];
const gate = new TurnGate(() => cfg, () => clock, (info) => reclaims.push(info));

// 获取 / 释放 / 计数
const t1 = gate.tryAcquire();
assert.ok(typeof t1 === 'string' && t1);
const t2 = gate.tryAcquire();
assert.ok(typeof t2 === 'string' && t2 && t2 !== t1);
assert.equal(gate.activeCount, 2);

// 满闸 → null
assert.equal(gate.tryAcquire(), null);

// 释放后可再获取
gate.release(t1);
assert.equal(gate.activeCount, 1);
const t3 = gate.tryAcquire();
assert.ok(typeof t3 === 'string');
assert.equal(gate.activeCount, 2);

// 双释放 / 未知 token 释放：安全 no-op（不产生幻影计数）
gate.release(t3);
gate.release(t3);
gate.release('never-existed');
gate.release('pass:999');
assert.equal(gate.activeCount, 1);

// 租约超时回收：t2 持有超 15min → 下一次 tryAcquire 回收并放行（transient 超限可接受）
clock += 15 * 60_000 + 1;
const t4 = gate.tryAcquire();
assert.ok(typeof t4 === 'string', '回收 wedged 槽后可再获取');
assert.equal(reclaims.length, 1);
assert.ok(reclaims[0].heldMs > 15 * 60_000);
assert.equal(reclaims[0].token, t2);
assert.equal(gate.activeCount, 1, 't2 的 wedged 槽被回收，t4 占新槽');

// 未超租约的不回收
clock += 60_000;
gate.release(t4);
const t5 = gate.tryAcquire();
assert.ok(typeof t5 === 'string');
assert.equal(reclaims.length, 1, '租约内的槽不回收');
gate.release(t5);
gate.release('stale-from-previous-run'); // 陈旧释放（重启后旧 token）no-op
assert.equal(gate.activeCount, 0);

// disabled 直通：不记槽、释放 no-op
cfg.enabled = false;
const pass1 = gate.tryAcquire();
const pass2 = gate.tryAcquire();
assert.ok(pass1 && pass2 && pass1 !== pass2);
assert.equal(gate.activeCount, 0, 'disabled 不占槽');
gate.release(pass1);
assert.equal(gate.activeCount, 0);
cfg.enabled = true;
console.log('ok: TurnGate 获取/满闸/释放/租约回收/直通矩阵');

// ---------- 2) TurnGateQueue：满闸暂存 + 释放即 drain ----------
{
  let clock2 = 5_000;
  const qCfg = { enabled: true, cap: 1, leaseMs: 15 * 60_000 };
  const qGate = new TurnGate(() => qCfg, () => clock2);
  const delivered = [];
  const retryTicks = [];
  const queue = new TurnGateQueue({
    gate: qGate,
    deliver: (item, token) => delivered.push({ ...item, token }),
    schedule: (fn, ms) => {
      retryTicks.push({ fn, ms });
      return retryTicks.length;
    },
    retryMs: 1234
  });

  const held = qGate.tryAcquire(); // 先占满唯一槽
  assert.equal(queue.submit({ text: 'evt-1', workspaceId: 'ws1' }), 'pending');
  assert.equal(queue.submit({ text: 'evt-2', workspaceId: 'ws2' }), 'pending');
  assert.equal(delivered.length, 0, '满闸不投递');
  assert.equal(queue.pendingCount, 2, '排队不丢');
  assert.equal(retryTicks.length, 1, '重试只挂一个（不重复）');
  assert.equal(retryTicks[0].ms, 1234);

  // 释放 → drain FIFO 重投；首项拿到槽投递，次项仍满闸回 pending。
  // 重试定时器不重复挂（首个未触发前唯一），但已足够覆盖后续重试。
  qGate.release(held);
  queue.drain();
  assert.deepEqual(
    delivered.map((d) => d.text),
    ['evt-1'],
    '释放后按 FIFO drain'
  );
  assert.equal(queue.pendingCount, 1);
  assert.equal(retryTicks.length, 1, '未触发的重试定时器不重复挂');

  // 首个重试到点（模拟）→ 释放后投递次项
  qGate.release(delivered[0].token);
  retryTicks[0].fn();
  assert.deepEqual(
    delivered.map((d) => d.text),
    ['evt-1', 'evt-2']
  );
  assert.equal(queue.pendingCount, 0);

  // fail-open：闸抛错（配置读崩等）→ 合成 token 直接投递，绝不拦截
  const broken = new TurnGate(() => {
    throw new Error('config boom');
  }, () => clock2);
  const failDelivered = [];
  const failQueue = new TurnGateQueue({
    gate: broken,
    deliver: (item, token) => failDelivered.push({ ...item, token }),
    schedule: () => 0
  });
  assert.equal(failQueue.submit({ text: 'x', workspaceId: 'ws1' }), 'sent');
  assert.equal(failDelivered.length, 1);
  assert.match(failDelivered[0].token, /^fail-open:/);
  failQueue.drain(); // 不抛
  assert.equal(TURN_GATE_RETRY_MS, 15_000);
}
console.log('ok: TurnGateQueue 满闸暂存/释放 drain/FIFO/fail-open');

// ---------- 3) 闸 × 事件泵 flush 集成：满闸排队不丢、释放后 drain ----------
{
  const { OrchestratorEventPump } = await import(
    pathToFileURL(compile('main/orchestrator/events.ts')).href
  );
  const messageStore = await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
  const { flushMailboxWake } = await import(pathToFileURL(compile('main/messages/wake.ts')).href);
  messageStore.setAgentMessagesUserDataDir(path.join(tmp, 'user-data'));
  const workspace = path.join(tmp, 'workspace'); fs.mkdirSync(workspace);

  const clock3 = 10_000;
  const gateCfg = { enabled: true, cap: 1, leaseMs: 15 * 60_000 };
  const gate3 = new TurnGate(() => gateCfg, () => clock3);
  const sent = [];
  const pending = [];
  let markPending;
  const admitted = new Promise(resolve => { markPending = resolve; });
  // 仿 orchestrator.ts 装配：send 的 host 分流 → gateQueue.submit；链收口 →
  // release(token) + drain（真实代码在 Orchestrator.send / releaseTurnGate）
  const queue = new TurnGateQueue({
    gate: gate3,
    deliver: (item, token) => { sent.push({ text: item.text, token }); item.onAccepted(); },
    schedule: () => 0
  });
  const fakeOrchestrator = {
    isBusy: () => false,
    send: async (text, _wsId, _images, opts) => {
      if (opts?.host) {
        const outcome = queue.submit({ text, workspaceId: 'ws1', beforeStart: opts.beforeStart, onAccepted: opts.onAccepted });
        if (outcome === 'pending') { pending.push(text); markPending(); }
        return;
      }
      sent.push({ text, token: null }); // 人输入直通（不经闸）
    }
  };
  const ctx = {
    sessions: {
      get: () => undefined,
      listByWorkspace: () => [],
      broadcastMessagesChanged: () => {}
    },
    workspaces: { list: () => [{ id: 'ws1', path: workspace }] },
    config: { get: () => ({ workspaces: [{ id: 'ws1', path: workspace }] }) },
    orchestrator: fakeOrchestrator
  };
  const pump = new OrchestratorEventPump({
    ctx,
    now: () => clock3,
    setTimeout: () => 0,
    clearTimeout: () => {},
    enabled: () => true
  });

  const held = gate3.tryAcquire(); // 满闸
  pump.enqueue({ kind: 'merge_blocked', workspaceId: 'ws1', sessionId: 's1', detail: '主仓脏文件挡住合入' });
  const res = await pump.flush('ws1');
  assert.equal(res, 'send', 'flush 视角正常返回（不向上游报错）');
  const mail = messageStore.readAgentMessageLedger(workspace, 'ws1').messages;
  assert.equal(mail.length, 1, '聚合事件先写入持久邮箱');
  assert.match(mail[0].text, /主仓脏文件挡住合入/);
  const wake = flushMailboxWake(ctx, 'orchestrator:ws1', 'ws1');
  await Promise.race([admitted, wake.then(() => { throw new Error('Mailbox wake completed before reaching the gate'); })]);
  assert.equal(sent.length, 0, '满闸：聚合文本未真正发出');
  assert.equal(pending.length, 1, '满闸：邮箱提醒排队不丢');
  assert.match(pending[0], /宿主收信提醒/);
  assert.doesNotMatch(pending[0], /主仓脏文件挡住合入/, '邮件正文不直接注入');

  // 槽释放 → drain → 投递（事件聚合文本原样到达 orchestrator.send）
  gate3.release(held);
  queue.drain();
  await wake;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, pending[0]);
  assert.equal(gate3.activeCount, 1, 'drain 后的新回合占用刚释放的槽');

  // 释放链收口（runTurn finally → releaseTurnGate）→ 槽归零
  gate3.release(sent[0].token);
  assert.equal(gate3.activeCount, 0);
  pump.stop();
}
console.log('ok: 闸 × flush 集成（满闸排队不丢 / 释放 drain / 人输入直通）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] turn-gate');
