/** Scheduler source persistence, active leases and actual Pi native path semantics. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager, createWriteTool, createReadTool } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-workspace-'));
const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
const load = async rel => import(pathToFileURL(compile(rel)).href);
const { captureSchedulerWorkspaceContext: capture, bindSchedulerSessionContext: bind,
  rememberSchedulerConnectionContext: remember, beginSchedulerWorkspaceContext: begin,
  schedulerWorkspacePromptScope: preview, setSchedulerCaptureUserData, SCHEDULER_SOURCE_ENTRY } = await load('main/agent/schedulerWorkspaceContext.ts');
const { sessionCaptureDirectory } = await load('main/desktop/sessionCaptureAccess.ts');
const { pathInExecutionDirectories, additionalExecutionDirectories } = await load('main/workspaceExecutionContext.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const { createSchedulerDirectoryExtension } = await load('main/agent/providers/directoryExtension.ts');
const { createPiApprovalExtension } = await load('main/agentSession/drivers/pi/approvalExtension.ts');
const { resolvePiToolPath } = await load('main/agent/piToolPaths.ts');
const { buildMetaAgentAppendPrompt } = await load('main/agent/systemPrompt.ts');
const { measureSchedulerInjection } = await load('main/agent/injectionMetrics.ts');
try {
  const [a, b, c, outside] = ['a', 'b', 'c', 'outside'].map(name => path.join(temp, name));
  for (const dir of [a, b, c, outside]) fs.mkdirSync(dir);
  const ws = { id: 'ws', name: 'Project', path: b, defaultRootId: 'b', controlRoot: a, rootsRevision: 1,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const cfg = { workspaces: [ws], activeWorkspaceId: 'other' }; const config = { get: () => cfg };
  const context = capture(cfg, 'ws'); assert.equal(context.cwd, b); assert.equal(context.controlRoot, a);
  const manager = SessionManager.create(b, path.join(temp, 'sessions'));
  const pinned = bind(cfg, manager, context); const session = { sessionManager: manager }; remember(session, pinned);
  assert.equal(manager.getEntries().filter(entry => entry.customType === SCHEDULER_SOURCE_ENTRY).length, 1);
  bind(cfg, manager, context); assert.equal(manager.getEntries().length, 1, 'source metadata is idempotent');
  ws.path = a; ws.defaultRootId = 'a'; ws.roots.reverse(); ws.rootsRevision++;
  const retained = capture(cfg, 'ws', session); assert.equal(retained.cwd, b, 'default/order never redirect history');
  const release = begin(config, retained); assert.equal(workspaceRootUsesFor(config).list('ws').length, 2);
  const releaseHeadless = begin(config, capture(cfg, 'ws', null, undefined, true), { publish: false, id: 'index:fixture' });
  assert.equal(preview(config, 'ws', session).workspaceContext, retained, 'headless work does not overwrite chat preview');
  releaseHeadless();
  ws.roots.push({ id: 'c', path: c }); ws.rootsRevision++;
  assert.equal(preview(config, 'ws', session).workspaceContext, retained, 'busy preview is the held snapshot');
  assert.equal(retained.roots.some(root => root.rootId === 'c'), false);
  release(); release(); assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  const next = capture(cfg, 'ws', session); assert.equal(next.cwd, b); assert.equal(next.roots.length, 3);
  assert.equal(preview(config, 'ws', session).workspaceContext.roots.length, 3);
  assert.equal(capture(cfg, 'ws', session, undefined, true).cwd, a, 'explicit new conversation follows default');

  // Real SessionManager data, including metadata invisible to the model, survives a cold reopen.
  manager.appendMessage({ role: 'user', content: 'history', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'retained' }], api: 'openai-completions',
    provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  const file = manager.getSessionFile(); assert.ok(fs.existsSync(file));
  const cold = capture(cfg, 'ws', null, file); assert.equal(cold.cwd, b);
  assert.throws(() => capture(cfg, 'ws', null, path.join(temp, 'missing-session.jsonl')), /unavailable/, 'missing history cannot silently choose a different cwd');
  const reopened = SessionManager.open(file, path.dirname(file), cold.cwd);
  assert.equal(bind(cfg, reopened, cold).sourceRootId, 'b');
  assert.equal(reopened.buildSessionContext().messages.length, 2);
  assert.ok(!JSON.stringify(reopened.buildSessionContext()).includes(SCHEDULER_SOURCE_ENTRY));
  const largeHeader = path.join(temp, 'large-header.jsonl');
  fs.writeFileSync(largeHeader, `${JSON.stringify({ type: 'session', cwd: b, padding: 'x'.repeat(100_000) })}\ninvalid later record`);
  assert.equal(capture(cfg, 'ws', null, largeHeader).cwd, b, 'first record only, without an invented header size cap');
  const originalB = ws.roots.find(root => root.id === 'b'); originalB.id = 'readded-b';
  assert.throws(() => capture(cfg, 'ws', session), /source folder/);
  assert.throws(() => bind(cfg, reopened, capture(cfg, 'ws', null, file)), /identity/);
  assert.match(preview(config, 'ws', session).workspaceContextError, /source folder/);
  originalB.id = 'b';

  const segments = buildMetaAgentAppendPrompt('http://fixture', { workspaceContext: next });
  assert.equal(segments.length, 3); assert.equal(segments[0], buildMetaAgentAppendPrompt('http://fixture')[0]);
  assert.equal(measureSchedulerInjection(segments)[2].name, 'workspace-context');
  assert.ok(segments[2].includes(JSON.stringify(a)) && segments[2].includes(JSON.stringify(b)));

  let schedulerCall; const ctx = { config, ui: { confirm: async () => ({ confirmed: true }) } };
  createSchedulerDirectoryExtension(ctx, next)({ on: (name, callback) => { if (name === 'tool_call') schedulerCall = callback; } });
  let guiCall;
  createPiApprovalExtension({ cwd: b, workspaceContext: next, sessionId: 'worker', hostToolIds: [], hostClassOf: () => 'edit',
    getPolicyState: () => ({ mode: 'default', planExecuting: false }), requestApproval: async () => ({ approved: true }), log: () => {} })
    ({ on: (name, callback) => { if (name === 'tool_call') guiCall = callback; } });
  const allowed = path.join(a, 'new.txt'); const blocked = path.join(outside, 'escape.txt');
  for (const candidate of [allowed, pathToFileURL(allowed).href, `@${allowed}`]) {
    assert.equal((await schedulerCall({ toolName: 'write', input: { path: candidate, content: 'ok' } }))?.block, undefined);
  }
  for (const candidate of [blocked, pathToFileURL(blocked).href, `@${blocked}`, '~/outside.txt']) {
    const event = { toolName: 'write', input: { path: candidate, content: 'no' } };
    assert.equal((await schedulerCall(event))?.block, true, candidate);
    assert.equal((await guiCall(event))?.block, true, `GUI: ${candidate}`);
  }
  // Execute installed native tools with recording operations: verify target parity without outside writes.
  const inputs = ['new.txt', '@new.txt', pathToFileURL(blocked).href, `@${blocked}`];
  if (process.platform === 'win32') {
    const slash = blocked.replaceAll('\\', '/'); const drive = slash[0].toLowerCase(); const rest = slash.slice(3);
    inputs.push(`/${drive}/${rest}`, `/mnt/${drive}/${rest}`, `/cygdrive/${drive}/${rest}`);
  }
  let written;
  const write = createWriteTool(b, { operations: { mkdir: async () => {}, writeFile: async target => { written = target; } } });
  for (const input of inputs) {
    await write.execute('fixture', { path: input, content: 'parity' });
    assert.equal(resolvePiToolPath('write', input, b), written, input);
  }
  const spacedCwd = path.join(temp, 'cwd\u00a0space'); fs.mkdirSync(spacedCwd);
  const spacedWrite = createWriteTool(spacedCwd, { operations: { mkdir: async () => {}, writeFile: async target => { written = target; } } });
  await spacedWrite.execute('space', { path: 'input\u00a0space.txt', content: '' });
  assert.equal(resolvePiToolPath('write', 'input\u00a0space.txt', spacedCwd), written, 'cwd unicode is not tool-input unicode');
  const unicodeRead = path.join(a, "quote\u2019.txt"); fs.writeFileSync(unicodeRead, 'unicode read');
  let readPath;
  const homeRead = createReadTool(b, { operations: { readFile: async target => { readPath = target; return Buffer.from('recorded'); },
    access: async () => {}, detectImageMimeType: async () => undefined } });
  for (const input of ['~/outside.txt', '~']) {
    await homeRead.execute('home', { path: input });
    assert.equal(resolvePiToolPath('read', input, b), readPath, 'native home expansion without accessing the user directory');
  }
  const read = createReadTool(b, { operations: { readFile: async target => { readPath = target; return fs.readFileSync(target); },
    access: async target => { fs.accessSync(target); }, detectImageMimeType: async () => undefined } });
  await read.execute('read', { path: path.join(a, "quote'.txt") });
  assert.equal(resolvePiToolPath('read', path.join(a, "quote'.txt"), b), readPath, 'native read fallback parity');
  fs.mkdirSync(path.join(a, '.muster'));
  fs.writeFileSync(path.join(a, '.muster', 'tool-rules.json'), JSON.stringify({ rules: [{ tool: 'write', action: 'ask' }] }));
  let approve;
  ctx.ui.confirm = () => new Promise(resolve => { approve = resolve; });
  const pendingApproval = schedulerCall({ toolName: 'write', input: { path: allowed, content: '' } });
  assert.equal(typeof approve, 'function', 'user tool rule is read from the fixed management root');
  originalB.path = outside;
  approve({ confirmed: true });
  assert.equal((await pendingApproval).block, true, 'approval cannot preserve a retargeted source');
  assert.equal((await schedulerCall({ toolName: 'write', input: { path: allowed, content: '' } })).block, true, 'retargeted snapshot fails closed');
  originalB.path = b;
  const userData = path.join(temp, 'scheduler-data'); fs.mkdirSync(userData);
  setSchedulerCaptureUserData(userData);
  const beforePreview = preview(config, 'ws');
  assert.ok(beforePreview.workspaceContext);
  assert.equal(fs.existsSync(path.join(userData, 'desktop-captures')), false, 'preview does not create a directory');
  const one = capture(cfg, 'ws'), again = capture(cfg, 'ws');
  assert.deepEqual(again, one, 'stable per-session scope cannot trigger a reconnect on each turn');
  const captureDir = sessionCaptureDirectory(userData, 'orchestrator:ws'), image = path.join(captureDir, 'screen.png');
  fs.writeFileSync(image, 'fixture');
  assert.equal(pathInExecutionDirectories(image, one.cwd, one.readableDirectories), true);
  assert.equal(pathInExecutionDirectories(image, one.cwd, one.writableDirectories), false);
  assert.ok(!additionalExecutionDirectories(one).includes(captureDir));
  const other = { ...ws, id: 'other-ws' }; cfg.workspaces.push(other);
  const otherContext = capture(cfg, 'other-ws');
  assert.equal(pathInExecutionDirectories(image, otherContext.cwd, otherContext.readableDirectories), false);
  setSchedulerCaptureUserData(undefined);
  console.log('scheduler-workspace-context: persistence, leases, previews and native tools passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
