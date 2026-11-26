/**
 * 悬浮输入条族质感守卫（2026-09-29）：
 * - 输入条 .chat-input-shell 与排队面板 .agent-composer-qspanel 同一族材质：--surface-input + --shadow-input；
 * - 输入条 focus 改中性描边、不带工作区色光晕；
 * - GUI 会话输入条下方使用实底遮挡滚动内容；
 *   GUI 会话与调度浮窗的输入条比阅读列略宽以盖住两侧头像；
 * - 左下工作区栈行保留不透明底，选中与列表共用哑光材质、无浮起投影；
 * - 排队行「立即」按钮的绿色规则须压过 .agent-composer-qsrow-actions button（曾因单类选择器被盖成灰色）。
 * 运行: node test/composer-material-css.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'styles');
const read = (f) => fs.readFileSync(path.join(stylesDir, f), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

function block(css, selector) {
  const i = css.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `应有 ${selector} 规则`);
  return css.slice(i, css.indexOf('}', i));
}

const base = read('base.css');
assert.match(base, /--input-surface:/, 'base.css :root 应定义 --input-surface');
assert.match(base, /--shadow-input:/, 'base.css :root 应定义 --shadow-input');
assert.match(
  base,
  /--input-surface:\s*var\(--surface-input\)/,
  '输入条始终使用实底'
);

const chat = read('chat.css');
const shell = block(chat, '.chat-input-shell');
assert.match(shell, /background:\s*var\(--surface-input\)/);
assert.match(shell, /border:\s*1px solid var\(--border-control\)/, '空态与填充态共用完整四边轮廓');
assert.doesNotMatch(shell, /border-top(?:-color)?:/, '输入壳不得单独重写顶边');
assert.match(shell, /box-shadow:\s*none/, '输入壳静息态无阴影');
assert.doesNotMatch(shell, /transition:[^;]*box-shadow/, '输入条不得过渡 box-shadow');
const focus = block(chat, '.chat-input-shell:focus-within');
assert.match(focus, /border-color:\s*var\(--input-focus-border\)/, '聚焦同时改变四边，不改变表面');
assert.doesNotMatch(focus, /background:|border-top(?:-color)?:/, '焦点不得让已填充输入区改变材质');
assert.doesNotMatch(focus, /--ws-accent|0 0 0 3px/, '聚焦不得出现工作区色光晕');

const float = read('float.css');
assert.match(block(float, '.send-btn-icon.stop-btn'), /background:\s*var\(--action-bg\)/, '终止钮与发送钮都使用同一项目动作色');
assert.match(block(float, '.agent-chat-clear-btn'), /background:\s*transparent/, '调度面板重置应为中性弱按钮');
assert.doesNotMatch(block(float, '.agent-chat-clear-btn'), /--ws-accent/, '重置不得使用工作区色');
const collapse = block(float, '.agent-chat-clear-btn.agent-panel-side-right');
assert.match(collapse, /background:\s*transparent/, '收起默认不应出现填充黑框');
assert.match(collapse, /border-color:\s*transparent/, '收起默认无常驻边框');
assert.doesNotMatch(collapse, /--ws-accent|color-mix/, '收起使用共享ghost颜色');
assert.doesNotMatch(block(float, '.agent-float-panel'), /--ws-accent/, '调度面板外壳保持中性');
const qs = block(float, '.agent-composer-qspanel');
assert.match(qs, /background:\s*transparent/, '排队区使用输入壳的实底');
assert.match(qs, /box-shadow:\s*none/, '队列不再单独浮起');
assert.match(block(base, ':root'), /--shadow-input:\s*none/, '默认去掉输入区内高光与阴影');
assert.doesNotMatch(float.slice(float.indexOf('.agent-composer-qspanel {'), float.indexOf('.agent-composer-qip-item-tools button {')), /var\(--green\)|var\(--status-success-fg\)/, '队列操作采用中性颜色');

const agentChat = read('agent-chat.css');
assert.doesNotMatch(agentChat, /\.chat-surface-view \.chat-input-shell:focus-within\s*\{/, '不覆盖共享焦点样式');
assert.doesNotMatch(agentChat, /\.agent-chat-view \.agent-chat-composer-wrap::before/, '输入条不再添加模糊层');
assert.match(block(agentChat, '.chat-surface-view'), /--composer-fade:\s*var\(--surface-canvas\)/, '输入条垫底使用工作面实底');
assert.doesNotMatch(agentChat, /composer-blurband/, '渐进模糊带已否决');

const widthRule = ':is(.agent-chat-view, .agent-float-panel) :is(.agent-chat-composer-wrap, .chat-history-pos)';
assert.match(agentChat, /\n\.agent-chat-view \.chat-list,\s*\n\.agent-float-panel \.chat-list \{/, '两处转写都常驻滚动条槽');
const wrap = block(agentChat, widthRule);
assert.match(wrap, /--composer-cover:\s*6px/, '输入条左右各比阅读列宽 6px（滚动条让列左移 4px 时也盖得住头像）');
assert.match(wrap, /width:\s*min\([\s\S]*var\(--chat-col-max,\s*760px\)\s*\+\s*2\s*\*\s*var\(--composer-cover\)/, 'wrap 宽 = 阅读列宽 + 两侧 cover');
assert.match(wrap, /100%\s*-\s*2\s*\*\s*var\(--composer-dock-inset\)/, '窄布局左右边距与底部一致');
assert.match(
  block(agentChat, '.agent-float-panel .chat-list'),
  /scrollbar-gutter:\s*stable/,
  '转写常驻滚动条槽，阅读列位置不随滚动条出现而左移'
);

const left = read('left.css');
assert.match(block(left, '.session-item.active,\n.utility-feature-item.active'), /background:\s*var\(--interaction-selected\)/);
assert.match(block(left, '.session-item.active,\n.utility-feature-item.active'), /box-shadow:\s*none/, '列表选中不应浮起');
const files = read('files.css');
assert.match(block(files, '.file-tree-row.is-active'), /background:\s*var\(--interaction-selected\)/);
assert.match(block(files, '.file-tree-row.is-active'), /box-shadow:\s*none/);
assert.match(block(files, '.files-panel .file-editor-main.is-reading-surface'), /background:\s*var\(--surface-canvas\)/, 'Markdown 与普通文本预览直接铺在工作面');
assert.doesNotMatch(files, /--bg-canvas:/, '编辑器颜色由resolved appearance直接发布，不再由外壳重写种子');
assert.doesNotMatch(block(left, '.left-ws-slot .agent-ws-stack-item.is-active .agent-notify-bubble'), /--ws-accent/);
assert.doesNotMatch(block(left, '.left-ws-slot .agent-ws-stack-item.is-chatting .agent-notify-bubble'), /--ws-accent/);
assert.doesNotMatch(fs.readFileSync(path.resolve(stylesDir, '../components/ChromeBar.tsx'), 'utf8'), /className="chrome-ws-dot"/, '顶栏工作区文字按钮不附带圆点');
const wsBubble = block(left, '.left-ws-slot .agent-notify-bubble');
assert.match(wsBubble, /background:\s*var\(--surface-frame\)/, '工作区栈行用框色实底兜住折叠重叠');
assert.match(block(left, '.left-ws-slot .agent-notify-bubble::before'), /background:\s*var\(--interaction-hover\)/, '工作区普通态与实用功能共用叠层');
assert.match(block(left, '.left-ws-slot .agent-ws-stack-item.is-active .agent-notify-bubble::before'), /background:\s*var\(--interaction-selected\)/, '工作区选中态与实用功能共用叠层');
assert.match(wsBubble, /box-shadow:\s*none/, '工作区栈行应去浮起投影');
assert.doesNotMatch(wsBubble, /transition:[^;]*box-shadow/, '禁止 box-shadow 过渡（动画规约）');
assert.match(
  block(left, '.left-ws-slot .agent-ws-stack-item.is-chatting .agent-notify-bubble'),
  /box-shadow:\s*none/,
  '对话中也不恢复浮起投影'
);

const stackCollapse = block(left, '.left-ws-slot .agent-ws-stack-item.is-chatting .agent-notify-chat');
assert.match(stackCollapse, /box-shadow:\s*none/, '栈行收起不能出现第二套边框');
assert.doesNotMatch(stackCollapse, /background:|inset|border:/, '栈行收起不因展开态变成独立卡片');
assert.match(block(left, '.session-capsule'), /background:\s*var\(--status-neutral-bg\)/, '所有胶囊共用resolved状态背景');
assert.match(block(left, '.session-rail-status'), /background:\s*var\(--status-neutral-bg\)/, '单行胶囊保持共享状态背景');
assert.match(block(left, '.session-capsule.dim'), /opacity:\s*1/, '退出态标签仍应可读');
assert.doesNotMatch(left, /\.left-panel \.session-item\.is-pane-focused,\s*\.left-panel \.utility-feature-item\.is-pane-focused\s*\{[^}]*outline:/, '当前pane不应永久占用键盘焦点描边');
assert.match(left, /\.session-item\.is-pane-focused::after/, '当前pane保留小型位置标记');
assert.doesNotMatch(chat, /--ws-accent/, '默认消息头像不染工作区色');
const split = read('split.css');
assert.match(block(split, '.center-split-divider > span'), /background:\s*var\(--divider-rest\)/);
assert.match(block(split, ".center-split-divider[aria-orientation='vertical'] > span"), /width:\s*1px/, 'divider视觉宽度不随hover放大');
assert.match(block(split, '.center-split-divider:hover > span'), /background:\s*var\(--divider-active\)/);
assert.doesNotMatch(block(split, '.center-split-divider:hover > span'), /box-shadow|width:/, 'hover不应增粗或发光');
const leftDivider = block(base, '.left-col-resizer::after');
assert.match(leftDivider, /width:\s*1px\s*;/, '左栏拖动视觉也严格为1px，命中区单独保留');
assert.doesNotMatch(leftDivider, /box-shadow:|filter:/, '左栏分割线不应带光晕');
const leftDividerActive = block(base, '.left-col-resizer:hover::after,\n.left-col-resizer.is-resizing::after');
assert.match(leftDividerActive, /background:\s*var\(--divider-active\)/, '左栏 hover/拖动与虚拟屏使用同一 divideractive');
assert.doesNotMatch(leftDividerActive, /width:|box-shadow:|filter:/, '左栏 hover/拖动不能增粗或发光');
assert.match(block(base, '.left-col-resizer:focus-visible::after'), /background:\s*var\(--divider-focus\)/, '键盘焦点使用独立 dividerfocus');

console.log('composer-material-css: ok');
