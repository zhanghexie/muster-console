/**
 * cli-runs 坏文件隔离回归（审计 cli F-01 / X3 B2，2026-10-26 修复）：
 * cli-runs 目录里单个损坏 run 文件（半写/外部编辑）旧实现令 CliRunStore 构造器 throw →
 * startCliRuns 整体失败 → 整个 CLI 禁用，需人工删文件恢复。修复后：坏文件改名 .bad 保留
 * 现场 + console.error + 跳过，其余 run 正常加载。还原修复即红（构造器 throw）。
 * 运行: node test/cli-runs-corruption.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runs-corruption-'));
const compile = createSharedCompiler(root, tmp);
const { CliRunStore } = await import(pathToFileURL(compile('main/cliRuns/runtime.ts')));

const errors = [];
const origError = console.error;
console.error = (...a) => errors.push(a.join(' '));
try {
  // 两个正常 run 落盘
  const dir = path.join(tmp, 'runs'); fs.mkdirSync(dir, { recursive: true });
  const seed = new CliRunStore(dir);
  seed.submit('ws-a', 'task one');
  seed.submit('ws-a', 'task two');
  const ids = seed.list('ws-a').runs.map(run => run.runId).sort();
  assert.equal(ids.length, 2, '种子 run 就绪');

  // 1) 其中一个文件写坏（半截 JSON）→ 新实例构造不 throw、只隔离坏文件
  const victim = ids[0];
  fs.writeFileSync(path.join(dir, `${victim}.json`), '{"runId":"' + victim + '","state":"run', 'utf8');
  const reopened = new CliRunStore(dir);
  const survivors = reopened.list('ws-a').runs;
  assert.equal(survivors.length, 1, '坏文件跳过，其余 run 正常加载');
  assert.equal(survivors[0].runId, ids[1], '幸存的是未损坏 run');
  assert.equal(survivors[0].state, 'interrupted', '非终态 run 重启标记 interrupted（既有行为保留）');
  const bads = fs.readdirSync(dir).filter(f => f.startsWith(`${victim}.json.`) && f.endsWith('.bad'));
  assert.equal(bads.length, 1, '坏文件改名 .bad 保留现场');
  assert.ok(fs.readFileSync(path.join(dir, bads[0]), 'utf8').includes('"state":"run'), '.bad 含原始损坏字节');
  assert.ok(!fs.existsSync(path.join(dir, `${victim}.json`)), '原坏文件名让位');
  assert.ok(errors.some(e => e.includes(victim) && e.includes('隔离')), '输出隔离诊断');

  // 2) 结构校验失败（合法 JSON 但 runId 与文件名不符）同样隔离不 throw
  errors.length = 0;
  const mismatch = ids[1];
  fs.writeFileSync(path.join(dir, `${mismatch}.json`), JSON.stringify({ runId: 'not-the-file-name', revision: 1, createdAt: 1, updatedAt: 1, state: 'delivered', inputHash: 'x', taskPath: 'x', workers: [], pending: [], replies: {}, logs: [], nextSeq: 1 }), 'utf8');
  const reopened2 = new CliRunStore(dir);
  assert.equal(reopened2.list('ws-a').runs.length, 0, '校验失败同样跳过');
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith(`${mismatch}.json.`) && f.endsWith('.bad')), '校验失败同样保留 .bad');

  // 3) 隔离后目录可继续提交新 run（干净自愈）
  const submitted = reopened2.submit('ws-a', 'task three');
  assert.equal(new CliRunStore(dir).get(submitted.runId).runId, submitted.runId, '隔离后目录恢复可用');

  console.log('cli-runs-corruption: ok');
} finally {
  console.error = origError;
  fs.rmSync(tmp, { recursive: true, force: true });
}
