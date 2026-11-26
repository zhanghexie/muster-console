/**
 * 记忆面板存储层生命周期测试（临时工作区；B8 自 metaAgent/memoryStore 迁入
 * memory/panelStore 后的落位守卫）：get / saveEntry / forget→recovery / restore /
 * stale hash 防护 / 未识别原位修复。
 * 注入上下文与工具追加（readMemoryContext/memoryAppend/memoryVersionToken）已随
 * memory-refactor B8 注入收敛/工具退役删除——注入面覆盖见 memory-read-path.mjs。
 * 运行: node test/memory-store.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
const compile = createSharedCompiler(root, tmp);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const store = await import(pathToFileURL(compile('main/memory/panelStore.ts')));

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ws-'));
const NOW = new Date('2026-09-02T10:00:00');

// ---------- 空工作区：get 静默降级 ----------
{
  const r = store.memoryGet(ws, NOW);
  assert.equal(r.exists, false);
  assert.equal(r.hash, '');
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.recovery, []);
  console.log('ok: empty workspace');
}

// ---------- 新增两条 → hash 变化 / 解析正确 ----------
{
  const r0 = store.memoryGet(ws, NOW);
  const r1 = store.memorySaveEntry(ws, r0.hash, { tags: ['decision'], links: ['db'], text: '数据库统一 PostgreSQL' }, NOW);
  assert.equal(r1.stale, false);
  assert.equal(r1.entries.length, 1);
  assert.equal(r1.entries[0].tags[0], 'decision');

  const r2 = store.memorySaveEntry(ws, r1.hash, { tags: [], links: [], text: 'pnpm only' }, NOW);
  assert.equal(r2.entries.length, 2);
  assert.equal(store.memoryGet(ws, NOW).hash, r2.hash);

  // 文件确实落盘到 docs/memory/MEMORY.md
  assert.ok(fs.existsSync(path.join(ws, 'docs', 'memory', 'MEMORY.md')));
  console.log('ok: save entries');
}

// ---------- stale 防护：baseHash 过期 → stale=true 且带回最新 ----------
{
  const fresh = store.memoryGet(ws, NOW);
  // 模拟 Agent 期间又写了一条（绕过面板）
  fs.appendFileSync(path.join(ws, 'docs', 'memory', 'MEMORY.md'), '\n\n<!-- 2026-09-02 11:00:00 [agent1] -->\n#lesson 新事实\n');
  const r = store.memorySaveEntry(ws, fresh.hash, { tags: ['bug'], links: [], text: '过期写入' }, NOW);
  assert.equal(r.stale, true);
  assert.equal(r.entries.length, 3, 'stale 结果携带最新 entries');
  console.log('ok: stale guard');
}

// ---------- forget → recovery → restore ----------
{
  const cur = store.memoryGet(ws, NOW);
  const victim = cur.entries.find((e) => e.tags.includes('decision'));
  const r = store.memoryForget(ws, cur.hash, victim.id);
  assert.equal(r.stale, false);
  assert.ok(r.recoveryId);
  assert.equal(r.entries.some((e) => e.id === victim.id), false);

  // recovery 文件落盘且不在 MEMORY.md
  const recDir = path.join(ws, 'docs', 'memory', 'recovery');
  assert.equal(fs.readdirSync(recDir).length, 1);
  const afterForget = store.memoryGet(ws, NOW);
  assert.equal(afterForget.recovery.length, 1);

  // 恢复
  const rr = store.memoryRestore(ws, afterForget.hash, r.recoveryId);
  assert.equal(rr.stale, false);
  assert.equal(rr.entries.some((e) => e.text.includes('PostgreSQL')), true, '恢复后条目回 file');
  assert.equal(fs.readdirSync(recDir).length, 0, 'recovery 消费后清理');
  console.log('ok: forget/restore');
}

// ---------- 编辑原位替换 ----------
{
  const cur = store.memoryGet(ws, NOW);
  const target = cur.entries.find((e) => !e.unparsed && e.text.includes('pnpm'));
  const r = store.memorySaveEntry(ws, cur.hash, { id: target.id, tags: target.tags, links: [], text: '改后的正文' }, NOW);
  assert.equal(r.stale, false);
  // id 是内容寻址：编辑正文后 id 变化（旧 id 不复存在），条目数量不变
  assert.equal(r.entries.length, cur.entries.length, '原位替换不增条目');
  assert.equal(r.entries.some((e) => e.id === target.id), false, '旧 id 失效');
  const edited = r.entries.find((e) => e.text === '改后的正文');
  assert.ok(edited, '新正文已写入');
  assert.deepEqual(edited.tags, target.tags, '原 tags 保留');
  console.log('ok: in-place edit');
}

// ---------- 未识别条目原位修复（替换 raw 块，不再追加留双份） ----------
{
  fs.writeFileSync(
    path.join(ws, 'docs', 'memory', 'MEMORY.md'),
    '手写坏块没注释\n\n<!-- 2026-09-01 09:00:00 [a1] -->\n#decision 保留条目\n'
  );
  const cur = store.memoryGet(ws, NOW);
  const bad = cur.entries.find((e) => e.unparsed);
  assert.ok(bad, '坏块识别为 unparsed');
  const r = store.memorySaveEntry(ws, cur.hash, { id: bad.id, tags: ['lesson'], links: [], text: '修复后的结构化条目' }, NOW);
  assert.equal(r.stale, false);
  assert.equal(r.entries.length, 2, '原位替换不追加双份');
  assert.match(r.entries[0].raw, /<!-- 2026-09-02 10:00:00 \[manual\] -->\n#lesson 修复后的结构化条目/, 'raw 块被结构化条目替换');
  assert.ok(!r.entries.some((e) => e.unparsed), '不再有未识别条目');
  console.log('ok: unparsed in-place repair');
}

// ---------- restore 对缺失/坏 recovery 的友好错误 ----------
{
  const bad = '00000000-0000-4000-8000-000000000000';
  assert.throws(
    () => store.memoryRestore(ws, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000', bad),
    /恢复记录不存在或已损坏/,
    '不抛裸 SyntaxError'
  );
  console.log('ok: restore friendly error');
}

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('memory-store: all ok');
