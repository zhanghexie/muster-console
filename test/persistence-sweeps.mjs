/**
 * 持久化清扫语义回归（可靠性专项 P3：X2-F07 交接临时文件 / X3-F05 无界增长族）。
 * 覆盖 persistenceSweeps 的核心契约——过期删 / 新留 / 不匹配不动（.bad 隔离档保留），
 * 以及 cli-runs（含 CliRunStore 启动接线）、pi-sessions、browser-captures 三个接入面。
 * 运行: node test/persistence-sweeps.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-sweeps-'));
const compile = createSharedCompiler(root, tmp);

const sweeps = await import(pathToFileURL(compile('main/persistenceSweeps.ts')).href);
const {
  sweepStaleEntries, handoverDir, HANDOVER_DIR_NAME, sweepHandoverFiles, sweepPiSessionBucket,
  pruneBrowserCaptures
} = sweeps;
const { sweepExpiredCliRuns, CliRunStore } = await import(
  pathToFileURL(compile('main/cliRuns/runtime.ts')).href
);

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const UUID = (n) => `00000000-0000-0000-0000-00000000000${n}`;

function fixture(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/** 写文件并按需回拨 mtime（清扫只看 mtime，回拨即可造「过期」） */
function touch(dir, name, ageMs = 0) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(file, past, past);
  }
  return file;
}
function exists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

function testSweepStaleEntries() {
  const dir = fixture('stale');
  const old = touch(dir, 'a.txt', 8 * DAY);
  touch(dir, 'b.txt', 30 * MIN);
  touch(dir, 'c.bad', 8 * DAY); // 不匹配 .txt → 隔离档/异名文件不动
  fs.mkdirSync(path.join(dir, 'old-dir'));
  fs.writeFileSync(path.join(dir, 'old-dir', 'task.txt'), 'x');
  fs.utimesSync(path.join(dir, 'old-dir'), new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));

  const removed = sweepStaleEntries(dir, { maxAgeMs: 7 * DAY, match: /\.txt$|old-dir/ });
  assert.equal(removed, 2, '过期文件与过期目录各计一条');
  assert.ok(!fs.existsSync(old), '过期文件删除');
  assert.ok(exists(dir, 'b.txt'), '新文件保留');
  assert.ok(exists(dir, 'c.bad'), '.bad 等不匹配条目不动');
  assert.ok(!exists(dir, 'old-dir'), '过期目录递归删除');
  assert.equal(sweepStaleEntries(path.join(tmp, 'no-such-dir'), { maxAgeMs: 1 }), 0, '目录不存在返回 0 不抛');
}

function testHandoverContract() {
  assert.equal(HANDOVER_DIR_NAME, 'muster-handover');
  assert.equal(handoverDir(), path.join(os.tmpdir(), 'muster-handover'), '交接目录固定在系统临时目录');
  assert.equal(typeof sweepHandoverFiles, 'function', '启动清扫入口存在（sessions 启动接线用）');
}

function testSweepExpiredCliRuns() {
  const dir = fixture('cli-runs');
  touch(dir, `${UUID(1)}.json`, 8 * DAY);          // 过期 run json → 删
  fs.mkdirSync(path.join(dir, UUID(2)));            // 过期任务目录 → 删
  fs.writeFileSync(path.join(dir, UUID(2), 'task.txt'), 'x');
  fs.utimesSync(path.join(dir, UUID(2)), new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));
  touch(dir, `${UUID(3)}.json`, 30 * MIN);          // 新 run → 留
  touch(dir, `${UUID(1)}.json.bad`, 8 * DAY);       // cli F-01 隔离档 → 不匹配 uuid 形状，不动

  const removed = sweepExpiredCliRuns(dir);
  assert.equal(removed, 2, '过期 <uuid>.json 与 <uuid>/ 各计一条');
  assert.ok(!exists(dir, `${UUID(1)}.json`), '过期 run json 删除');
  assert.ok(!exists(dir, UUID(2)), '过期任务目录删除');
  assert.ok(exists(dir, `${UUID(3)}.json`), '新 run 保留');
  assert.ok(exists(dir, `${UUID(1)}.json.bad`), '.bad 隔离档保留');
}

function testCliRunStoreSweepsOnBoot() {
  const dir = fixture('cli-runs-boot');
  const dead = `${UUID(1)}.json`;
  const liveId = UUID(4);
  const live = `${liveId}.json`;
  // 构造器会校验 run 形状（cli F-01），这里写合法 run：过期的不该被加载（已回收），新的应加载
  const validRun = { runId: liveId, logs: [], workers: [], pending: [] };
  const writeRun = (name, body, ageMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(file, past, past);
  };
  writeRun(dead, { runId: UUID(1), logs: [], workers: [], pending: [] }, 8 * DAY);
  writeRun(live, validRun, 10 * MIN);
  // 构造器即启动清扫：旧 run 不加载、文件回收；新 run 加载进内存
  new CliRunStore(dir);
  assert.ok(!exists(dir, dead), '构造（启动）时过期 run 已回收');
  assert.ok(exists(dir, live), '新 run 保留（未被误清扫/未被 .bad 隔离）');
}

function testSweepPiSessionBucket() {
  const dir = fixture('pi-sessions');
  touch(dir, 'old.jsonl', 8 * DAY);
  touch(dir, 'new.jsonl', 30 * MIN);
  touch(dir, 'note.txt', 8 * DAY); // 非 jsonl → 不动（桶内只回收会话文件）

  const removed = sweepPiSessionBucket(dir);
  assert.equal(removed, 1);
  assert.ok(!exists(dir, 'old.jsonl'), '过期旧会话 jsonl 删除');
  assert.ok(exists(dir, 'new.jsonl'), '近期会话保留（活跃文件续聊触 mtime 不会被删）');
  assert.ok(exists(dir, 'note.txt'), '非 jsonl 条目不动');
}

function testPruneBrowserCaptures() {
  const dir = fixture('browser-captures');
  const KEEP = 20;
  for (let i = 0; i < 25; i++) {
    touch(dir, `shot-${String(i).padStart(2, '0')}.png`, (25 - i) * MIN); // 编号大 = 新
    touch(dir, `rec-${String(i).padStart(2, '0')}.webm`, (25 - i) * MIN);
  }
  touch(dir, 'readme.txt', 999 * DAY);

  const removed = pruneBrowserCaptures(dir);
  assert.equal(removed, 10, 'png 与 webm 各删最旧 5 条');
  for (let i = 0; i < 25; i++) {
    const kept = i >= 5;
    assert.equal(exists(dir, `shot-${String(i).padStart(2, '0')}.png`), kept, `shot-${i} ${kept ? '留' : '删'}`);
    assert.equal(exists(dir, `rec-${String(i).padStart(2, '0')}.webm`), kept, `rec-${i} ${kept ? '留' : '删'}`);
  }
  assert.ok(exists(dir, 'readme.txt'), '非截图/录屏文件不动');
  assert.equal(pruneBrowserCaptures(path.join(tmp, 'no-captures')), 0, '目录不存在返回 0 不抛');
}

function testWiringCallsSweeps() {
  // 接线面（source 断言，同 gui-host-lifecycle 的源码核对模式）：写路径/启动路径确实挂了清扫
  const src = (rel) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');
  const turnShot = src('main/browser/turnShotCapture.ts');
  assert.ok(turnShot.includes('pruneBrowserCaptures('), 'turnShotCapture 写路径挂 pruneBrowserCaptures');
  const recording = src('main/browser/browserRecording.ts');
  assert.ok(recording.includes('pruneBrowserCaptures('), 'browserRecording 写路径挂 pruneBrowserCaptures');
  const store = src('main/store.ts');
  assert.ok(store.includes('sweepPiSessionBucket('), 'store pi-sessions 桶清扫接线');
  assert.ok(store.includes('piSessionSwept'), '每桶一次性清扫标记存在');
  const sessions = src('main/sessions.ts');
  assert.ok(sessions.includes('sweepHandoverFiles()'), 'sessions 启动清扫交接临时文档接线');
  const canvas = src('main/canvasLink.ts');
  assert.ok(canvas.includes('prepareCanvasHandover('), 'canvasLink 通过受管交接文档服务准备交接');
  const documents = src('main/handover/documents.ts');
  assert.ok(documents.includes('handoverSessionDirectory(userData, id)'), '交接文档写入会话隔离目录');
  assert.ok(sessions.includes('sweepOrphanHandovers(app.getPath(\'userData\'), new Set(this.sessions.map(session => session.id)))'), '启动清理遗留草稿时保护现有会话');
  assert.ok(sessions.includes('deleteSessionHandover(app.getPath(\'userData\'), id)'), '删除会话同步释放交接文档');
}

const tests = [
  ['sweepStaleEntries：过期删/新留/不匹配不动/缺目录 0', testSweepStaleEntries],
  ['handover 目录契约（X2-F07）', testHandoverContract],
  ['sweepExpiredCliRuns：7 天滚动 + .bad 保留（X3-F05）', testSweepExpiredCliRuns],
  ['CliRunStore 启动即清扫过期 run（X3-F05）', testCliRunStoreSweepsOnBoot],
  ['sweepPiSessionBucket：仅 jsonl 按 7 天回收（X3-F05）', testSweepPiSessionBucket],
  ['pruneBrowserCaptures：png/webm 各保最新 20（X3-F05）', testPruneBrowserCaptures],
  ['写路径/启动路径清扫接线（X2-F07/X3-F05）', testWiringCallsSweeps]
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(`${tests.length - failed}/${tests.length} passed`);
