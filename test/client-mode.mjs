/**
 * clientMode 契约 + task-run owner/lease 词表回归（zcode-adopt-batch-d D3 / T3）：
 * 1) hello 强校验：合法配对、缺 clientMode、未知 clientMode、缺/未知 deliveryProfile、
 *    配对不匹配（desktop×replayable / web×continuous）一律拒绝；
 * 2) lease 互斥：acquire 首占、同主续租、他主未过期拒绝 held_by_other、
 *    他主过期 reclaim（owner_lost 语义）、release 仅持有者成功；
 * 3) 词表：stream_mirror_gap / owner_lost 判定与投递分型 recoverable。
 * 运行: node test/client-mode.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-mode-'));
const compile = createSharedCompiler(root, tmp);

const cm = await import(pathToFileURL(compile('shared/clientMode.ts')).href);
const {
  CLIENT_MODES,
  DELIVERY_PROFILES,
  CLIENT_MODE_DELIVERY,
  parseClientMode,
  parseDeliveryProfile,
  expectedDeliveryProfile,
  isReplayableDelivery,
  validateClientHello,
  DEFAULT_TASK_RUN_LEASE_MS,
  isLeaseExpired,
  peekTaskRunLease,
  acquireTaskRunLease,
  releaseTaskRunLease,
  detectOwnerLost,
  classifyStreamMirrorGap
} = cm;

// ── 1) hello 强校验 ──
{
  assert.equal(CLIENT_MODES.length, 2);
  assert.deepEqual([...CLIENT_MODES], ['desktop-continuous', 'web-remote-replayable']);
  assert.deepEqual([...DELIVERY_PROFILES], ['continuous', 'replayable']);
  assert.equal(CLIENT_MODE_DELIVERY['desktop-continuous'], 'continuous');
  assert.equal(CLIENT_MODE_DELIVERY['web-remote-replayable'], 'replayable');
  assert.equal(expectedDeliveryProfile('desktop-continuous'), 'continuous');
  assert.equal(expectedDeliveryProfile('web-remote-replayable'), 'replayable');
  assert.equal(isReplayableDelivery('continuous'), false);
  assert.equal(isReplayableDelivery('replayable'), true);

  assert.equal(parseClientMode('desktop-continuous'), 'desktop-continuous');
  assert.equal(parseClientMode('web-remote-replayable'), 'web-remote-replayable');
  assert.equal(parseClientMode('phone-remote'), null);
  assert.equal(parseClientMode(1), null);
  assert.equal(parseDeliveryProfile('continuous'), 'continuous');
  assert.equal(parseDeliveryProfile('replayable'), 'replayable');
  assert.equal(parseDeliveryProfile('streaming'), null);

  // 合法配对
  const okDesktop = validateClientHello({
    clientMode: 'desktop-continuous',
    deliveryProfile: 'continuous'
  });
  assert.equal(okDesktop.ok, true);
  assert.equal(okDesktop.clientMode, 'desktop-continuous');
  assert.equal(okDesktop.deliveryProfile, 'continuous');

  const okWeb = validateClientHello({
    clientMode: 'web-remote-replayable',
    deliveryProfile: 'replayable'
  });
  assert.equal(okWeb.ok, true);
  assert.equal(okWeb.clientMode, 'web-remote-replayable');

  // 非对象
  for (const bad of [null, undefined, 'x', 3, ['a']]) {
    const r = validateClientHello(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_object');
  }

  // 缺 clientMode
  for (const payload of [{}, { clientMode: '' }, { clientMode: null }]) {
    const r = validateClientHello(payload);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing_client_mode');
  }

  // 未知 clientMode
  {
    const r = validateClientHello({ clientMode: 'phone-remote', deliveryProfile: 'continuous' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_client_mode');
  }

  // 缺 deliveryProfile（strict：必填）
  for (const payload of [
    { clientMode: 'desktop-continuous' },
    { clientMode: 'desktop-continuous', deliveryProfile: '' }
  ]) {
    const r = validateClientHello(payload);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing_delivery_profile');
  }

  // 未知 deliveryProfile
  {
    const r = validateClientHello({
      clientMode: 'desktop-continuous',
      deliveryProfile: 'streaming'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_delivery_profile');
  }

  // 配对不匹配：双向都拒
  {
    const a = validateClientHello({
      clientMode: 'desktop-continuous',
      deliveryProfile: 'replayable'
    });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'delivery_mismatch');

    const b = validateClientHello({
      clientMode: 'web-remote-replayable',
      deliveryProfile: 'continuous'
    });
    assert.equal(b.ok, false);
    assert.equal(b.code, 'delivery_mismatch');
  }
}

// ── 2) lease 互斥 ──
{
  const table = new Map();
  const now = 1_000_000;
  const leaseMs = 10_000;

  // 首占
  const a1 = acquireTaskRunLease(table, { runId: 'run-1', owner: 'desk', now, leaseMs });
  assert.equal(a1.ok, true);
  assert.equal(a1.reclaimed, false);
  assert.equal(a1.lease.owner, 'desk');
  assert.equal(peekTaskRunLease(table, 'run-1')?.owner, 'desk');

  // 同主续租（刷新 acquiredAt）
  const a2 = acquireTaskRunLease(table, {
    runId: 'run-1',
    owner: 'desk',
    now: now + 1_000,
    leaseMs
  });
  assert.equal(a2.ok, true);
  assert.equal(a2.reclaimed, false);
  assert.equal(a2.lease.acquiredAt, now + 1_000);

  // 他主未过期 → 互斥拒绝
  const a3 = acquireTaskRunLease(table, {
    runId: 'run-1',
    owner: 'web',
    now: now + 2_000,
    leaseMs
  });
  assert.equal(a3.ok, false);
  assert.equal(a3.code, 'held_by_other');
  assert.equal(a3.heldBy, 'desk');
  assert.equal(peekTaskRunLease(table, 'run-1')?.owner, 'desk');

  // 他主过期 → reclaim（owner_lost 语义）
  const a4 = acquireTaskRunLease(table, {
    runId: 'run-1',
    owner: 'web',
    now: now + 1_000 + leaseMs,
    leaseMs
  });
  assert.equal(a4.ok, true);
  assert.equal(a4.reclaimed, true);
  assert.equal(a4.evictedOwner, 'desk');
  assert.equal(peekTaskRunLease(table, 'run-1')?.owner, 'web');

  // release：非持有者 no-op
  assert.equal(releaseTaskRunLease(table, { runId: 'run-1', owner: 'desk' }), false);
  assert.equal(peekTaskRunLease(table, 'run-1')?.owner, 'web');

  // release：持有者成功
  assert.equal(releaseTaskRunLease(table, { runId: 'run-1', owner: 'web' }), true);
  assert.equal(peekTaskRunLease(table, 'run-1'), null);

  // 释放后可被任意一方再占
  const a5 = acquireTaskRunLease(table, { runId: 'run-1', owner: 'phone', now, leaseMs });
  assert.equal(a5.ok, true);
  assert.equal(a5.reclaimed, false);

  // 非法入参
  assert.equal(acquireTaskRunLease(table, { runId: '', owner: 'x', now }).ok, false);
  assert.equal(acquireTaskRunLease(table, { runId: 'r', owner: '', now }).ok, false);
  assert.equal(acquireTaskRunLease(table, { runId: 'r', owner: 'x', now: NaN }).ok, false);
  assert.equal(releaseTaskRunLease(table, { runId: '', owner: 'x' }), false);

  // isLeaseExpired 边界：到期即过期（>= leaseMs）
  const lease = { runId: 'r', owner: 'o', acquiredAt: 100, leaseMs: 50 };
  assert.equal(isLeaseExpired(lease, 149), false);
  assert.equal(isLeaseExpired(lease, 150), true);

  // 缺省租约时长
  const t2 = new Map();
  const d = acquireTaskRunLease(t2, { runId: 'r', owner: 'o', now: 0 });
  assert.equal(d.ok, true);
  assert.equal(d.lease.leaseMs, DEFAULT_TASK_RUN_LEASE_MS);
}

// ── 3) 词表事件：owner_lost / stream_mirror_gap ──
{
  const table = new Map();
  acquireTaskRunLease(table, { runId: 'run-2', owner: 'desk', now: 0, leaseMs: 100 });

  assert.equal(detectOwnerLost(table, { runId: 'run-2', now: 50 }), null);
  assert.equal(detectOwnerLost(table, { runId: 'run-2', now: 100 }), 'owner_lost');
  assert.equal(detectOwnerLost(table, { runId: 'nope', now: 100 }), null);

  // 持有者自身流：无缺口
  const owner = classifyStreamMirrorGap({
    role: 'owner',
    lastSeq: 3,
    seq: 4,
    deliveryProfile: 'continuous'
  });
  assert.equal(owner.gap, false);

  // 镜像端连续序号：无缺口
  const cont = classifyStreamMirrorGap({
    role: 'mirror',
    lastSeq: 3,
    seq: 4,
    deliveryProfile: 'continuous'
  });
  assert.equal(cont.gap, false);

  // 镜像端缺口 + continuous：不可回放
  const gapC = classifyStreamMirrorGap({
    role: 'mirror',
    lastSeq: 3,
    seq: 7,
    deliveryProfile: 'continuous'
  });
  assert.equal(gapC.gap, true);
  assert.equal(gapC.kind, 'stream_mirror_gap');
  assert.equal(gapC.recoverable, false);

  // 镜像端缺口 + replayable：可回放补洞
  const gapR = classifyStreamMirrorGap({
    role: 'mirror',
    lastSeq: 3,
    seq: 7,
    deliveryProfile: 'replayable'
  });
  assert.equal(gapR.gap, true);
  assert.equal(gapR.kind, 'stream_mirror_gap');
  assert.equal(gapR.recoverable, true);

  // 重复投递（seq === last）与倒退重放（seq < last）不是缺口：重复≠丢，只有跳号才算洞
  const dup = classifyStreamMirrorGap({
    role: 'mirror',
    lastSeq: 3,
    seq: 3,
    deliveryProfile: 'replayable'
  });
  assert.equal(dup.gap, false);
  const back = classifyStreamMirrorGap({
    role: 'mirror',
    lastSeq: 7,
    seq: 3,
    deliveryProfile: 'replayable'
  });
  assert.equal(back.gap, false);
}

// ── 2026-09-27 复审回归：now 非有限（NaN/Infinity）不误报过期 ──
{
  const lease = { owner: 'a', runId: 'r', acquiredAt: 100, leaseMs: 150 };
  assert.equal(isLeaseExpired(lease, NaN), false, 'NaN now → 不过期（不误报 owner_lost）');
  assert.equal(isLeaseExpired(lease, Infinity), false, 'Infinity now → 不过期');
  assert.equal(detectOwnerLost(new Map([['r', lease]]), { runId: 'r', now: NaN }), null);
  assert.equal(detectOwnerLost(new Map([['r', lease]]), { runId: 'r', now: 300 }), 'owner_lost');
}

console.log('client-mode.mjs OK');
