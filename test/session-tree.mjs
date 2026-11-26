/**
 * 会话父子链（子代理通用化）：深度计算与树构建回归。
 * 运行: node test/session-tree.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(root, fs.mkdtempSync(path.join(os.tmpdir(), 'session-tree-')));
const mod = await import(`file://${compile('shared/sessionTree.ts').replace(/\\/g, '/')}`);
const {
  buildSessionTree,
  breakParentCycles,
  canSpawnChild,
  countChildSessions,
  flattenSessionTree,
  sessionDepth,
  sessionAncestry,
  sessionDepthLabel
} = mod;

test('后代清理叶子优先，包含归档子，子操作不向上扩散，成环不死循环', () => {
  const rows = [{ id: 'p' }, { id: 'c', parentSessionId: 'p' }, { id: 'g', parentSessionId: 'c', archived: true }, { id: 'other' }];
  assert.deepEqual(mod.sessionSubtreePostOrder(rows, 'p').map(s => s.id), ['g', 'c', 'p']);
  assert.deepEqual(mod.sessionSubtreePostOrder(rows, 'c').map(s => s.id), ['g', 'c']);
  assert.deepEqual(mod.sessionSubtreePostOrder(rows, 'missing'), []);
  assert.equal(mod.sessionSubtreePostOrder([{ id: 'p', parentSessionId: 'c' }, { id: 'c', parentSessionId: 'p' }], 'p').length, 2);
});

const lookupOf = (list) => {
  const map = new Map(list.map((s) => [s.id, s]));
  return (id) => map.get(id);
};

test('顶层会话深度为 1', () => {
  assert.equal(sessionDepth({ id: 'a' }, lookupOf([{ id: 'a' }])), 1);
});

test('子代理深度为 2，孙代理为 3', () => {
  const list = [{ id: 'a' }, { id: 'b', parentSessionId: 'a' }, { id: 'c', parentSessionId: 'b' }];
  const lk = lookupOf(list);
  assert.equal(sessionDepth(list[1], lk), 2);
  assert.equal(sessionDepth(list[2], lk), 3);
});

test('有效父子链不受固定三层限制', () => {
  const list = [
    { id: 'a' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'b' },
    { id: 'd', parentSessionId: 'c' }
  ];
  const lk = lookupOf(list);
  assert.equal(canSpawnChild(list[0], lk), true);
  assert.equal(canSpawnChild(list[1], lk), true);
  assert.equal(canSpawnChild(list[2], lk), true, '孙代理可继续创建普通子会话');
  assert.equal(sessionDepth(list[3], lk), 4, '深度应反映真实链');
  const deep = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, ...(i ? { parentSessionId: `d${i - 1}` } : {}) }));
  assert.equal(sessionDepth(deep.at(-1), lookupOf(deep)), 50);
  assert.equal(canSpawnChild(deep.at(-1), lookupOf(deep)), true);
});

test('断链按上限收敛，不当作顶层放行', () => {
  const orphan = { id: 'x', parentSessionId: 'missing' };
  const lk = lookupOf([orphan]);
  assert.equal(sessionDepth(orphan, lk), Infinity);
  assert.equal(canSpawnChild(orphan, lk), false);
});

test('自环与互环不导致死循环', () => {
  const self = { id: 's', parentSessionId: 's' };
  assert.equal(sessionDepth(self, lookupOf([self])), Infinity);
  const pair = [{ id: 'p', parentSessionId: 'q' }, { id: 'q', parentSessionId: 'p' }];
  const lk = lookupOf(pair);
  for (const s of pair) assert.equal(sessionDepth(s, lk), Infinity);
});

test('层级展示名', () => {
  assert.equal(sessionDepthLabel(1), '会话');
  assert.equal(sessionDepthLabel(2), '子代理');
  assert.equal(sessionDepthLabel(3), '孙代理');
  assert.equal(sessionDepthLabel(4), '第4层子代理');
});

test('树构建：子挂父下，level 逐层递增', () => {
  const list = [
    { id: 'a', name: 'A' },
    { id: 'b', parentSessionId: 'a', name: 'B' },
    { id: 'c', parentSessionId: 'b', name: 'C' },
    { id: 'd', name: 'D' }
  ];
  const tree = buildSessionTree(list);
  assert.equal(tree.length, 2, '两个顶层：A 与 D');
  assert.equal(tree[0].level, 0);
  assert.equal(tree[0].children[0].session.id, 'b');
  assert.equal(tree[0].children[0].level, 1);
  assert.equal(tree[0].children[0].children[0].session.id, 'c');
  assert.equal(tree[0].children[0].children[0].level, 2);
});

test('父被过滤时子提升为顶层（不消失）', () => {
  const list = [
    { id: 'a', archived: true },
    { id: 'b', parentSessionId: 'a' }
  ];
  const tree = buildSessionTree(list, { include: (s) => !s.archived });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].session.id, 'b', '子提升为顶层');
  assert.equal(tree[0].level, 0);
});

test('buildSessionTree 内部自愈环：x→y→x 不整枝消失', () => {
  // 回归：环若不在建树时自愈，x 与 y 会互为 children 且都不在 roots，整对从列表消失
  const tree = buildSessionTree([
    { id: 'x', parentSessionId: 'y' },
    { id: 'y', parentSessionId: 'x' }
  ]);
  const ids = tree.map((n) => n.session.id);
  assert.ok(ids.includes('x'), 'x 必须可见');
  assert.ok(ids.includes('y'), 'y 必须可见');
});

test('buildSessionTree 自愈环时保留挂在环上的第三方子', () => {
  const tree = buildSessionTree([
    { id: 'x', parentSessionId: 'y' },
    { id: 'y', parentSessionId: 'x' },
    { id: 'z', parentSessionId: 'x' }
  ]);
  const flat = flattenSessionTree(tree).map((r) => r.session.id);
  for (const id of ['x', 'y', 'z']) assert.ok(flat.includes(id), `${id} 必须可见`);
});

test('展平：折叠父时整枝跳过（含孙层）', () => {
  const list = [
    { id: 'a' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'b' },
    { id: 'd', parentSessionId: 'a' }
  ];
  const tree = buildSessionTree(list);
  const flat = flattenSessionTree(tree);
  assert.deepEqual(flat.map((r) => r.session.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(flat.map((r) => r.level), [0, 1, 2, 1]);

  // 折叠 b → b 自身仍渲染，其子树 c 消失，兄弟 d 保留
  const collapsed = flattenSessionTree(tree, { collapsed: new Set(['b']) });
  assert.deepEqual(collapsed.map((r) => r.session.id), ['a', 'b', 'd']);
});

test('展平：折叠顶层时其整枝消失，其他顶层保留', () => {
  const list = [{ id: 'a' }, { id: 'b', parentSessionId: 'a' }, { id: 'z' }];
  const collapsed = flattenSessionTree(buildSessionTree(list), { collapsed: new Set(['a']) });
  assert.deepEqual(collapsed.map((r) => r.session.id), ['a', 'z']);
});

test('子节点计数用于 twisty 判定', () => {
  const list = [
    { id: 'a' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'a' },
    { id: 'z' }
  ];
  const counts = countChildSessions(buildSessionTree(list));
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.has('z'), false);
});

test('环数据经 breakParentCycles 后可正常建树', () => {
  const broken = breakParentCycles([
    { id: 'a', parentSessionId: 'b' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'a' }
  ]);
  const tree = buildSessionTree(broken);
  const ids = tree.map((n) => n.session.id);
  assert.ok(ids.includes('a'), '环起点提升为顶层');
  assert.ok(ids.includes('b'), '另一环成员仍可见');
  const aNode = tree.find((n) => n.session.id === 'a');
  assert.equal(aNode.children.length, 1);
  assert.equal(aNode.children[0].session.id, 'c');
});

test('自定义排序：顶层与子会话各自排序', () => {
  const list = [
    { id: 'a', rank: 2 },
    { id: 'b', parentSessionId: 'a', rank: 9 },
    { id: 'c', parentSessionId: 'a', rank: 1 },
    { id: 'z', rank: 1 }
  ];
  const tree = buildSessionTree(list, {
    compareRoots: (x, y) => x.rank - y.rank,
    compareChildren: (x, y) => x.rank - y.rank
  });
  assert.deepEqual(tree.map((n) => n.session.id), ['z', 'a']);
  assert.deepEqual(tree[1].children.map((n) => n.session.id), ['c', 'b']);
});

test('自环会话提升为顶层', () => {
  const tree = buildSessionTree([{ id: 's', parentSessionId: 's' }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].level, 0);
});

// —— 祖先链（层级路径面包屑用）——
test('祖先链：自根到自身，顺序由根到叶', () => {
  const byId = new Map([
    ['a', { id: 'a' }],
    ['a1', { id: 'a1', parentSessionId: 'a' }],
    ['a1a', { id: 'a1a', parentSessionId: 'a1' }]
  ]);
  const chain = sessionAncestry('a1a', byId);
  assert.deepEqual(chain.map((s) => s.id), ['a', 'a1', 'a1a']);
});

test('祖先链：顶层会话的链只有自己', () => {
  const byId = new Map([['a', { id: 'a' }]]);
  assert.deepEqual(sessionAncestry('a', byId).map((s) => s.id), ['a']);
});

test('祖先链：父不在索引内时链到此为止（不崩、不猜）', () => {
  const byId = new Map([['kid', { id: 'kid', parentSessionId: 'gone' }]]);
  assert.deepEqual(sessionAncestry('kid', byId).map((s) => s.id), ['kid']);
});

test('祖先链：成环数据不死循环', () => {
  const byId = new Map([
    ['x', { id: 'x', parentSessionId: 'y' }],
    ['y', { id: 'y', parentSessionId: 'x' }]
  ]);
  const chain = sessionAncestry('x', byId);
  assert.ok(chain.length <= 2, '环里最多各出现一次');
  assert.equal(new Set(chain.map((s) => s.id)).size, chain.length, '无重复');
});

test('祖先链：会话不存在时返回空', () => {
  assert.deepEqual(sessionAncestry('nope', new Map()), []);
});
