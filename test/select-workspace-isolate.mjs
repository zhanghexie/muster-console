/**
 * 跨工作区 select / create 不抢中栏：
 * 1) 目标会话不属于当前活动工作区 → pending（记该区待显示），不 show；
 * 2) 切回该工作区后，待显示会话被 adopt 恢复（可见）；
 * 3) 中栏 displayActiveId 对串台 activeId 视为未选中。
 * 接线守卫：sessions.ts / CenterPanel / store 必须消费纯函数（防孤儿模块）。
 * 运行: node test/select-workspace-isolate.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL as toFileUrl } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'select-ws-'));
const compile = createSharedCompiler(root, tmp);

const { decideSelectDisplay, decideAdoptActive, resolveCenterActiveId } = await import(
  toFileUrl(compile('shared/workspaceActiveSession.ts')).href
);

{
  const sessionsSrc = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
  assert.match(
    sessionsSrc,
    /decideSelectDisplay\(/,
    'SessionsService.applySelectDisplay 必须消费 decideSelectDisplay'
  );
  assert.match(
    sessionsSrc,
    /applySelectDisplay\(/,
    'create / select 必须走 applySelectDisplay'
  );
  assert.match(
    sessionsSrc,
    /if \(display === 'show'\)[\s\S]{0,160}sessions:reveal/,
    'sessions:reveal 只能在同区 show 时发，跨区不得切当前区终端页'
  );
  // 2026-09-26 sessions.ts 拆分：createTerminal 双分支在 sessions/createTerminal.ts（经 ctx 转发）
  const createTerminalSrc = fs.readFileSync(path.join(root, 'src/main/sessions/createTerminal.ts'), 'utf8');
  const createHits = createTerminalSrc.match(/applySelectDisplay\(session,\s*opts\.activate\)/g) ?? [];
  assert.ok(createHits.length >= 2, 'shell + agent 两条 create 路径都要走 applySelectDisplay');
  assert.match(
    sessionsSrc,
    /const display = this\.applySelectDisplay\(s,\s*true\)/,
    'select() 必须走 applySelectDisplay（sessions.create / sessions.select 汇入点）'
  );

  const delegateSrc = fs.readFileSync(path.join(root, 'src/main/tasks/delegate.ts'), 'utf8');
  assert.match(
    delegateSrc,
    /sessions\.select\(session\.id\)/,
    'sessions.create 仍经 select（隔离由 select 内部处理）'
  );

  const centerSrc = fs.readFileSync(path.join(root, 'src/renderer/src/panels/CenterPanel.tsx'), 'utf8');
  assert.match(centerSrc, /displayActiveId/, '中栏 visible 必须认 displayActiveId，不得直接用跨区 activeId');
  assert.doesNotMatch(
    centerSrc,
    /visible=\{s\.id === activeId\}/,
    '中栏不得再用 activeId 控制 visible（会跨区串台）'
  );

  const storeSrc = fs.readFileSync(path.join(root, 'src/renderer/src/store.tsx'), 'utf8');
  assert.match(storeSrc, /resolveCenterActiveId\(/, 'store.displayActiveId 必须消费 resolveCenterActiveId');
}

assert.deepEqual(
  decideSelectDisplay({ sessionWorkspaceId: 'ws-a', activeWorkspaceId: 'ws-a' }),
  { kind: 'show' },
  '同区 select → show'
);
assert.deepEqual(
  decideSelectDisplay({ sessionWorkspaceId: 'ws-a', activeWorkspaceId: 'ws-b' }),
  { kind: 'pending', workspaceId: 'ws-a' },
  '跨区 select → 该区待显示'
);
assert.deepEqual(
  decideSelectDisplay({
    sessionWorkspaceId: 'ws-a',
    activeWorkspaceId: 'ws-b',
    activate: false
  }),
  { kind: 'skip' },
  'select=false 不记待显示'
);
assert.deepEqual(
  decideSelectDisplay({
    sessionWorkspaceId: 'ws-a',
    activeWorkspaceId: 'ws-a',
    hidden: true
  }),
  { kind: 'skip' },
  'hidden 不抢中栏'
);
assert.deepEqual(
  decideSelectDisplay({ sessionWorkspaceId: 'ws-a' }),
  { kind: 'show' },
  '活动工作区未知时不拦截（避免启动瞬间空白）'
);

const rows = [
  { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', createdAt: 1000 },
  { id: 't-a-new', type: 'terminal', workspaceId: 'ws-a', createdAt: 4000, lastUsedAt: 4000 },
  { id: 't-b1', type: 'terminal', workspaceId: 'ws-b', createdAt: 2000, lastUsedAt: 3000 }
];

// ---------- 核心：在 B 区被跨区 select A 新会话 → 不抢 B 中栏；切回 A 可见 ----------
{
  const memory = new Map();
  const d = decideSelectDisplay({
    sessionWorkspaceId: 'ws-a',
    activeWorkspaceId: 'ws-b'
  });
  assert.equal(d.kind, 'pending');
  if (d.kind === 'pending') memory.set(d.workspaceId, 't-a-new');

  const centerWhileInB = resolveCenterActiveId(rows, 't-b1', 'ws-b');
  assert.equal(centerWhileInB, 't-b1', 'B 区中栏仍显示本区会话');
  assert.equal(
    resolveCenterActiveId(rows, 't-a-new', 'ws-b'),
    null,
    '即便 activeId 被误设成 A 区会话，B 区中栏也不显示它'
  );

  const adopted = decideAdoptActive(rows, 't-b1', 'ws-a', memory, () => 'ws-active');
  assert.equal(adopted.activeId, 't-a-new', '切回 A 应恢复跨区 select 记下的待显示会话');
  assert.equal(
    resolveCenterActiveId(rows, adopted.activeId, 'ws-a'),
    't-a-new',
    '切回后中栏可见该待显示会话'
  );
}

assert.equal(resolveCenterActiveId(rows, null, 'ws-b'), null);
assert.equal(resolveCenterActiveId(rows, 'missing', 'ws-b'), null);
assert.equal(
  resolveCenterActiveId(rows, 't-a-new', null),
  't-a-new',
  '活动工作区未就绪不拦截'
);

console.log('select-workspace-isolate: ok');
