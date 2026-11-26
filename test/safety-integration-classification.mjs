import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-role-'));
let service;
try {
  const compile = createSharedCompiler(process.cwd(), directory);
  const { createSafetyGitEvidenceCollector, createSafetyGitEvidenceView } = await import(pathToFileURL(compile('main/safety/evidence.ts')));
  const { createSafetyService } = await import(pathToFileURL(compile('main/safety/service.ts')));
  const sourceText = process.env.APPROVAL_BASELINE
    ? execFileSync('git', ['show', `${process.env.APPROVAL_BASELINE}:src/main/sessions.ts`], { encoding: 'utf8' })
    : fs.readFileSync('src/main/sessions.ts', 'utf8');
  const ast = ts.createSourceFile('sessions.ts', sourceText, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionsService');
  const method = cls.members.find(n => n.name?.getText(ast) === 'approvalSnapshot').getText(ast);
  const code = ts.transpileModule(`class Gate { ${method} }; exports.Gate=Gate;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('exports', 'path', 'fs', 'pathKey', 'resolveRepoIdentity', 'errorMessage', 'sessionSubtreePostOrder', code)(exports, path, fs, x => x, async root => ({ root }), String, rows => rows);
  const gate = new exports.Gate();
  gate.sessions = [{ id: 's', cwd: '/main', worktreePath: '/task', worktreeSource: { mainRepo: '/main' }, worktreeBranch: 'feature', worktreeBaseBranch: 'main' }];
  let changedPath = 'src/feature.ts', missingCommit = false, unavailableTarget = false;
  let targetModified = 1, targetUntracked = 1, targetAhead = 0;
  const patch = name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`;
  gate.git = { approvalEvidence: async (root, targetRef, sourceRef, capture) => {
    if (root === '/main' && unavailableTarget) throw new Error('auxiliary unavailable');
    const parts = { diff: patch(changedPath), workingDiff: root === '/main' ? patch('src/main/safety/evidence.ts') : '', stagedDiff: '', commits: 'commit' };
    capture?.(parts);
    return { root, sourceRef, targetRef, source: missingCommit ? undefined : 'source-sha', target: 'target-sha',
      status: { branch: root === '/main' ? 'main' : 'feature', ahead: targetAhead,
        files: root === '/main' ? Array.from({ length: targetModified }, (_, i) => ({ path: i ? `wip-${i}.txt` : 'src/main/safety/evidence.ts' })) : [] },
      untrackedFiles: root === '/main' ? Array.from({ length: targetUntracked }, (_, i) => ({ path: `new-${i}.txt` })) : [], tests: { status: 'not-collected' },
      ...Object.fromEntries(Object.entries(parts).map(([key, text]) => [key, { text, sha256: createHash('sha256').update(text).digest('hex') }])) };
  } };
  const evidence = async delivery => {
    const collector = createSafetyGitEvidenceCollector();
    return collector.finish(await gate.approvalSnapshot(['s'], undefined, collector.capture, 'integrate'), delivery);
  };
  let humanCalls = 0, modelVerdict = 'allow', lastHumanReason = '';
  service = createSafetyService({ userDataPath: directory, reviewer: async request => {
    const view = createSafetyGitEvidenceView(request.gitEvidence);
    // Deterministic reviewer inspects a task patch; the real service applies hard policy.
    const task = request.gitEvidence.repositories.find(r => r.role === 'task' && !r.roleUnknown);
    if (task && !view.incomplete) assert.equal(view.query({ action: 'read', repositoryId: task.id, fileId: 0 }).contentRead, true);
    return { requestId: request.requestId, fingerprint: request.fingerprint, generation: request.generation, verdict: modelVerdict, reason: 'fixture reviewed task diff' };
  }, humanConfirm: async (_operation, reason) => { humanCalls++; lastHumanReason = reason; return false; } });
  const decide = gitEvidence => service.authorize({ workspaceId: 'w', action: 'sessions.integrateWorktree', source: 'catalog', args: {}, gitEvidence });
  const clean = await evidence();
  const view = createSafetyGitEvidenceView(clean);
  assert.equal(view.query({ action: 'read', repositoryId: 'repo-1', part: 'workingDiff', fileId: 0 }).contentRead, false, 'target WIP cannot satisfy task diff read');
  assert.equal((await decide(clean)).allowed, true, 'dirty target and not-collected tests alone allow');
  assert.equal(clean.repositories[0].role, 'task', 'task identity must come from the session mapping');
  assert.equal(clean.repositories[1].role, 'target-checkout');
  assert.equal(humanCalls, 0);
  console.log('PASS dirty target + not-collected tests => allow');
  // Historical reasons only: original evidence was not persisted. These cases
  // reconstruct the reported auxiliary conditions, not unseen original code.
  for (const sample of [
    { id: 'bea18d32-94d6-4b3b-91cf-027158f892af', modified: 1, untracked: 13, ahead: 0, task: 'docs/research/computer-use.md' },
    { id: 'afa7caae-5af8-469d-b16a-3ebc2d68a4e2', modified: 1, untracked: 13, ahead: 37, task: 'docs/research/computer-use.md' },
    { id: '68309c28-21df-455d-a5d2-8adbcd562617', modified: 27, untracked: 13, ahead: 45, task: 'src/renderer/src/components/MarkdownBody.tsx' },
  ]) {
    changedPath = sample.task; targetModified = sample.modified; targetUntracked = sample.untracked; targetAhead = sample.ahead;
    const reconstructed = await evidence();
    assert.equal(reconstructed.repositories[1].untrackedFiles.length, sample.untracked);
    assert.equal((await decide(reconstructed)).allowed, true, `${sample.id}: auxiliary conditions alone cannot force concern`);
    console.log(`PASS historical-shape ${sample.id} => allow (synthetic diff, deterministic reviewer)`);
  }
  changedPath = 'src/main/safety/evidence.ts';
  assert.equal((await decide(await evidence())).escalated, true);
  changedPath = 'src/feature.ts';
  const unsupported = await decide(await evidence('测试通过'));
  assert.equal(unsupported.escalated, true);
  assert.match(lastHumanReason, /交付声称测试通过/);
  missingCommit = true;
  assert.equal((await decide(await evidence())).escalated, true);
  missingCommit = false;
  const failed = await evidence(); failed.repositories[0].tests = { status: 'verified-fail' };
  assert.equal((await decide(failed)).escalated, true);
  const passed = await evidence('tests passed'); passed.repositories[0].tests = { status: 'verified-pass' };
  assert.equal((await decide(passed)).allowed, true);
  const unknown = await evidence(); unknown.repositories[0].roleUnknown = true;
  const unknownDecision = await decide(unknown);
  assert.equal(unknownDecision.escalated, true, 'unknown ownership is informational but missing task identity is critical');
  assert.match(lastHumanReason, /任务仓库及源\/目标提交无法确认/);
  const missing = await evidence(); missing.incomplete = true;
  delete missing.contents[missing.repositories[0].content.diff];
  assert.equal((await decide(missing)).escalated, true);
  unavailableTarget = true;
  assert.equal((await decide(await evidence())).allowed, true, 'extra unavailable target is informational');
  modelVerdict = 'concern';
  assert.equal((await decide(await evidence())).escalated, true, 'never override model concern');
  console.log('PASS safety diff, unsupported pass claim, missing commits/diff => concern; auxiliary failure => allow; model concern preserved');
} finally {
  service?.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
