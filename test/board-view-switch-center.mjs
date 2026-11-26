/**
 * ⑥ 全局看板工具栏「状态/自由」切换控件居中守卫（回归 2026-10-06 用户报单）。
 *
 * 布局改动把 .board-view-switch 从绝对居中改为流式布局，
 * 并给标题 div 加 margin-right: auto——切换器被推到右侧（实测中心偏右 96.5px）。
 * 修复：两侧等弹性 flank（标题 flex:1、操作区 flex:1 + justify-content: flex-end），
 * 单行时切换器几何居中，窄容器换行仍成立。
 *
 * 视觉/几何证据见 .tmp/review-ui-five（switchCenterOffsetFromToolbarCenter），
 * 本守卫锁 CSS 形态不被再次改回「标题 margin-right:auto 推右」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles/board.css'), 'utf8');

function blockOf(selector, source = css) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `board.css 缺少规则 ${selector}`);
  // 处理同行复合选择器（.a,\n.b { } 形式取整段）
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return source.slice(start, end);
}

// 1) 标题列：minmax(0,1fr) 等宽侧列保证切换器几何居中；不得用 margin-right:auto 推右
const toolbar = blockOf('.board-toolbar');
assert.ok(
  /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/.test(toolbar),
  `.board-toolbar 应为 grid 1fr auto 1fr（两侧列严格等宽，切换器几何居中；flex 等分 grow 在两侧内容宽不等时会偏，实测偏 145px）。当前：\n${toolbar}`
);
const titleFlank = blockOf('.board-toolbar > div:first-child');
assert.ok(
  !/margin-right:\s*auto/.test(titleFlank),
  `.board-toolbar > div:first-child 不得用 margin-right:auto（会把切换器推到右侧）。当前：\n${titleFlank}`
);

// 2) 管理操作区靠右，窄容器横向滚动而不撑高工具栏
const actions = blockOf('.board-management-actions');
assert.ok(
  /margin-left:\s*auto/.test(actions) && /flex-wrap:\s*nowrap/.test(actions),
  `管理操作区应右对齐并保持单行。当前：\n${actions}`
);
assert.match(blockOf('.board-management'), /overflow-x:\s*auto/);
assert.match(toolbar, /height:\s*60px/);

// 3) 切换器保持流内（不绝对定位），不抢弹性
const viewSwitch = blockOf('.board-toolbar .board-view-switch');
assert.ok(
  !/position:\s*absolute/.test(viewSwitch),
  `.board-view-switch 不应回到绝对定位居中（窄容器会与标题/操作区重叠）。当前：\n${viewSwitch}`
);

console.log('board-view-switch-center: 切换控件居中 CSS 形态守卫通过');
