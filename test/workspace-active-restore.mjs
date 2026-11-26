/**
 * 切换工作区恢复上次选中会话（decideAdoptActive）：
 * 1) 切回工作区应恢复「上次离开时选中」的会话；
 * 2) 无记忆/记忆失效时兜底应选该区左栏最上一行（置顶优先，同组内 lastUsedAt/createdAt 最新），
 *    而不是内部数组第一个（创建最早、UI 里排在末尾）。
 * 运行: node test/workspace-active-restore.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL as toFileUrl } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-active-'));
const compile = createSharedCompiler(root, tmp);

const { decideAdoptActive, compareSessionsByRail } = await import(
  toFileUrl(compile('shared/workspaceActiveSession.ts')).href
);

// 接线守卫：纯函数被 sessions.ts 真实消费才算修复落地——本用例只直译纯函数，
// 接线被 revert 掉时它依然绿（测试通过时仍可能存在未接线的模块）
{
  const sessionsSrc = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
  assert.match(
    sessionsSrc,
    /decideAdoptActive\(/,
    'SessionsService.adoptActiveForWorkspace 必须消费 decideAdoptActive（防功能被回退成孤儿模块）'
  );
  assert.match(
    sessionsSrc,
    /lastActiveByWs/,
    '每工作区选中记忆 lastActiveByWs 必须存在'
  );
}

/** 与 SessionsService.resolveWorkspaceId 同语义的最小实现：workspaceId 优先，cwd 按前缀归区 */
const workspaces = [
  { id: 'ws-a', path: 'E:/proj/a' },
  { id: 'ws-b', path: 'E:/proj/b' }
];
function resolveWorkspaceId(cwd) {
  if (!cwd) return 'ws-active';
  const abs = cwd.replace(/\\/g, '/');
  let best = null;
  for (const w of workspaces) {
    const wp = w.path.replace(/\\/g, '/');
    if (abs === wp || abs.startsWith(`${wp}/`)) {
      if (!best || wp.length > best.len) best = { id: w.id, len: wp.length };
    }
  }
  return best?.id ?? 'ws-active';
}

/** 切区动作：调 decision、落 remember，返回新 activeId（模拟 adoptActiveForWorkspace 全流程） */
function switchTo(rows, activeId, targetWs, memory) {
  const d = decideAdoptActive(rows, activeId, targetWs, memory, resolveWorkspaceId);
  if (d.remember) memory.set(d.remember.workspaceId, d.remember.sessionId);
  return d.activeId;
}

const T0 = 1000;
const T1 = 2000;
const T2 = 3000;
const T3 = 4000;
// A 区两行：t-a1 创建最早且从未真用过（UI 排末尾）；t-a2 最近使用过（UI 顶行）
const rowsA = [
  { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', createdAt: T0 },
  { id: 't-a2', type: 'terminal', workspaceId: 'ws-a', createdAt: T1, lastUsedAt: T3 }
];
const rowsFull = [
  ...rowsA,
  { id: 't-b1', type: 'terminal', workspaceId: 'ws-b', createdAt: T2 }
];

// ---------- 核心回归①：切回 A 区恢复 t-a2（上次离开时选中），而不是列表第一个 t-a1 ----------
{
  const memory = new Map();
  let active = 't-a2'; // 用户在 A 区选中了第二个会话
  active = switchTo(rowsFull, active, 'ws-b', memory); // 切到 B
  assert.equal(active, 't-b1', 'B 区无记忆 → 兜底 B 区唯一 terminal');
  assert.deepEqual([...memory], [['ws-a', 't-a2']], '离开 A 时应记下当时选中的 t-a2');
  active = switchTo(rowsFull, active, 'ws-a', memory); // 切回 A
  assert.equal(active, 't-a2', '切回 A 应恢复上次离开时的 t-a2');
}

// ---------- 核心回归②：无记忆时兜底选左栏顶行（lastUsedAt 最新），不是数组第一个 ----------
{
  const active = switchTo(rowsFull, null, 'ws-a', new Map());
  assert.equal(active, 't-a2', '无记忆 → 兜底选 UI 顶行 t-a2（lastUsedAt 最新），不是数组第一个 t-a1');
}

// ---------- 兜底：置顶优先于 lastUsedAt ----------
{
  const rows = [
    { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', createdAt: T0, pinned: true, pinnedAt: T1 },
    ...rowsA.slice(1) // t-a2：lastUsedAt=T3 最新但未置顶
  ];
  const active = switchTo(rows, null, 'ws-a', new Map());
  assert.equal(active, 't-a1', '置顶行在 UI 最上 → 兜底选它，即使 lastUsedAt 更旧');
}

// ---------- 兜底：lastUsedAt 都缺省时按 createdAt 新的 ----------
{
  const rows = [
    { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', createdAt: T0 },
    { id: 't-a3', type: 'terminal', workspaceId: 'ws-a', createdAt: T2 }
  ];
  const active = switchTo(rows, null, 'ws-a', new Map());
  assert.equal(active, 't-a3', '都无 lastUsedAt → 按createdAt 取新的 t-a3');
}

// ---------- 在 A 区换了选中再切走：记忆被覆盖为最新选中 ----------
{
  const memory = new Map();
  let active = 't-a2';
  active = switchTo(rowsFull, active, 'ws-b', memory); // A→B，记 A→t-a2
  active = switchTo(rowsFull, active, 'ws-a', memory); // B→A，恢复 t-a2
  assert.equal(active, 't-a2');
  active = 't-a1'; // 用户在 A 区改选 t-a1（sessions.select）
  active = switchTo(rowsFull, active, 'ws-b', memory); // A→B，A 的记忆覆盖为 t-a1
  assert.equal(memory.get('ws-a'), 't-a1', '离开时记忆覆盖为最新选中的 t-a1');
  active = switchTo(rowsFull, active, 'ws-a', memory); // 切回 A
  assert.equal(active, 't-a1', '恢复的是改选后的 t-a1 而非旧记忆 t-a2');
}

// ---------- 记忆已失效：兜底同样选左栏顶行 ----------
{
  // 记忆的会话已归档：t-a1 是唯一有效行
  const archived = [
    { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', createdAt: T0 },
    { id: 't-a2', type: 'terminal', workspaceId: 'ws-a', createdAt: T1, lastUsedAt: T3, archived: true }
  ];
  const active = switchTo(archived, 't-b1', 'ws-a', new Map([['ws-a', 't-a2']]));
  assert.equal(active, 't-a1', '记忆的会话已归档 → 兜底选剩余顶行 t-a1');
}
{
  // 记忆的会话已删除（如被 close）：t-a2 不在表中，兜底 t-a1
  const closed = rowsFull.filter((r) => r.id !== 't-a2');
  const active = switchTo(closed, 't-b1', 'ws-a', new Map([['ws-a', 't-a2']]));
  assert.equal(active, 't-a1', '记忆的会话已不存在 → 兜底选顶行 t-a1');
}
{
  // 记忆指向 hidden 会话（不可选中）
  const hidden = [
    { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', createdAt: T0 },
    { id: 't-a2', type: 'terminal', workspaceId: 'ws-a', createdAt: T1, lastUsedAt: T3, hidden: true }
  ];
  const active = switchTo(hidden, 't-b1', 'ws-a', new Map([['ws-a', 't-a2']]));
  assert.equal(active, 't-a1', '记忆的会话已隐藏 → 兜底选顶行 t-a1');
}

// ---------- 当前 active 已属于目标区：保持不动、不产生记忆 ----------
{
  const d = decideAdoptActive(rowsFull, 't-a2', 'ws-a', new Map(), resolveWorkspaceId);
  assert.deepEqual(d, { activeId: 't-a2', remember: null }, 'active 已在目标区 → 保持');
}

// ---------- scheduled 会话可作为记忆恢复（与「保持」分支语义一致），但不进兜底 ----------
{
  const rows = [
    ...rowsFull,
    { id: 'sch-a1', type: 'scheduled', workspaceId: 'ws-a', lastUsedAt: T3 + 1 }
  ];
  const restored = switchTo(rows, 't-b1', 'ws-a', new Map([['ws-a', 'sch-a1']]));
  assert.equal(restored, 'sch-a1', '上次停在 scheduled 行 → 恢复该行');
  const fallback = switchTo(rows, null, 'ws-a', new Map());
  assert.equal(fallback, 't-a2', '兜底只考虑 terminal：scheduled 即使最新也不选');
}

// ---------- 空区：active 置 null ----------
{
  const active = switchTo(rowsFull, 't-a2', 'ws-empty', new Map());
  assert.equal(active, null, '目标区无会话 → null');
}

// ---------- compareSessionsByRail：与旧左栏排序逐语义对齐 ----------
{
  const list = [
    { id: 'x', createdAt: T3 }, // 最新但未置顶
    { id: 'p2', pinned: true, pinnedAt: T1 },
    { id: 'p1', pinned: true, pinnedAt: T2 },
    { id: 'old', createdAt: T0, lastUsedAt: T1 }
  ];
  assert.deepEqual(
    [...list].sort(compareSessionsByRail).map((r) => r.id),
    ['p1', 'p2', 'x', 'old'],
    '置顶按 pinnedAt 新的在上，其余按 lastUsedAt/createdAt 新的在上'
  );
}

// 回归守卫：capLaunchError 截断条件（曾在一批 diff 中被反转——短消息原样返回、长消息才截断；
// 反转回去会让每个短 launch error 挂「省略 -N 字符」负数后缀、长消息撑爆 SessionMeta.launchError）
{
  const sessionsSrc = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
  assert.match(
    sessionsSrc,
    /function capLaunchError[\s\S]*?msg\.length <= MAX_LAUNCH_ERROR_CHARS\) return msg;/,
    'capLaunchError 必须「短的原样返回」（<=），还原反转（>）即红'
  );
}

// ---------- session-model F-02：railFirstTerminalId（listForAgent 兜底复用左栏排序） ----------
{
  const { railFirstTerminalId } = await import(
    toFileUrl(compile('shared/workspaceActiveSession.ts')).href
  );
  const rows = [
    { id: 'se-old', type: 'terminal', archived: false, createdAt: T0, lastUsedAt: T1 }, // 列表序第一但最旧
    { id: 'se-pin', type: 'terminal', archived: false, pinned: true, pinnedAt: T1, createdAt: T0, lastUsedAt: T0 },
    { id: 'se-new', type: 'terminal', archived: false, createdAt: T3 },
    { id: 'se-arch', type: 'terminal', archived: true, pinned: true, pinnedAt: T3 }, // 归档不参与
    { id: 'se-sch', type: 'scheduled', archived: false, createdAt: T3 } // scheduled 不参与
  ];
  assert.equal(railFirstTerminalId(rows), 'se-pin', '置顶优先于更新时间');
  assert.equal(railFirstTerminalId(rows.filter((r) => r.id !== 'se-pin')), 'se-new', '无置顶取最新');
  assert.equal(railFirstTerminalId([]), null, '无候选 → null');
  // 接线守卫：listForAgent 兜底必须消费 railFirstTerminalId（还原回列表序 find 即红）
  const sessionsSrc = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
  assert.match(
    sessionsSrc,
    /railFirstTerminalId\(sessions\)/,
    'session-model F-02：listForAgent 兜底必须复用左栏排序（防回退成列表序 find）'
  );
}

console.log('workspace-active-restore: ok');
