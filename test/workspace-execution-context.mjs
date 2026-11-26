/** Real directories and Junctions: connection snapshots, all file targets and GUI callbacks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-execution-context-'));
const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
const load = async rel => import(pathToFileURL(compile(rel)).href);
const { captureWorkspaceExecutionContext, additionalExecutionDirectories, executionPathKey } = await load('main/workspaceExecutionContext.ts');
const { decideToolCallPermission, extractToolPaths } = await load('main/agentSession/tools/policy.ts');
const { createClaudeCanUseTool } = await load('main/agentSession/drivers/claude/canUseTool.ts');
const { createPiApprovalExtension } = await load('main/agentSession/drivers/pi/approvalExtension.ts');
const { renderWorkerDirectoryScope, renderWorkspaceExecutionContext } = await load('shared/workspaceExecutionContext.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const { CHAT_RUNTIME_CAPABILITIES } = await load('shared/agentRuntimeCapabilities.ts');
const { beginWorkspaceContext, endWorkspaceContext } = await load('main/agentSession/host/workspaceContext.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const { withAttachmentReadAccess } = await load('main/attachments/access.ts');
const { attachmentDir } = await load('main/attachments/service.ts');
const { sessionCaptureDirectory, prepareSessionCaptureDirectory } = await load('main/desktop/sessionCaptureAccess.ts');

try {
  const a = path.join(temp, 'a'); const b = path.join(temp, 'b');
  const tree = path.join(temp, 'task-tree'); const outside = path.join(temp, 'outside');
  for (const dir of [a, b, tree, outside]) fs.mkdirSync(dir);
  const workspace = { id: 'ws', name: '工程', path: b, controlRoot: a, defaultRootId: 'b', rootsRevision: 7,
    roots: [{ id: 'a', path: a, label: '源 A' }, { id: 'b', path: b, label: '源 B' }] };
  const cfg = { workspaces: [workspace], activeWorkspaceId: 'other' };
  const session = { id: 'session', name: '任务', runtime: 'pi', type: 'terminal', workspaceId: 'ws', cwd: a,
    sourceRoot: { rootId: 'a', path: a, cwd: a, physicalPath: sourcePathKey(a) } };
  const context = captureWorkspaceExecutionContext(cfg, session);
  assert.equal(context.controlRoot, a, 'management folder does not follow the default');
  assert.equal(context.cwd, a, 'selected session directory stays fixed');
  assert.deepEqual(additionalExecutionDirectories(context), [b]);
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.roots) && Object.isFrozen(context.writableDirectories[0]));
  workspace.roots[0].label = 'changed';
  assert.equal(context.roots[0].label, '源 A', 'no mutable config references');
  const decide = (ctx, tool, input, extra = {}) => decideToolCallPermission({ mode: 'default', planExecuting: false,
    engineToolName: tool, input, cwd: ctx.cwd, workspaceContext: ctx, hostToolIds: [], hostClassOf: () => 'edit', userRules: [], ...extra });
  assert.equal(decide(context, 'Write', { file_path: path.join(b, 'new', 'index.ts') }).decision, 'auto', 'second source folder accepts an edit');
  assert.equal(decide(context, 'Edit', { path: '..visible.txt' }).decision, 'auto', 'dot-prefixed filenames stay inside');
  assert.equal(decide(context, 'Write', { path: path.join(outside, 'x.ts') }, { mode: 'auto' }).decision, 'deny');
  assert.equal(decide(context, 'Read', { path: path.join(b, 'index.ts') }).decision, 'auto');
  assert.deepEqual(extractToolPaths({ files: [{ filePath: 'x.ts', movePath: 'y.ts' }, { filePath: 'z.ts' }] }), ['x.ts', 'y.ts', 'z.ts']);
  assert.equal(decide(context, 'apply_patch', { files: [{ filePath: 'x.ts' }, { filePath: path.join(outside, 'y.ts') }] }).decision, 'deny', 'all patch files are checked');
  assert.equal(decide(context, 'apply_patch', { files: [{ filePath: 'x.ts', movePath: path.join(outside, 'y.ts') }] }).decision, 'deny', 'move destination is checked');
  assert.equal(decide(context, 'apply_patch', { patch: `*** Update File: x.ts\n@@\n*** Move to: ${path.join(outside, 'y.ts')}\n*** End Patch` }).decision, 'deny');
  assert.equal(decide(context, 'Write', { path: path.join(outside, 'x.ts') }, { userRules: [{ id: 'allow', tool: 'Write', action: 'allow' }] }).decision, 'deny', 'allow cannot expand directories');

  const isolated = captureWorkspaceExecutionContext(cfg, { ...session, cwd: tree, worktreePath: tree, worktreeSource: { mainRepo: a, commonDir: path.join(a, '.git') } });
  assert.deepEqual(isolated.writableDirectories.map(dir => dir.path), [tree]);
  assert.deepEqual(additionalExecutionDirectories(isolated), [], 'source paths never enter writable SDK directories');
  assert.equal(decide(isolated, 'Write', { path: path.join(a, 'x.ts') }, { mode: 'auto' }).decision, 'deny');
  assert.equal(decide(isolated, 'Write', { path: path.join(b, 'x.ts') }).decision, 'deny');
  assert.equal(decide(isolated, 'Read', { path: path.join(a, 'x.ts') }).decision, 'auto');
  assert.equal(decide(isolated, 'Write', { path: 'x.ts' }).decision, 'auto');
  assert.equal(decide(isolated, 'Write', { path: 'x.ts' }, { mode: 'ask' }).decision, 'deny');
  assert.equal(isolated.mappings[0].sourcePath, a);
  const owner = { ...session, id: 'tree-owner', cwd: tree, worktreePath: tree, worktreeSource: { mainRepo: a } };
  const borrowed = { ...session, id: 'borrowed-tree', cwd: tree };
  assert.throws(() => captureWorkspaceExecutionContext(cfg, borrowed), /outside its registered source folder/);
  const sharedTree = captureWorkspaceExecutionContext(cfg, borrowed, [owner, borrowed]);
  assert.deepEqual(sharedTree.writableDirectories.map(dir => dir.path), [tree]);
  assert.equal(sharedTree.mappings[0].sourcePath, a);
  assert.equal(decide(sharedTree, 'Write', { path: path.join(a, 'source.txt') }).decision, 'deny');
  assert.equal(decide(sharedTree, 'Write', { path: 'fork.txt' }).decision, 'auto');
  assert.equal(borrowed.worktreePath, undefined, 'execution scope does not transfer cleanup ownership');
  const hostConfig = { get: () => cfg }; const entry = { sessionId: borrowed.id };
  beginWorkspaceContext({ ctx: { config: hostConfig, sessions: {
    get: () => borrowed, list: () => [borrowed], rootDependencyRoster: () => [{ ...owner, hidden: true }, borrowed]
  } } }, entry);
  assert.deepEqual(entry.turnWorkspaceContext.writableDirectories.map(dir => dir.path), [tree], 'host resolves a hidden registered owner');
  assert.equal(workspaceRootUsesFor(hostConfig).list('ws').length, 2);
  endWorkspaceContext(entry); assert.equal(workspaceRootUsesFor(hostConfig).list('ws').length, 0);
  assert.match(renderWorkspaceExecutionContext(isolated, 'engine note'), /sourceFolders[\s\S]*isolationMappings[\s\S]*engine note/);
  const scope = renderWorkerDirectoryScope(isolated, 'engine note');
  assert.ok(scope.includes('cwd: ' + JSON.stringify(tree)));
  assert.ok(scope.includes('Read/write directories: cwd.'));
  for (const folder of [a, b, tree]) assert.equal(scope.split(JSON.stringify(folder)).length - 1, 1);
  const readOnly = scope.split('\n').find(line => line.startsWith('Additional read-only directories:'));
  assert.equal(readOnly, 'Additional read-only directories: root a, root b.');
  assert.ok(scope.includes('root a → cwd'));
  assert.match(scope, /engine note$/);
  assert.doesNotMatch(renderWorkerDirectoryScope(context, ''), /Isolation mappings|Additional read-only/);
  assert.match(renderWorkerDirectoryScope(isolated, '', 'cli'), /does not intercept native CLI file tools/);
  assert.equal(CHAT_RUNTIME_CAPABILITIES.acp.directories.registration, 'cwd-only');
  // Windows app virtualization can make native realpath differ from the lexical/regular path.
  const nativeRealpath = fs.realpathSync.native;
  const physicalB = path.join(temp, 'physical-b'); fs.mkdirSync(physicalB);
  fs.realpathSync.native = candidate => {
    const real = nativeRealpath(candidate);
    return real === b ? physicalB : real;
  };
  try {
    const virtualized = captureWorkspaceExecutionContext(cfg, session);
    assert.equal(decide(virtualized, 'Write', { path: path.join(b, 'new', 'virtualized.ts') }).decision, 'auto', 'new paths retain native ancestor identity');
  } finally { fs.realpathSync.native = nativeRealpath; }

  // The actual callback paths, rather than tests of the shared decision table alone.
  const calls = [];
  const common = { cwd: a, workspaceContext: context, hostToolIds: [], hostClassOf: () => 'edit',
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    requestApproval: async req => { calls.push(req); return { approved: true, nativeChoiceId: 'allow' }; }, log: () => {} };
  const approvalOptions = { signal: new AbortController().signal, toolUseID: 'fixture' };
  const claude = createClaudeCanUseTool({ ...common, interrupt: () => {} });
  assert.equal((await claude('Write', { file_path: path.join(b, 'x.ts') }, approvalOptions)).behavior, 'allow');
  const isolatedClaude = createClaudeCanUseTool({ ...common, cwd: tree, workspaceContext: isolated,
    requestApproval: async request => { calls.push(request); return { approved: false, nativeChoiceId: 'deny' }; } });
  assert.equal((await isolatedClaude('Write', { file_path: path.join(a, 'x.ts') }, approvalOptions)).behavior, 'deny');
  let piCall;
  createPiApprovalExtension({ ...common, sessionId: session.id })({ on: (event, callback) => { if (event === 'tool_call') piCall = callback; } });
  assert.equal(await piCall({ toolName: 'write', toolCallId: 'second', input: { path: path.join(b, 'x.ts') } }), undefined);
  assert.equal((await piCall({ toolName: 'write', toolCallId: 'outside', input: { path: path.join(outside, 'x.ts') } })).block, true);
  assert.equal(calls.length, 2, 'native Claude asks for a decision, while the Pi boundary checks directories directly');

  const userData = path.join(temp, 'userdata');
  const attachmentContext = withAttachmentReadAccess(context, userData, session.id);
  const ownDir = attachmentDir(userData, `gui:${session.id}`);
  const ownImage = path.join(ownDir, 'image.png'); fs.writeFileSync(ownImage, 'fixture');
  const derived = path.join(ownDir, 'converted-test'); fs.mkdirSync(derived);
  const pageImage = path.join(derived, 'page-1.jpg'); fs.writeFileSync(pageImage, 'fixture');
  const otherDir = attachmentDir(userData, 'gui:other'); fs.mkdirSync(otherDir);
  const otherImage = path.join(otherDir, 'private.png'); fs.writeFileSync(otherImage, 'private');
  assert.equal(decide(context, 'read', { path: ownImage }).decision, 'deny', 'reproduces original missing-scope denial');
  assert.equal(decide(attachmentContext, 'read', { path: ownImage }).decision, 'auto');
  assert.equal(decide(attachmentContext, 'read_image', { path: pageImage }).decision, 'auto');
  assert.equal(decide(attachmentContext, 'write', { path: ownImage }).decision, 'deny');
  assert.equal(decide(attachmentContext, 'read', { path: otherImage }).decision, 'deny');
  const capture = path.join(sessionCaptureDirectory(userData, session.id), 'capture.png'); fs.writeFileSync(capture, 'capture');
  const otherCaptureDir = prepareSessionCaptureDirectory(userData, 'other');
  const otherCapture = path.join(otherCaptureDir, 'capture.png'); fs.writeFileSync(otherCapture, 'other');
  assert.equal(decide(attachmentContext, 'read', { path: capture }).decision, 'auto');
  assert.equal(decide(attachmentContext, 'read', { path: otherCapture }).decision, 'deny');
  assert.equal(decide(attachmentContext, 'write', { path: capture }).decision, 'deny');
  assert.equal(withAttachmentReadAccess(attachmentContext, userData, session.id), attachmentContext, 'session scope is stable across turns');
  assert.deepEqual(additionalExecutionDirectories(attachmentContext), additionalExecutionDirectories(context), 'SDK writable roots unchanged');
  const attachmentClaude = createClaudeCanUseTool({ ...common, workspaceContext: attachmentContext, interrupt: () => {} });
  assert.equal((await attachmentClaude('Read', { file_path: ownImage }, approvalOptions)).behavior, 'allow');
  createPiApprovalExtension({ ...common, workspaceContext: attachmentContext, sessionId: session.id })({ on: (event, callback) => { if (event === 'tool_call') piCall = callback; } });
  assert.equal(await piCall({ toolName: 'read', toolCallId: 'attachment', input: { path: ownImage } }), undefined);
  assert.equal((await piCall({ toolName: 'read', toolCallId: 'other-attachment', input: { path: otherImage } })).block, true);
  const attachmentAlias = path.join(ownDir, 'escape');
  fs.symlinkSync(otherDir, attachmentAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(decide(attachmentContext, 'read', { path: path.join(attachmentAlias, 'private.png') }).decision, 'deny');
  fs.unlinkSync(attachmentAlias);
  fs.rmSync(ownDir, { recursive: true });
  assert.equal(decide(attachmentContext, 'read', { path: ownImage }).decision, 'deny', 'cleared attachments lose access');

  const rulesDir = path.join(a, '.muster'); fs.mkdirSync(rulesDir);
  fs.writeFileSync(path.join(rulesDir, 'tool-rules.json'), JSON.stringify([{ id: 'host-deny', tool: 'Write', action: 'deny' }]));
  assert.equal(decide(context, 'Write', { path: path.join(b, 'x.ts') }, { cwd: b, userRules: undefined }).decision, 'deny', 'rules come from management root');
  fs.unlinkSync(path.join(rulesDir, 'tool-rules.json'));

  workspace.roots.push({ id: 'offline', path: path.join(temp, 'missing') });
  const offline = captureWorkspaceExecutionContext(cfg, session);
  assert.ok(offline.roots.at(-1).error);
  assert.equal(offline.writableDirectories.length, 2, 'offline folder grants no access');
  assert.throws(() => captureWorkspaceExecutionContext(cfg, { ...session, workspaceId: 'missing' }), /workspace not found/);
  assert.throws(() => captureWorkspaceExecutionContext(cfg, { ...session, sourceRoot: { ...session.sourceRoot, rootId: 'missing' } }), /source folder/);
  assert.equal(captureWorkspaceExecutionContext({ workspaces: [], activeWorkspaceId: '' }, { ...session, workspaceId: undefined, sourceRoot: undefined }), undefined);

  const alias = path.join(a, 'escape');
  fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(decide(context, 'Write', { path: path.join(alias, 'new', 'x.ts') }).decision, 'deny', 'nearest-existing ancestor catches Junction escape');
  fs.unlinkSync(alias);
  fs.symlinkSync(path.join(temp, 'missing-target'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => executionPathKey(path.join(alias, 'x.ts')));
  assert.equal(decide(context, 'Write', { path: path.join(alias, 'x.ts') }).decision, 'deny', 'broken link cannot fall back to parent permission');
  fs.unlinkSync(alias);
  const registeredAlias = path.join(temp, 'registered-alias');
  fs.symlinkSync(b, registeredAlias, process.platform === 'win32' ? 'junction' : 'dir');
  workspace.roots[1].path = registeredAlias;
  const aliased = captureWorkspaceExecutionContext(cfg, session);
  assert.equal(decide(aliased, 'Write', { path: path.join(registeredAlias, 'new.ts') }).decision, 'auto');
  fs.unlinkSync(registeredAlias); fs.symlinkSync(outside, registeredAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(decide(aliased, 'Write', { path: path.join(registeredAlias, 'new.ts') }).decision, 'deny', 'snapshot does not follow a retargeted root');
  fs.unlinkSync(registeredAlias);
  console.log('ok workspace-execution-context: real filesystem, all targets, snapshots, Pi/Claude callbacks');
} finally {
  // The absolute directory is owned by this fixture, with no user-selected roots.
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
}
