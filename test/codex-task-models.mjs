import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-models-'));
const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
const { listTaskCodexModels } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/taskModels.ts')));
const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
fs.mkdirSync(a); fs.mkdirSync(b);
let config = { workspaces: [{ id: 'ws', name: 'workspace', openedAt: 0, path: b, controlRoot: a,
  defaultRootId: 'b', rootsRevision: 2, roots: [{ id: 'a', path: a }, { id: 'b', path: b }] }], activeWorkspaceId: 'ws' };
const source = { workspaceId: 'ws', rootId: 'b', rootsRevision: 2 };
const result = { ok: true, items: [{ id: 'actual', displayName: 'Actual' }], defaultModelId: 'actual', source: 'app-server' };
let calls = [];
const query = async (cwd, refresh) => { calls.push([cwd, refresh]); return result; };
try {
  assert.deepEqual(await listTaskCodexModels(() => config, source, true, query), result);
  assert.deepEqual(calls, [[b, true]]);
  calls = [];
  assert.equal((await listTaskCodexModels(() => config, { ...source, rootsRevision: 1 }, false, query)).ok, false);
  assert.equal((await listTaskCodexModels(() => config, { ...source, rootId: 'missing' }, false, query)).ok, false);
  assert.equal((await listTaskCodexModels(() => config, { cwd: b }, false, query)).ok, false);
  assert.equal(calls.length, 0);
  const unavailable = await listTaskCodexModels(() => config, source, false, async () => { throw new Error('catalog offline'); });
  assert.deepEqual(unavailable, { ok: false, error: 'catalog offline' });
  const stale = await listTaskCodexModels(() => config, source, false, async () => {
    config = { ...config, workspaces: [{ ...config.workspaces[0], roots: [{ id: 'a', path: a }], defaultRootId: 'a', path: a, rootsRevision: 3 }] };
    return result;
  });
  assert.equal(stale.ok, false);
  console.log('codex-task-models: source/version guards, cwd, failure, and late removal passed');
} finally {
  if (path.dirname(tmp) !== os.tmpdir() || !path.basename(tmp).startsWith('codex-task-models-')) throw new Error('unexpected test directory');
  fs.rmSync(tmp, { recursive: true, force: true });
}
