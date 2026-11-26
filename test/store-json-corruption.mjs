/**
 * Store 家族 JSON 损坏防护回归（审计 X3-F02 + X3-F04，2026-10-26 修复）：
 * - F02：Store.read 覆盖的注册表文件（sessions/session-ended/usage 三件/
 *   agent-modes/models/thinking/scheduler-status）解析失败不得静默回空——否则 PersistQueue
 *   首次写把「空」落盘固化（聊天史/会话表无声丢失）。修复后：改名 .bad 保留现场 + 按空起步。
 * - Muster：旧 JSON/NDJSON 历史不读取、不迁移；调度 SQLite 是当前唯一格式。
 * 还原修复即红。运行: node test/store-json-corruption.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-corruption-'));
const compile = createSharedCompiler(root, tmp);

const userData = path.join(tmp, 'userdata');
fs.mkdirSync(userData, { recursive: true });
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
fs.writeFileSync(path.join(electronDir, 'index.mjs'), `export const app={getPath:()=>${JSON.stringify(userData)}}; export default {app};`);

const errors = [];
const origError = console.error;
console.error = (...a) => errors.push(a.join(' '));
try {
  const { Store } = await import(pathToFileURL(compile('main/store.ts')).href);
  const bads = () => fs.readdirSync(userData).filter(f => f.endsWith('.bad'));
  const legacyContent = { display: [{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: '旧聊天史' }], ts: 1 }], api: [] };

  // ---------- F02：损坏 → .bad 保留 + 空数据返回 ----------
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[{"id":"s1","name":"会话"', 'utf8');
  const store = new Store();
  assert.deepEqual(store.loadSessions(), [], '损坏的 sessions.json 回空');
  assert.equal(bads().length, 1, '必须保留 .bad 现场');
  assert.ok(fs.readFileSync(path.join(userData, bads()[0]), 'utf8').includes('"s1"'), '.bad 含原始字节');
  assert.ok(errors.some(e => e.includes('sessions.json') && e.includes('解析失败')), '输出诊断日志');

  // 首启缺文件（ENOENT）不产生 .bad
  assert.deepEqual(store.loadAgentModes(), {}, '缺文件回空');
  assert.equal(bads().length, 1, 'ENOENT 不留 .bad');

  // Muster clean-break: valid or malformed old JSON must remain untouched.
  const oldScoped = path.join(userData, 'chat-history-ws9.json');
  fs.writeFileSync(oldScoped, '{"display":[{"id":"m1"', 'utf8');
  const oldGlobal = path.join(userData, 'chat-history.json');
  fs.writeFileSync(oldGlobal, JSON.stringify(legacyContent), 'utf8');
  assert.deepEqual(store.loadChat('ws9').display, []);
  assert.deepEqual(store.loadChat('fresh-ws').display, []);
  assert.equal(fs.readFileSync(oldScoped, 'utf8'), '{"display":[{"id":"m1"');
  assert.equal(fs.readFileSync(oldGlobal, 'utf8'), JSON.stringify(legacyContent));
  assert.equal(bads().length, 1, 'old history is not read, quarantined or migrated');
  const { SchedulerSessionAdapter } = await import(pathToFileURL(compile('main/runtimeKernel/schedulerSession.ts')).href);
  const source = new SchedulerSessionAdapter(userData, 'ws9', { display: [], api: [] });
  source.recordMessage({ id: 'new', role: 'assistant', content: 'Muster event', createdAt: 1 });
  await source.flush('fixture');
  assert.equal(store.loadChat('ws9').display[0].content, 'Muster event');
  assert.equal((await store.loadChatForReviewRetention('ws9'))[0].id, 'new');
  source.close();
  const legacySchedulerFile = path.join(userData, 'scheduler-sessions/workspace-ws9.ndjson');
  fs.appendFileSync(legacySchedulerFile, '{broken}\n');
  assert.equal(store.loadChat('ws9').display[0].content, 'Muster event');
  await assert.doesNotReject(store.loadChatForReviewRetention('ws9'));
  assert.equal(fs.readFileSync(legacySchedulerFile, 'utf8'), '{broken}\n');

  console.log('store-json-corruption: ok');
} finally {
  console.error = origError;
  fs.rmSync(tmp, { recursive: true, force: true });
}
