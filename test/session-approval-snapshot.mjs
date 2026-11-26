import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const text = process.env.APPROVAL_BASELINE
  ? execFileSync('git', ['show', `${process.env.APPROVAL_BASELINE}:src/main/sessions.ts`], { encoding: 'utf8' })
  : fs.readFileSync('src/main/sessions.ts', 'utf8');
const source = ts.createSourceFile('sessions.ts', text, ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionsService');
const names = new Set(['approvalSnapshot', 'approvalChanges', 'integrateWorktree', 'deletePermanently', 'assertArchiveAllowed', 'isExecuting']);
const methods = declaration.members.filter(n => names.has(n.name?.getText(source))).map(n => n.getText(source)).join('\n');
const code = ts.transpileModule(`class Gate { ${methods} }; exports.Gate=Gate;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
let merged = 0, deleted = 0;
const subtree = (rows, id) => rows.filter(r => r.id === id || r.parentSessionId === id);
new Function('exports', 'path', 'fs', 'pathKey', 'resolveRepoIdentity', 'errorMessage', 'sessionSubtreePostOrder', 'createSafetyGitEvidenceCollector', 'usesTaskWorktreeLifecycle', 'beginTaskWorktreeOperation', 'integrateSessionWorktree', 'assertTaskWorktreeOperationIdle', 'assertSingleWorktreeGroup', 'cleanupSessionWorktreeOnClose', 'clearSessionWorktreeMetadata', code)(
  exports, path, fs, x => x, async root => ({ root }), String, subtree,
  () => ({ capture() {}, finish: (_snapshot, delivery) => ({ delivery }), clear() {} }), () => false, () => ({ release() {} }), async () => { merged++; return { merged: true }; }, () => {}, () => {}, async () => true, () => {});
const gate = new exports.Gate();
let row, evidence, opts;
const reset = () => {
  row = { id: 'task', type: 'terminal', workspaceId: 'ws', cwd: '/source', archived: true,
    worktreePath: '/task', worktreeSource: { mainRepo: '/source', commonDir: '/source/.git' },
    worktreeBranch: 'feature', worktreeBaseBranch: 'main' };
  evidence = { source: 'task-commit', target: 'base-commit', workingDiff: { sha256: 'clean' }, stagedDiff: { sha256: 'clean' }, untrackedFiles: [], status: { files: [] } };
  opts = { targetBranch: 'main', stashMain: true };
  gate.sessions = [row]; gate.config = {}; gate.get = id => gate.sessions.find(r => r.id === id);
  gate.resolveWorkspaceId = () => 'ws'; gate.integrateCtx = () => ({}); gate.close = () => { deleted++; };
  gate.markArchived = target => { target.archived = true; };
  gate.broadcast = () => {};
  gate.releaseTaskWorktreeSession = async () => {};
  gate.worktreeReferencedByOtherSession = () => false;
  gate.worktreeCtx = () => ({});
  gate.git = { approvalEvidence: async (root, targetRef, sourceRef) => ({ root, targetRef, sourceRef, ...structuredClone(evidence) }) };
};
reset();
gate.businessApproval = async () => { Object.assign(row, { phase: { value: 'needs_you' }, updatedAt: 2, busy: false, summary: 'delivered', lastUsedAt: 3, activity: { ts: 4 }, retry: { count: 1 }, liveStatus: { label: '完成' } }); return true; };
await gate.integrateWorktree('task', opts);
assert.equal(merged, 1, 'telemetry must not invalidate integration consent');
console.log('PASS telemetry changes preserve integration approval');
for (const [label, mutate, expected] of [
  ['target advances', () => { evidence.target = 'new-target'; }, /repositories.*source.*target/],
  ['checked-out HEAD changes', () => { evidence.head = 'new-head'; }, /repositories.*head/],
  ['task commits', () => { evidence.source = 'new-task'; }, /repositories.*task.*source/],
  ['overlap content changes', () => { evidence.workingDiff.sha256 = 'changed'; }, /workingDiff.sha256/],
  ['file diagnostic', () => { evidence.workingDiff = { sha256: 'changed', text: 'diff --git a/src/example.ts b/src/example.ts\n+private content' }; }, /files=.*src\/example.ts/],
  ['staged content changes', () => { evidence.stagedDiff.sha256 = 'changed'; }, /stagedDiff.sha256/],
  ['untracked content changes', () => { evidence.untrackedFiles = [{ path: 'new.txt', sha256: 'new' }]; }, /untrackedFiles/],
  ['target option changes', () => { opts.targetBranch = 'release'; }, /options.targetBranch/],
  ['stash option changes', () => { opts.stashMain = false; }, /options.stashMain/],
  ['mapping changes', () => { row.worktreeSource.mainRepo = '/other'; }, /mainRepo/],
]) {
  reset(); const count = merged;
  gate.businessApproval = async () => { mutate(); return true; };
  await assert.rejects(gate.integrateWorktree('task', opts), error => { assert.match(error.message, /changed during approval/); assert.match(error.message, expected); console.log(`${label}: ${error.message}`); return true; });
  assert.equal(merged, count);
}
reset();
gate.businessApproval = async (_ws, _action, _args, snapshot) => {
  const parsed = JSON.parse(snapshot);
  assert.ok(parsed.sessions[0].repositories.every(r => r.sourceRef === 'feature'), 'no-options integration must use task branch');
  return true;
};
await gate.integrateWorktree('task');
reset();
row.worktreeGroups = { version: 1, primaryGroupId: 'g', groups: [{ id: 'g', path: '/other-task', source: { mainRepo: '/other-source', commonDir: '/other-source/.git' }, branch: 'other-feature', baseBranch: 'release', repos: [{ path: 'nested', branch: 'nested-feature', baseBranch: 'nested-main' }] }] };
const snapshot = JSON.parse(await gate.approvalSnapshot(['task'], undefined, undefined, 'integrate'));
const repos = snapshot.sessions[0].repositories;
assert.equal(repos.find(r => r.root === '/other-source').targetRef, 'release');
assert.equal(repos.find(r => r.root === path.join('/other-source', 'nested')).sourceRef, 'nested-feature');
row.worktreeGroups.groups[0].integration = [{ repo: '', branch: 'other-feature', target: 'saved-target', status: 'merged' }];
assert.equal(JSON.parse(await gate.approvalSnapshot(['task'], undefined, undefined, 'integrate')).sessions[0].repositories.find(r => r.root === '/other-source').targetRef, 'saved-target');
gate.businessApproval = async () => { row.worktreeGroups.groups[0].integration[0].target = 'changed-target'; return true; };
await assert.rejects(gate.integrateWorktree('task'), /integration.*target/);
for (const [label, mutate, expected] of [
  ['unarchive', () => { row.archived = false; }, /archived/],
  ['type changes', () => { row.type = 'scheduled'; }, /type/],
  ['child added', () => { gate.sessions.push({ id: 'child', parentSessionId: 'task', type: 'terminal' }); }, /sessions/],
  ['deletion mapping changes', () => { row.worktreePath = '/another-task'; }, /worktreePath/],
  ['history identity changes', () => { row.externalSessionId = 'another-history'; }, /externalSessionId/],
]) {
  reset(); const count = deleted;
  gate.businessApproval = async () => { mutate(); return true; };
  await assert.rejects(gate.deletePermanently(['task']), expected, label);
  assert.equal(deleted, count);
}
reset();
gate.businessApproval = async () => { row.phase = { value: 'done' }; row.summary = 'updated'; return true; };
await gate.deletePermanently(['task']); assert.equal(deleted, 1);
reset();
gate.businessApproval = async () => { opts.confirmNote = 'display only'; opts.notifyUserOnFail = true; evidence.status.remoteCheck = { at: 99 }; evidence.status.ahead = 2; return true; };
await gate.integrateWorktree('task', opts);
reset();
gate.sessions.push({ id: 'child', parentSessionId: 'task', type: 'terminal' });
gate.businessApproval = async () => { gate.sessions.pop(); return true; };
await assert.rejects(gate.deletePermanently(['task']), /sessions/);
reset();
row.runtime = 'pi'; row.liveStatus = { summary: 'delivery status' };
gate.isChatRuntime = () => true;
gate.agentSessionsRef = { observe: () => ({ lastReply: { text: 'tests passed' } }) };
gate.businessApproval = async (_ws, _action, _args, _snapshot, evidence) => {
  assert.match(evidence.delivery, /delivery status/);
  assert.match(evidence.delivery, /tests passed/, 'actual GUI reply reaches review as an untrusted claim');
  return true;
};
await gate.integrateWorktree('task');
console.log('ok session-approval-snapshot: integration and deletion protections');
