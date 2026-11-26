/**
 * 全局面板灯带 AppConfig 读写：
 * 1) 缺省 / 缺字段 = 开；显式 false 保留；
 * 2) update→save 落盘必须含 globalPanelGlow（回归：save payload 漏字段会被静默丢弃）；
 * 3) 磁盘往返：重启后偏好存活，无关 update 不洗掉。
 * 运行: node test/global-panel-glow-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-panel-glow-config-'));
const compile = createSharedCompiler(root, tmp);

const userData = path.join(tmp, 'userdata');
fs.mkdirSync(userData, { recursive: true });
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(
  path.join(electronDir, 'package.json'),
  JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' })
);
fs.writeFileSync(
  path.join(electronDir, 'index.mjs'),
  `export const app = { getPath: () => ${JSON.stringify(userData)} };\nexport default { app };\n`
);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const configPath = path.join(userData, 'config.json');
const configMod = await import(pathToFileURL(compile('main/config.ts')));

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().globalPanelGlow, true);
  ok('缺省：无字段时灯带开');
}

{
  fs.writeFileSync(configPath, JSON.stringify({ globalPanelGlow: false }));
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().globalPanelGlow, false);
  ok('load：显式 false 保留');
}

{
  fs.writeFileSync(configPath, JSON.stringify({ globalPanelGlow: 'no' }));
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().globalPanelGlow, true, '非 false 回落为开');
  ok('load：非法值回落为开');
}

{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  cm.update({ globalPanelGlow: false });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.globalPanelGlow, false, 'config.json 落盘必须含 globalPanelGlow');
  ok('update：关灯带写入 config.json');
}

{
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().globalPanelGlow, false);
  cm.update({ dispatcherAppendPrompt: 'x' });
  assert.equal(cm.get().globalPanelGlow, false);
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.globalPanelGlow, false);
  ok('往返：重启后关态存活，无关 update 不洗掉');
}

console.log(`\nglobal-panel-glow-config: ${passed} 组断言全绿`);
