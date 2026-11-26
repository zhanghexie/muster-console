import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tool-result-'));
try {
  const compile = createSharedCompiler(root, temp);
  const { projectSessionToolResult: project } = await import(pathToFileURL(compile('shared/sessionToolResult.ts')));
  const meta = { id: 'worker', type: 'terminal', name: 'Worker', createdAt: 1,
    statusToken: 'credential', runtimeResumeToken: 'host-resume', nativePermissionRestore: { mode: 'private' },
    briefCount: 3, autoNamed: true, pinnedAt: 2, cwd: '/workspace', phase: { value: 'needs_you', source: 'user' },
    worktreeGroups: { groups: [{ path: '/tree', repos: ['project'] }] },
    workerRouting: { phase: 'blocked', attempts: [{ reason: 'quota' }] },
    meta: { launchError: 'failed to start' }, warnings: ['dirty tree'], futureEvidence: { preserved: true } };
  const saved = structuredClone(meta);
  const expected = { id: meta.id, name: meta.name, cwd: meta.cwd, phase: meta.phase, worktreeGroups: meta.worktreeGroups, workerRouting: meta.workerRouting, warnings: meta.warnings, launchError: meta.meta.launchError };
  const large = { ...meta, warnings: undefined, liveStatus: { label: '编译中', kind: 'active', ts: 123 },
    workerRouting: { history: 'x'.repeat(15000) } };
  assert.deepEqual(project('host.sessions.setStatus', { note: '编译中' }, large),
    { id: 'worker', liveStatus: { label: '编译中', kind: 'active' } }, 'note-only write fits even when the session exceeds the serialization limit');
  assert.deepEqual(project('host.sessions.setStatus', { phase: 'needs_you' }, meta),
    { id: 'worker', phase: meta.phase, warnings: meta.warnings }, 'the actual user-held phase survives a blocked phase write');
  const stored = { ...meta, phase: { ...meta.phase, ts: 100 }, sourceRoot: { rootId: 'repo-2', path: '/root', cwd: '/root/sub' } };
  assert.deepEqual(project('host.sessions.setStatus', { phase: 'done' }, stored).phase, meta.phase);
  assert.deepEqual(project('host.sessions.recover', {}, { session: stored }).session.sourceRoot, stored.sourceRoot);
  assert.deepEqual(meta, saved, 'projection never mutates the internal result');
  for (const name of ['host.sessions.create', 'host.sessions.select', 'host.terminal.create']) {
    assert.deepEqual(project(name, {}, meta), expected, `${name} uses the same session projection`);
  }
  assert.deepEqual(project('host.sessions.update', { name: 'Worker' }, meta), { id: meta.id, name: meta.name, warnings: meta.warnings },
    'GUI rename source projects its direct SessionMeta before serialization');
  assert.deepEqual(project('host.sessions.update', { pinned: false }, { ...meta, pinned: false }),
    { id: meta.id, pinned: false, warnings: meta.warnings }, 'unpin false survives GUI source projection');
  assert.equal(project('host.sessions.select', {}, { ...meta, archived: false }).archived, false);
  const delegated = { session: meta, status: 'starting', inject: { mode: 'gui-prompt', messageId: 'm', queued: true }, isolate: true, repoSet: ['x'], warning: 'inspect' };
  assert.deepEqual(project('host.sessions.create', {}, delegated), { ...delegated, session: expected });
  const recovered = { ok: true, sourceId: 'old', messageStored: true, session: meta };
  assert.deepEqual(project('host.sessions.recover', {}, recovered), { ...recovered, session: expected });
  const queued = { status: 'queued', queueId: 'q', routing: { state: 'queued' } };
  assert.deepEqual(project('host.sessions.create', {}, queued), queued, 'queued and new routing shapes are untouched');
  const refused = { ...meta, refused: true, message: 'budget exhausted', dirtyWorktree: true, escalate: { allowed: false, remaining: 0 } };
  assert.deepEqual(project('host.sessions.setStatus', { phase: 'needs_you' }, refused),
    { id: 'worker', phase: meta.phase, warnings: meta.warnings, refused: true, message: refused.message,
      dirtyWorktree: true, escalate: refused.escalate }, 'all refusal and recovery information survives');
  const scheduler = { ok: true, channel: 'scheduler', sessionId: 'orchestrator:w', phase: 'idle' };
  assert.equal(project('host.sessions.setStatus', {}, scheduler), scheduler, 'scheduler status is not mistaken for SessionMeta');

  const success = { ok: true, completed: [{ tool: 'sessions.rename', result: { ok: true, result: meta } },
    { tool: 'sessions.setPinned', result: { ok: true, text: JSON.stringify({ ok: true, result: meta }) } }] };
  const updated = project('host.sessions.update', {}, success);
  assert.deepEqual(updated.completed[0].result.result, { id: meta.id, name: meta.name, warnings: meta.warnings });
  assert.deepEqual(JSON.parse(updated.completed[1].result.text).result, { id: meta.id, pinned: false, warnings: meta.warnings });
  assert.deepEqual(success.completed[0].result.result, saved);
  const partial = { ...success, ok: false, failed: { tool: 'sessions.setPinned', error: 'inspect before retry' } };
  const partialProjected = project('host.sessions.update', {}, partial);
  assert.deepEqual(partialProjected.failed, partial.failed, 'failure evidence is unchanged');
  assert.deepEqual(partialProjected.completed[0].result.result, { id: meta.id, name: meta.name, warnings: meta.warnings }, 'completed effects still omit host bookkeeping');
  const invalid = { ok: true, completed: [{ tool: 'sessions.rename', result: { ok: true, text: 'not JSON' } }] };
  assert.equal(project('host.sessions.update', {}, invalid), invalid);

  const base = { runId: 'run', workspaceId: 'w', revision: 3, createdAt: 1, updatedAt: 4,
    taskPath: '/task', workers: [{ taskId: 'task', sessionId: 'worker' }], futureEvidence: ['keep'] };
  const receipt = { runId: base.runId, state: undefined, revision: base.revision };
  delete receipt.state;
  const askArgs = { action: 'ask', params: { runId: 'run', question: 'Need details?' } };
  const question = { ...base, state: 'waiting', question: { id: 'question-1', text: 'Need details?', future: 'keep' } };
  assert.deepEqual(project('host.dispatch.run', askArgs, question), { ...receipt, state: 'waiting', question: { id: 'question-1', future: 'keep' } });
  assert.deepEqual(project('host.dispatch.run', { ...askArgs, params: { ...askArgs.params, question: 'different' } }, question), { ...receipt, state: 'waiting', question: question.question });
  const failArgs = { action: 'fail', params: { runId: 'run', error: 'failed with evidence' } };
  const failed = { ...base, state: 'failed', error: failArgs.params.error };
  assert.deepEqual(project('host.dispatch.run', failArgs, failed), { ...receipt, state: 'failed' });
  const params = { runId: 'run', summary: 'done', artifacts: ['/artifact'], verification: 'targeted test' };
  const delivered = { ...base, state: 'delivered', result: { summary: params.summary, artifacts: params.artifacts, verification: params.verification } };
  assert.deepEqual(project('host.dispatch.run', { action: 'deliver', params }, delivered), { ...receipt, state: 'delivered' });
  const extended = { ...delivered, result: { ...delivered.result, newEvidence: 'preserve' } };
  assert.deepEqual(project('host.dispatch.run', { action: 'deliver', params }, extended), { ...receipt, state: 'delivered', result: extended.result }, 'unknown result data is not dropped');
  const altered = { ...delivered, result: { ...delivered.result, artifacts: ['/other'] } };
  assert.deepEqual(project('host.dispatch.run', { action: 'deliver', params }, altered), { ...receipt, state: 'delivered', result: altered.result }, 'different persisted data is not an echo');
  for (const action of ['get', 'delegate', 'unknown']) {
    assert.equal(project('host.dispatch.run', { action, params }, delivered), delivered);
  }
  assert.equal(project('host.dispatch.run', { action: 'deliver', params: { ...params, runId: 'other' } }, delivered), delivered);
  assert.equal(project('host.mail.read', {}, meta), meta, 'unrelated domains and user data are untouched');
  const route = { ...meta, workerRouting: { plan: { requested: { tierId: 'high' },
    candidates: Array.from({ length: 300 }, (_, i) => ({ config: { harnessId: `candidate-${i}`, modelParameters: { ignoredPolicy: 'x'.repeat(100) } } })) },
    attempts: [{ attempt: 1, state: 'failed', reason: 'quota', diagnostic: 'preserve' }], phase: 'blocked', reason: 'quota' } };
  const routeSaved = structuredClone(route);
  assert.ok(JSON.stringify(route).length > 12000);
  for (const name of ['host.sessions.create', 'host.sessions.select', 'host.terminal.create']) {
    const projected = project(name, {}, route);
    assert.ok(JSON.stringify(projected).length < 2000, `${name} removes the amplified untried policy before model serialization`);
    assert.deepEqual(projected.workerRouting.attempts, route.workerRouting.attempts);
    assert.deepEqual(projected.workerRouting.requested, { tierId: 'high' });
    assert.equal(projected.launchError, route.meta.launchError);
    assert.equal(projected.meta, undefined);
  }
  assert.deepEqual(route, routeSaved);
  const history = { ...meta, acceptanceLog: [{ note: 'user-history'.repeat(2000) }], boardReplyPreview: 'old response'.repeat(2000), archiveTerminalText: 'old terminal'.repeat(2000) };
  assert.ok(JSON.stringify(history).length > 12000);
  assert.deepEqual(project('host.sessions.update', { name: 'Worker' }, history), { id: meta.id, name: meta.name, warnings: meta.warnings });
  const run = { ...base, state: 'running', workers: Array.from({ length: 400 }, (_, i) => ({ taskId: `task-${i}`, sessionId: `worker-${i}` })) };
  assert.ok(JSON.stringify(run).length > 12000);
  const progress = project('host.dispatch.run', { action: 'progress', params: { runId: 'run', text: 'working' } }, run);
  assert.deepEqual(progress, { ...receipt, state: 'running' });
  assert.ok(JSON.stringify(progress).length < 300);
  const recoveryRun = { ...run, workers: [...run.workers, { taskId: 'orphan', sessionId: 'orphan-session', creationFailed: true }] };
  assert.deepEqual(project('host.dispatch.run', { action: 'progress', params: { runId: 'run' } }, recoveryRun).workers,
    [{ taskId: 'orphan', sessionId: 'orphan-session', creationFailed: true }]);

  console.log('session write receipts omit history and untried policy, retain actual effects, failures, routes and isolation');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
}
