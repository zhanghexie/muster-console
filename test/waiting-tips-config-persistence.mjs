/** Exercise the real configuration writer and loader using isolated user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-tips-config-'));
try {
  const userData = path.join(tmp, 'data'); fs.mkdirSync(userData);
  const electron = path.join(tmp, 'node_modules', 'electron'); fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), `export const app={getPath:()=>${JSON.stringify(userData)}}; export default {app};`);
  const compile = createSharedCompiler(repo, tmp);
  const { ConfigManager } = await import(pathToFileURL(compile('main/config.ts')).href);
  let manager = new ConfigManager();
  assert.notEqual(manager.get().showWaitingTips, false, 'tips default on');
  manager.update({ showWaitingTips: false });
  manager = new ConfigManager();
  assert.equal(manager.get().showWaitingTips, false, 'preference survives restart');
  manager.update({ dispatcherAppendPrompt: 'unrelated update' });
  assert.equal(new ConfigManager().get().showWaitingTips, false, 'unrelated updates preserve preference');
  manager.update({ showWaitingTips: true });
  assert.equal(new ConfigManager().get().showWaitingTips, true);
  console.log('waiting-tips-config-persistence: ok');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
