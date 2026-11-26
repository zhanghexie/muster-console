/**
 * 界面字体设置 AppConfig 读写（uiFont / uiFontScale）：
 * 1) 缺省 / 非法值回落 oppo + standard；
 * 2) update→save 落盘必须含 uiFont/uiFontScale（回归：save payload 漏字段会被静默丢弃，
 *    重启静默回默认——同 global-panel-glow-config.mjs 记录过的坑）；
 * 3) 磁盘往返：重启后偏好存活，无关 update 不洗掉。
 * 运行: node test/ui-font-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-font-config-'));
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
  assert.deepEqual(
    { uiFont: cm.get().uiFont, uiFontScale: cm.get().uiFontScale },
    { uiFont: 'oppo', uiFontScale: 'standard' }
  );
  ok('缺省：无字段时 OPPO Sans + 标准档');
}

{
  fs.writeFileSync(configPath, JSON.stringify({ uiFont: 'comic-sans', uiFontScale: 'huge' }));
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().uiFont, 'oppo', '非法字体回落 oppo');
  assert.equal(cm.get().uiFontScale, 'standard', '非法档位回落 standard');
  ok('load：非法值回落默认');
}

{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  cm.update({ uiFont: 'misans', uiFontScale: 'comfortable' });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.uiFont, 'misans', 'config.json 落盘必须含 uiFont');
  assert.equal(onDisk.uiFontScale, 'comfortable', 'config.json 落盘必须含 uiFontScale');
  ok('update：字体设置写入 config.json');
}

{
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().uiFont, 'misans');
  assert.equal(cm.get().uiFontScale, 'comfortable');
  cm.update({ dispatcherAppendPrompt: 'x' });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.uiFont, 'misans', '无关 update 不得洗掉 uiFont');
  assert.equal(onDisk.uiFontScale, 'comfortable');
  ok('往返：重启后设置存活，无关 update 不洗掉');
}

console.log(`\nui-font-config: ${passed} 组断言全绿`);
fs.rmSync(tmp, { recursive: true, force: true });
