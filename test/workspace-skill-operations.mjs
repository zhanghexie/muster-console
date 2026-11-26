/** Actual discovery IPC and brief producer hold all roots before their first await. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-operations-'));
const electron = path.join(temp, 'node_modules/electron'); fs.mkdirSync(electron, { recursive: true });
fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ type: 'module', main: 'index.mjs' }));
fs.writeFileSync(path.join(electron, 'index.mjs'), `
export const ipcMain = {handle() {}, on() {}}; export const app = {getPath: () => ${JSON.stringify(temp)}};
export const dialog = {}; export const shell = {}; export const nativeImage = {}; export const clipboard = {};
export class BrowserWindow {} export class WebContentsView {} export class Notification {}
`);
const bundle = path.join(temp, 'operations.mjs');
await require('esbuild').build({ stdin: { contents: `
export {registerFsIpc} from './src/main/ipc/fs';
export {invokeIpcChannel} from './src/main/ipc/handle';
export {buildBriefWithNamedSkills} from './src/main/capabilities/hosts/chat';
export {workspaceRootUsesFor} from './src/main/workspaceRootUses';
export {captureWorkspaceExecutionContext} from './src/main/workspaceExecutionContext';
`, resolveDir: repo, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
plugins: [{ name: 'boundaries', setup(build) {
  build.onLoad({ filter: /[\\/]agent[\\/]skillsList\.ts$/ }, () => ({ contents: 'export const listAgentSkills = (...args) => globalThis.__skillOperation(...args);', loader: 'ts' }));
  build.onLoad({ filter: /[\\/]memory[\\/]serviceRef\.ts$/ }, () => ({ contents: 'export const getMemoryService = () => ({inject: () => ({text:""}), init: () => ({}), search: async () => []});', loader: 'ts' }));
  build.onLoad({ filter: /[\\/]memory[\\/]brief\.ts$/ }, () => ({ contents: 'export const buildBriefRecallSection = async () => ({text:""});', loader: 'ts' }));
  build.onResolve({ filter: /^[^./]/ }, args => {
    if (args.path === 'electron' || args.path.startsWith('node:') || builtinModules.includes(args.path)) return;
    return { path: import.meta.resolve(args.path), external: true };
  });
} }] });
const { registerFsIpc, invokeIpcChannel, buildBriefWithNamedSkills, workspaceRootUsesFor, captureWorkspaceExecutionContext: capture } = await import(pathToFileURL(bundle).href);
try {
  const a = path.join(temp, 'a'); const b = path.join(temp, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const ws = { id: 'ws', name: 'Project', path: a, controlRoot: a, defaultRootId: 'a', rootsRevision: 1,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const cfg = { workspaces: [ws], activeWorkspaceId: 'elsewhere' }; const config = { get: () => cfg, onChanged: () => () => {} };
  const ctx = { config, runtimes: { list: builtinHarnessFixtures } }; registerFsIpc(ctx, {});
  const registry = workspaceRootUsesFor(config);
  const roots = () => registry.list('ws').map(use => use.rootId).sort();
  let resolveSkills; let rejectSkills; let received; let announce;
  globalThis.__skillOperation = (cwd, context, target) => {
    received = { cwd, context, target };
    return new Promise((resolve, reject) => {
      resolveSkills = resolve; rejectSkills = reject; announce?.();
    });
  };
  async function listSkills(...args) {
    const started = new Promise(resolve => { announce = resolve; });
    const result = invokeIpcChannel('agent:listSkills', args);
    await Promise.race([started, result.then(value => { throw new Error('Skill enumeration did not start: ' + JSON.stringify(value)); })]);
    announce = undefined;
    return { result };
  }
  const { result: listed } = await listSkills('ws'); assert.deepEqual(roots(), ['a', 'b']);
  assert.equal(received.target, 'pi-gui', 'legacy request preserves default GUI target');
  ws.path = b; ws.defaultRootId = 'b'; ws.rootsRevision++;
  assert.equal(received.cwd, a); assert.equal(received.context.sourceRootId, 'a');
  resolveSkills([]); assert.deepEqual(await listed, { skills: [] }); assert.deepEqual(roots(), []);
  for (const target of ['claude-gui', 'codex-gui', 'pi-dispatcher']) {
    const { result: requested } = await listSkills('ws', target);
    assert.equal(received.target, target, 'actual IPC passes the exact runtime target');
    resolveSkills([]); assert.deepEqual(await requested, { skills: [] }); assert.deepEqual(roots(), []);
  }
  ws.path = a; ws.defaultRootId = 'a'; ws.rootsRevision++;
  const cliSession = { id: 'cli-skills', name: 'CLI', type: 'terminal', launchKind: 'agent',
    runtime: 'claude-code', workspaceId: 'ws', cwd: b, createdAt: 0 };
  ctx.sessions = { get: id => id === cliSession.id ? cliSession : undefined, list: () => [cliSession], isChatRuntime: () => false };
  const { result: cliSkills } = await listSkills('ws', 'claude-cli', cliSession.id);
  assert.equal(received.cwd, b, 'CLI discovery uses the session cwd, not the workspace default');
  assert.equal(received.target, 'claude-cli');
  resolveSkills([]); assert.deepEqual(await cliSkills, { skills: [] }); assert.deepEqual(roots(), []);
  const mismatch = await invokeIpcChannel('agent:listSkills', ['ws', 'codex-cli', cliSession.id]);
  assert.match(mismatch.error, /技能入口不可用/);
  const { result: changed } = await listSkills('ws', 'claude-cli', cliSession.id);
  cliSession.cwd = a; resolveSkills([{ name: 'stale', description: '' }]);
  assert.match((await changed).error, /会话已变化/); assert.deepEqual(roots(), []);
  cliSession.cliSuggestedReplies = { messageId: 'new', replies: ['新建议'] };
  ctx.sessions.clearCliSuggestedReplies = (id, expected) => {
    assert.equal(id, cliSession.id);
    if (cliSession.cliSuggestedReplies?.messageId === expected) delete cliSession.cliSuggestedReplies;
  };
  const oldClear = await invokeIpcChannel('suggestions:clear', [{ kind: 'cli', targetId: cliSession.id, messageId: 'old', replies: ['旧建议'] }]);
  assert.deepEqual(oldClear, { ok: true, cleared: false });
  assert.equal(cliSession.cliSuggestedReplies.messageId, 'new', 'late clear cannot remove a newer batch');
  const clear = await invokeIpcChannel('suggestions:clear', [{ kind: 'cli', targetId: cliSession.id, messageId: 'new', replies: ['新建议'] }]);
  assert.deepEqual(clear, { ok: true, cleared: true });
  assert.equal(cliSession.cliSuggestedReplies, undefined);
  const invalidTarget = await invokeIpcChannel('agent:listSkills', ['ws', 'unknown-runtime']);
  assert.deepEqual(invalidTarget.skills, []); assert.match(invalidTarget.error, /技能入口无效/);
  assert.deepEqual(roots(), [], 'invalid target cannot acquire a root lease');
  const { result: failed } = await listSkills('ws'); assert.deepEqual(roots(), ['a', 'b']);
  rejectSkills(new Error('SDK failed')); assert.match((await failed).error, /SDK failed/); assert.deepEqual(roots(), []);
  const { result: stale } = await listSkills('ws');
  ws.roots = [{ id: 'a', path: a }]; ws.path = a; ws.defaultRootId = 'a'; ws.rootsRevision++;
  resolveSkills([{ name: 'removed', description: '' }]); const discarded = await stale;
  assert.deepEqual(discarded.skills, []); assert.match(discarded.error, /source folder not found/); assert.deepEqual(roots(), []);

  ws.roots.push({ id: 'b', path: b }); ws.rootsRevision++;
  const context = capture(cfg, { id: 'pending', name: 'Task', type: 'terminal', createdAt: 0, workspaceId: 'ws', cwd: b });
  const brief = buildBriefWithNamedSkills(ctx, undefined, '/skill:demo', { workspaceRoot: a, skillCwd: a, workspaceContext: context });
  assert.deepEqual(roots(), ['a', 'b'], 'brief roots registered before recall await');
  // buildBrief's recall awaits before the skill loader boundary is reached.
  for (let i = 0; i < 30 && received.context !== context; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.context, context, 'brief reached the actual skill loader');
  assert.equal(received.cwd, b, 'existing task snapshot wins over management/default folder');
  ws.roots = [{ id: 'a', path: a }]; ws.rootsRevision++;
  resolveSkills([]); await assert.rejects(brief, /source folder not found/); assert.deepEqual(roots(), []);
  console.log('workspace-skill-operations: actual IPC/brief synchronous leases, source capture, failure cleanup and stale-result rejection passed');
} finally { delete globalThis.__skillOperation; fs.rmSync(temp, { recursive: true, force: true }); }
