import ts from 'typescript';
/**
 * sessions.delete：Catalog 门 + handler（空 ids / 未归档整批拒删 / 全归档才删）。
 * 自查：把 aborted 短路去掉或允许未归档 close，本文件应转红。
 * Run: node test/sessions-close-batch.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-close-batch-'));
const compile = createSharedCompiler(root, tmp);

const { CATALOG_VERSION, getToolDef, WORKER_TOOL_ALLOWLIST, isWorkerAllowedTool, isExtensionHostTool } =
  await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);

assert.ok(Number(CATALOG_VERSION.split('.')[1] || 0) >= 37, `Catalog 版本随 R-18b 多仓组 bump（≥1.37，当前 ${CATALOG_VERSION}）`);
const def = getToolDef('sessions.delete');
assert.ok(def, '应有 sessions.delete');
assert.equal(def.dangerous, true);
assert.equal(def.confirmAction, '删除');
assert.deepEqual(def.parameters.required, ['sessionIds']);
assert.match(def.description, /one business approval/);
assert.match(def.description, /archived targets and their descendants/);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.delete'), false);
assert.equal(isWorkerAllowedTool('sessions.delete'), false);
assert.equal(isExtensionHostTool('sessions.delete'), false);

assert.equal(getToolDef('sessions.close'), undefined, '单目标关闭别名已删除');

const sessionsEntry = compile('main/capabilities/hosts/sessions.ts');
fs.writeFileSync(compile('main/capabilities/hosts/creation.ts'), "export async function createSessionWithTask() { throw new Error('not used in this test'); }\n");
const { sessionsHost } = await import(pathToFileURL(sessionsEntry).href);
const { sessionSubtreePostOrder } = await import(pathToFileURL(compile('shared/sessionTree.ts')).href);
// Keep the actual asynchronous service batch/deduplication method behind the handler fixture.
const serviceSource = ts.createSourceFile('sessions.ts', fs.readFileSync(path.join(root,'src/main/sessions.ts'),'utf8'), ts.ScriptTarget.Latest, true);
const declaration = serviceSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionsService');
const method = declaration.members.find(member => member.name?.getText(serviceSource) === 'deletePermanently');
const archiveGuard = declaration.members.find(member => member.name?.getText(serviceSource) === 'assertArchiveAllowed');
const execution = declaration.members.find(member => member.name?.getText(serviceSource) === 'isExecuting');
const emitted = ts.transpileModule(`class Gate { ${archiveGuard.getText(serviceSource)} ${execution.getText(serviceSource)} ${method.getText(serviceSource)} }; exports.Gate=Gate;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const fixtureExports={};new Function('exports','sessionSubtreePostOrder','createSafetyGitEvidenceCollector','assertTaskWorktreeOperationIdle','usesTaskWorktreeLifecycle','assertSingleWorktreeGroup',emitted)(fixtureExports,sessionSubtreePostOrder,()=>({capture(){},finish:()=>({}),clear(){}}),()=>{},()=>false,()=>{});


const archivedA = {
  id: 'aaaaaaaa-1111-4222-8333-444444444444',
  name: '已归档 A',
  type: 'terminal',
  archived: true,
  lastUsedAt: Date.UTC(2026, 8, 17),
  cwd: 'E:/ws/.worktrees/a',
  phase: { value: 'done' },
  lifecycle: 'exited'
};
const archivedB = {
  id: 'bbbbbbbb-1111-4222-8333-444444444444',
  name: '已归档 B',
  type: 'terminal',
  archived: true,
  lastUsedAt: Date.UTC(2026, 8, 18),
  cwd: 'E:/ws/.worktrees/b',
  lifecycle: 'exited'
};
const liveC = {
  id: 'cccccccc-1111-4222-8333-444444444444',
  name: '还在跑',
  type: 'terminal',
  archived: false,
  lifecycle: 'working',
  phase: { value: 'needs_you' }
};

function mockCtx(rows) {
  const store = new Map(rows.map((s) => [s.id, { workspaceId:'ws', ...s }]));
  const closed = [];
  const context = {
    closed,
    sessions: Object.assign(new fixtureExports.Gate(), {
      get sessions() { return [...store.values()]; },
      businessApproval: async () => true,
      markArchived: row => { row.archived = true; },
      broadcast() {},
      approvalSnapshot: async () => JSON.stringify([...store.values()]),
      list: () => [...store.values()],
      get: (id) => store.get(id),
      resolveSessionRef: ({ sessionId }) => {
        if (store.has(sessionId)) return { id: sessionId };
        const hit = [...store.values()].find((s) => s.id.startsWith(sessionId));
        if (hit) return { id: hit.id };
        throw new Error(`会话不存在: ${sessionId}`);
      },
      close: (id) => {
        const s = store.get(id);
        if (!s) throw new Error(`会话不存在: ${id}`);
        if (!s.archived) throw new Error('会话尚未归档：请先归档再删除（删除仅对已归档会话开放）');
        for (const row of sessionSubtreePostOrder([...store.values()],id)) store.delete(row.id);
        closed.push(id);
      }
    })
  };
  Object.defineProperty(context.sessions,'sessions',{get:()=>[...store.values()]});
  return context;
}

{
  const ctx = mockCtx([archivedA, archivedB, liveC]);
  try {
    await sessionsHost['sessions.delete'](ctx, { sessionIds: [] });
    assert.fail('空 ids 应抛');
  } catch (e) {
    assert.match(String(e.message || e), /ids 不能为空/);
  }
  assert.deepEqual(ctx.closed, []);
}

{
  const ctx = mockCtx([archivedA, archivedB, liveC]);
  const res = await sessionsHost['sessions.delete'](ctx, {
    sessionIds: [archivedA.id, liveC.id]
  });
  assert.equal(res.aborted, true, '含未归档必须整批中止');
  assert.equal(res.count, 0);
  assert.deepEqual(res.closed, []);
  assert.equal(ctx.closed.length, 0, '未归档拒删：一个都没删');
  assert.ok(res.failed.some((f) => f.reason === 'unarchived' && f.name === '还在跑'));
}

{
  const ctx = mockCtx([archivedA, archivedB, liveC]);
  const res = await sessionsHost['sessions.delete'](ctx, {
    sessionIds: ['aaaaaaaa', archivedB.id]
  });
  assert.equal(res.aborted, false);
  assert.equal(res.count, 2);
  assert.deepEqual(
    res.closed.map((x) => x.name),
    ['已归档 A', '已归档 B']
  );
  assert.deepEqual(ctx.closed, [archivedA.id, archivedB.id]);
  assert.ok(ctx.sessions.get(liveC.id), '未点名的会话不受影响');
}

{
  const ctx = mockCtx([archivedA]);
  const res = await sessionsHost['sessions.delete'](ctx, { sessionIds: ['missing-id'] });
  assert.equal(res.aborted, true);
  assert.equal(ctx.closed.length, 0);
  assert.equal(res.failed[0].reason, 'missing');
}

{
  const ctx = mockCtx([archivedA, { ...archivedB, parentSessionId: archivedA.id }]);
  const result = await sessionsHost['sessions.delete'](ctx, { sessionIds: [archivedB.id, archivedA.id] });
  assert.equal(result.count, 2, '两条显式目标都由父的级联删除覆盖');
  assert.deepEqual(ctx.closed, [archivedA.id], '避免父子重复触发清理');
  assert.equal(ctx.sessions.get(archivedB.id), undefined, '父的级联删除包含后代');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] sessions-close-batch');
