/** Exercise the real configuration writer and loader using isolated user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-config-persistence-'));
try {
  const userData = path.join(tmp, 'data'); fs.mkdirSync(userData);
  const electron = path.join(tmp, 'node_modules', 'electron'); fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), `export const app={getPath:()=>${JSON.stringify(userData)}}; export default {app};`);
  const compile = createSharedCompiler(repo, tmp);
  const { ConfigManager } = await import(pathToFileURL(compile('main/config.ts')).href);
  const browser = { tabs: { urls: ['muster-home://new/one', 'https://example.test/'], activeIdx: 1, owners: [{ workspaceId: 'ws', sessionId: 's' }, { workspaceId: 'ws', sessionId: 's' }] }, tabbarWidth: 220, tabbarCollapsed: true, cdpEnabled: false };
  let manager = new ConfigManager();
  manager.update({ browser });
  manager = new ConfigManager();
  assert.deepEqual(manager.get().browser, browser, 'browser tabs and preferences must survive a fresh ConfigManager');
  manager.update({ dispatcherAppendPrompt: 'unrelated update' });
  assert.deepEqual(new ConfigManager().get().browser, browser, 'unrelated configuration updates must preserve browser state');
  console.log('browser-config-persistence: tab owners, selection and preferences survive restart');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
