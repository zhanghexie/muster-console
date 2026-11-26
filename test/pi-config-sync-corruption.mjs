/**
 * pi 同步文件损坏防护回归（审计 model-providers F-04，2026-10-26 修复）：
 * ~/.pi/agent/{models,auth}.json 损坏（半写/磁盘异常/外部改坏）时，旧实现把损坏当空配置
 * 合并整写——用户手工配置的外部 provider 被静默抹掉。修复后：读失败跳过本次 sync（文件现状
 * 原样保留），写侧改原子写。还原修复即红（models.json 被整写覆盖）。运行: node test/pi-config-sync-corruption.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sync-corruption-'));
const compile = createSharedCompiler(root, tmp);
const { syncPiConfigFromApp } = await import(pathToFileURL(compile('main/agent/piConfigSync.ts')));

const errors = [];
const origError = console.error;
console.error = (...a) => errors.push(a.join(' '));
const config = {
  providers: [{ id: 'myprov', name: 'MyProv', baseUrl: 'https://gw.example.com', apiKey: 'sk-workbench', models: [{ id: 'm1', name: 'M1' }] }],
  activeProviderId: 'myprov',
  activeModelId: 'm1'
};
try {
  // 1) models.json 损坏：跳过本次同步，文件字节原样保留，不写 auth.json
  const dir1 = path.join(tmp, 'pi1'); fs.mkdirSync(dir1, { recursive: true });
  const corrupt = '{"providers":{"external-manual":{"baseUrl":"https://manual.example';
  fs.writeFileSync(path.join(dir1, 'models.json'), corrupt, 'utf8');
  const result1 = syncPiConfigFromApp(config, dir1);
  assert.deepEqual(result1.providers, [], '损坏时同步跳过（无 provider 落盘）');
  assert.equal(fs.readFileSync(path.join(dir1, 'models.json'), 'utf8'), corrupt, 'models.json 现状原样保留，不被空配置整写');
  assert.ok(!fs.existsSync(path.join(dir1, 'auth.json')), '跳过时不写 auth.json');
  assert.ok(errors.some(e => e.includes('models.json') && e.includes('跳过本次同步')), '输出跳过诊断');

  // 2) auth.json 损坏：同样跳过，models.json 不被触碰
  errors.length = 0;
  const dir2 = path.join(tmp, 'pi2'); fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'models.json'), JSON.stringify({ providers: { 'external-manual': { baseUrl: 'https://manual.example.com/v1', apiKey: 'sk-external' } } }), 'utf8');
  const corruptAuth = '{"metaagent":{"type":"api_key"';
  fs.writeFileSync(path.join(dir2, 'auth.json'), corruptAuth, 'utf8');
  syncPiConfigFromApp(config, dir2);
  assert.equal(fs.readFileSync(path.join(dir2, 'models.json'), 'utf8'), JSON.stringify({ providers: { 'external-manual': { baseUrl: 'https://manual.example.com/v1', apiKey: 'sk-external' } } }), 'auth 损坏时 models.json 不被整写');
  assert.equal(fs.readFileSync(path.join(dir2, 'auth.json'), 'utf8'), corruptAuth, 'auth.json 现状原样保留');
  assert.ok(errors.some(e => e.includes('auth.json') && e.includes('跳过本次同步')), 'auth 损坏同样诊断');

  // 3) 正常路径不回退：有效外部配置保留 + 工作台 provider 合入，产物可解析
  errors.length = 0;
  const dir3 = path.join(tmp, 'pi3'); fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(path.join(dir3, 'models.json'), JSON.stringify({ providers: { 'external-manual': { baseUrl: 'https://manual.example.com/v1', apiKey: 'sk-external' } } }), 'utf8');
  const result3 = syncPiConfigFromApp(config, dir3);
  assert.deepEqual(result3.providers, ['myprov'], '正常同步落盘工作台 provider');
  const synced = JSON.parse(fs.readFileSync(path.join(dir3, 'models.json'), 'utf8'));
  assert.ok(synced.providers['external-manual'], '外部手工 provider 保留');
  assert.ok(synced.providers['myprov'], '工作台 provider 合入');
  const auth = JSON.parse(fs.readFileSync(path.join(dir3, 'auth.json'), 'utf8'));
  assert.equal(auth['myprov'].key, 'sk-workbench', 'auth.json 正常写入');
  assert.ok(!errors.some(e => e.includes('跳过本次同步')), '正常路径无跳过日志');

  // 4) 首启缺文件（ENOENT）按空起步正常同步，不算损坏
  const dir4 = path.join(tmp, 'pi4'); fs.mkdirSync(dir4, { recursive: true });
  const result4 = syncPiConfigFromApp(config, dir4);
  assert.deepEqual(result4.providers, ['myprov'], '缺文件首启正常同步');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir4, 'models.json'), 'utf8')).providers['myprov'], '首启产物可解析');

  console.log('pi-config-sync-corruption: ok');
} finally {
  console.error = origError;
  fs.rmSync(tmp, { recursive: true, force: true });
}
