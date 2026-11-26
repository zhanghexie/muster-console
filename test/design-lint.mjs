/**
 * design-lint：design.md 落地守门（防止「改了主 token 漏改镜像/残留旧值」类遗漏）。
 * 覆盖五类失败模式（均来自真实踩坑）：
 *   1. 圆角纪律：border-radius 只许 token/微档，禁止 var(--radius-nested) 与乱写像素
 *   2. 选中指示条：禁止 inset 2px 描边与普通选中竖条；当前分屏与工作区使用受约束的短标记
 *   3. 旧调色板残留：旧 token 十六进制值（含 %23 编码）一律报错
 *   4. token 镜像同步：扩展 SDK theme.css / 工作日报 panel.html 必须与 base.css 同值
 *   5. 主进程窗口色同步：titleBarOverlay 必须等于 --bg-frame/--ink
 * 运行：node test/design-lint.mjs（npm test 自动包含）
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesDir = path.join(root, 'src/renderer/src/styles');
const dailyReportPanel = path.join(root, 'resources/extensions/daily-report/ui/panel.html');
assert.ok(fs.existsSync(dailyReportPanel), '内置日报的发布源码必须存在');
const violations = [];
const v = (msg) => violations.push(msg);

/* ---------- 0. 解析 base.css :root token ---------- */
const baseCss = fs.readFileSync(path.join(stylesDir, 'base.css'), 'utf8');
const rootBlock = baseCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const tokens = {};
for (const m of rootBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  tokens[m[1]] = m[2].trim();
}

/* ---------- 1. 圆角纪律 ---------- */
const RADIUS_VAR_OK = /^var\(--radius-(page|control|card|modal|pill|small|composer|chat-card)\)$/;
const RADIUS_ATOM_OK = /^(0|1px|2px|4px|50%|999px|inherit)$/;
const RADIUS_EXPRESSIONS = new Set([
  'calc(var(--radius-chat-card) - 1px)',
  'calc(var(--radius-small) / 2)',
  'var(--filter-popover-radius, var(--radius-card))',
  'max(0px, calc(var(--radius-card) - var(--board-list-inset, 6px)))',
  'max(0px, calc(var(--radius-page) - 2px))',
  // 看板工作区表头嵌在 1px 描边的组框内（docs/features/global-board.md §布局）：
  // 半径按外框边框内缩 1px，否则顶部两角盖不住描边内缘。
  'calc(var(--radius-card) - 1px)'
]);
function allowedRadiusAtom(atom, file) {
  return RADIUS_VAR_OK.test(atom) || RADIUS_ATOM_OK.test(atom) || RADIUS_EXPRESSIONS.has(atom) ||
    file === 'mail-envelope.css' && atom === 'var(--es-envelope-radius)';
}
assert.ok(allowedRadiusAtom('var(--radius-composer)', 'chat.css'));
assert.ok(allowedRadiusAtom('var(--filter-popover-radius, var(--radius-card))', 'dialogs.css'));
assert.ok(allowedRadiusAtom('max(0px, calc(var(--radius-page) - 2px))', 'right-workspace.css'));
assert.ok(allowedRadiusAtom('var(--es-envelope-radius)', 'mail-envelope.css'));
assert.equal(allowedRadiusAtom('var(--es-envelope-radius)', 'chat.css'), false);
assert.equal(allowedRadiusAtom('var(--radius-nested)', 'chat.css'), false);
assert.equal(allowedRadiusAtom('calc(var(--radius-page) - 99px)', 'chat.css'), false);
assert.equal(allowedRadiusAtom('8px', 'usage.css'), false);
const cssFiles = fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css'));
for (const f of cssFiles) {
  const noComment = fs
    .readFileSync(path.join(stylesDir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  postcss.parse(noComment, { from: f }).walkDecls('border-radius', decl => {
    const val = decl.value.trim();
    if (val.includes('--radius-nested')) {
      v(`radius: ${f} 使用已废除的 var(--radius-nested)，请按语义归档 control/card/small`);
      return;
    }
    for (const atom of postcss.list.space(val)) {
      if (!allowedRadiusAtom(atom, f)) {
        v(`radius: ${f} 非法圆角值 "${atom}"（声明: ${val}）——只允许 token 与 0/1/2/4px/50%/999px`);
      }
    }
  });
}

/* ---------- 2. 选中指示条模式 ---------- */
const hiddenPaneMarkers = new Map([
  ['.ext-nav-row::before', '.ext-nav-row.is-pane-focused:not([data-drop])::before'],
  ['.left-panel .session-item::after', '.left-panel .session-item.is-pane-focused::after'],
  ['.left-panel .utility-feature-item::after', '.left-panel .utility-feature-item.is-pane-focused::after']
]);
function isCurrentPaneMarker(selectors, body, focusedSelectors = new Set()) {
  const allSelectors = selectors.split(',').map(s => s.trim());
  const props = Object.fromEntries(body.split(';').map(declaration => {
    const colon = declaration.indexOf(':');
    return colon < 0 ? [] : [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
  }).filter(pair => pair.length === 2));
  const focused = allSelectors.every(s => /\.is-pane-focused(?=[^\w-]|$)/.test(s) && /::(?:before|after)$/.test(s));
  const hidden = props.opacity === '0' && props.transform === 'scaleY(0.25)' && allSelectors.every(s => {
    const active = hiddenPaneMarkers.get(s);
    return !!active && focusedSelectors.has(active);
  });
  return (focused || hidden) && props.width === '2px' && props.height === '12px' && props.position === 'absolute' &&
    props['pointer-events'] === 'none' && !('inset' in props) && !('bottom' in props) && !('border-left' in props);
}
const markerBody = 'position:absolute;width:2px;height:12px;pointer-events:none;background:var(--fg-selected-secondary);';
assert.equal(isCurrentPaneMarker('.session-item.is-pane-focused::after', markerBody), true);
assert.equal(isCurrentPaneMarker('.ext-nav-row.is-pane-focused:not([data-drop])::before', markerBody), true);
assert.equal(isCurrentPaneMarker('.session-item.active::after', markerBody), false, '普通 selected 行不得获得标记例外');
assert.equal(isCurrentPaneMarker('.session-item.is-pane-focused::after, .session-item.active::after', markerBody), false, '例外不得通过逗号扩散至普通选中项');
assert.equal(isCurrentPaneMarker('.session-item.is-pane-focused::after', markerBody.replace('height:12px', 'height:100%')), false, '当前分屏也不得恢复整条高亮');
assert.equal(isCurrentPaneMarker('.session-item.is-pane-focused::after', markerBody.replace('width:2px', 'width:3px')), false, '当前分屏短标记严格限为2px');
const hiddenMarkerBody = `${markerBody}opacity:0;transform:scaleY(0.25);`;
const focusedExt = new Set(['.ext-nav-row.is-pane-focused:not([data-drop])::before']);
assert.equal(isCurrentPaneMarker('.ext-nav-row::before', hiddenMarkerBody, focusedExt), true);
assert.equal(isCurrentPaneMarker('.ext-nav-row::before', hiddenMarkerBody, new Set()), false, '隐藏标记必须有对应的仅当前分屏显示规则');
assert.equal(isCurrentPaneMarker('.ext-nav-row::before', hiddenMarkerBody.replace('opacity:0', 'opacity:1'), focusedExt), false, '普通行不可显示标记');
/**
 * 文档化例外（每条都有设计依据，且逐属性锁死形状，防止被当成「随便加竖条」的缺口）：
 *  - `.board-card.active::before`：当前会话的左侧短中性色标记（docs/features/global-board.md
 *    「当前会话以卡片左侧短中性色标记，不改变卡片底色和边框」），2×18px pill。
 *  - `.ext-agent-resizer::before`：拖拽分隔条 hover 指示线（ext.css 注释），常态透明、
 *    hover 才上色，属交互手柄，不是选中态。
 *  - 当前工作区：用切区按钮的 aria-current 标记位置（docs/features/workspaces.md），2×12px。
 */
const currentWorkspaceMarker = ".agent-notify-bubble:has(> .agent-notify-body[aria-current='true'])::after";
const DOCUMENTED_MARKERS = new Map([
  ['.board-card.active::before', (props) =>
    props.left === '0' && props.top === '50%' && props.height === '18px' &&
    props['border-radius'] === 'var(--radius-pill)' &&
    props.background === 'var(--fg-muted)' &&
    props.transform === 'translateY(-50%)' && props['pointer-events'] === 'none'],
  ['.ext-agent-resizer::before', (props) => props.background === 'transparent'],
  [currentWorkspaceMarker, (props) =>
    props.position === 'absolute' && props['inset-inline-start'] === '2px' && props.top === 'calc(50% - 6px)' &&
    props.width === '2px' && props.height === '12px' && props['border-radius'] === 'var(--radius-pill)' &&
    props.background === 'var(--ws-current-marker-color, var(--overlay-fg-selected-secondary))' &&
    props['pointer-events'] === 'none']
]);
function isDocumentedMarker(selectors, props) {
  const check = DOCUMENTED_MARKERS.get(selectors.trim());
  return !!check && check(props);
}
const markerDecls = (body) => Object.fromEntries(body.split(';').map((declaration) => {
  const colon = declaration.indexOf(':');
  return colon < 0 ? [] : [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
}).filter((pair) => pair.length === 2));
const boardMarkerBody = 'position:absolute;left:0;top:50%;width:2px;height:18px;border-radius:var(--radius-pill);' +
  'background:var(--fg-muted);transform:translateY(-50%);pointer-events:none;';
const workspaceMarkerBody = 'position:absolute;inset-inline-start:2px;top:calc(50% - 6px);width:2px;height:12px;' +
  'border-radius:var(--radius-pill);background:var(--ws-current-marker-color, var(--overlay-fg-selected-secondary));pointer-events:none;';
assert.equal(isDocumentedMarker(currentWorkspaceMarker, markerDecls(workspaceMarkerBody)), true);
assert.equal(isDocumentedMarker('.agent-notify-bubble::after', markerDecls(workspaceMarkerBody)), false);
assert.equal(isDocumentedMarker(currentWorkspaceMarker, markerDecls(workspaceMarkerBody.replace('height:12px', 'height:100%'))), false);
assert.equal(isDocumentedMarker('.board-card.active::before', markerDecls(boardMarkerBody)), true);
assert.equal(
  isDocumentedMarker('.board-card.active::before', markerDecls(boardMarkerBody.replace('height:18px', 'height:100%'))),
  false,
  '看板当前会话标记不得拉成整条高亮'
);
assert.equal(
  isDocumentedMarker('.board-card::before', markerDecls(boardMarkerBody)),
  false,
  '例外只给 .active，普通卡片不得带竖条'
);
assert.equal(
  isDocumentedMarker('.ext-agent-resizer::before', markerDecls('position:absolute;width:3px;background:transparent;top:0;')),
  true
);
assert.equal(
  isDocumentedMarker('.ext-agent-resizer::before', markerDecls('position:absolute;width:3px;background:var(--fg-muted);top:0;')),
  false,
  '拖拽手柄常态必须透明，显示色只许在 :hover/:active'
);
for (const f of cssFiles) {
  const src = fs.readFileSync(path.join(stylesDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/inset\s+2px\s+0\s+0/.test(src)) v(`indicator: ${f} 含 inset 2px 0 0 左缘指示条（已废除）`);
  const focusedSelectors = new Set();
  postcss.parse(src, { from: f }).walkRules(rule => {
    const props = Object.fromEntries((rule.nodes ?? []).filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
    if (props.opacity === '1' && props.transform === 'scaleY(1)') {
      for (const selector of postcss.list.comma(rule.selector)) focusedSelectors.add(selector);
    }
  });
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/::(?:before|after)/.test(m[1])) continue;
    const body = m[2];
    if (/\bwidth:\s*[23]px\b/.test(body) && /background|border-left/.test(body) && /top|bottom|inset|absolute/.test(body)) {
      if (isCurrentPaneMarker(m[1], body, focusedSelectors)) continue;
      if (isDocumentedMarker(m[1], markerDecls(body))) continue;
      v(`indicator: ${f} 疑似竖条指示器（::before/after 内 width 2-3px + 背景定位）`);
    }
  }
}

/* ---------- 3. 旧调色板残留（含 %23 编码） ---------- */
const STALE_HEX = [
  '#0a0a0b', '#101013', '#16161a', '#1b1b20', '#0d0d10', '#0a0a0a', '#111111',
  '#171717', '#26262b', '#27272a', '#2a2a2e', '#a1a1aa', '#71717a', '#9b9ba4',
  '#6c6c75', '#f4f4f5', '#e4e4e7', '#e05252', '#1e1e1e6'
].map((h) => h.toLowerCase());
function scanStale(fileAbs, label) {
  let src;
  try {
    src = fs.readFileSync(fileAbs, 'utf8');
  } catch {
    return; // 文件不存在则跳过
  }
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const hex of STALE_HEX) {
    const encoded = '%' + hex.slice(1);
    const re = new RegExp(hex.slice(1).replace(/./g, (c) => `[${c}${c.toUpperCase()}]`), 'g');
    // 精确匹配整个 hex（避免 #1a1a1a 匹配 #1a1a1a1）
    let idx = -1;
    const plain = new RegExp(hex + '(?![0-9a-fA-F])', 'i');
    if (plain.test(src)) v(`stale: ${label} 残留旧色值 ${hex}`);
    if (src.toLowerCase().includes(encoded)) v(`stale: ${label} 残留旧色值（url 编码）${encoded}`);
    void re;
    void idx;
  }
}
for (const f of cssFiles) scanStale(path.join(stylesDir, f), `styles/${f}`);
scanStale(path.join(root, 'src/main/extensions/sdk/theme.css'), 'sdk/theme.css');
scanStale(dailyReportPanel, 'daily-report/panel.html');
scanStale(path.join(root, 'src/main/index.ts'), 'main/index.ts');
// 主进程全部源码：运行时 setTitleBarOverlay/setBackgroundColor 的旧色也会覆盖创建参数（曾真实漏改）
scanStale(path.join(root, 'src/main/ipc/app.ts'), 'main/ipc/app.ts');
const rendererDir = path.join(root, 'src/renderer/src');
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(ent.name)) scanStale(p, path.relative(root, p));
  }
};
walk(rendererDir);

/* ---------- 4. token 镜像同步 ---------- */
const MIRROR_TOKENS = [
  '--bg-frame', '--bg-canvas', '--bg-panel', '--bg-raised', '--bg-overlay', '--bg-input',
  '--ink', '--text-2', '--text-3', '--hairline',
  '--green', '--yellow', '--red', '--blue', '--purple',
  '--hover-fill', '--selected-fill',
  '--radius-control', '--radius-card', '--radius-modal', '--radius-pill',
  '--corner-shape'
];
function mirrorCheck(fileAbs, label) {
  let src;
  try {
    src = fs.readFileSync(fileAbs, 'utf8');
  } catch {
    return;
  }
  for (const t of MIRROR_TOKENS) {
    const expect = tokens[t];
    if (expect == null) continue;
    const re = new RegExp(`${t.replace(/[-]/g, '\\-')}\\s*:\\s*([^;\\n]+)[;\\n]`);
    const m = src.match(re);
    if (!m) continue; // 未声明的交给 stale 扫描
    if (m[1].trim().toLowerCase() !== expect.toLowerCase()) {
      v(`mirror: ${label} 的 ${t}=${m[1].trim()} 与 base.css 的 ${expect} 不一致`);
    }
  }
}
mirrorCheck(path.join(root, 'src/main/extensions/sdk/theme.css'), 'sdk/theme.css');
mirrorCheck(dailyReportPanel, 'daily-report/panel.html');

/* ---------- 5. 主进程窗口色同步 ---------- */
const mainTs = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const needPairs = [
  ['backgroundColor', tokens['--bg-frame'], '窗口底(=--bg-frame，双保险：overlay 不生效时透出顶栏同色)'],
  ['color', tokens['--bg-frame'], 'titleBarOverlay.color(--bg-frame)'],
  ['symbolColor', tokens['--ink'], 'titleBarOverlay.symbolColor(--ink)']
];
for (const [prop, expect, label] of needPairs) {
  const re = new RegExp(`${prop}\\s*:\\s*['"]([^'"]+)['"]`);
  const m = mainTs.match(re);
  if (!m) {
    v(`sync: main/index.ts 未找到 ${prop} 声明`);
  } else if (m[1].toLowerCase() !== expect.toLowerCase()) {
    v(`sync: main/index.ts ${label}=${m[1]} ≠ ${expect}（改色板必须同步）`);
  }
}

/* ---------- 汇总 ---------- */
if (violations.length > 0) {
  console.error(`design-lint: ${violations.length} 处违例`);
  for (const msg of violations) console.error('  ✗ ' + msg);
  process.exit(1);
}
console.log('design-lint: ok');
