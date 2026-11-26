/** 全局主题色读写与重启往返：临时 userData，禁止接触真实配置。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-accent-config-'));
try {
  const userData = path.join(tmp, 'data');
  fs.mkdirSync(userData, { recursive: true });
  const electron = path.join(tmp, 'node_modules/electron');
  fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), `export const app = {getPath:()=>${JSON.stringify(userData)}}; export default {app};`);
  const compile = createSharedCompiler(root, tmp);
  const { ConfigManager } = await import(pathToFileURL(compile('main/config.ts')).href);
  const configPath = new ConfigManager().filePath;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ workspaceAccentDefault: { accent: 'oops', enabled: 'no' } }));
  let manager = new ConfigManager();
  assert.deepEqual(manager.get().workspaceAccentDefault, { accent: 'avatar', enabled: true });
  manager.update({ workspaceAccentDefault: { accent: '#ABCDEF', enabled: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaceAccentDefault, { accent: '#abcdef', enabled: false });
  manager = new ConfigManager();
  assert.deepEqual(manager.get().workspaceAccentDefault, { accent: '#abcdef', enabled: false });
  manager.update({ tasksKeepAwake: false });
  assert.deepEqual(new ConfigManager().get().workspaceAccentDefault, { accent: '#abcdef', enabled: false });
  console.log('workspace-accent-config: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
