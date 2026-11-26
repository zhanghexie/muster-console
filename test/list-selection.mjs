/**
 * 列表多选纯逻辑（shared/listSelection.ts）语义测试：
 * Ctrl/⌘ 切换、Shift 范围（含 Ctrl+Shift 并集）、锚点跨点击保持、
 * Shift+方向键扩展、Ctrl+A、数据变化剪枝、批量删除的祖先路径吸收。
 * 运行: node test/list-selection.mjs（npm test 自动带上）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'list-selection-'));
const compile = createSharedCompiler(root, tmp);
const {
  EMPTY_LIST_SELECTION,
  selectionClick,
  extendSelection,
  selectAll,
  pruneSelection,
  removeCoveredPaths,
  idRange
} = await import(pathToFileURL(compile('shared/listSelection.ts')));
fs.rmSync(tmp, { recursive: true, force: true });

const IDS = ['a', 'b', 'c', 'd', 'e'];
const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const ctrlShift = { ctrl: true, shift: true };

// ── selectionClick ──

// 普通点击：清空选区、锚点移动
{
  let s = selectionClick(EMPTY_LIST_SELECTION, 'a', ctrl, IDS).state;
  assert.equal(s.ids.size, 1);
  const r = selectionClick(s, 'c', plain, IDS);
  assert.equal(r.mode, 'plain');
  assert.equal(r.state.ids.size, 0);
  assert.equal(r.state.anchorId, 'c');
}

// Ctrl 切换：加/减，锚点随点击移动
{
  let s = selectionClick(EMPTY_LIST_SELECTION, 'a', ctrl, IDS).state;
  s = selectionClick(s, 'c', ctrl, IDS).state;
  assert.deepEqual([...s.ids], ['a', 'c']);
  assert.equal(s.anchorId, 'c');
  s = selectionClick(s, 'a', ctrl, IDS).state;
  assert.deepEqual([...s.ids], ['c'], 'ctrl 再点已选项应移除');
  // 切掉最后一项后选区为空，锚点仍在
  s = selectionClick(s, 'c', ctrl, IDS).state;
  assert.equal(s.ids.size, 0);
  assert.equal(s.anchorId, 'c');
}

// Shift 范围：锚点到点击项闭区间，反向也成立；锚点保持不动
{
  let s = selectionClick(EMPTY_LIST_SELECTION, 'b', plain, IDS).state; // 锚点 b
  s = selectionClick(s, 'd', shift, IDS).state;
  assert.deepEqual([...s.ids], ['b', 'c', 'd']);
  assert.equal(s.anchorId, 'b', 'shift 后锚点应保持');
  // 再 shift 回 a：反向范围
  s = selectionClick(s, 'a', shift, IDS).state;
  assert.deepEqual([...s.ids], ['a', 'b']);
  assert.equal(s.anchorId, 'b');
}

// Shift 无锚点：退化为单项
{
  const r = selectionClick(EMPTY_LIST_SELECTION, 'c', shift, IDS);
  assert.equal(r.mode, 'range');
  assert.deepEqual([...r.state.ids], ['c']);
  assert.equal(r.state.anchorId, 'c');
}

// Ctrl+Shift：范围并入现有选区
{
  let s = selectionClick(EMPTY_LIST_SELECTION, 'a', ctrl, IDS).state; // {a}
  s = selectionClick(s, 'd', ctrlShift, IDS).state;
  assert.deepEqual([...s.ids], ['a', 'b', 'c', 'd'], 'ctrl+shift 应并集');
}

// idRange：端点不在序列时退化为 [toId]
{
  assert.deepEqual(idRange('x', 'c', IDS), ['c']);
  assert.deepEqual(idRange('a', 'x', IDS), ['x']);
  assert.deepEqual(idRange('e', 'a', IDS), ['a', 'b', 'c', 'd', 'e']);
}

// ── extendSelection（Shift+方向键）──

// 无锚点：以当前焦点为锚，选中焦点→目标
{
  const s = extendSelection(EMPTY_LIST_SELECTION, 'c', IDS, false);
  assert.deepEqual([...s.ids], ['c']);
  assert.equal(s.anchorId, 'c');
}
// 有锚点：范围=锚点→目标
{
  let s = { ids: new Set(), anchorId: 'b' };
  s = extendSelection(s, 'd', IDS, false);
  assert.deepEqual([...s.ids], ['b', 'c', 'd']);
  assert.equal(s.anchorId, 'b');
  // additive 并入
  s = { ids: new Set(['a']), anchorId: 'b' };
  s = extendSelection(s, 'c', IDS, true);
  assert.deepEqual([...s.ids], ['a', 'b', 'c']);
}

// ── selectAll ──
{
  let s = selectAll(EMPTY_LIST_SELECTION, IDS);
  assert.equal(s.ids.size, 5);
  assert.equal(s.anchorId, 'a', '无锚点时全选把锚点落到首行');
  // 已有锚点保持
  s = selectAll({ ids: new Set(), anchorId: 'd' }, IDS);
  assert.equal(s.anchorId, 'd');
}

// ── pruneSelection ──
{
  const s = { ids: new Set(['a', 'x']), anchorId: 'x' };
  const next = pruneSelection(s, new Set(['a', 'b']));
  assert.deepEqual([...next.ids], ['a'], '消失项被剪掉');
  assert.equal(next.anchorId, null, '失效锚点置空');
  // 无变化时同引用返回（React 跳过渲染）
  const same = pruneSelection(next, new Set(['a', 'b']));
  assert.equal(same, next);
}

// ── removeCoveredPaths：祖先目录吸收子路径 ──
{
  assert.deepEqual(removeCoveredPaths(['a', 'a/b.ts', 'c.ts']), ['a', 'c.ts']);
  assert.deepEqual(removeCoveredPaths(['a/b/c.ts', 'a', 'x.ts']), ['a', 'x.ts']);
  // 兄弟目录不吸收
  assert.deepEqual(removeCoveredPaths(['a/b.ts', 'ab/c.ts']).sort(), ['a/b.ts', 'ab/c.ts']);
  // 反斜杠归一
  assert.deepEqual(removeCoveredPaths(['a\\b.ts', 'a']), ['a']);
  // 空串被过滤（根不入集）
  assert.deepEqual(removeCoveredPaths(['', 'a.ts']), ['a.ts']);
  // 单项原样返回
  assert.deepEqual(removeCoveredPaths(['a/b.ts']), ['a/b.ts']);
}

console.log('list-selection: all assertions passed');
