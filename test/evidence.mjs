/**
 * 证据归集器（T4.4）：shared 纯函数（切片/索引/过期）+ EvidenceCollector 集成（翻转切片 /
 * bgTask 摘要 / browser 截图开关 / 7 天滚动清理）；O10 任务翻转与留言账本（内联 kind +
 * 归属会话 + 截断 + 与既有 kind 同池 FIFO）。
 * 运行: node test/evidence.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));

/** 显式模块表：alias → 源 ts（main 模块有相对 import，需递归转译并改写说明符） */
const MODULES = {
  'shared-evidence': 'src/shared/evidence.ts',
  collector: 'src/main/sessions/evidence.ts',
  'atomic-json': 'src/main/atomicJson.ts',
  'strip-ansi': 'src/main/detect/stripAnsi.ts',
  'storage-resolver': 'src/main/runtimeKernel/storageRootResolver.ts',
  'product-identity': 'src/shared/productIdentity.ts'
};
const relByPath = new Map(Object.entries(MODULES).map(([a, r]) => [r, a]));

async function load(alias) {
  const rel = MODULES[alias];
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  let out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel
  }).outputText;
  // 相对 import/export 说明符 → 同目录别名产物
  const deps = [];
  out = out.replace(/(from\s*|import\(\s*)'(\.[^']+)'/g, (m, head, spec) => {
    let targetRel = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (!/\.ts$/.test(targetRel)) targetRel += '.ts'; // TS 源码 import 不带扩展名
    const dep = relByPath.get(targetRel);
    if (!dep) throw new Error(`未注册模块: ${targetRel}（${rel} 引用）`);
    deps.push(dep);
    return `${head}'./${dep}.mjs'`;
  });
  const file = path.join(tmp, `${alias}.mjs`);
  fs.writeFileSync(file, out, 'utf8');
  for (const d of deps) await load(d); // 依赖先落盘再 import（ESM 链接期就要解析）
  return import(pathToFileURL(file));
}

const ev = await load('shared-evidence');
const collectorMod = await load('collector');
const { EvidenceCollector } = collectorMod;

const KEEP_MS = ev.EVIDENCE_KEEP_DAYS * 24 * 60 * 60 * 1000;

// ---- slicePtyTail：尾部 N 行 / 空行压缩 / 边界 ----
{
  const lines = (n) => Array.from({ length: n }, (_, i) => `line-${i}`).join('\n');
  assert.equal(ev.slicePtyTail(lines(300), 120).split('\n')[0], 'line-180');
  assert.equal(ev.slicePtyTail(lines(300), 120).split('\n').length, 120);
  assert.equal(ev.slicePtyTail(lines(50), 120), lines(50));
  assert.equal(ev.slicePtyTail('a\n\n\n\n\nb'), 'a\n\nb'); // 3+ 空行压成 2
  assert.equal(ev.slicePtyTail('   \n  x  \n  '), 'x');
  assert.equal(ev.slicePtyTail('', 10), '');
  assert.equal(ev.slicePtyTail('abc', 0), '');
  // ANSI 已在主进程剥离；shared 只负责行裁剪
  assert.equal(ev.slicePtyTail('x'.repeat(10) + '\n尾巴'), 'x'.repeat(10) + '\n尾巴');
}

// ---- 头部/after 段格式 ----
{
  const h = ev.formatPhaseFlipHeader({ from: 'idle', to: 'needs_you', source: 'model' }, 0, 120);
  assert.match(h, /\[phase-flip\] idle -> needs_you \(source=model\) at .* \| tail 120 lines/);
  const h2 = ev.formatPhaseFlipHeader({ to: 'done', source: 'llm' }, 0, 120);
  assert.match(h2, /\[phase-flip\] \(none\) -> done/);
  assert.match(ev.formatAfterSection('out', 45000), /^--- after \+45s ---\nout$/);
}

// ---- appendEvidenceEntry：追加 / FIFO 上限 / 不可变 ----
{
  const idx = ev.newEvidenceIndex('s1', 1000);
  let cur = idx;
  for (let i = 0; i < 5; i++) {
    cur = ev.appendEvidenceEntry(cur, { id: `e${i}`, kind: 'bgtask-summary', ts: 1000 + i }, 2000 + i, 3);
  }
  assert.equal(cur.entries.length, 3);
  assert.deepEqual(
    cur.entries.map((e) => e.id),
    ['e2', 'e3', 'e4']
  ); // 最旧被丢
  assert.equal(cur.updatedAt, 2004);
  assert.equal(idx.entries.length, 0); // 原 index 不被改
}

// ---- pruneEvidenceEntries：7 天边界 ----
{
  const now = 10 * KEEP_MS;
  const entries = [
    { id: 'old', kind: 'pty-slice', ts: now - KEEP_MS - 1 },
    { id: 'edge', kind: 'pty-slice', ts: now - KEEP_MS }, // 恰好 7 天：保留
    { id: 'new', kind: 'browser-shot', ts: now - 1000 }
  ];
  const { kept, dropped } = ev.pruneEvidenceEntries(entries, now);
  assert.deepEqual(
    kept.map((e) => e.id),
    ['edge', 'new']
  );
  assert.deepEqual(
    dropped.map((e) => e.id),
    ['old']
  );
  assert.deepEqual(ev.pruneEvidenceEntries([], now), { kept: [], dropped: [] });
}

// ---- evidenceDirExpired / sanitize ----
{
  const now = 10 * KEEP_MS;
  assert.equal(ev.evidenceDirExpired(now - KEEP_MS - 1, now), true);
  assert.equal(ev.evidenceDirExpired(now - KEEP_MS, now), false);
  assert.equal(ev.evidenceDirExpired(now - 1000, now), false);
  assert.equal(ev.sanitizeEvidenceSessionDir('c1e022f1-ebac-4713-b3d0-fd86fc1cd9ee'), 'c1e022f1-ebac-4713-b3d0-fd86fc1cd9ee');
  assert.equal(ev.sanitizeEvidenceSessionDir('../pivot'), null);
  assert.equal(ev.sanitizeEvidenceSessionDir('a/b'), null);
  assert.equal(ev.sanitizeEvidenceSessionDir('.hidden'), null);
  assert.equal(ev.sanitizeEvidenceSessionDir(''), null);
  assert.equal(ev.truncateEvidenceText(undefined, 5), undefined);
  assert.equal(ev.truncateEvidenceText('abc  ', 5), 'abc');
  assert.equal(ev.truncateEvidenceText('abcdef', 5), 'abcde…');
}

// ---- append FIFO 不分 kind（新 kind 同池同上限） ----
{
  const idx = ev.newEvidenceIndex('s-mix', 0);
  let cur = idx;
  for (let i = 0; i < 4; i++) {
    cur = ev.appendEvidenceEntry(cur, { id: `f${i}`, kind: 'bgtask-summary', ts: i }, i, 3);
    cur = ev.appendEvidenceEntry(cur, { id: `m${i}`, kind: 'pty-slice', ts: i }, i, 3);
  }
  assert.equal(cur.entries.length, 3);
  assert.deepEqual(
    cur.entries.map((e) => e.id),
    ['m2', 'f3', 'm3'] // 逐次插入即逐次丢最旧（f0/m0/…），与新老 kind 无关
  );
}

// ---- EvidenceCollector 集成 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkCollector = (over = {}) =>
  new EvidenceCollector({
    userDataDir: tmp,
    getPtyTail: () => undefined,
    isBrowserShotEnabled: () => false,
    afterMs: 20,
    ...over
  });

// 1) phase 翻转：before 切片落盘 + 索引 + after 补抓
{
  let call = 0;
  const texts = [Array.from({ length: 150 }, (_, i) => `out-${i}`).join('\n'), Array.from({ length: 5 }, (_, i) => `after-${i}`).join('\n')];
  const c = mkCollector({ getPtyTail: () => texts[Math.min(call++, texts.length - 1)] });
  const sid = '11111111-2222-3333-4444-555555555555';
  c.recordPhaseFlip(sid, { from: 'idle', to: 'needs_you', source: 'model' }, 12345);
  const idx = c.getIndex(sid);
  assert.ok(idx, '索引已在内存');
  const entry = idx.entries[0];
  assert.equal(entry.kind, 'pty-slice');
  assert.equal(entry.phase.from, 'idle');
  assert.equal(entry.phase.to, 'needs_you');
  const dir = path.join(tmp, 'evidence', sid);
  const sliceFile = path.join(dir, entry.file);
  const first = fs.readFileSync(sliceFile, 'utf8');
  assert.match(first, /\[phase-flip\] idle -> needs_you \(source=model\)/);
  assert.match(first, /--- before ---/);
  assert.equal(entry.afterTs, undefined, 'after 未补抓前无 afterTs');
  await sleep(60);
  const second = fs.readFileSync(sliceFile, 'utf8');
  assert.match(second, /--- after \+0s ---\nafter-0/); // afterMs=20 → +0s
  assert.equal(c.getIndex(sid).entries[0].afterTs !== undefined, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.sessionId, sid);
  assert.equal(onDisk.entries[0].id, entry.id);
}

// 2) GUI 会话（无 pty buffer）与空输出：不归集
{
  const c = mkCollector({ getPtyTail: () => undefined });
  c.recordPhaseFlip('aaaaaaaa-0000-0000-0000-000000000001', { to: 'done', source: 'model' }, 1);
  assert.equal(c.getIndex('aaaaaaaa-0000-0000-0000-000000000001'), undefined);
  const c2 = mkCollector({ getPtyTail: () => '   \n\n  ' });
  c2.recordPhaseFlip('aaaaaaaa-0000-0000-0000-000000000002', { to: 'done', source: 'model' }, 1);
  assert.equal(c2.getIndex('aaaaaaaa-0000-0000-0000-000000000002'), undefined);
}

// 3) bgTask 摘要：shell 收、subagent/timer 不收、running 不收、summary 截断
{
  const c = mkCollector();
  const sid = 'bbbbbbbb-0000-0000-0000-000000000001';
  const base = {
    id: 't-1',
    parentSessionId: sid,
    kind: 'shell',
    label: '构建',
    detail: 'npm run build',
    status: 'done',
    createdAt: 1,
    unread: true,
    pendingDigest: true,
    wake: false
  };
  c.recordBgTaskFinished({ ...base, endedAt: 500, exitCode: 0, summary: '编译通过' });
  c.recordBgTaskFinished({ ...base, id: 't-2', kind: 'subagent', endedAt: 501 });
  c.recordBgTaskFinished({ ...base, id: 't-3', kind: 'timer', endedAt: 502 });
  c.recordBgTaskFinished({ ...base, id: 't-4', status: 'running' });
  c.recordBgTaskFinished({
    ...base,
    id: 't-5',
    status: 'error',
    endedAt: 503,
    exitCode: 1,
    summary: 'x'.repeat(700)
  });
  const entries = c.getIndex(sid).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].bgTask.command, 'npm run build');
  assert.equal(entries[0].bgTask.exitCode, 0);
  assert.equal(entries[1].bgTask.status, 'error');
  assert.equal(entries[1].bgTask.summary.length, 601); // 600 + 省略号
}

// 4) browser 截图：默认关 no-op；开关开复制文件 + 索引记源路径
{
  const src = path.join(tmp, 'shot-src.png');
  fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sid = 'cccccccc-0000-0000-0000-000000000001';
  const off = mkCollector({ isBrowserShotEnabled: () => false });
  off.recordBrowserShot(sid, src);
  assert.equal(off.getIndex(sid), undefined);
  const on = mkCollector({ isBrowserShotEnabled: () => true });
  on.recordBrowserShot(sid, src);
  const entry = on.getIndex(sid).entries[0];
  assert.equal(entry.kind, 'browser-shot');
  assert.equal(entry.sourcePath, src);
  assert.equal(fs.existsSync(path.join(tmp, 'evidence', sid, entry.file)), true);
}

// 5) 滚动清理：条目级剔除+删文件 / 目录级删除 / 孤儿目录 mtime 判期 / 幸存者保留
{
  const tmpClean = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-clean-'));
  const c = new EvidenceCollector({
    userDataDir: tmpClean,
    getPtyTail: () => undefined,
    isBrowserShotEnabled: () => false
  });
  const keepSid = 'dddddddd-0000-0000-0000-000000000001';
  const staleSid = 'dddddddd-0000-0000-0000-000000000002';
  const now = 100 * KEEP_MS;
  // 会话 A：一条过期（8 天前）+ 一条新鲜
  const dirA = path.join(tmpClean, 'evidence', keepSid);
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'old.txt'), 'old');
  fs.writeFileSync(path.join(dirA, 'new.txt'), 'new');
  fs.writeFileSync(
    path.join(dirA, 'index.json'),
    JSON.stringify({
      version: 1,
      sessionId: keepSid,
      createdAt: now - KEEP_MS,
      updatedAt: now - 1000,
      entries: [
        { id: 'p-old', kind: 'pty-slice', ts: now - KEEP_MS - 1, file: 'old.txt' },
        { id: 'p-new', kind: 'pty-slice', ts: now - 1000, file: 'new.txt' }
      ]
    })
  );
  // 会话 B：全部条目过期
  const dirB = path.join(tmpClean, 'evidence', staleSid);
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(
    path.join(dirB, 'index.json'),
    JSON.stringify({
      version: 1,
      sessionId: staleSid,
      createdAt: now - KEEP_MS - 1,
      updatedAt: now - KEEP_MS - 1,
      entries: [{ id: 'p-x', kind: 'pty-slice', ts: now - KEEP_MS - 1, file: 'x.txt' }]
    })
  );
  // 孤儿目录（无索引）：超期与未超期各一
  const orphanOld = path.join(tmpClean, 'evidence', 'eeeeeeee-0000-0000-0000-000000000001');
  const orphanNew = path.join(tmpClean, 'evidence', 'eeeeeeee-0000-0000-0000-000000000002');
  fs.mkdirSync(orphanOld, { recursive: true });
  fs.mkdirSync(orphanNew, { recursive: true });
  fs.writeFileSync(path.join(orphanOld, 'garbage.txt'), 'x');
  const oldTime = new Date(now - KEEP_MS - 1);
  fs.utimesSync(orphanOld, oldTime, oldTime);

  const removed = c.cleanupExpired(now);
  assert.equal(removed, 2); // 会话 B + 超期孤儿
  assert.equal(fs.existsSync(dirA), true);
  assert.equal(fs.existsSync(path.join(dirA, 'old.txt')), false, '过期条目文件被删');
  assert.equal(fs.existsSync(path.join(dirA, 'new.txt')), true);
  const idxA = JSON.parse(fs.readFileSync(path.join(dirA, 'index.json'), 'utf8'));
  assert.deepEqual(
    idxA.entries.map((e) => e.id),
    ['p-new']
  );
  assert.equal(fs.existsSync(dirB), false);
  assert.equal(fs.existsSync(orphanOld), false);
  assert.equal(fs.existsSync(orphanNew), true);
  // 再跑一轮：无变化
  assert.equal(c.cleanupExpired(now), 0);
}

// 6) 证据页读取 API（T4.5）：readIndex 磁盘回源 / 正文与图片按索引命中 / 防穿越
{
  const tmpRead = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-read-'));
  const sid = 'ffffffff-0000-0000-0000-000000000001';
  const dir = path.join(tmpRead, 'evidence', sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p-ok.txt'), '[phase-flip] working -> done\n--- before ---\nok-slice');
  fs.writeFileSync(path.join(dir, 's-ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // 篡改索引：file 指向目录外（防穿越回归样本）
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      sessionId: sid,
      createdAt: 1,
      updatedAt: 1,
      entries: [
        { id: 'p-ok', kind: 'pty-slice', ts: 10, file: 'p-ok.txt' },
        { id: 'p-evil', kind: 'pty-slice', ts: 11, file: '../evil.txt' },
        { id: 's-ok', kind: 'browser-shot', ts: 12, file: 's-ok.png' }
      ]
    })
  );
  // 新实例（无内存缓存）：readIndex 落盘回源
  const c = new EvidenceCollector({
    userDataDir: tmpRead,
    getPtyTail: () => undefined,
    isBrowserShotEnabled: () => false
  });
  const idx = c.readIndex(sid);
  assert.equal(idx.entries.length, 3, 'readIndex 磁盘回源');
  assert.equal(c.readIndex('no-such'), undefined);
  // 正文：命中条目 / 不在索引的 entryId / 篡改 file（穿越）一律拒
  assert.match(c.readEntryText(sid, 'p-ok'), /ok-slice/);
  assert.equal(c.readEntryText(sid, 'p-missing'), undefined);
  assert.equal(c.readEntryText(sid, 'p-evil'), undefined, '索引 file 被篡改为穿越路径时拒绝');
  assert.equal(c.readEntryText(sid, 's-ok'), undefined, 'png 条目不走文本通道');
  // 图片：data URL 前缀；非图片条目拒
  assert.equal(c.readEntryImage(sid, 's-ok').startsWith('data:image/png;base64,'), true);
  assert.equal(c.readEntryImage(sid, 'p-ok'), undefined);
  assert.equal(c.readEntryImage(sid, 'p-missing'), undefined);
}

// 8) 已移除（O10 留言账本证据随子代理邮箱重构退役，kind 与收集入口已整体删除）

{
  let tailReads = 0;
  const stopped = mkCollector({ getPtyTail: () => { tailReads++; return 'one line'; } });
  stopped.start();
  stopped.recordPhaseFlip('aaaaaaaa-0000-0000-0000-000000000099', { to: 'done', source: 'model' }, Date.now());
  assert.equal(tailReads, 1);
  stopped.stop();
  await sleep(40);
  assert.equal(tailReads, 1, 'stopped collector cancels delayed PTY evidence reads');
  stopped.recordPhaseFlip('aaaaaaaa-0000-0000-0000-000000000098', { to: 'done', source: 'model' }, Date.now());
  assert.equal(tailReads, 1, 'stopped collector accepts no new writes or follow-up timers');
  assert.throws(() => stopped.start(), /stopped/);
}
console.log('evidence: all assertions passed');
