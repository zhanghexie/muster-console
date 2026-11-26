/**
 * 左栏连续框面守卫。
 * 运行: node test/left-card-css.mjs
 *
 * 左栏直接连框、列表区独立滚动、栈在滚动区外不垫底。若有人还原垫底 / 把栈放回滚动区 / 把 backdrop-filter 挂回卡片本体
 * （会让 .feishu-bind-hint 等 fixed 后代被困进卡片），此用例转红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const css = read('src', 'renderer', 'src', 'styles', 'left.css');

function block(selector) {
  const i = css.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `left.css 应有 ${selector} 规则`);
  return css.slice(i, css.indexOf('}', i));
}

// 1) 工作区栈槽位不垫底、不钉底；宽度与左栏解耦（展开栈不得撑宽会话列表）
const slot = block('.left-ws-slot');
assert.ok(!/background/.test(slot), '.left-ws-slot 不得垫底色（半透明卡片上会显成色块）');
assert.ok(!/position:\s*sticky/.test(slot), '.left-ws-slot 不再 sticky（已在滚动区外）');
assert.ok(/contain:\s*inline-size/.test(slot), '.left-ws-slot 须 contain:inline-size（切断浮层/长名 min-content 撑栏）');
assert.ok(/min-width:\s*0/.test(slot), '.left-ws-slot 须 min-width:0');
assert.ok(/max-width:\s*100%/.test(slot), '.left-ws-slot 须 max-width:100%');
assert.ok(!/overflow-x:/.test(slot), '.left-ws-slot 不得写 overflow-x（会把 overflow-y 算成 auto，裁掉折叠露边）');

// 2) 宽屏左栏连框，窄屏抽屉保持浮层材质
const panel = block('.left-panel');
assert.ok(!/backdrop-filter/.test(panel), '.left-panel 本体不得挂 backdrop-filter（fixed 后代会被困进卡片）');
assert.ok(/border-radius:\s*0/.test(panel), '.left-panel 不应再有独立卡片圆角');
assert.ok(!/overflow-y:\s*auto/.test(panel), '.left-panel 本体不滚动');
assert.ok(/background:\s*transparent/.test(block('.left-panel::before')), '宽屏左栏应透出框');
const group = block('.left-section-scroll');
assert.match(group, /flex:\s*none/, '分组按自然内容高度排列');
assert.match(group, /min-width:\s*0/, '分组列表须 min-width:0');
assert.doesNotMatch(group, /overflow(?:-y)?:\s*(?:auto|scroll)/, '分组不创建嵌套滚动容器');
const scroll = [...css.matchAll(/\.left-panel-scroll\s*\{([^{}]*)\}/g)].map(match => match[1]).join('\n');
assert.match(scroll, /overflow-y:\s*auto/, '工作会话与终端由外层统一滚动');
assert.match(scroll, /overflow-x:\s*hidden/, '滚动区限制横向溢出');
assert.match(scroll, /scrollbar-width:\s*none/, '滚动区不占用滚动条槽宽');
const item = block('.left-ws-slot .agent-ws-stack-item');
assert.match(item, /--ws-bubble:\s*100%/, '槽位内切断浮层 --sessions-col-w 公式宽');
assert.match(item, /max-width:\s*100%/, '槽位胶囊不得 max-width:none 把父栏撑开');

// 3) 结构：栈槽位在滚动区之外（LeftPanel.tsx 中滚动区先闭合，槽位在后）
const tsx = read('src', 'renderer', 'src', 'panels', 'LeftPanel.tsx');
const open = tsx.indexOf('<div className="left-panel-scroll"');
const slotAt = tsx.indexOf('<div className="left-ws-slot"');

assert.ok(tsx.indexOf('<UtilityNavigationSection') < open, '实用工具在分组列表滚动区外');
assert.ok(open > 0 && slotAt > open, 'LeftPanel 应有分组滚动区且槽位在其后');
const between = tsx.slice(open, slotAt);
assert.equal((between.match(/className=\{`left-section-scroll/g) || []).length, 2, '工作会话与终端同在外层滚动区');
const depth = (between.match(/<div\b/g) || []).length - (between.match(/<\/div>/g) || []).length;
assert.equal(depth, 0, '.left-ws-slot 必须在外层滚动区闭合之后');

// 4) 宿主只留框缝不裁剪：卡片投影要落进缝里
const col = block('.sessions-column');
assert.ok(!/overflow:\s*hidden/.test(col), '.sessions-column 不得裁剪（会硬切卡片投影）');
assert.ok(!/overflow:\s*hidden/.test(block('.sessions-float')), '.sessions-float 不得裁剪（会硬切悬浮卡投影）');

// 名称/胶囊保持单行，详情改为独立 portal 卡片。
assert.ok(!css.includes('.session-rail-status-expanded'), '不得恢复旧胶囊展开层');
assert.ok(/max-width:\s*50%/.test(block('.session-rail-status')), '长状态给会话名称保留空间');
assert.ok(/position:\s*fixed/.test(block('.session-details-card')), '详情卡独立于列表裁切层');
assert.ok(/pointer-events:\s*auto/.test(block('.session-details-card')), '详情卡可悬浮保活并操作复制按钮');
assert.ok(/(?:^|[;\s])user-select:\s*none/.test(block('.session-details-card')), '详情卡禁止框选，避免触发被浮层遮挡的文字操作面板');
assert.ok(/border-radius:\s*var\(--radius-pill\)/.test(block('.session-details-summary')), '详情状态文案使用胶囊形状');
assert.ok(/padding:\s*10px 12px/.test(block('.session-details-summary')), '详情状态文案保留原有内边距与高度');
console.log('left-card-css: OK');
