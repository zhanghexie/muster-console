/**
 * 扩展 tasks.json 损坏降级回归（审计 X3-F07，2026-10-25 修复）：
 * 损坏/校验不过时 ExtensionTaskStore 构造器不得 throw——原实现使该扩展此后所有
 * start/runCommand 入口永久报同一错误，且无 .bad 隔离与自助出口（workbench 构造点无兜底）。
 * 修复后：降级空表 + 原文件改名 .bad 保留现场 + console.error（navigationStore X3-F03 同范式）。
 * 还原修复即红（构造器 throw）。运行: node test/extension-task-store-corruption.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-task-corruption-'));
const compile = createSharedCompiler(root, tmp);
const { ExtensionTaskStore } = await import(pathToFileURL(compile('main/extensions/taskStore.ts')).href);

const errors = [];
const origError = console.error;
console.error = (...a) => errors.push(a.join(' '));
const task = (id, status = 'completed') => ({
  state: { id, command: 'demo.run', requestId: `req-${id}`, status },
  args: {},
  fingerprint: `fp-${id}`
});
try {
  // 1) 半截 JSON：构造不 throw + .bad 现场保留 + 空表
  const file1 = path.join(tmp, 'tasks-a.json');
  fs.writeFileSync(file1, '{"version":1,"tasks":[{"state":{"id":"t1"', 'utf8');
  const store1 = new ExtensionTaskStore(file1);
  assert.deepEqual(store1.list(), [], '损坏后降级空表');
  const bads1 = fs.readdirSync(tmp).filter(f => f.startsWith('tasks-a.json.') && f.endsWith('.bad'));
  assert.equal(bads1.length, 1, `必须保留一个 .bad 现场，实际: ${bads1}`);
  assert.ok(fs.readFileSync(path.join(tmp, bads1[0]), 'utf8').includes('"id":"t1"'), '.bad 含原始损坏字节');
  assert.ok(errors.some(e => e.includes('tasks.json') && e.includes('解析失败')), '必须输出诊断日志');

  // 2) 结构校验失败（version 错）同样降级不 throw
  const file2 = path.join(tmp, 'tasks-b.json');
  fs.writeFileSync(file2, JSON.stringify({ version: 2, tasks: [] }), 'utf8');
  const store2 = new ExtensionTaskStore(file2);
  assert.deepEqual(store2.list(), [], '版本不兼容降级空表');
  assert.ok(fs.readdirSync(tmp).some(f => f.startsWith('tasks-b.json.') && f.endsWith('.bad')), '结构损坏同样保留 .bad');

  // 3) 降级后 store 仍可用：save 落干净新文件、重开可读回
  store1.save(task('n1'));
  const reopened = new ExtensionTaskStore(file1);
  assert.equal(reopened.list().length, 1, '干净文件可正常重开');
  assert.equal(reopened.list()[0].state.id, 'n1', '重开读回保存的任务');

  // 4) 正常路径不回退：合法文件照常加载，running 恢复降级 interrupted 语义保留
  const file3 = path.join(tmp, 'tasks-c.json');
  fs.writeFileSync(file3, JSON.stringify({ version: 1, tasks: [task('k1')] }), 'utf8');
  const store3 = new ExtensionTaskStore(file3);
  assert.equal(store3.list().length, 1, '合法文件正常加载');
  assert.equal(fs.readdirSync(tmp).filter(f => f.startsWith('tasks-c.json.') && f.endsWith('.bad')).length, 0, '正常加载不产生 .bad');
  const file4 = path.join(tmp, 'tasks-d.json');
  fs.writeFileSync(file4, JSON.stringify({ version: 1, tasks: [task('r1', 'running')] }), 'utf8');
  assert.equal(new ExtensionTaskStore(file4).list()[0].state.status, 'interrupted', 'running 恢复语义保留');

  console.log('extension-task-store-corruption: ok');
} finally {
  console.error = origError;
  fs.rmSync(tmp, { recursive: true, force: true });
}
