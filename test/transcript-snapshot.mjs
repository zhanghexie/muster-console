/**
 * B3 transcript 快照回归（zcode-adoption-plan B3，批次 R3）：
 * 1) 会话文件名 → sessionId 解析（pi `<时间戳>_<sessionId>.jsonl` 布局）；
 * 2) 快照文件名/删除计划纯函数；3) tmpdir 集成：拷贝内容一致、每 sessionId 保留
 * 最近 2 份（更旧的删）、会话本体不被误删、keep 可调；4) fail-open：会话文件缺失/
 * 目录不可用返回 null 不抛错；5) 转红锚：orchestrator 必须把快照接进 compactSession。
 * 运行: node test/transcript-snapshot.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-snapshot-'));
const compile = createSharedCompiler(root, tmp);

const mod = await import(pathToFileURL(compile('main/agent/transcriptSnapshot.ts')).href);
const {
  TRANSCRIPT_SNAPSHOT_KEEP,
  TRANSCRIPT_SNAPSHOT_PREFIX,
  parseSessionIdFromSessionFile,
  snapshotFileName,
  prunePlan,
  snapshotTranscriptForCompact
} = mod;

// ── 1) sessionId 解析 ──
{
  assert.equal(
    parseSessionIdFromSessionFile('2026-09-23T10-30-00-123Z_ab12cd34.jsonl'),
    'ab12cd34',
    'pi 布局：<时间戳（:. 已替换为 -）>_<sessionId>.jsonl'
  );
  assert.equal(parseSessionIdFromSessionFile('abc123.jsonl'), 'abc123', '无时间戳前缀回退为主干');
  assert.equal(parseSessionIdFromSessionFile('/x/y/2026-01-01T00-00-00_s1.jsonl'), 's1', '绝对路径取文件名');
  assert.equal(parseSessionIdFromSessionFile('transcript-s1-999.jsonl'), 'transcript-s1-999', '对快照名幂等');
  console.log('ok   sessionId 解析');
}

// ── 2) 快照名与删除计划（纯函数）──
{
  assert.equal(snapshotFileName('s1', 1234), 'transcript-s1-1234.jsonl');
  assert.equal(TRANSCRIPT_SNAPSHOT_KEEP, 2, '保留最近 2 份');
  const files = [
    '/d/transcript-s1-100.jsonl',
    '/d/transcript-s1-300.jsonl',
    '/d/transcript-s1-200.jsonl',
    '/d/transcript-s2-50.jsonl',
    '/d/2026-01-01T00-00-00_s1.jsonl', // 会话本体
    '/d/transcript-s1-broken.jsonl', // 时间戳段缺失 → 视为最老
    '/d/other.txt'
  ];
  const stale = prunePlan(files, 's1');
  assert.deepEqual(stale, ['/d/transcript-s1-100.jsonl', '/d/transcript-s1-broken.jsonl'], '保留最新 2 份（300/200），其余删');
  assert.equal(prunePlan(files, 's2').length, 0, '只有 1 份不删');
  assert.equal(prunePlan(files, 's1', 1).length, 3, 'keep=1 收紧保留面');
  assert.equal(prunePlan([], 's1').length, 0);
  console.log('ok   快照名/删除计划');
}

// ── 3) tmpdir 集成：拷贝/保留 2 份/本体不误伤 ──
{
  const dir = fs.mkdtempSync(path.join(tmp, 'sessions-'));
  const sessionFile = path.join(dir, '2026-09-23T10-00-00_sess1.jsonl');
  fs.writeFileSync(sessionFile, '{"type":"message","message":{"role":"user"}}\n{"type":"message","message":{"role":"assistant"}}\n');

  const p1 = await snapshotTranscriptForCompact({ sessionFile, sessionDir: dir, nowMs: 1000 });
  assert.equal(p1, path.join(dir, 'transcript-sess1-1000.jsonl'));
  assert.equal(fs.readFileSync(p1, 'utf8'), fs.readFileSync(sessionFile, 'utf8'), '快照内容=会话内容');

  const p2 = await snapshotTranscriptForCompact({ sessionFile, sessionDir: dir, nowMs: 2000 });
  const p3 = await snapshotTranscriptForCompact({ sessionFile, sessionDir: dir, nowMs: 3000 });
  assert.ok(p2 && p3);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith(TRANSCRIPT_SNAPSHOT_PREFIX)).sort();
  assert.deepEqual(
    kept,
    ['transcript-sess1-2000.jsonl', 'transcript-sess1-3000.jsonl'],
    '第三次快照后只保留最近 2 份'
  );
  assert.ok(fs.existsSync(sessionFile), '会话本体不被 prune 误删');

  // keep=1 收紧
  await snapshotTranscriptForCompact({ sessionFile, sessionDir: dir, nowMs: 4000, keep: 1 });
  const kept1 = fs.readdirSync(dir).filter((f) => f.startsWith(TRANSCRIPT_SNAPSHOT_PREFIX));
  assert.deepEqual(kept1, ['transcript-sess1-4000.jsonl'], 'keep=1 只留最新');
  console.log('ok   集成（拷贝/保留 2 份/keep 可调/本体不误删）');
}

// ── 4) fail-open：失败不阻塞压缩（返回 null，不抛错）──
{
  assert.equal(await snapshotTranscriptForCompact({ sessionFile: undefined, sessionDir: os.tmpdir() }), null, '无会话文件→null');
  assert.equal(await snapshotTranscriptForCompact({ sessionFile: '', sessionDir: os.tmpdir() }), null, '空串→null');
  assert.equal(
    await snapshotTranscriptForCompact({ sessionFile: path.join(os.tmpdir(), 'no-such-session.jsonl'), sessionDir: os.tmpdir() }),
    null,
    '会话文件不存在→null'
  );
  const dir = fs.mkdtempSync(path.join(tmp, 'failopen-'));
  const sessionFile = path.join(dir, '2026-01-01T00-00-00_s2.jsonl');
  fs.writeFileSync(sessionFile, '{}\n');
  // 目标目录不可用（是个文件）→ copyFile 失败 → null
  const badDir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(badDir, 'x');
  assert.equal(await snapshotTranscriptForCompact({ sessionFile, sessionDir: badDir }), null, '快照目录不可用→null 不抛');
  console.log('ok   fail-open（缺文件/坏目录 → null，不阻塞压缩）');
}

// ── 5) 还原转红锚：快照必须接进 orchestrator 的 compactSession ──
// 自查方式：把 compactSession 里的 snapshotTranscriptForCompact 调用删掉（或不再
// 把 snapshotPath 记到桶上），test/compact-summary.mjs §6 与本节同时转红。
{
  // 拆分后 compactSession 在 orchestrator/compaction.ts：守卫读「门面 + 子模块全量」
  // 拼接源（拆分 2026-09-26，锚点语义不变；this.ctx → o.ctx 为协作面调用形式）
  const orchDir = path.join(root, 'src/main/agent/orchestrator');
  const src = [
    fs.readFileSync(path.join(root, 'src/main/agent/orchestrator.ts'), 'utf8'),
    ...fs
      .readdirSync(orchDir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => fs.readFileSync(path.join(orchDir, f), 'utf8'))
  ].join('\n');
  assert.ok(
    src.includes('snapshotTranscriptForCompact({'),
    'compactSession 压缩前必须尝试快照'
  );
  assert.ok(
    src.includes('o.ctx.store.getPiSessionDir(wsId)'),
    '快照落 store.getPiSessionDir 会话数据目录'
  );
  assert.ok(
    src.includes('await snapshotTranscriptForCompact') && src.includes('b.busy = true'),
    '快照在 busy 窗内、flush 之前执行（check-and-set 之后才做 IO；纯文件复制 fail-open）'
  );
  // 序断言：置位必须先于快照 IO——把快照挪回置位之前，
  // busy 窗会漏掉快照期间的并发回合（两个字符串存在性断言对相对顺序失明，此处还原即红）
  assert.ok(
    src.indexOf('b.busy = true') !== -1 &&
      src.indexOf('b.busy = true') < src.indexOf('await snapshotTranscriptForCompact'),
    'busy check-and-set 必须先于快照 IO（原子闸：置位后才做快照）'
  );
  console.log('ok   还原转红锚（快照链路接线守卫）');
}

console.log('transcript-snapshot: ok');
