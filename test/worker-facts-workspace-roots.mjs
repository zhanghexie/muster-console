import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const fixture = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'worker-facts-roots-'));
const compile = createSharedCompiler(process.cwd(), fixture);
try {
  const observeFile = compile('main/sessions/observe.ts');
  fs.writeFileSync(compile('main/git/pipelineFacts.ts'), 'export async function collectWorktreeLastWriteAt() { throw Error("unexpected Git IO"); }\nexport async function collectPipelineGitFacts(options) { globalThis.workerFactsFixture.push(options); return { uncommittedCount: 0, aheadCount: 1, canFastForward: true, dirtyOverlap: false, overlapFiles: [], dirtyPaths: [] }; }');
  const { observeHost } = await import(pathToFileURL(observeFile).href);
  const { RuntimeAwarenessStore } = await import(pathToFileURL(compile('main/awareness/store.ts')).href);
  const workspace = { id: 'ws', path: path.join(fixture, 'default'), controlRoot: path.join(fixture, 'control') };
  const session = { id: 'worker', name: 'Worker', createdAt: 1, workspaceId: 'ws', type: 'terminal', launchKind: 'agent',
    lifecycle: 'idle', worktreePath: path.join(fixture, 'checkout'), worktreeBranch: 'ao/test',
    worktreeSource: { mainRepo: path.join(fixture, 'actual-git-source') } };
  const ctx = { config: { get: () => ({ workspaces: [workspace] }) }, resolveBubbleWorkspaceId: () => 'ws',
    sessions: { list: () => [session], get: id => id === session.id ? session : undefined, isChatRuntime: () => false },
    pty: { getBufferTail: () => undefined }, workspaces: { list: () => [workspace] },
    awareness: new RuntimeAwarenessStore(path.join(fixture, 'awareness')) };
  globalThis.workerFactsFixture = [];
  await observeHost(ctx);
  assert.equal(globalThis.workerFactsFixture.length, 0, '普通观察不扫描 Git');
  const facts = await observeHost(ctx, { sessionId: session.id, includeGit: true });
  assert.equal(globalThis.workerFactsFixture.length, 1);
  assert.equal(globalThis.workerFactsFixture[0].mainRepo, session.worktreeSource.mainRepo);
  assert.ok(facts.state.facts.some(f => f.kind.startsWith('git.')));
  delete session.worktreeSource;
  await observeHost(ctx, { sessionId: session.id, includeGit: true });
  assert.equal(globalThis.workerFactsFixture.at(-1).mainRepo, workspace.path);
  const { PipelineStallScanner } = await import(pathToFileURL(compile('main/pipeline/stallScanner.ts')).href);
  session.lifecycle = 'working'; session.lastUsedAt = 1;
  const scanner = new PipelineStallScanner({ ctx });
  const scan = await scanner.scanOnce(Date.now());
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.facts.length, 1, '停滞判定不再要求共享任务记录');
  assert.equal(scan.facts[0].data.stalled, true);
} finally {
  delete globalThis.workerFactsFixture;
  fs.rmSync(fixture, { recursive: true, force: true });
}
