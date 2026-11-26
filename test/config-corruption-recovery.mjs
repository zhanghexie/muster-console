/**
 * config.json 损坏恢复回归（审计 X3-F01，2026-10-26 修复）：
 * 损坏（非首启缺文件）时 ConfigManager.load 必须把原文件保留为 .bad 现场副本并输出诊断——
 * 保证 API Key 等机密可人工找回，不被后续 save() 的默认空值固化后永久丢失。
 * 同时锁定正常路径：有效配置（含 BOM）照常加载。
 * 还原修复即红（无 .bad 产生）。运行: node test/config-corruption-recovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-corruption-'));
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
  const { ConfigManager } = await import(pathToFileURL(compile('main/config.ts')).href);

  // 1) 损坏文件：含机密的半截 JSON → .bad 现场保留 + 诊断日志 + 回默认不抛
  fs.writeFileSync(path.join(userData, 'config.json'), '{"openai":{"apiKey":"sk-CORRUPT-SECRET"},"broken":', 'utf8');
  const mgr = new ConfigManager();
  assert.equal(mgr.get().openai.apiKey, '', '损坏后内存回落默认空 Key');
  const bads = fs.readdirSync(userData).filter((f) => f.startsWith('config.json.') && f.endsWith('.bad'));
  assert.equal(bads.length, 1, `必须恰好保留一个 .bad 现场副本，实际: ${bads}`);
  assert.ok(fs.readFileSync(path.join(userData, bads[0]), 'utf8').includes('sk-CORRUPT-SECRET'), '.bad 副本含原机密可人工找回');
  assert.ok(errors.some((e) => e.includes('损坏')), '必须输出损坏诊断日志');

  // 2) 正常路径：带 BOM 的有效配置照常加载（既有行为不回退）
  errors.length = 0;
  fs.writeFileSync(path.join(userData, 'config.json'), '\uFEFF{"openai":{"apiKey":"sk-OK"}}', 'utf8');
  const mgr2 = new ConfigManager();
  assert.equal(mgr2.get().openai.apiKey, 'sk-OK', 'BOM 配置正常加载');
  assert.equal(fs.readdirSync(userData).filter((f) => f.endsWith('.bad')).length, 1, '正常加载不产生新 .bad');

  console.log('config-corruption-recovery: ok');
} finally {
  console.error = origError;
  fs.rmSync(tmp, { recursive: true, force: true });
}
