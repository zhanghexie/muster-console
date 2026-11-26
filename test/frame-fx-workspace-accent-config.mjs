/**
 * 外观「渐变与毛玻璃」+ 工作区主题色的配置读写：
 * 1) frameEffects 缺省开、显式 false 保留、update 落盘不丢、重启存活；
 * 2) WorkspaceService.updateMeta 写主题色字段（accent/avatarAccent/accentOff），重启后存活；
 *    null 清除、非法值忽略；只改主题色也要落盘（回归：早退判断漏了主题色字段会静默不写）；
 * 3) 新建工作区（open）带主题色落盘。
 * 运行: node test/frame-fx-workspace-accent-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-fx-accent-config-'));
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
  `export const app = { getPath: () => ${JSON.stringify(userData)} };\n` +
    `export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };\n` +
    `export default { app, dialog };\n`
);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const configPath = path.join(userData, 'config.json');
const configMod = await import(pathToFileURL(compile('main/config.ts')));
const wsMod = await import(pathToFileURL(compile('main/workspaces.ts')));

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// —— frameEffects ——
{
  fs.rmSync(configPath, { force: true });
  assert.equal(new configMod.ConfigManager().get().frameEffects, true);
  fs.writeFileSync(configPath, JSON.stringify({ frameEffects: false }));
  assert.equal(new configMod.ConfigManager().get().frameEffects, false);
  fs.writeFileSync(configPath, JSON.stringify({ frameEffects: 'no' }));
  assert.equal(new configMod.ConfigManager().get().frameEffects, true, '非 false 回落为开');
  ok('frameEffects：缺省开 / 显式 false 保留 / 非法值回落');
}

{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  cm.update({ frameEffects: false });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).frameEffects, false, '落盘必须含 frameEffects');
  const again = new configMod.ConfigManager();
  again.update({ dispatcherAppendPrompt: 'x' });
  assert.equal(again.get().frameEffects, false, '无关 update 不洗掉');
  ok('frameEffects：update 落盘、重启存活');
}

// —— 工作区主题色 ——
const dirA = fs.mkdtempSync(path.join(tmp, 'ws-a-'));
const dirB = fs.mkdtempSync(path.join(tmp, 'ws-b-'));
{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  const svc = new wsMod.WorkspaceService(cm);
  const r = await svc.open({ path: dirA, name: 'A', avatar: '🦊', accent: 'avatar', avatarAccent: '#F19255' });
  assert.equal(r.ok, true);
  const a = svc.list().find((w) => w.name === 'A');
  assert.equal(a.accent, 'avatar');
  assert.equal(a.avatarAccent, '#f19255');
  ok('open：新建工作区带主题色');

  const before = fs.readFileSync(configPath, 'utf8');
  svc.updateMeta(a.id, { accentOff: true });
  assert.notEqual(fs.readFileSync(configPath, 'utf8'), before, '只改主题色也必须落盘');
  svc.updateMeta(a.id, { accent: '#ABCDEF', avatarAccent: 'bad' });
  const reloaded = new wsMod.WorkspaceService(new configMod.ConfigManager()).list().find((w) => w.id === a.id);
  assert.equal(reloaded.accentOff, true);
  assert.equal(reloaded.accent, '#abcdef');
  assert.equal(reloaded.avatarAccent, '#f19255', '非法值忽略，保留旧值');
  ok('updateMeta：只改主题色也落盘、重启存活、非法值忽略');

  svc.updateMeta(a.id, { accent: null, avatarAccent: null, accentOff: false });
  const cleared = new configMod.ConfigManager().get().workspaces.find((w) => w.id === a.id);
  assert.equal('accent' in cleared, false);
  assert.equal('avatarAccent' in cleared, false);
  assert.equal('accentOff' in cleared, false);
  ok('updateMeta：null / accentOff:false 清除字段');

  await svc.open({ path: dirB, name: 'B' });
  const b = svc.list().find((w) => w.name === 'B');
  assert.equal('accent' in b, false, '未传主题色不写字段');
  ok('open：未传主题色不写字段');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nframe-fx-workspace-accent-config: ${passed} 组断言全绿`);
