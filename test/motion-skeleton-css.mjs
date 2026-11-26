/**
 * 动效骨架静态守卫（docs/plans/motion-fixes-plan.md）：
 * - .xfade「先出后入」：旧视图 --dur-micro + --ease-exit 淡出，新视图 --dur-panel 延迟 micro/2 淡入
 *   （恢复同时交叉淡化会叠字）；
 * - .xfade-instant 去过渡（会话实例瞬切），TerminalView / AgentChatView 挂上它；
 * - .acc 收起走退场档；
 * - styles 下无字面量时长（reduced-motion 兜底的 0.01ms / 0s 除外）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBody = (css, selectorRe) => [...css.matchAll(new RegExp(`(?:^|\\n)${selectorRe}\\s*\\{([^}]*)\\}`, 'g'))].map(match => match[1]).join('\n') || undefined;

const base = strip(read('src/renderer/src/styles/base.css'));

const xfade = ruleBody(base, '\\.xfade');
assert.ok(xfade, '找不到 .xfade 规则');
assert.match(xfade, /opacity var\(--dur-micro\) var\(--ease-exit\)/, '.xfade 退出须 --dur-micro + --ease-exit');
assert.match(xfade, /visibility 0s linear var\(--dur-micro\)/, 'visibility 须在淡出结束后才切');

const shown = ruleBody(base, '\\.xfade\\.is-shown');
assert.ok(shown, '找不到 .xfade.is-shown 规则');
assert.match(
  shown,
  /opacity var\(--dur-panel\) var\(--ease-standard\) calc\(var\(--dur-micro\) \/ 2\)/,
  '.xfade.is-shown 须延迟 micro/2 再入场（先出后入）'
);

assert.match(
  base,
  /\.xfade\.xfade-instant,\s*\.xfade\.xfade-instant\.is-shown\s*\{\s*transition:\s*none;?\s*\}/,
  '.xfade-instant 须两态都去过渡'
);
for (const rel of [
  'src/renderer/src/components/TerminalView.tsx',
  'src/renderer/src/agentChat/AgentChatView.tsx'
]) {
  assert.match(read(rel), /xfade xfade-instant/, `${rel} 会话视图须挂 xfade-instant（会话切换瞬切）`);
}

const accClosed = ruleBody(base, '\\.acc:not\\(\\.is-open\\)');
assert.ok(accClosed, '找不到 .acc:not(.is-open) 规则');
assert.match(accClosed, /transition-duration:\s*var\(--dur-exit\)/, '.acc 收起须走 --dur-exit');
assert.match(accClosed, /transition-timing-function:\s*var\(--ease-exit\)/, '.acc 收起须走 --ease-exit');

const board = strip(read('src/renderer/src/styles/board.css'));
// The board uses interruptible presence transitions; the former keyframe classes are retired.
const flyPanel = ruleBody(base, '\\.mp-panel-fly');
assert.ok(flyPanel, '找不到飞入面板骨架');
assert.match(flyPanel, /transition:\s*transform var\(--dur-panel\) var\(--ease-standard\);/, '飞入面板只过渡位移');
const flyExit = ruleBody(base, "\\.mp-panel-fly\\[data-mp-stage='out'\\]");
assert.ok(flyExit, '找不到飞入面板的退场规则');
assert.match(flyExit, /opacity:\s*1;/, '飞入面板退场期间保持实底');
assert.match(flyExit, /transition-duration:\s*var\(--dur-exit\)/, '飞入面板退场须走退出档');
assert.match(flyExit, /transition-timing-function:\s*var\(--ease-exit\)/, '飞入面板退场须走退出曲线');
const boardSource = read('src/renderer/src/panels/GlobalBoard.tsx');
assert.match(boardSource, /g-board-sheet mp-panel mp-panel-fly/, '看板使用共用的飞入面板骨架');
assert.match(boardSource, /usePresence\(open \|\| visiblePeek\)/, '看板开合须使用 presence');
assert.match(boardSource, /\.\.\.presence\.spread/, '看板须接入 presence 阶段属性');
assert.doesNotMatch(board, /animation:\s*g-board-(?:in|expand)\b/, '不得恢复不可中断的开合 keyframes');

const stylesDir = path.join(root, 'src/renderer/src/styles');
const decl = /(?:^|[;{\s])((?:animation|transition)(?:-duration|-delay)?)\s*:([^;{}]*)/g;
const timeLiteral = /(?<![\w-])(\d*\.?\d+)m?s\b/g;
const offenders = [];
for (const file of fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css'))) {
  const css = strip(fs.readFileSync(path.join(stylesDir, file), 'utf8'));
  for (const d of css.matchAll(decl)) {
    for (const t of d[2].matchAll(timeLiteral)) {
      if (/^0?\.01$|^0$/.test(t[1])) continue;
      offenders.push(`${file}: ${d[1]}:${d[2].trim().slice(0, 90)}`);
    }
  }
}
assert.deepEqual(offenders, [], `styles 下有字面量时长（改用 --dur-* token）：\n${offenders.join('\n')}`);

console.log('motion-skeleton-css ok');
