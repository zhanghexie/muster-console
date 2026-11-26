/** Actual ConfigManager save/restart roundtrip; never touches user home. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-persistence-'));
try {
  const userData = path.join(tmp, 'data'); fs.mkdirSync(userData);
  const electron = path.join(tmp, 'node_modules', 'electron'); fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), `export const app={getPath:()=>${JSON.stringify(userData)}}; export default {app};`);
  const compile = createSharedCompiler(repo, tmp);
  const { ConfigManager } = await import(pathToFileURL(compile('main/config.ts')).href);
  let manager = new ConfigManager();
  const base = name => ({ name, enabled: true, transport: 'stdio', command: 'node' });
  manager.update({ mcp: { enabled: true, servers: [
    { ...base('legacy') }, { ...base('closed'), targetIds: [] },
    { ...base('limited'), targetIds: ['codex-cli', 'codex-cli', 'pi-dispatcher'], env: { TOKEN: 'isolated-secret' } }
  ] }, mcpByWorkspace: { fixture: [{ ...base('project'), targetIds: ['claude-gui'] }] } });
  manager = new ConfigManager();
  assert.equal(manager.get().mcp.servers[0].targetIds, undefined);
  assert.deepEqual(manager.get().mcp.servers[1].targetIds, []);
  assert.deepEqual(manager.get().mcp.servers[2].targetIds, ['codex-cli', 'pi-dispatcher']);
  assert.deepEqual(manager.get().mcpByWorkspace.fixture[0].targetIds, ['claude-gui']);
  assert.deepEqual(manager.effectiveMcp('fixture', 'codex-cli').servers.map(server => server.name), ['legacy', 'limited']);
  assert.deepEqual(manager.effectiveMcp('fixture', 'claude-gui').servers.map(server => server.name), ['legacy', 'project']);
  assert.equal(manager.getRedacted().mcp.servers[2].env.TOKEN, '***');
  manager.update({ dispatcherAppendPrompt: 'unrelated change' });
  manager = new ConfigManager();
  assert.deepEqual(manager.get().mcp.servers[2].targetIds, ['codex-cli', 'pi-dispatcher']);
  assert.equal(manager.get().mcp.servers[2].env.TOKEN, 'isolated-secret');
  console.log('mcp-config-persistence: saved/reloaded global+project target bindings and secrets verified');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
