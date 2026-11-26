/**
 * 全局看板「左上角热区驻留自动展开」移除守卫（2026-09-25，误触下线）。
 * 运行: node test/hot-corner-removed.mjs
 *
 * 全局看板唤出方式收敛为：顶栏按钮 / 鼠标中键 / 快捷键 / 探出条点击。
 * 旧交互是盖在窗口左上角的 no-drag L 形热区（.top-left-hot-corner）+
 * 驻留 280ms 自动展开（armed 重武装），因老是误触整体移除。
 * 若有人还原该交互（热区 JSX / 驻留逻辑 / 样式 / 提示文案任一回归），此用例转红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// 1) 渲染层不得再有热区实现痕迹
const app = read('src', 'renderer', 'src', 'App.tsx');
assert.ok(!app.includes('top-left-hot-corner'), 'App.tsx 不应再有 .top-left-hot-corner 热区 JSX');
assert.ok(!app.includes('TOP_LEFT_CORNER_HOVER_MS'), 'App.tsx 不应再有热区驻留时长常量');
assert.ok(
  !app.includes('topHotArmedRef') && !app.includes('topHotTimerRef') && !app.includes('onTopHotEnter'),
  'App.tsx 不应再有热区武装态/计时/进入回调'
);

const css = read('src', 'renderer', 'src', 'styles', 'board.css');
assert.ok(!css.includes('top-left-hot-corner'), 'board.css 不应再有热区样式');

// 2) 文案不再提示「移到窗口左上角也可开关」
const chromeBar = read('src', 'renderer', 'src', 'components', 'ChromeBar.tsx');
assert.ok(!chromeBar.includes('左上角也可开关'), 'ChromeBar tooltip 不应再提示左上角可开关');
const en = read('src', 'shared', 'i18n', 'locales', 'en.ts');
assert.ok(!en.includes('top-left corner'), 'en.ts 不应再有 top-left corner 英文文案');

// 3) 其余唤出方式仍在：中键 toggle、顶栏按钮
assert.ok(app.includes('e.button !== 1'), 'App.tsx 中键 toggle 监听应保留');
assert.ok(chromeBar.includes('onToggleGlobalBoard'), 'ChromeBar 顶栏按钮入口应保留');

console.log('hot-corner-removed: OK');
