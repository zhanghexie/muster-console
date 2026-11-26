/**
 * 记忆审计修复回归（2026-10-02 docs/audits/memory-integrity-review-2026-10-02.md）：
 *
 * - M3（读取错误不能覆盖旧内容）：巩固 apply / 画像执行 / 画像追
 *   加 / 面板 saveEntry·forget·restore / 记忆中心回滚的一次 EIO/EACCES 注入——原文件
 *   字节不变、明确失败；ENOENT 首次创建仍正常；sweep 目标读失败跳过留 log。
 * - M1（审批跨存储幂等恢复）：文件写盘后收尾翻转失败（重启再批准）/ 写盘前崩溃
 *   （过期接管重写）/ 写盘后日志未推进（哈希识别已写→只收尾）/ busy 竞争 / reject
 *   单事务原子性 / 部分拒绝 / 双连接与真·双进程竞争；正文效果恰好一次、日志与
 *   staging 一致、add/supersede/画像分别覆盖。
 * - M2（画像零应用不装批准成功）：哈希冲突/超上限/全拒绝 → ok:false + 审批保持
 *   pending + 正文不变 + 可驳回退场；部分应用如实报 appliedCount 与拒绝分类。
 * - F（2026-10-06 生产事故回归）：小文件（两条目 467 字）merge 的 oldSnippet 占
 *   原文 44%+，旧条目损失界（按全文 25%）把人工批准的改写全量拒成零应用、审批永久
 *   卡死——审批路径关损失界（lossGuard:'none'：merge/supersede 全经人工批准，人即
 *   内容门）；零应用文案如实带拒绝分类（ambiguous 直说，不再笼统「目标可能已变化」）。
 *
 * 还原修复即红：去掉 M3 写前读取分类 / 去掉 approval_exec 恢复协议 / 去掉画像零应用
 * 守卫，对应断言转红。全部落系统临时目录（mkdtemp），不触真实用户记忆与
 * `.muster/local/`；fs/db 故障注入只针对夹具文件与夹具库句柄。
 * Run: node test/memory-approval-recovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

// 本机 Node 构建缺 fts5 时按仓库惯例打印原因后退出 0 跳过（见 helpers/sqlite-fts5.mjs）
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-approval-recovery-'));
const compile = createSharedCompiler(root, tmp);

const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const stagingMod = await import(pathToFileURL(compile('main/memory/staging.ts')).href);
const applyMod = await import(pathToFileURL(compile('main/memory/consolidation/apply.ts')).href);
const approvalMod = await import(pathToFileURL(compile('main/memory/consolidation/approval.ts')).href);
const approvalExecMod = await import(pathToFileURL(compile('main/memory/consolidation/approvalExec.ts')).href);
const profileMod = await import(pathToFileURL(compile('main/memory/consolidation/profile.ts')).href);
const userProfileMod = await import(pathToFileURL(compile('main/memory/userProfile.ts')).href);
const panelStoreMod = await import(pathToFileURL(compile('main/memory/panelStore.ts')).href);
const centerMod = await import(pathToFileURL(compile('main/memory/center.ts')).href);
const svcRefMod = await import(pathToFileURL(compile('main/memory/serviceRef.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);
const sweepMod = await import(pathToFileURL(compile('main/memory/consolidation/sweep.ts')).href);

const { openMemoryDb, getApproval, getApprovalExec, upsertApprovalExecClaim, listConsolidationLog } = dbMod;
const { noteStaging } = stagingMod;
const { sha256Content } = applyMod;
const { enqueueConsolidationApproval, decideConsolidationApproval, consolidationApprovalFileHooks } = approvalMod;
const { executeApprovalFilePhase, writeOwnedApprovalContent, APPROVAL_EXEC_STALE_MS } = approvalExecMod;
const { enqueueUserProfileApproval, decideUserProfileApproval, planProfileWrite } = profileMod;
const { setUserProfileFilePath } = userProfileMod;
const { memorySaveEntry, memoryForget, memoryRestore } = panelStoreMod;
const { memoryCenterRollback } = centerMod;
const { runConsolidationSweep } = sweepMod;

// 记忆中心回滚走 MemoryService 单例开门（与生产同链路）
svcRefMod.setMemoryService(new svcMod.MemoryService());

// ---------------------------------------------------------------------------
// 夹具与注入器
// ---------------------------------------------------------------------------

let wsCounter = 0;
function freshWs(tag) {
  const ws = path.join(tmp, `ws-${tag}-${(wsCounter += 1)}`);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function seedCandidate(db, opts = {}) {
  const r = noteStaging(db, {
    text: opts.text ?? '用户偏好：测试一律用临时目录 #lesson',
    origin: opts.origin ?? 'worker',
    sessionKind: opts.sessionKind ?? 'worker',
    evidencePath: opts.evidencePath ?? 'agent-session:rec'
  });
  assert.ok(r.ok, `noteStaging 应成功：${JSON.stringify(r)}`);
  if (!opts.noGate) {
    // 信号门三硬门槛需要非普通搜索的召回事件（与 memory-consolidation.mjs 同款）
    const chunkId = mirrorChunkId(db, r.stagingId);
    const day = 86_400_000;
    for (const [q, ts, rel] of [
      ['临时目录', Date.now(), 0.8],
      ['测试目录', Date.now() - day, 0.6],
      ['临时目录', Date.now() - 2 * day, 0.9]
    ]) {
      dbMod.recordRecallStat(db, chunkId, 'brief_injected', q, ts, rel);
    }
  }
  return r.stagingId;
}

function mirrorChunkId(db, stagingId) {
  const row = db.handle.prepare('SELECT id FROM chunks WHERE staging_id = ?').get(stagingId);
  return row ? Number(row.id) : null;
}

function addOp(stagingId, text, extra = {}) {
  return {
    op: 'add',
    candidateId: stagingId,
    stagingId,
    text,
    reason: 'test',
    confidence: 0.4,
    citation: 'Source: agent-session:rec',
    ...extra
  };
}

/** 一次性读失败注入（只针对指定文件的第一次 readFileSync；finally 恢复） */
function withReadFailure(fileAbs, code, fn) {
  const orig = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function injected(p, ...args) {
    if (armed && String(p) === fileAbs) {
      armed = false;
      const e = new Error(`injected ${code} for test`);
      e.code = code;
      throw e;
    }
    return orig.call(this, p, ...args);
  };
  const restore = () => {
    fs.readFileSync = orig;
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

/** 一次性 db.write 内 prepare 故障注入（sql 前缀匹配；finally 恢复） */
function withDbWriteFault(db, sqlPrefix, fn) {
  const orig = db.write.bind(db);
  let armed = true;
  db.write = (f) =>
    orig((tx) =>
      f(
        new Proxy(tx, {
          get(t, prop) {
            if (prop === 'prepare') {
              return (sql) => {
                if (armed && String(sql).startsWith(sqlPrefix)) {
                  armed = false;
                  throw new Error(`injected db fault on ${sqlPrefix}`);
                }
                return t.prepare(sql);
              };
            }
            const v = Reflect.get(t, prop);
            return typeof v === 'function' ? v.bind(t) : v;
          }
        })
      )
    );
  try {
    return fn();
  } finally {
    db.write = orig;
  }
}

function logLinesFor(db, approvalId) {
  return listConsolidationLog(db, 200).filter((l) => (l.triggerSource ?? '') === `approval:${approvalId}:approved`);
}

function eventsFor(db, kind, approvalId) {
  return db.handle
    .prepare('SELECT * FROM memory_events WHERE kind = ? AND approval_id = ? ORDER BY id')
    .all(kind, approvalId);
}

// ---------------------------------------------------------------------------
// A. M3：读取错误分类——各写入口一次 EIO/EACCES，原字节不变 + 明确失败
// ---------------------------------------------------------------------------

{
  // A1/A2.（已删）directWrite 双面 M3 用例随 MEMORY.md 直写通道退役（2026-10-26 F-01）；
  // 读前分类守卫（readTextForWrite）在存活写入面（A3 巩固 apply / A4 画像执行 / A5 画像
  // 追加）继续守卫，合同不缩水。

  // A3. 巩固 apply（sweep 自动应用写点）：读失败抛出、不写盘
  const ws4 = freshWs('m3-apply');
  const t4 = path.join(ws4, 'MEMORY.md');
  fs.writeFileSync(t4, '# APPLY_KEEP\n');
  const db4 = openMemoryDb(ws4);
  const sid4 = seedCandidate(db4);
  let applyErr = null;
  try {
    withReadFailure(t4, 'EIO', () => {
      applyMod.applyConsolidationOperations(db4, {
        ops: [addOp(sid4, '#lesson APPLY_NEW')],
        evidence: [{ stagingId: sid4, evidencePath: 'agent-session:rec' }],
        targetFile: t4,
        budgetChars: 16_000,
        surface: 'worker',
        baseHash: null,
        now: Date.now(),
        cause: 'test'
      });
    });
  } catch (e) {
    applyErr = e;
  }
  assert.ok(applyErr, 'apply 读失败应抛出（不被吞）');
  assert.match(String(applyErr.message), /EIO|中止写入/);
  assert.equal(fs.readFileSync(t4, 'utf8'), '# APPLY_KEEP\n', '巩固写点原样保留');
  db4.close();

  // A4. 画像执行 executeProfileWrite：读失败抛出、USER.md 不动
  const ws5 = freshWs('m3-profile');
  setUserProfileFilePath(ws5);
  const p5 = path.join(ws5, 'memory', 'USER.md');
  fs.mkdirSync(path.dirname(p5), { recursive: true });
  fs.writeFileSync(p5, '<!-- observed: 2026-01-01 | status: active -->\nAlways 保持简洁。\n');
  const db5 = openMemoryDb(ws5);
  let profileErr = null;
  try {
    withReadFailure(p5, 'EIO', () => {
      profileMod.executeProfileWrite(db5, {
        ops: [{ op: 'add', stagingId: 1, directive: 'Never 覆盖。', confidence: 0.9 }],
        targetFile: p5,
        baseHash: null,
        baseHashFn: sha256Content,
        now: Date.now(),
        cause: 'test'
      });
    });
  } catch (e) {
    profileErr = e;
  }
  assert.ok(profileErr, '画像执行读失败应抛出');
  assert.match(String(profileErr.message), /EIO|中止写入/);
  assert.ok(fs.readFileSync(p5, 'utf8').includes('保持简洁'), '画像原指令保留');
  db5.close();

  // A5. appendProfileDirective（memory.remember 画像路由）：读失败→read_failed，旧画像不动
  const ws6 = freshWs('m3-profile-append');
  setUserProfileFilePath(ws6);
  fs.mkdirSync(path.join(ws6, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws6, 'memory', 'USER.md'), '<!-- observed: 2026-01-01 | status: active -->\nAlways 先给结论。\n');
  const r6 = withReadFailure(path.join(ws6, 'memory', 'USER.md'), 'EIO', () =>
    userProfileMod.appendProfileDirective('Never 铺垫。')
  );
  assert.equal(r6.ok, false);
  assert.equal(r6.code, 'read_failed');
  assert.ok(fs.readFileSync(path.join(ws6, 'memory', 'USER.md'), 'utf8').includes('先给结论'), '画像未被清空重写');
  // ENOENT 首建正常
  const ws6b = freshWs('m3-profile-append-create');
  setUserProfileFilePath(ws6b);
  const r6b = userProfileMod.appendProfileDirective('Always 简洁回复。');
  assert.ok(r6b.ok, `画像首建应成功：${r6b.ok ? '' : r6b.message}`);
  assert.ok(fs.readFileSync(path.join(ws6b, 'memory', 'USER.md'), 'utf8').includes('简洁回复'));

  // A6. 面板写路径（saveEntry/forget/restore）：读失败抛错、正文与回收站不动
  const ws7 = freshWs('m3-panel');
  const t7 = path.join(ws7, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(t7), { recursive: true });
  fs.writeFileSync(t7, '<!-- 2026-01-01 10:00:00 [s1] -->\n#lesson PANEL_KEEP 条目。\n');
  const before7 = fs.readFileSync(t7);
  const hash7 = panelStoreMod.memoryGet(ws7).hash;
  const entryId7 = panelStoreMod.memoryGet(ws7).entries[0].id;
  let saveErr = null;
  try {
    withReadFailure(t7, 'EIO', () => memorySaveEntry(ws7, hash7, { tags: [], links: [], text: '面板新条目' }));
  } catch (e) {
    saveErr = e;
  }
  assert.ok(saveErr, 'saveEntry 读失败应抛错');
  assert.match(String(saveErr.message), /EIO|中止写入/);
  let forgetErr = null;
  try {
    withReadFailure(t7, 'EIO', () => memoryForget(ws7, hash7, entryId7));
  } catch (e) {
    forgetErr = e;
  }
  assert.ok(forgetErr, 'forget 读失败应抛错');
  assert.match(String(forgetErr.message), /EIO|中止写入/);
  assert.ok(fs.readFileSync(t7).equals(before7), '面板正文字节不变');
  // 真实 forget 造回收站记录，再在 restore 读失败时验证：正文不动、备份不丢
  const forgot = memoryForget(ws7, hash7, entryId7);
  assert.equal(forgot.stale, false);
  const recoveryId = forgot.recoveryId;
  const hashAfterForget = panelStoreMod.memoryGet(ws7).hash;
  let restoreErr = null;
  try {
    withReadFailure(t7, 'EIO', () => memoryRestore(ws7, hashAfterForget, recoveryId));
  } catch (e) {
    restoreErr = e;
  }
  assert.ok(restoreErr, 'restore 读失败应抛错');
  assert.match(String(restoreErr.message), /EIO|中止写入/);
  assert.equal(fs.readFileSync(t7, 'utf8'), '', 'restore 失败不写正文（forget 后的空文件保持）');
  assert.ok(
    fs.existsSync(path.join(ws7, 'docs', 'memory', 'recovery', `${recoveryId}.json`)),
    '恢复备份未被消费（失败不丢数据）'
  );
  // 读恢复后重试 restore 成功（故障是瞬时的）
  const restored = memoryRestore(ws7, hashAfterForget, recoveryId);
  assert.equal(restored.stale, false, '读恢复后 restore 正常');
  // ENOENT 首建：无文件时 saveEntry 仍可创建
  const ws7b = freshWs('m3-panel-create');
  const r7b = memorySaveEntry(ws7b, '', { tags: [], links: [], text: '首条面板条目' });
  assert.equal(r7b.stale, false, `无文件首建不 stale：${JSON.stringify(r7b).slice(0, 120)}`);
  assert.ok(fs.readFileSync(path.join(ws7b, 'docs', 'memory', 'MEMORY.md'), 'utf8').includes('首条面板条目'));

  // A7. 记忆中心回滚（preimage 恢复）：现状读失败→中止回滚（不留无镜像的覆盖）
  const ws8 = freshWs('m3-rollback');
  const t8 = path.join(ws8, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(t8), { recursive: true });
  fs.writeFileSync(t8, 'NEW CONTENT\n');
  const db8 = openMemoryDb(ws8);
  const pre8 = dbMod.insertPreimage(db8, {
    filePath: t8,
    content: 'OLD CONTENT\n',
    contentHash: 'x',
    cause: 'test',
    now: Date.now()
  });
  const preimageCount = () => Number(db8.handle.prepare('SELECT count(*) n FROM preimages').get().n);
  const beforeCount = preimageCount();
  const rb = withReadFailure(t8, 'EIO', () => memoryCenterRollback(ws8, pre8));
  assert.equal(rb.ok, false, '回滚读失败不得成功');
  assert.match(String(rb.error), /EIO|中止回滚/);
  assert.equal(fs.readFileSync(t8, 'utf8'), 'NEW CONTENT\n', '现状未被覆盖');
  assert.equal(preimageCount(), beforeCount, '未落安全镜像（读失败时不得盲目写旧文）');
  db8.close();
  setUserProfileFilePath(null);

  // A8. sweep 目标文件读失败：跳过模型回合、留 read_failed log、不建审批
  const ws9 = freshWs('m3-sweep');
  const t9 = path.join(ws9, 'MEMORY.md');
  fs.writeFileSync(t9, '# SWEEP_KEEP\n');
  const db9 = openMemoryDb(ws9);
  seedCandidate(db9);
  const summary9 = await withReadFailure(t9, 'EIO', () =>
    runConsolidationSweep({
      db: db9,
      namespace: 'worker',
      targetFileAbs: t9,
      targetFileRel: 'MEMORY.md',
      budgetChars: 16_000,
      callModel: async () => {
        throw new Error('模型不应被调用');
      },
      now: Date.now(),
      reason: 'test'
    })
  );
  assert.ok(summary9.modelError, '读失败应记入 summary.modelError');
  const logs9 = listConsolidationLog(db9, 5);
  assert.ok(logs9.some((l) => (l.diffSummary ?? '').includes('读取失败')), 'sweep 留读取失败 log');
  assert.equal(getApprovalCount(db9), 0, '读失败不建审批');
  assert.equal(fs.readFileSync(t9, 'utf8'), '# SWEEP_KEEP\n');
  db9.close();

  console.log('ok: A M3 读取错误分类（直写双面/巩固/画像/面板/回滚/sweep + ENOENT 首建）');
}

function getApprovalCount(db) {
  return Number(db.handle.prepare('SELECT count(*) n FROM approvals').get().n);
}

// ---------------------------------------------------------------------------
// B. M1：普通审批跨存储幂等恢复
// ---------------------------------------------------------------------------

{
  // B1. 文件写盘后、审批翻转前失败（db 注入）→ 重试恰好一次
  const ws = freshWs('m1-add');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE\n'),
    baseContentChars: 7,
    operations: [addOp(sid, '#lesson CRASH_ONCE_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  let firstErr = null;
  try {
    withDbWriteFault(db, 'UPDATE approvals SET state', () => decideConsolidationApproval(db, approvalId, 'approve', deps));
  } catch (e) {
    firstErr = e;
  }
  assert.ok(firstErr, '收尾翻转失败应抛出（不被吞成成功）');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'CRASH_ONCE_ENTRY'), 1, '文件已写一次');
  assert.equal(getApproval(db, approvalId).state, 'pending', '翻转失败后审批仍 pending（可恢复）');
  const journal = getApprovalExec(db, approvalId);
  assert.equal(journal.phase, 'file_applied', '执行日志显示文件已落盘');

  // 「重启」后（新连接）再批准：恢复收尾，不重复写正文
  db.close();
  const db2 = openMemoryDb(ws);
  const retry = decideConsolidationApproval(db2, approvalId, 'approve', { ...deps, now: Date.now() + 1000 });
  assert.ok(retry.ok, `恢复收尾应成功：${retry.error}`);
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'CRASH_ONCE_ENTRY'), 1, '正文效果恰好一次（不重复追加）');
  assert.equal(getApproval(db2, approvalId).state, 'approved');
  assert.equal(
    db2.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state,
    'promoted',
    '恢复收尾后候选晋升'
  );
  assert.equal(logLinesFor(db2, approvalId).length, 1, 'approved 日志恰好一行（失败重试不重复）');
  assert.equal(eventsFor(db2, 'approval_decided', approvalId).length, 1, 'approval_decided 事件恰好一条');

  // 幂等重放：已 approved 再点批准 → 按日志回执 ok:true，不再新增日志
  const replay = decideConsolidationApproval(db2, approvalId, 'approve', { ...deps, now: Date.now() + 2000 });
  assert.ok(replay.ok, '崩溃恢复后的重复点击应幂等重放成功回执');
  assert.equal(replay.plan.applied.length, 1);
  assert.equal(logLinesFor(db2, approvalId).length, 1, '重放不新增日志');
  assert.equal(eventsFor(db2, 'approval_decided', approvalId).length, 1, '重放不新增事件');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'CRASH_ONCE_ENTRY'), 1, '重放不碰正文');
  db2.close();
  console.log('ok: B1 文件写后收尾失败→重启再批准（恰好一次/日志事件不重复/幂等重放）');
}

{
  // B2. 崩在领取后写盘前（过期 claimed，现状==基线）→ 接管重写计划产物
  const ws = freshWs('m1-claim-nowrite');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE2\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE2\n'),
    baseContentChars: 8,
    operations: [addOp(sid, '#lesson TAKEOVER_ENTRY')],
    reason: 'test',
    now: 1_000_000
  });
  // 模拟崩溃现场：旧 attempt 已领取（claimed_at 很老），文件没写（现状==旧基线）
  upsertApprovalExecClaim(db, {
    approvalId,
    attempt: 1,
    baseHash: sha256Content('# BASE2\n'),
    plannedHash: sha256Content('# BASE2\nSTALE_PLANNED\n'),
    plannedContent: '# BASE2\nSTALE_PLANNED\n',
    settleJson: '{}',
    now: 1_000_000
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: 1_000_000 + APPROVAL_EXEC_STALE_MS + 5_000,
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  const r = decideConsolidationApproval(db, approvalId, 'approve', deps);
  assert.ok(r.ok, `过期接管应按新计划继续：${r.error}`);
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'TAKEOVER_ENTRY'), 1, '接管写盘恰好一次');
  assert.ok(!fs.readFileSync(target, 'utf8').includes('STALE_PLANNED'), '未写入旧计划残留（现状==基线→按新计划）');
  assert.equal(getApprovalExec(db, approvalId).attempt, 2, '接管后 attempt+1');
  assert.equal(getApproval(db, approvalId).state, 'approved');
  db.close();
  console.log('ok: B2 领取后崩溃（未写盘）→ 过期接管按新计划写一次');
}

{
  // B3. 崩在写盘后、phase 推进前（过期 claimed，现状==旧计划产物）→ 只收尾不重写
  //     用 supersede：若错误重放计划，旧片段已消失会 zero_applied——正好钉死「不重规划」
  const ws = freshWs('m1-claim-written');
  const target = path.join(ws, 'MEMORY.md');
  const pad3 = '<!-- 2026-01-01 10:00:00 [s1] -->\n#lesson 基线占位条目一。\n<!-- 2026-01-02 10:00:00 [s2] -->\n#lesson 基线占位条目二。\n<!-- 2026-01-03 10:00:00 [s3] -->\n#lesson 基线占位条目三。\n';
  fs.writeFileSync(target, `${pad3}#seed 旧口径：pnpm 可用。\n`);
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content(fs.readFileSync(target, 'utf8')),
    baseContentChars: 10,
    operations: [
      {
        op: 'supersede',
        candidateId: sid,
        stagingId: sid,
        text: '#lesson 新口径：npm run',
        oldSnippet: '#seed 旧口径：pnpm 可用。',
        reason: '取代',
        confidence: 0.6,
        citation: 'Source: agent-session:rec'
      }
    ],
    reason: 'test',
    now: 2_000_000
  });
  // 用生产同款 hooks 造「已写盘」现场（planned 产物真实落盘），claim 留在老时间戳
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: 2_000_000,
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  const row = getApproval(db, approvalId);
  const payload = JSON.parse(row.payload);
  const hooks = consolidationApprovalFileHooks(db, approvalId, payload, deps);
  const current = fs.readFileSync(target, 'utf8');
  const plan = hooks.buildPlan(current);
  assert.equal(plan.appliedCount, 1, 'supersede 应可应用');
  // r1-P2③：走生产同款 prepareWrite（前镜像先于写盘落库 + preimageId 并入 settle 事实）
  const settledJson = hooks.prepareWrite(plan, current, plan.settleJson);
  const facts3 = JSON.parse(settledJson);
  assert.ok(facts3.preimageId != null, '改写操作在前镜像入账后 preimageId 已关联');
  fs.writeFileSync(target, plan.plannedContent); // 模拟原子写已完成、随后进程崩溃
  upsertApprovalExecClaim(db, {
    approvalId,
    attempt: 1,
    baseHash: plan.baseHash,
    plannedHash: sha256Content(plan.plannedContent),
    plannedContent: plan.plannedContent,
    settleJson: settledJson,
    now: 2_000_000
  });
  const afterCrash = fs.readFileSync(target, 'utf8');
  assert.ok(afterCrash.includes('新口径') && !afterCrash.includes('旧口径'));

  const r = decideConsolidationApproval(db, approvalId, 'approve', { ...deps, now: 2_000_000 + APPROVAL_EXEC_STALE_MS + 5_000 });
  assert.ok(r.ok, `已写盘恢复只收尾：${r.error}`);
  assert.equal(r.plan.applied.length, 1, '回执按旧 attempt 事实（applied=1，而非重规划后的 0）');
  assert.equal(fs.readFileSync(target, 'utf8'), afterCrash, '恢复收尾不再碰文件');
  assert.equal(getApproval(db, approvalId).state, 'approved');
  assert.equal(logLinesFor(db, approvalId).length, 1);
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state,
    'promoted'
  );
  // r1-P2③：superseded 事件在收尾事务内补发恰好一次；log 明细的镜像关联（preimageId）在场
  assert.equal(
    db.handle.prepare("SELECT count(*) n FROM memory_events WHERE kind = 'superseded' AND staging_id = ?").get(sid).n,
    1,
    'superseded 事件恰好一条（收尾补发）'
  );
  const logRow = logLinesFor(db, approvalId)[0];
  const logPayload = logRow.payload ? JSON.parse(logRow.payload) : null;
  assert.ok(logPayload?.supersededPairs?.length === 1, 'log 明细含 supersededPairs');
  assert.equal(logPayload.supersededPairs[0].preimageId, facts3.preimageId, '镜像关联（preimageId）随 settle 事实入 log');
  assert.equal(
    Number(db.handle.prepare('SELECT count(*) n FROM preimages WHERE cause = ?').get(`approval:${approvalId}`).n),
    1,
    '前镜像恰好一份（恢复不重复落镜像）'
  );
  db.close();
  console.log('ok: B3 写盘后崩溃（supersede）→ 只收尾不重写 + 前镜像关联/superseded 事件恰好一次');
}

{
  // B4. 新鲜 claim → busy：另一方得到明确状态，文件不动
  const ws = freshWs('m1-busy');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE4\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE4\n'),
    baseContentChars: 7,
    operations: [addOp(sid, '#lesson BUSY_ENTRY')],
    reason: 'test',
    now: 3_000_000
  });
  const nowA = 3_000_000;
  const nowB = nowA + 1_000; // 30s 内 → busy
  // 进程 A（连接一）领取
  upsertApprovalExecClaim(db, {
    approvalId,
    attempt: 1,
    baseHash: sha256Content('# BASE4\n'),
    plannedHash: sha256Content('# OTHER\n'),
    plannedContent: '# OTHER\n',
    settleJson: '{}',
    now: nowA
  });
  // 进程 B（连接二）决定 → busy
  const dbB = openMemoryDb(ws);
  const rB = decideConsolidationApproval(dbB, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: nowB,
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  });
  assert.equal(rB.ok, false, '竞争方不得执行');
  assert.equal(rB.code, 'busy', `失败码 busy（got ${rB.code}）`);
  assert.match(rB.error, /正在另一执行中/);
  assert.equal(fs.readFileSync(target, 'utf8'), '# BASE4\n', 'busy 不写文件');
  assert.equal(getApproval(dbB, approvalId).state, 'pending', 'busy 不翻状态');
  dbB.close();
  db.close();
  console.log('ok: B4 双连接竞争：新鲜 claim → busy 明确回执、文件不动');
}

{
  // B5. reject 原子性：翻转后日志失败 → 整体回滚仍 pending；重试成功
  const ws = freshWs('m1-reject');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE5\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE5\n'),
    baseContentChars: 7,
    operations: [addOp(sid, '#lesson REJECT_ATOMIC')],
    reason: 'test',
    now: Date.now()
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  let rejErr = null;
  try {
    withDbWriteFault(db, 'INSERT INTO consolidation_log', () =>
      decideConsolidationApproval(db, approvalId, 'reject', deps)
    );
  } catch (e) {
    rejErr = e;
  }
  assert.ok(rejErr, 'reject 中途失败应抛出');
  assert.equal(getApproval(db, approvalId).state, 'pending', '驳回整体回滚：状态仍 pending');
  assert.equal(db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state, 'pending', '候选未被退场');
  const retry = decideConsolidationApproval(db, approvalId, 'reject', { ...deps, now: Date.now() + 1 });
  assert.ok(retry.ok, `驳回重试应成功：${retry.error}`);
  assert.equal(getApproval(db, approvalId).state, 'rejected');
  assert.equal(db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state, 'rejected');
  db.close();
  console.log('ok: B5 驳回单事务原子性（中途失败整体回滚、重试成功）');
}

{
  // B6. 部分拒绝：一条 add 超预算被拒、一条生效 → 如实回执 applied<total
  const ws = freshWs('m1-partial');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE6\n');
  const db = openMemoryDb(ws);
  const sid1 = seedCandidate(db, { text: '短候选一' });
  const sid2 = seedCandidate(db, { text: '长候选二' });
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE6\n'),
    baseContentChars: 7,
    operations: [addOp(sid1, '短条目生效'), addOp(sid2, 'x'.repeat(500))],
    reason: 'test',
    now: Date.now()
  });
  const r = decideConsolidationApproval(db, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 300, // 只够第一条
    surface: 'worker',
    now: Date.now(),
    evidence: [
      { stagingId: sid1, evidencePath: 'agent-session:rec' },
      { stagingId: sid2, evidencePath: 'agent-session:rec' }
    ]
  });
  assert.ok(r.ok, `部分应用仍算批准成功：${r.error}`);
  assert.equal(r.plan.applied.length, 1);
  assert.ok(r.plan.rejected.some((x) => x.category === 'over_budget'), '超预算明细在回执');
  assert.ok(fs.readFileSync(target, 'utf8').includes('短条目生效'));
  assert.ok(!fs.readFileSync(target, 'utf8').includes('x'.repeat(100)), '超预算条目未写入');
  const log = logLinesFor(db, approvalId);
  assert.equal(log.length, 1);
  assert.match(log[0].diffSummary, /应用 1\/2 项/);
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid2).state,
    'pending',
    '被拒候选保持 pending（仍在暂存池可见）'
  );
  db.close();
  console.log('ok: B6 部分拒绝（applied 1/2、over_budget 明细、候选留池）');
}

// ---------------------------------------------------------------------------
// B7. 真·双进程竞争：子进程领取并持锁写盘窗口内，父进程 busy；子进程「崩溃」
//     （写盘完成、未收尾即退出）后父进程重试 → 恢复收尾，正文恰好一次。
// ---------------------------------------------------------------------------

{
  const ws = freshWs('m1-multiproc');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE_MP\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE_MP\n'),
    baseContentChars: 9,
    operations: [addOp(sid, '#lesson MULTIPROC_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  db.close();

  const sigDir = path.join(tmp, `sig-${path.basename(ws)}`);
  fs.mkdirSync(sigDir, { recursive: true });
  const claimedSignal = path.join(sigDir, 'claimed');
  const releaseSignal = path.join(sigDir, 'release');
  const childScript = path.join(sigDir, 'child.mjs');
  fs.writeFileSync(
    childScript,
    `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const compileDir = ${JSON.stringify(tmp)};
const ws = ${JSON.stringify(ws)};
const target = ${JSON.stringify(target)};
const approvalId = ${JSON.stringify(approvalId)};
const sid = ${JSON.stringify(sid)};
const claimedSignal = ${JSON.stringify(claimedSignal)};
const releaseSignal = ${JSON.stringify(releaseSignal)};
const mod = (rel) => import(pathToFileURL(path.join(compileDir, rel)).href);
const dbm = await mod('main/memory/db.mjs');
const approvalMod = await mod('main/memory/consolidation/approval.mjs');
const execMod = await mod('main/memory/consolidation/approvalExec.mjs');
const db = dbm.openMemoryDb(ws);
const row = dbm.getApproval(db, approvalId);
const payload = JSON.parse(row.payload);
const deps = {
  targetFileAbs: target,
  budgetChars: 16000,
  surface: 'worker',
  now: Date.now(),
  evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
};
const hooks = approvalMod.consolidationApprovalFileHooks(db, approvalId, payload, deps);
// 领取后、写盘前挂起等父进程放行（持锁窗口）；随后真实写盘、推进 file_applied，
// 然后直接退出——不收尾（模拟崩溃在收尾前）
const outcome = execMod.executeApprovalFilePhase(db, {
  approvalId,
  now: deps.now,
  readFile: hooks.readFile,
  hashOf: hooks.hashOf,
  buildPlan: hooks.buildPlan,
  prepareWrite: hooks.prepareWrite,
  writeContent: (plannedContent) => {
    fs.writeFileSync(claimedSignal, '1');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(releaseSignal) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!fs.existsSync(releaseSignal)) process.exit(2);
    hooks.writeContent(plannedContent);
  }
});
fs.writeFileSync(path.join(${JSON.stringify(sigDir)}, 'outcome.json'), JSON.stringify(outcome));
db.close();
`
  );
  // 父连接先开（迁移写在子进程持写锁前完成）；busy 探测只读，持锁窗口内照常可用
  const dbParent = openMemoryDb(ws);
  const child = spawn(process.execPath, [childScript], { stdio: 'pipe' });
  let childErr = '';
  child.stderr.on('data', (d) => {
    childErr += String(d);
  });
  // 等子进程领取（最多 15s）
  const waitFile = (f, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!fs.existsSync(f) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.ok(fs.existsSync(f), `等待信号文件超时：${f}${childErr ? `；child stderr: ${childErr}` : ''}`);
  };
  waitFile(claimedSignal);

  // 父进程（另一进程视角）在子进程持锁窗口内批准 → busy
  const busy = decideConsolidationApproval(dbParent, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  });
  assert.equal(busy.ok, false, '子进程持锁期间父进程不得执行');
  assert.equal(busy.code, 'busy', `跨进程竞争失败码 busy（got ${busy.code}）`);
  assert.equal(fs.readFileSync(target, 'utf8'), '# BASE_MP\n', 'busy 期间文件不动');

  // 放行：子进程写盘 + 推进 file_applied 后退出（不收尾）
  fs.writeFileSync(releaseSignal, '1');
  const childExit = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.equal(childExit, 0, `子进程应正常退出（outcome 写盘后崩溃模拟）${childErr}`);
  const outcome = JSON.parse(fs.readFileSync(path.join(sigDir, 'outcome.json'), 'utf8'));
  assert.equal(outcome.ok, true, `子进程文件阶段应成功：${JSON.stringify(outcome)}`);
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'MULTIPROC_ENTRY'), 1, '子进程已写盘一次');
  assert.equal(getApproval(dbParent, approvalId).state, 'pending', '子进程未收尾——审批仍 pending');

  // 父进程重试批准 → 恢复收尾；正文恰好一次、日志/事件恰好一条
  const resume = decideConsolidationApproval(dbParent, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  });
  assert.ok(resume.ok, `跨进程恢复收尾应成功：${resume.error}`);
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'MULTIPROC_ENTRY'), 1, '跨进程正文恰好一次');
  assert.equal(getApproval(dbParent, approvalId).state, 'approved');
  assert.equal(logLinesFor(dbParent, approvalId).length, 1, '日志恰好一行');
  assert.equal(eventsFor(dbParent, 'approval_decided', approvalId).length, 1, '事件恰好一条');
  assert.equal(
    dbParent.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state,
    'promoted'
  );
  dbParent.close();
  console.log('ok: B7 真·双进程竞争（持锁窗口 busy → 子进程崩溃后恢复收尾，恰好一次）');
}

// ---------------------------------------------------------------------------
// B8. r1-P1①：真·双进程**同时领取**（CAS）——起跑线同步，只成一方，另一方 busy
// ---------------------------------------------------------------------------

{
  const ws = freshWs('m1-cas-race');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE_CAS\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE_CAS\n'),
    baseContentChars: 10,
    operations: [addOp(sid, '#lesson CAS_RACE_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  db.close();

  const sigDir = path.join(tmp, `cas-${path.basename(ws)}`);
  fs.mkdirSync(sigDir, { recursive: true });
  const startSignal = path.join(sigDir, 'start');
  const releaseSignal = path.join(sigDir, 'release');
  const childScript = path.join(sigDir, 'child.mjs');
  // 两子进程同款脚本（tag 区分信号/产物文件）：
  //  等起跑线 → 同时进入 executeApprovalFilePhase（真实 CAS 竞争）；
  //  赢家在 writeContent 挂起等放行后真实写盘、推进 file_applied、退出不收尾（模拟崩溃）；
  //  输家立即得 busy 回执落盘退出。
  fs.writeFileSync(
    childScript,
    `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tag = process.argv[2];
const compileDir = ${JSON.stringify(tmp)};
const ws = ${JSON.stringify(ws)};
const target = ${JSON.stringify(target)};
const approvalId = ${JSON.stringify(approvalId)};
const sid = ${JSON.stringify(sid)};
const sigDir = ${JSON.stringify(sigDir)};
const mod = (rel) => import(pathToFileURL(path.join(compileDir, rel)).href);
const dbm = await mod('main/memory/db.mjs');
const approvalMod = await mod('main/memory/consolidation/approval.mjs');
const execMod = await mod('main/memory/consolidation/approvalExec.mjs');
const db = dbm.openMemoryDb(ws);
const row = dbm.getApproval(db, approvalId);
const payload = JSON.parse(row.payload);
const deps = {
  targetFileAbs: target,
  budgetChars: 16000,
  surface: 'worker',
  now: Date.now(),
  evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
};
const hooks = approvalMod.consolidationApprovalFileHooks(db, approvalId, payload, deps);
// 起跑线：两进程都就位后才同时冲 CAS
while (!fs.existsSync(${JSON.stringify(startSignal)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
const outcome = execMod.executeApprovalFilePhase(db, {
  approvalId,
  now: deps.now,
  readFile: hooks.readFile,
  hashOf: hooks.hashOf,
  buildPlan: hooks.buildPlan,
  prepareWrite: hooks.prepareWrite,
  writeContent: (plannedContent) => {
    fs.writeFileSync(path.join(sigDir, 'claimed-' + tag), '1');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(${JSON.stringify(releaseSignal)}) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!fs.existsSync(${JSON.stringify(releaseSignal)})) process.exit(2);
    hooks.writeContent(plannedContent);
  }
});
fs.writeFileSync(path.join(sigDir, 'outcome-' + tag + '.json'), JSON.stringify(outcome));
db.close();
`
  );
  const children = ['a', 'b'].map((tag) => {
    const c = spawn(process.execPath, [childScript, tag], { stdio: 'pipe' });
    c.stderr.on('data', (d) => process.stderr.write(`[child-${tag}] ${d}`));
    return c;
  });
  // 两子进程就位（各自打开库后即等起跑线——给 3s 预热）后同时放行
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  fs.writeFileSync(startSignal, '1');

  const waitFileSet = (dir, names, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (names.every((n) => fs.existsSync(path.join(dir, n)))) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return false;
  };
  // 输家很快落 outcome（busy）；赢家卡在 writeContent（claimed-* 信号之一在场）
  const loserOut = ['a', 'b']
    .map((tag) => ({ tag, file: path.join(sigDir, `outcome-${tag}.json`) }))
    .filter((x) => fs.existsSync(x.file));
  let attempts = 0;
  while (loserOut.length < 1 && attempts < 100) {
    attempts += 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    for (const tag of ['a', 'b']) {
      const f = path.join(sigDir, `outcome-${tag}.json`);
      if (fs.existsSync(f) && !loserOut.some((x) => x.tag === tag)) loserOut.push({ tag, file: f });
    }
  }
  assert.ok(loserOut.length >= 1, '至少一方（CAS 输家）应很快产出 busy 结果');
  const loser = JSON.parse(fs.readFileSync(loserOut[0].file, 'utf8'));
  assert.equal(loser.ok, false, 'CAS 输家不得执行');
  assert.equal(loser.code, 'busy', `CAS 输家失败码 busy（got ${loser.code}）`);

  // 放行赢家：写盘 + 推进 file_applied + 退出不收尾
  fs.writeFileSync(releaseSignal, '1');
  const exits = await Promise.all(children.map((c) => new Promise((r) => c.on('exit', (code) => r(code)))));
  assert.ok(exits.every((c) => c === 0), `两子进程正常退出：${exits.join(',')}（CAS 输家 busy 退出、赢家崩溃模拟退出）`);
  // 恰好一个 claimed-* 信号：只有赢家到过 writeContent
  const claimedCount = ['a', 'b'].filter((tag) => fs.existsSync(path.join(sigDir, `claimed-${tag}`))).length;
  assert.equal(claimedCount, 1, '同时领取只成一方（另一方可未触及写盘）');
  const winnerOut = ['a', 'b']
    .map((tag) => path.join(sigDir, `outcome-${tag}.json`))
    .map((f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null))
    .filter((o) => o && o.ok);
  assert.equal(winnerOut.length, 1, '恰好一方文件阶段成功');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'CAS_RACE_ENTRY'), 1, '正文恰好写一次');
  const dbp = openMemoryDb(ws);
  const j = getApprovalExec(dbp, approvalId);
  assert.equal(j.attempt, 1, 'CAS 后 attempt 只被领取方推进一次（输家未双写日志行）');
  assert.equal(j.phase, 'file_applied');
  // 父进程恢复收尾：正文仍恰好一次、日志/事件一条
  const resume = decideConsolidationApproval(dbp, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  });
  assert.ok(resume.ok, `恢复收尾应成功：${resume.error}`);
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'CAS_RACE_ENTRY'), 1);
  assert.equal(logLinesFor(dbp, approvalId).length, 1);
  assert.equal(eventsFor(dbp, 'approval_decided', approvalId).length, 1);
  dbp.close();
  // ---- 直接 CAS 竞争（r1-P1① 的最小复现面）：绕过协调器预检查，两进程同时调
  // claimApprovalExecRow —— 断言恰好一方 true。还原 CAS（无条件 upsert）时两方都
  // true，本段转红。
  {
    const sigDir2 = path.join(tmp, `cas-direct-${path.basename(ws)}`);
    fs.mkdirSync(sigDir2, { recursive: true });
    const start2 = path.join(sigDir2, 'start');
    const child2 = path.join(sigDir2, 'child.mjs');
    const ws2 = freshWs('m1-cas-direct');
    const target2 = path.join(ws2, 'MEMORY.md');
    fs.writeFileSync(target2, '# BASE_CAS2\n');
    const dbc = openMemoryDb(ws2);
    const sidc = seedCandidate(dbc, { text: 'CAS 直接竞争候选' });
    const apc = enqueueConsolidationApproval(dbc, {
      namespace: 'worker',
      targetFileRel: 'MEMORY.md',
      baseHash: sha256Content('# BASE_CAS2\n'),
      baseContentChars: 11,
      operations: [addOp(sidc, '#lesson CAS_DIRECT_ENTRY')],
      reason: 'test',
      now: Date.now()
    });
    dbc.close();
    fs.writeFileSync(
      child2,
      `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tag = process.argv[2];
const mod = (rel) => import(pathToFileURL(path.join(${JSON.stringify(tmp)}, rel)).href);
const dbm = await mod('main/memory/db.mjs');
const db = dbm.openMemoryDb(${JSON.stringify(ws2)});
while (!fs.existsSync(${JSON.stringify(start2)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
const won = dbm.claimApprovalExecRow(db, {
  approvalId: ${JSON.stringify(apc)},
  attempt: 1,
  baseHash: ${JSON.stringify(sha256Content('# BASE_CAS2\n'))},
  plannedHash: ${JSON.stringify(sha256Content('# PLANNED2\n'))},
  plannedContent: '# PLANNED2\\n',
  settleJson: '{}',
  staleBefore: Date.now() - 60_000,
  now: Date.now()
});
fs.writeFileSync(path.join(${JSON.stringify(sigDir2)}, 'claim-' + tag + '.json'), JSON.stringify({ won }));
db.close();
`
    );
    const kids = ['a', 'b'].map((tag) => {
      const c = spawn(process.execPath, [child2, tag], { stdio: 'pipe' });
      c.stderr.on('data', (d) => process.stderr.write(`[cas-${tag}] ${d}`));
      return c;
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
    fs.writeFileSync(start2, '1');
    await Promise.all(kids.map((c) => new Promise((r) => c.on('exit', r))));
    const results = ['a', 'b'].map((tag) =>
      JSON.parse(fs.readFileSync(path.join(sigDir2, `claim-${tag}.json`), 'utf8')).won
    );
    assert.equal(results.filter(Boolean).length, 1, `同时领取只成一方（got ${JSON.stringify(results)}）`);
    const dbd = openMemoryDb(ws2);
    const jd = getApprovalExec(dbd, apc);
    assert.equal(jd.attempt, 1, 'attempt 单跳（未被两方各推一次）');
    assert.equal(jd.phase, 'claimed');
    dbd.close();
  }
  console.log('ok: B8 真·双进程同时领取 CAS（只成一方 attempt 单跳、输家 busy、恢复收尾恰好一次）');
}

// ---------------------------------------------------------------------------
// B9. r1-P1②：驳回与执行日志协调（文件已写阻断 / 在途 busy / 过期未写放行）
// ---------------------------------------------------------------------------

{
  const ws = freshWs('m1-reject-guard');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE_RG\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE_RG\n'),
    baseContentChars: 9,
    operations: [addOp(sid, '#lesson REJECT_GUARD_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };

  // a) 文件写盘后收尾翻转失败（崩溃现场）→ 驳回被阻断（in_flight），重试批准完成收尾
  let crashErr = null;
  try {
    withDbWriteFault(db, 'UPDATE approvals SET state', () =>
      decideConsolidationApproval(db, approvalId, 'approve', deps)
    );
  } catch (e) {
    crashErr = e;
  }
  assert.ok(crashErr, '收尾翻转失败应抛出');
  assert.equal(getApprovalExec(db, approvalId).phase, 'file_applied');
  const rejBlocked = decideConsolidationApproval(db, approvalId, 'reject', { ...deps, now: Date.now() + 1 });
  assert.equal(rejBlocked.ok, false, '文件已写未收尾时驳回不得成功');
  assert.equal(rejBlocked.code, 'in_flight', `阻断码 in_flight（got ${rejBlocked.code}）`);
  assert.equal(getApproval(db, approvalId).state, 'pending', '阻断后审批仍 pending');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'REJECT_GUARD_ENTRY'), 1, '正文保持已写状态');
  const finishApprove = decideConsolidationApproval(db, approvalId, 'approve', { ...deps, now: Date.now() + 2 });
  assert.ok(finishApprove.ok, `重试批准完成收尾：${finishApprove.error}`);
  assert.equal(getApproval(db, approvalId).state, 'approved');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'REJECT_GUARD_ENTRY'), 1);

  // b) 新鲜 claim 在途 → 驳回 busy（防「批准写盘中途被驳」账实分裂）
  const sid2 = seedCandidate(db, { text: 'RG 第二候选' });
  const approval2 = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content(fs.readFileSync(target, 'utf8')),
    baseContentChars: 10,
    operations: [addOp(sid2, '#lesson RG_INFLIGHT_ENTRY')],
    reason: 'test',
    now: 5_000_000
  });
  upsertApprovalExecClaim(db, {
    approvalId: approval2,
    attempt: 1,
    baseHash: sha256Content(fs.readFileSync(target, 'utf8')),
    plannedHash: sha256Content('# OTHER_RG\n'),
    plannedContent: '# OTHER_RG\n',
    settleJson: '{}',
    now: 5_000_000
  });
  const rejBusy = decideConsolidationApproval(db, approval2, 'reject', {
    ...deps,
    now: 5_000_000 + 1_000 // 30s 内
  });
  assert.equal(rejBusy.ok, false, '在途审批驳回不得成功');
  assert.equal(rejBusy.code, 'busy', `在途阻断码 busy（got ${rejBusy.code}）`);
  assert.equal(getApproval(db, approval2).state, 'pending');

  // c) 过期 claim 且文件未写（现状==基线）→ 释放僵尸领取后驳回放行
  const rejStale = decideConsolidationApproval(db, approval2, 'reject', {
    ...deps,
    now: 5_000_000 + 60_000 // 过期接管窗之外
  });
  assert.ok(rejStale.ok, `过期未写盘的僵尸领取应释放并允许驳回：${rejStale.error ?? ''}`);
  assert.equal(getApproval(db, approval2).state, 'rejected');
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid2).state,
    'rejected',
    '驳回退场候选'
  );
  assert.ok(!fs.readFileSync(target, 'utf8').includes('RG_INFLIGHT_ENTRY'), '未写盘内容不出现');
  assert.equal(getApprovalExec(db, approval2).phase, 'failed', '僵尸领取已释放');
  db.close();
  console.log('ok: B9 驳回协调（已写阻断 in_flight/在途 busy/过期未写放行）');
}

// ---------------------------------------------------------------------------
// B10. r1-P1②：收尾 already_decided 核验最终裁决态——被并发裁决不得报成功
// ---------------------------------------------------------------------------

{
  const ws = freshWs('m1-settle-verify');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE_SV\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE_SV\n'),
    baseContentChars: 9,
    operations: [addOp(sid, '#lesson SETTLE_VERIFY_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  // 崩溃现场：文件已写、phase=file_applied、state 仍 pending
  let crashErr = null;
  try {
    withDbWriteFault(db, 'UPDATE approvals SET state', () =>
      decideConsolidationApproval(db, approvalId, 'approve', deps)
    );
  } catch (e) {
    crashErr = e;
  }
  assert.ok(crashErr, '收尾翻转失败应抛出（制造 file_applied 崩溃现场）');
  assert.equal(getApproval(db, approvalId).state, 'pending');
  // 模拟「并发驳回在收尾事务内抢先落库」：拦截 settle 的条件翻转 SQL，先真的把
  // 状态翻成 rejected（同事务可见），再放行——settle 自身的 UPDATE 因此 miss（0 变更），
  // 走 already_decided 分支；decide 必须核验最终裁决态后如实失败（r1-P1②）
  const origWrite = db.write.bind(db);
  let intercepted = false;
  db.write = (fn) =>
    origWrite((tx) =>
      fn(
        new Proxy(tx, {
          get(t, prop) {
            if (prop === 'prepare') {
              return (sql) => {
                if (!intercepted && String(sql).startsWith('UPDATE approvals SET state')) {
                  intercepted = true;
                  t.prepare("UPDATE approvals SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'pending'").run(Date.now(), approvalId);
                }
                return t.prepare(sql);
              };
            }
            const v = Reflect.get(t, prop);
            return typeof v === 'function' ? v.bind(t) : v;
          }
        })
      )
    );
  let after;
  try {
    after = decideConsolidationApproval(db, approvalId, 'approve', { ...deps, now: Date.now() + 1 });
  } finally {
    db.write = origWrite;
  }
  assert.equal(after.ok, false, '收尾发现终态非 approved 时不得报成功');
  assert.match(after.error ?? '', /并发裁决/, `应给出并发裁决核验说明（got ${after.error}）`);
  assert.equal(getApproval(db, approvalId).state, 'rejected', '并发驳回的裁决生效');
  assert.equal(logLinesFor(db, approvalId).length, 0, 'approved 日志不落（他方裁决的账目归他方）');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'SETTLE_VERIFY_ENTRY'), 1, '正文保持已写、不再被触碰');
  db.close();
  console.log('ok: B10 收尾 already_decided 核验（终态非 approved 如实失败，不装成功）');
}

// ---------------------------------------------------------------------------
// B11. r2-P1①：初检 pending 后领取前被并发驳回——claim 同事务核验 pending，不写正文（两族）
// ---------------------------------------------------------------------------

{
  // worker 族：B（approve）入口检查 pending 通过 → 首个写事务（=claim）前注入 A 的完整 reject
  const ws = freshWs('r2-interleave-worker');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE_IW\n');
  const dbA = openMemoryDb(ws);
  const sid = seedCandidate(dbA);
  const approvalId = enqueueConsolidationApproval(dbA, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE_IW\n'),
    baseContentChars: 10,
    operations: [addOp(sid, '#lesson INTERLEAVE_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  const dbB = openMemoryDb(ws);
  const origWriteB = dbB.write.bind(dbB);
  let injected = false;
  dbB.write = (fn) => {
    if (!injected) {
      injected = true;
      const rej = decideConsolidationApproval(dbA, approvalId, 'reject', { ...deps, now: Date.now() + 1 });
      assert.ok(rej.ok, `注入的并发驳回应成功：${rej.error}`);
    }
    return origWriteB(fn);
  };
  let r;
  try {
    r = decideConsolidationApproval(dbB, approvalId, 'approve', { ...deps, now: Date.now() + 2 });
  } finally {
    dbB.write = origWriteB;
  }
  assert.equal(r.ok, false, '并发驳回后的 approve 不得成功');
  assert.equal(getApproval(dbB, approvalId).state, 'rejected');
  assert.equal(getApprovalExec(dbB, approvalId), null, 'claim 同事务核验 pending：被驳回的审批领取不到执行权（无日志行）');
  assert.equal(fs.readFileSync(target, 'utf8'), '# BASE_IW\n', '正文完全未写（无账实分裂）');
  dbA.close();
  dbB.close();

  // profile 族同构：并发驳回后 approve 不写 USER.md、无执行日志
  const wsp = freshWs('r2-interleave-profile');
  setUserProfileFilePath(wsp);
  const pp = path.join(wsp, 'memory', 'USER.md');
  fs.mkdirSync(path.dirname(pp), { recursive: true });
  fs.writeFileSync(pp, '<!-- observed: 2026-01-01 | status: active -->\nAlways 简洁先行。\n');
  const dbpA = openMemoryDb(wsp);
  const sidp = seedCandidate(dbpA, { origin: 'user', text: 'IW 画像候选' });
  const ap = enqueueUserProfileApproval(dbpA, {
    operations: [{ op: 'add', stagingId: sidp, directive: 'Never 交错写入。', confidence: 0.5 }],
    baseHash: sha256Content(fs.readFileSync(pp, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now: Date.now()
  });
  const pdeps = { targetFileAbs: pp, baseHashFn: sha256Content, now: Date.now() };
  const dbpB = openMemoryDb(wsp);
  const origWriteP = dbpB.write.bind(dbpB);
  let injectedP = false;
  dbpB.write = (fn) => {
    if (!injectedP) {
      injectedP = true;
      const rej = decideUserProfileApproval(dbpA, ap, 'reject', { ...pdeps, now: Date.now() + 1 });
      assert.ok(rej.ok, `画像并发驳回应成功：${rej.error}`);
    }
    return origWriteP(fn);
  };
  let rp;
  try {
    rp = decideUserProfileApproval(dbpB, ap, 'approve', { ...pdeps, now: Date.now() + 2 });
  } finally {
    dbpB.write = origWriteP;
  }
  assert.equal(rp.ok, false, '画像：并发驳回后的 approve 不得成功');
  assert.equal(getApproval(dbpB, ap).state, 'rejected');
  assert.equal(getApprovalExec(dbpB, ap), null, '画像：无执行日志行');
  assert.ok(fs.readFileSync(pp, 'utf8').includes('简洁先行') && !fs.readFileSync(pp, 'utf8').includes('交错写入'), 'USER.md 未被写');
  dbpA.close();
  dbpB.close();
  setUserProfileFilePath(null);
  console.log('ok: B11 两族生产交错（初检后领取前被驳回：claim 同事务核验 pending，正文零写入）');
}

// ---------------------------------------------------------------------------
// B12. r2-P1②：写盘全程所有权——旧执行者停滞被接管后复活，绝不重写（EXTERNAL_KEEP 保留）
//        + 跨进程在写盘事务内互斥（持锁期间他方领取被锁拒）
// ---------------------------------------------------------------------------

{
  const ws = freshWs('r2-revive');
  const target = path.join(ws, 'MEMORY.md');
  const pad = '<!-- 2026-01-01 10:00:00 [s1] -->\n#lesson 基线占位一。\n<!-- 2026-01-02 10:00:00 [s2] -->\n#lesson 基线占位二。\n';
  fs.writeFileSync(target, `${pad}#seed 旧口径：pnpm 可用。\n`);
  const dbA = openMemoryDb(ws);
  const sid = seedCandidate(dbA);
  const approvalId = enqueueConsolidationApproval(dbA, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content(fs.readFileSync(target, 'utf8')),
    baseContentChars: 40,
    operations: [
      {
        op: 'supersede',
        candidateId: sid,
        stagingId: sid,
        text: '#lesson 旧执行者的新口径',
        oldSnippet: '#seed 旧口径：pnpm 可用。',
        reason: '取代',
        confidence: 0.6,
        citation: 'Source: agent-session:rec'
      }
    ],
    reason: 'test',
    now: 9_000_000
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: 9_000_000,
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  // 造「A 停滞在 prepare 之后、写盘事务之前」的现场：生产同款 claim + prepare（tx1/tx2）
  const rowA = getApproval(dbA, approvalId);
  const payloadA = JSON.parse(rowA.payload);
  const hooksA = consolidationApprovalFileHooks(dbA, approvalId, payloadA, deps);
  const currentA = fs.readFileSync(target, 'utf8');
  const planA = hooksA.buildPlan(currentA);
  assert.equal(planA.appliedCount, 1);
  const claimedA = dbMod.claimApprovalExecRow(dbA, {
    approvalId, attempt: 1,
    baseHash: planA.baseHash,
    plannedHash: sha256Content(planA.plannedContent),
    plannedContent: planA.plannedContent,
    settleJson: planA.settleJson,
    staleBefore: 9_000_000 - 60_000,
    now: 9_000_000
  });
  assert.ok(claimedA, 'A 首次领取应成功');
  const settleJsonA = dbA.write(() => {
    const merged = hooksA.prepareWrite(planA, currentA, planA.settleJson);
    dbA.handle
      .prepare(`UPDATE approval_exec SET settle_json = ?, updated_at = ? WHERE approval_id = ? AND attempt = 1 AND phase = 'claimed'`)
      .run(merged, 9_000_000, approvalId);
    return merged;
  });
  const factsA = JSON.parse(settleJsonA);
  assert.ok(factsA.preimageId != null, 'A 的前镜像已入账');
  const preimageIdA = factsA.preimageId;

  // b0（r2-P1② 暴露子例）：B 已 CAS 接管（attempt2）但尚未写盘（文件仍=基线）——
  // 此时 A 复活走写盘事务：哈希门拦不住（现状===A 的基线），唯一防线是所有权核验
  const ok2 = dbMod.claimApprovalExecRow(dbA, {
    approvalId, attempt: 2,
    baseHash: planA.baseHash,
    plannedHash: sha256Content('# B_PLANNED\n'),
    plannedContent: '# B_PLANNED\n',
    settleJson: '{}',
    staleBefore: 9_000_000 + 30_000,
    now: 9_000_000 + 45_000
  });
  assert.ok(ok2, 'B 过期接管 attempt2 应成功');
  let aWrote0 = false;
  const revive0 = approvalExecMod.writeOwnedApprovalContent(dbA, {
    approvalId, attempt: 1, now: 9_000_000 + 50_000,
    readFile: () => fs.readFileSync(target, 'utf8'),
    hashOf: sha256Content,
    baseHash: planA.baseHash,
    plannedContent: planA.plannedContent,
    settleJson: settleJsonA,
    writeContent: () => {
      aWrote0 = true;
    }
  });
  assert.equal(aWrote0, false, '被接管的旧执行者在「哈希门拦不住」的窗口也绝不能写（所有权核验）');
  assert.equal(revive0.ok, false, '所有权已失时不得报成功');
  assert.equal(revive0.code, 'conflict', `复活回执 conflict（got ${revive0.code}）`);
  assert.ok(!fs.readFileSync(target, 'utf8').includes('旧执行者的新口径'), 'A 的产物仍未落盘');

  // B（另一连接）在 A 停滞过期后接管：重规划→CAS attempt3→复用镜像→写盘→收尾
  const dbB = openMemoryDb(ws);
  const rb = decideConsolidationApproval(dbB, approvalId, 'approve', { ...deps, now: 9_000_000 + 120_000 });
  assert.ok(rb.ok, `B 接管应完成：${rb.error}`);
  assert.ok(fs.readFileSync(target, 'utf8').includes('新口径'), 'B 已写盘');
  assert.equal(getApproval(dbB, approvalId).state, 'approved');
  // B 收尾后外部又改了文件（评审场景的 EXTERNAL_KEEP）
  fs.appendFileSync(target, '<!-- 2026-01-03 10:00:00 [ext] -->\n#lesson EXTERNAL_KEEP 外部追加。\n');

  // A 复活：走写盘事务（tx3）——所有权核验失败，writeContent 不会被调用
  let aWrote = false;
  const revive = approvalExecMod.writeOwnedApprovalContent(dbA, {
    approvalId, attempt: 1, now: 9_000_000 + 120_000,
    readFile: () => fs.readFileSync(target, 'utf8'),
    hashOf: sha256Content,
    baseHash: planA.baseHash,
    plannedContent: planA.plannedContent,
    settleJson: settleJsonA,
    writeContent: () => {
      aWrote = true;
    }
  });
  assert.equal(aWrote, false, '复活的旧执行者绝不再写盘');
  assert.ok(fs.readFileSync(target, 'utf8').includes('EXTERNAL_KEEP'), '外部追加内容未被旧产物覆盖');
  assert.notEqual(fs.readFileSync(target, 'utf8'), planA.plannedContent, '盘上不是 A 的旧计划产物原样（A 未重写）');
  if (revive.ok) {
    assert.equal(revive.resumed, true, '复活者只能拿到恢复回执（B 的事实），不能是本方新写');
  } else {
    assert.equal(revive.code, 'conflict');
  }
  // r2-P2③：接管重规划复用了 A 已持久化的镜像身份——镜像仍恰 1 份、log 关联同一 id
  assert.equal(
    Number(dbA.handle.prepare('SELECT count(*) n FROM preimages WHERE cause = ?').get(`approval:${approvalId}`).n),
    1,
    '前镜像恰好 1 份（接管复用，不重复落）'
  );
  const logRow = logLinesFor(dbA, approvalId)[0];
  const logPayload = logRow?.payload ? JSON.parse(logRow.payload) : null;
  assert.equal(logPayload?.supersededPairs?.[0]?.preimageId, preimageIdA, 'log 镜像关联 = 最初入账的 id');
  dbA.close();
  dbB.close();
  console.log('ok: B12 旧执行者复活不重写（EXTERNAL_KEEP 保留）+ 接管复用镜像身份');
}

{
  // 跨进程写盘互斥：子进程在写盘事务（tx3）内停滞持写锁——父进程领取被锁拒（明确失败，
  // 不死锁不双写）；放行后子进程完成，父进程重试走恢复
  const ws = freshWs('r2-lock');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# BASE_LK\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# BASE_LK\n'),
    baseContentChars: 9,
    operations: [addOp(sid, '#lesson LOCK_WINDOW_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  db.close();
  const sigDir = path.join(tmp, `lk-${path.basename(ws)}`);
  fs.mkdirSync(sigDir, { recursive: true });
  const inWriteSignal = path.join(sigDir, 'in-write');
  const releaseSignal = path.join(sigDir, 'release');
  const childScript = path.join(sigDir, 'child.mjs');
  fs.writeFileSync(
    childScript,
    `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const mod = (rel) => import(pathToFileURL(path.join(${JSON.stringify(tmp)}, rel)).href);
const dbm = await mod('main/memory/db.mjs');
const approvalMod = await mod('main/memory/consolidation/approval.mjs');
const execMod = await mod('main/memory/consolidation/approvalExec.mjs');
const db = dbm.openMemoryDb(${JSON.stringify(ws)});
const row = dbm.getApproval(db, ${JSON.stringify(approvalId)});
const payload = JSON.parse(row.payload);
const deps = {
  targetFileAbs: ${JSON.stringify(target)},
  budgetChars: 16000,
  surface: 'worker',
  now: Date.now(),
  evidence: [{ stagingId: ${JSON.stringify(sid)}, evidencePath: 'agent-session:rec' }]
};
const hooks = approvalMod.consolidationApprovalFileHooks(db, ${JSON.stringify(approvalId)}, payload, deps);
// 直接走文件阶段；writeContent 在 tx3（写事务）内停滞持锁
const outcome = execMod.executeApprovalFilePhase(db, {
  approvalId: ${JSON.stringify(approvalId)},
  now: deps.now,
  readFile: hooks.readFile,
  hashOf: hooks.hashOf,
  buildPlan: hooks.buildPlan,
  prepareWrite: hooks.prepareWrite,
  writeContent: (plannedContent) => {
    fs.writeFileSync(${JSON.stringify(inWriteSignal)}, '1');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(${JSON.stringify(releaseSignal)}) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!fs.existsSync(${JSON.stringify(releaseSignal)})) process.exit(2);
    hooks.writeContent(plannedContent);
  }
});
fs.writeFileSync(path.join(${JSON.stringify(sigDir)}, 'outcome.json'), JSON.stringify(outcome));
db.close();
`
  );
  const dbParent = openMemoryDb(ws); // 先开连接，避免迁移写在持锁窗口内
  const child = spawn(process.execPath, [childScript], { stdio: 'pipe' });
  let childErr = '';
  child.stderr.on('data', (d) => {
    childErr += String(d);
  });
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(inWriteSignal) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(fs.existsSync(inWriteSignal), `子进程应进入写盘事务${childErr ? `：${childErr}` : ''}`);
  // 父进程在写盘事务持锁期间领取 → 被写锁拒绝（busy_timeout 后明确抛错，非静默双写）
  let locked = false;
  try {
    dbMod.claimApprovalExecRow(dbParent, {
      approvalId,
      attempt: 2,
      baseHash: sha256Content('# BASE_LK\n'),
      plannedHash: sha256Content('# X\n'),
      plannedContent: '# X\n',
      settleJson: '{}',
      staleBefore: Date.now() - 60_000,
      now: Date.now()
    });
  } catch (e) {
    locked = /database is locked|SQLITE_BUSY/i.test(String(e?.message ?? e));
  }
  assert.ok(locked, '写盘事务持锁期间他方领取应被锁拒（跨进程互斥证据）');
  fs.writeFileSync(releaseSignal, '1');
  const exitCode = await new Promise((r) => child.on('exit', (c) => r(c)));
  assert.equal(exitCode, 0, `子进程完成写盘退出${childErr}`);
  const outcome = JSON.parse(fs.readFileSync(path.join(sigDir, 'outcome.json'), 'utf8'));
  assert.equal(outcome.ok, true, '子进程写盘事务应成功');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'LOCK_WINDOW_ENTRY'), 1);
  // 父进程锁释放后重试领取 → CAS 失败（file_applied 不可领）→ decide 走恢复收尾
  const retry = decideConsolidationApproval(dbParent, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  });
  assert.ok(retry.ok, `锁释放后恢复收尾：${retry.error}`);
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'LOCK_WINDOW_ENTRY'), 1);
  dbParent.close();
  console.log('ok: B12b 跨进程写盘事务互斥（持锁领取被拒不死锁，放行后恢复收尾恰好一次）');
}

// ---------------------------------------------------------------------------
// B13. r2-P2③：prepare 后未写盘中断（rename 前崩溃/EIO）→ 重试镜像仍 1 份
// ---------------------------------------------------------------------------

{
  const ws = freshWs('r2-preimage-reuse');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '<!-- 2026-01-01 10:00:00 [s1] -->\n#seed 旧结论占位。\n<!-- 2026-01-02 10:00:00 [s2] -->\n#lesson 基线占位。\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content(fs.readFileSync(target, 'utf8')),
    baseContentChars: 40,
    operations: [
      {
        op: 'supersede',
        candidateId: sid,
        stagingId: sid,
        text: '#lesson 重试后的新结论',
        oldSnippet: '#seed 旧结论占位。',
        reason: '取代',
        confidence: 0.6,
        citation: 'Source: agent-session:rec'
      }
    ],
    reason: 'test',
    now: 7_000_000
  });
  const deps = {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: 7_000_000,
    evidence: [{ stagingId: sid, evidencePath: 'agent-session:rec' }]
  };
  // attempt1：领取 + prepare（镜像入账）后、写盘前崩溃（文件未动）
  const row = getApproval(db, approvalId);
  const payload = JSON.parse(row.payload);
  const hooks = consolidationApprovalFileHooks(db, approvalId, payload, deps);
  const current = fs.readFileSync(target, 'utf8');
  const plan = hooks.buildPlan(current);
  const ok1 = dbMod.claimApprovalExecRow(db, {
    approvalId, attempt: 1,
    baseHash: plan.baseHash, plannedHash: sha256Content(plan.plannedContent),
    plannedContent: plan.plannedContent, settleJson: plan.settleJson,
    staleBefore: 7_000_000 - 60_000, now: 7_000_000
  });
  assert.ok(ok1);
  const settleJson1 = db.write(() => {
    const merged = hooks.prepareWrite(plan, current, plan.settleJson);
    db.handle
      .prepare(`UPDATE approval_exec SET settle_json = ?, updated_at = ? WHERE approval_id = ? AND attempt = 1 AND phase = 'claimed'`)
      .run(merged, 7_000_000, approvalId);
    return merged;
  });
  const p1 = JSON.parse(settleJson1).preimageId;
  assert.ok(p1 != null, 'attempt1 前镜像已入账');
  assert.equal(
    Number(db.handle.prepare('SELECT count(*) n FROM preimages WHERE cause = ?').get(`approval:${approvalId}`).n),
    1
  );
  // 过期后重试（接管重规划）：prepare 复用镜像身份 → 仍 1 份，log 关联不变
  const r = decideConsolidationApproval(db, approvalId, 'approve', { ...deps, now: 7_000_000 + 60_000 });
  assert.ok(r.ok, `重试应完成：${r.error}`);
  assert.equal(
    Number(db.handle.prepare('SELECT count(*) n FROM preimages WHERE cause = ?').get(`approval:${approvalId}`).n),
    1,
    'r2-P2③：prepare 后中断重试不重复落镜像（复用持久化身份）'
  );
  const logRow = logLinesFor(db, approvalId)[0];
  const logPayload = logRow?.payload ? JSON.parse(logRow.payload) : null;
  assert.equal(logPayload?.supersededPairs?.[0]?.preimageId, p1, 'log 镜像关联保持 attempt1 的 id');
  assert.ok(fs.readFileSync(target, 'utf8').includes('重试后的新结论'));
  db.close();
  console.log('ok: B13 prepare 后未写盘中断重试（镜像 1→1 复用、log 关联不变）');
}

// ---------------------------------------------------------------------------
// C. M1：画像审批恢复
// ---------------------------------------------------------------------------

{
  // C1. 画像写盘后收尾翻转失败 → 重试恢复收尾，USER.md 恰好一次
  const ws = freshWs('m1-profile');
  setUserProfileFilePath(ws);
  const p = path.join(ws, 'memory', 'USER.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '<!-- observed: 2026-01-01 | status: active -->\nAlways 简洁先行。\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db, { origin: 'user' });
  const approvalId = enqueueUserProfileApproval(db, {
    operations: [{ op: 'add', stagingId: sid, directive: 'Never 过度铺垫。', confidence: 0.5 }],
    baseHash: sha256Content(fs.readFileSync(p, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now: Date.now()
  });
  const deps = { targetFileAbs: p, baseHashFn: sha256Content, now: Date.now() };
  let err = null;
  try {
    withDbWriteFault(db, 'UPDATE approvals SET state', () => decideUserProfileApproval(db, approvalId, 'approve', deps));
  } catch (e) {
    err = e;
  }
  assert.ok(err, '画像收尾翻转失败应抛出');
  assert.ok(fs.readFileSync(p, 'utf8').includes('过度铺垫'), '画像已写一次');
  assert.equal(getApproval(db, approvalId).state, 'pending');
  const retry = decideUserProfileApproval(db, approvalId, 'approve', { ...deps, now: Date.now() + 1000 });
  assert.ok(retry.ok, `画像恢复收尾应成功：${retry.error}`);
  assert.equal(retry.appliedCount, 1);
  assert.equal(countOccurrences(fs.readFileSync(p, 'utf8'), '过度铺垫'), 1, '画像恰好写一次（不重复追加）');
  assert.equal(getApproval(db, approvalId).state, 'approved');
  db.close();
  setUserProfileFilePath(null);
  console.log('ok: C1 画像写盘后收尾失败→恢复收尾恰好一次');
}

// ---------------------------------------------------------------------------
// D. M2：画像零应用不装批准成功
// ---------------------------------------------------------------------------

{
  const ws = freshWs('m2-profile');
  setUserProfileFilePath(ws);
  const p = path.join(ws, 'memory', 'USER.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '<!-- observed: 2026-01-01 | status: active -->\nAlways 简洁先行。\n');
  const db = openMemoryDb(ws);
  const now = Date.now();
  const deps = { targetFileAbs: p, baseHashFn: sha256Content, now };

  // D1. 哈希冲突（入队后画像被外部修改）→ ok:false + state pending + 外部修改保留
  const sid1 = seedCandidate(db, { origin: 'user', text: 'D1 冲突候选' });
  const a1 = enqueueUserProfileApproval(db, {
    operations: [{ op: 'add', stagingId: sid1, directive: 'Never 冲突指令。', confidence: 0.5 }],
    baseHash: sha256Content('stale-not-current'),
    baseContentChars: 10,
    reason: 'test',
    now
  });
  const r1 = decideUserProfileApproval(db, a1, 'approve', deps);
  assert.equal(r1.ok, false, 'M2：哈希冲突零应用不能返回批准成功');
  assert.equal(r1.code, 'zero_applied', `失败码 zero_applied（got ${r1.code}）`);
  assert.equal(r1.hashConflict, true);
  assert.equal(getApproval(db, a1).state, 'pending', '审批保持待审（可明确处理）');
  assert.equal(fs.readFileSync(p, 'utf8'), '<!-- observed: 2026-01-01 | status: active -->\nAlways 简洁先行。\n', '正文不变');
  // 旧审批可明确驳回退场（不留永久卡住）
  const rej1 = decideUserProfileApproval(db, a1, 'reject', { ...deps, now: now + 1 });
  assert.equal(rej1.ok, true, '冲突审批可驳回退场');
  assert.equal(getApproval(db, a1).state, 'rejected');

  // D2. 超上限（add 顶破 4000）→ ok:false zero_applied + pending
  const sid2 = seedCandidate(db, { origin: 'user', text: 'D2 超限候选' });
  const a2 = enqueueUserProfileApproval(db, {
    operations: [{ op: 'add', stagingId: sid2, directive: `Always ${'长'.repeat(4200)}。`, confidence: 0.5 }],
    baseHash: sha256Content(fs.readFileSync(p, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now
  });
  const r2 = decideUserProfileApproval(db, a2, 'approve', deps);
  assert.equal(r2.ok, false, 'M2：超上限零应用不能批准成功');
  assert.equal(r2.code, 'zero_applied');
  assert.match(r2.error, /上限/);
  assert.equal(getApproval(db, a2).state, 'pending');
  assert.ok(!fs.readFileSync(p, 'utf8').includes('长'.repeat(50)), '超限指令未写入');

  // D3. 全拒绝（supersede 定位歧义）→ ok:false zero_applied + pending
  fs.writeFileSync(p, '<!-- observed: 2026-01-01 | status: active -->\nAlways 重复指令。\n\n<!-- observed: 2026-01-02 | status: active -->\nAlways 重复指令。\n');
  const sid3 = seedCandidate(db, { origin: 'user', text: 'D3 歧义候选' });
  const a3 = enqueueUserProfileApproval(db, {
    operations: [{ op: 'supersede', stagingId: sid3, oldDirective: 'Always 重复指令。', directive: 'Always 新指令。', confidence: 0.6 }],
    baseHash: sha256Content(fs.readFileSync(p, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now
  });
  const r3 = decideUserProfileApproval(db, a3, 'approve', deps);
  assert.equal(r3.ok, false, 'M2：全拒绝不能批准成功');
  assert.equal(r3.code, 'zero_applied');
  assert.equal(getApproval(db, a3).state, 'pending');

  // D4. 部分应用：supersede 生效 + delete 歧义被拒 → ok:true + 明细
  fs.writeFileSync(p, '<!-- observed: 2026-01-01 | status: active -->\nAlways 旧画像指令。\n');
  const sid4 = seedCandidate(db, { origin: 'user', text: 'D4 部分应用候选' });
  const a4 = enqueueUserProfileApproval(db, {
    operations: [
      { op: 'supersede', stagingId: sid4, oldDirective: 'Always 旧画像指令。', directive: 'Always 新画像指令。', confidence: 0.6 },
      { op: 'delete', stagingId: sid4 + 1, directive: '', oldDirective: '不存在的指令', confidence: 0.6 }
    ],
    baseHash: sha256Content(fs.readFileSync(p, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now
  });
  const r4 = decideUserProfileApproval(db, a4, 'approve', deps);
  assert.ok(r4.ok, `部分应用应批准成功：${r4.error}`);
  assert.equal(r4.appliedCount, 1, '生效 1/2');
  assert.equal(r4.total, 2);
  assert.equal(r4.rejectedCounts?.ambiguous, 1, '拒绝明细报 ambiguous=1');
  assert.ok(fs.readFileSync(p, 'utf8').includes('新画像指令'));
  assert.ok(!fs.readFileSync(p, 'utf8').includes('旧画像指令'));

  // D5. 正常批准/驳回仍通过（回归保护）
  const sid5 = seedCandidate(db, { origin: 'user', text: 'D5 正常批准候选' });
  const a5 = enqueueUserProfileApproval(db, {
    operations: [{ op: 'add', stagingId: sid5, directive: 'Always 正常路径。', confidence: 0.5 }],
    baseHash: sha256Content(fs.readFileSync(p, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now
  });
  const r5 = decideUserProfileApproval(db, a5, 'approve', { ...deps, now: now + 2 });
  assert.ok(r5.ok && r5.appliedCount === 1, `正常批准回归：${JSON.stringify(r5)}`);
  const sid6 = seedCandidate(db, { origin: 'user', text: 'D6 正常驳回候选' });
  const a6 = enqueueUserProfileApproval(db, {
    operations: [{ op: 'add', stagingId: sid6, directive: 'Never 被驳回指令。', confidence: 0.5 }],
    baseHash: sha256Content(fs.readFileSync(p, 'utf8')),
    baseContentChars: 40,
    reason: 'test',
    now: now + 3
  });
  const r6 = decideUserProfileApproval(db, a6, 'reject', { ...deps, now: now + 4 });
  assert.ok(r6.ok, '正常驳回回归');
  assert.equal(getApproval(db, a6).state, 'rejected');
  db.close();
  setUserProfileFilePath(null);
  console.log('ok: D M2 画像零应用（冲突/超限/全拒绝不装成功、可驳回）+ 部分明细 + 正常路径回归');
}

// ---------------------------------------------------------------------------
// E. 协调器单元边界：写前读失败 / 写盘失败 → failed 释放后可重试
// ---------------------------------------------------------------------------

{
  const ws = freshWs('edge');
  const target = path.join(ws, 'MEMORY.md');
  fs.writeFileSync(target, '# EDGE\n');
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'MEMORY.md',
    baseHash: sha256Content('# EDGE\n'),
    baseContentChars: 6,
    operations: [addOp(sid, '#lesson EDGE_ENTRY')],
    reason: 'test',
    now: Date.now()
  });
  const hooks = {
    readFile: () => {
      throw Object.assign(new Error('读失败'), { name: 'MemoryFileReadError', message: '读失败' });
    },
    hashOf: sha256Content,
    buildPlan: (cur) => ({
      baseHash: sha256Content(cur),
      plannedContent: `${cur}X`,
      settleJson: '{}',
      appliedCount: 1
    }),
    prepareWrite: (_plan, _fresh, settleJson) => settleJson,
    writeContent: () => {}
  };
  // 写前读失败：不领取、不写、审批 pending
  const rr = executeApprovalFilePhase(db, { approvalId, now: Date.now(), ...hooks });
  assert.equal(rr.ok, false);
  assert.equal(rr.code, 'read_failed');
  assert.equal(getApprovalExec(db, approvalId), null, '读失败不领取');
  assert.equal(fs.readFileSync(target, 'utf8'), '# EDGE\n');

  // 写盘失败：领取后标 failed 释放；重试（写盘修复）可继续
  let failOnce = true;
  const rw = executeApprovalFilePhase(db, {
    approvalId,
    now: Date.now(),
    readFile: () => fs.readFileSync(target, 'utf8'),
    hashOf: sha256Content,
    buildPlan: (cur) => ({
      baseHash: sha256Content(cur),
      plannedContent: `${cur}#lesson EDGE_ENTRY\n`,
      settleJson: '{"applied":[],"rejected":[]}',
      appliedCount: 1
    }),
    prepareWrite: (_plan, _fresh, settleJson) => settleJson,
    writeContent: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('injected write failure');
      }
      fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}#lesson EDGE_ENTRY\n`);
    }
  });
  assert.equal(rw.ok, false);
  assert.equal(rw.code, 'write_failed', `写失败分类（got ${rw.code}）`);
  assert.equal(getApprovalExec(db, approvalId).phase, 'failed', '写失败标 failed 释放');
  assert.equal(getApproval(db, approvalId).state, 'pending');
  const rRetry = executeApprovalFilePhase(db, {
    approvalId,
    now: Date.now() + 1,
    readFile: () => fs.readFileSync(target, 'utf8'),
    hashOf: sha256Content,
    buildPlan: (cur) => ({
      baseHash: sha256Content(cur),
      plannedContent: `${cur}#lesson EDGE_ENTRY\n`,
      settleJson: '{"applied":[],"rejected":[]}',
      appliedCount: 1
    }),
    prepareWrite: (_plan, _fresh, settleJson) => settleJson,
    writeContent: () => {
      fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}#lesson EDGE_ENTRY\n`);
    }
  });
  assert.ok(rRetry.ok, `failed 释放后重试应继续：${rRetry.message}`);
  assert.notEqual(rRetry.resumed, true, '重走完整写盘路径（非恢复）');
  assert.equal(countOccurrences(fs.readFileSync(target, 'utf8'), 'EDGE_ENTRY'), 1);
  db.close();
  console.log('ok: E 协调器边界（写前读失败不领取/写失败释放可重试）');
}

// ---------------------------------------------------------------------------
// F. 生产事故回归（2026-10-06）：小文件 merge 审批被旧条目损失界全量拒绝
// ---------------------------------------------------------------------------
{
  // F1. 复刻生产现场：调度 MEMORY.md 仅两条目共 467 字，merge 的 oldSnippet 占原文
  //     44%+ > 25% 损失界。修复前：over_loss 拒全部改写 → zero_applied，审批永久卡死；
  //     修复后（审批路径 lossGuard:'none'）：人工批准即内容门，merge 正常落盘。
  //     还原 approval.ts 的 lossGuard:'none' 即红（approve 转零应用失败）。
  const ws = freshWs('f-smallfile-merge');
  const target = path.join(ws, 'MEMORY.md');
  const headEntry =
    '<!-- 2026-09-22 14:05:55 [scheduler] -->\n宿主机制缺陷要当场指出并立项修复，不得默默绕过或用临时手段规避（2026-09-22）。\n';
  const oldBody =
    '#lesson [[one-reviewer-per-line]] （用户纠正 2026-10-04）审查会话的正确粒度=按主题/线绑定：一条修复线一个常驻审查会话，线内 r1/r2/r3 全复用同一会话（有上下文、复审快）。当前修复线绑定：远程=03ff0540、记忆=e368130c、工作流/聊天=c1ffdba7。\nSource: staging#33';
  const base = `${headEntry}\n<!-- 2026-10-04 09:01:49 [scheduler] -->\n${oldBody} <!-- origin: scheduler -->\n`;
  fs.writeFileSync(target, base);
  assert.ok(
    oldBody.length / base.length > 0.25,
    `夹具须复现损失界触发（oldSnippet ${oldBody.length} / 全文 ${base.length} = ${(oldBody.length / base.length * 100).toFixed(0)}%）`
  );
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db, { origin: 'scheduler', text: '合并候选：常驻审查会话 + sessions.message 转单' });
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'scheduler',
    targetFileRel: '.muster/scheduler/MEMORY.md',
    baseHash: sha256Content(base),
    baseContentChars: base.length,
    operations: [
      {
        op: 'merge',
        candidateId: sid,
        stagingId: sid,
        text: `${oldBody} 追加：操作方式用 sessions.message 转单，勿 tasks_delegate 新拉。`,
        oldSnippet: oldBody,
        reason: 'test',
        confidence: 0.85,
        citation: `Source: staging#${sid}`
      }
    ],
    reason: 'session_end',
    now: Date.now()
  });
  const r = decideConsolidationApproval(db, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 6000,
    surface: 'scheduler',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: null }]
  });
  assert.ok(r.ok, `小文件 merge 审批应成功（修复前 over_loss 零应用卡死）：${r.error}`);
  assert.equal(r.plan?.mode, 'rewrite', '人工批准的 merge 走改写而非 append 回退');
  assert.equal(r.plan?.applied.length, 1);
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(after.includes('sessions.message 转单'), '合并正文已落盘');
  assert.ok(after.includes(oldBody), 'merge 保留旧片段信息（新正文含旧文）');
  assert.notEqual(after, base, '全文已被改写（非 append 回退）');
  assert.equal(countOccurrences(after, '\u8ffd\u52a0\uff1a\u64cd\u4f5c\u65b9\u5f0f\u7528 sessions.message \u8f6c\u5355'), 1, '追加的新信息恰好在文一次');
  assert.equal(getApproval(db, approvalId).state, 'approved');
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state,
    'promoted',
    '候选晋升'
  );
  assert.ok(
    Number(
      db.handle.prepare('SELECT count(*) n FROM preimages WHERE file_path = ?').get(target).n
    ) >= 1,
    '改写前镜像已入库（可回滚）'
  );
  db.close();
  console.log('ok: F1 小文件 merge 审批（损失界不再拦人工批准，镜像可回滚）');
}

{
  // F2. 零应用文案如实带拒绝分类：oldSnippet 定位失败（ambiguous）的 merge 审批，
  //     报错要说出真实分类而不是笼统的「目标可能已变化或被校验拒绝」。
  //     还原 approval.ts 文案改动即红（error 不再含「拒绝分类：ambiguous」）。
  const ws = freshWs('f-honest-message');
  const target = path.join(ws, 'MEMORY.md');
  const base = '<!-- 2026-01-01 10:00:00 [s1] -->\n#lesson 现存条目。\n';
  fs.writeFileSync(target, base);
  const db = openMemoryDb(ws);
  const sid = seedCandidate(db, { origin: 'scheduler', text: 'F2 歧义候选' });
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'scheduler',
    targetFileRel: '.muster/scheduler/MEMORY.md',
    baseHash: sha256Content(base),
    baseContentChars: base.length,
    operations: [
      {
        op: 'merge',
        candidateId: sid,
        stagingId: sid,
        text: '新正文（旧片段已不在现状里）',
        oldSnippet: '#lesson 早被外部改掉的旧片段。',
        reason: 'test',
        confidence: 0.7,
        citation: `Source: staging#${sid}`
      }
    ],
    reason: 'session_end',
    now: Date.now()
  });
  const r = decideConsolidationApproval(db, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 6000,
    surface: 'scheduler',
    now: Date.now(),
    evidence: [{ stagingId: sid, evidencePath: null }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'zero_applied');
  assert.match(r.error ?? '', /拒绝分类：ambiguous×1/, `文案要说出真实分类（got: ${r.error}）`);
  assert.equal(getApproval(db, approvalId).state, 'pending', '审批保持待审（可驳回退场）');
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(sid).state,
    'pending',
    '候选留池'
  );
  db.close();
  console.log('ok: F2 零应用文案如实带拒绝分类（ambiguous 直说）');
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

console.log(`memory-approval-recovery: ok (tmp=${tmp})`);
