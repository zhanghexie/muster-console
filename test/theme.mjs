/**
 * 主题系统：shared/theme 校验规整 + ThemeService 文件 CRUD 与格式化落盘。
 * Run: node test/theme.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-'));
// 递归转译入口及其相对依赖（含 shared/i18n 目录索引 + i18next shim）
const compile = createSharedCompiler(root, tmp);
const loadTs = (rel) => import(pathToFileURL(compile(rel.replace(/^src\//, ''))).href);
const { pathToFileURL } = await import('node:url');

const shared = await loadTs('src/shared/theme.ts');
const {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  THEME_COLOR_KEYS,
  TERMINAL_COLOR_KEYS,
  THEME_UI_GROUPS,
  formatCssColor,
  formatThemeJson,
  parseCssColor,
  parseTheme,
  slugifyThemeId
} = shared;
const serviceMod = await loadTs('src/main/themes.ts');
const { ThemeService } = serviceMod;
const { t } = await loadTs('src/shared/i18n/index.ts');
const { themesHost } = await loadTs('src/main/capabilities/hosts/themes.ts');
const { DEFAULT_RESOLVED_DARK } = await loadTs('src/shared/resolvedAppearance.ts');

/* ---------- 激活未知主题：报错附 id 全小写提示（theme-system F-04） ----------
   置于 resolved-appearance 守卫块之前：该块存在存量红（sdk theme.css 滞后于
   resolver 种子，见审查报告 F-02），本节需在其前独立可跑。 */
{
  const cfgF04 = { themeId: DEFAULT_THEME_ID, workspaces: [], activeWorkspaceId: '', themeByWorkspace: {} };
  const svcF04 = new ThemeService(path.join(tmp, 'f04'), { get: () => cfgF04, update: () => {} });
  const miss = svcF04.activate('No-Such-Theme');
  assert.equal(miss.ok, false, '未知主题激活拒绝');
  assert.equal(
    miss.error,
    t('主题 "{{id}}" 不存在（主题 id 需全小写）', { id: 'no-such-theme' }),
    '报错附「主题 id 需全小写」提示且经 t() 路由（大写入参已被小写化）'
  );
  console.log('✔ activate 未知主题：报错附 id 全小写提示（F-04）');
}

/* ---------- 内置主题完整且键集一致 ---------- */
const dark = BUILTIN_THEMES.find((t) => t.id === 'dark');
const light = BUILTIN_THEMES.find((t) => t.id === 'light');
assert.ok(dark && light, '内置深/浅主题都存在');
// 阅读区应比导航框提供更高文字对比度；避免深色又退回黑框、灰页。
{
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((v) => {
      const s = parseInt(v, 16) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  for (const theme of [dark, light]) {
    for (const text of ['ink', 'ink-soft', 'text-2', 'text-3']) {
      const ink = luminance(theme.colors[text]);
      assert.ok(
        contrast(ink, luminance(theme.colors['bg-panel'])) > contrast(ink, luminance(theme.colors['bg-frame'])),
        `${theme.id} ${text} 在阅读面上的对比度应高于导航框`
      );
    }
  }
  assert.equal(dark.colors['bg-panel'], dark.colors['bg-canvas'], '深色聊天/文件与终端/编辑器背景连续');
}
{
  for (const file of ['src/renderer/src/styles/base.css', 'src/main/extensions/sdk/theme.css']) {
    const css = fs.readFileSync(path.join(root, file), 'utf8');
    const block = css.match(/\/\* resolved-appearance:start \*\/([\s\S]*?)\/\* resolved-appearance:end \*\//)?.[1];
    assert.ok(block, `${file} 有单源生成的默认 appearance`);
    const tokens = {};
    for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].replace(/\s+/g, ' ').trim();
    assert.deepEqual(tokens, DEFAULT_RESOLVED_DARK.cssVars, `${file} 与默认 resolver 输出同值（编辑种子独立于最终角色）`);
    for (const key of THEME_COLOR_KEYS) assert.ok(tokens[`--${key}`], `${file} 完整发布种子词汇 ${key}`);
  }
}
assert.deepEqual(
  Object.keys(dark.colors).sort(),
  Object.keys(light.colors).sort(),
  '两内置主题颜色键集一致'
);
assert.deepEqual(
  Object.keys(dark.terminal).sort(),
  Object.keys(light.terminal).sort(),
  '两内置主题终端键集一致'
);

/* ---------- parseTheme：合法 / 回填 / 报错 ---------- */
const full = parseTheme(JSON.parse(formatThemeJson(dark)), { id: 'dark' });
assert.ok(full.ok && full.theme, '完整 JSON 解析通过');
assert.equal(full.theme.colors['bg-panel'], dark.colors['bg-panel'], 'round-trip 色值不变');

const partial = parseTheme(
  { name: '夜蓝', appearance: 'dark', colors: { 'bg-canvas': '#0f172a' } },
  { id: 'night-blue' }
);
assert.ok(partial.ok, '缺省键允许（按同外观内置主题回填）');
assert.equal(partial.theme.colors['bg-canvas'], '#0f172a', '显式键保留');
assert.equal(partial.theme.colors['ink'], dark.colors['ink'], '缺省键回填内置深色');

const partialLight = parseTheme(
  { name: '纸白', appearance: 'light', colors: { hairline: '#cccccc' } },
  { id: 'paper' }
);
assert.equal(partialLight.theme.colors['bg-canvas'], light.colors['bg-canvas'], '浅色主题缺省回填内置浅色');

assert.equal(parseTheme(null).ok, false, '非对象拒绝');
assert.equal(parseTheme('x').ok, false, '字符串拒绝');

const badColor = parseTheme({ name: 'x', colors: { green: 'red' } }, { id: 'x' });
assert.equal(badColor.ok, false);
assert.ok(badColor.errors.some((e) => e.includes('green')), '非法色值报出字段名');

const unknownKey = parseTheme({ name: 'x', colors: { 'bg-canvs': '#111111' } }, { id: 'x' });
assert.ok(unknownKey.errors.some((e) => e.includes('bg-canvs')), '未知键（拼写错误）报错');

const badAppearance = parseTheme({ name: 'x', appearance: 'blue' }, { id: 'x' });
assert.ok(badAppearance.errors.some((e) => e.includes('appearance')), '非法 appearance 报错');

const emptyName = parseTheme({ appearance: 'dark' }, { id: 'x' });
assert.ok(emptyName.errors.some((e) => e.includes('name')), '缺 name 报错');

// 合法色值面：hex 3/6/8 位 + rgb/rgba；拒绝命名色 / var() / 短横
for (const v of ['#fff', '#1a1a1a', '#ffffff80', 'rgb(0, 0, 0)', 'rgba(250, 250, 250, 0.05)', 'rgb(100% 0% 0%)'.replace(/ /g, ', ')]) {
  const key = parseCssColor(v).a < 1 ? 'hover-fill' : 'green';
  const r = parseTheme({ name: 'x', colors: { [key]: v } }, { id: 'x' });
  assert.ok(r.ok, `色值 ${v} 应被接受`);
}
for (const key of ['bg-frame', 'bg-canvas', 'bg-panel', 'bg-raised', 'bg-overlay', 'bg-input', 'ink', 'green']) {
  assert.equal(parseTheme({ name: 'alpha', colors: { [key]: '#ffffff80' } }).ok, false, `${key} 必须实底/实色`);
}
assert.equal(parseTheme({ name: 'alpha', terminal: { background: '#11111180' } }).ok, false, '终端默认底不能透明');
assert.equal(parseTheme({ name: 'alpha', terminal: { selectionBackground: '#11111180' } }).ok, true, '终端选区种子可透明');
assert.equal(parseCssColor('rgb(1.2.3, 0, 0)'), null, '畸形数字不能进入最终配色');
for (const v of ['red', 'var(--green)', 'url(x)', '#12', '#12345']) {
  const r = parseTheme({ name: 'x', colors: { green: v } }, { id: 'x' });
  assert.equal(r.ok, false, `色值 ${v} 应被拒绝`);
}

/* ---------- formatThemeJson：2 空格格式化（绝不能是一行） ---------- */
const text = formatThemeJson(dark);
assert.ok(text.endsWith('\n'), '落盘文本以换行结尾');
assert.ok(text.includes('\n  "name"'), '2 空格缩进（第二层）');
assert.ok(text.includes('\n    "bg-canvas"'), '2 空格缩进（colors 内层）');
assert.ok(text.split('\n').length > 50, '多行格式化输出');
assert.ok(!text.includes('"id"'), 'id 由文件名承载，不写入 JSON');
const again = formatThemeJson(parseTheme(JSON.parse(text), { id: 'dark' }).theme);
assert.equal(again, text, '键序稳定：round-trip 输出逐字节一致');

/* ---------- slugifyThemeId ---------- */
assert.equal(slugifyThemeId('Night Blue', []), 'night-blue');
assert.equal(slugifyThemeId('夜蓝', []), 'theme', '纯中文名回退 theme');
assert.equal(slugifyThemeId('night-blue', ['night-blue', 'dark']), 'night-blue-2', '冲突追加序号');

/* ---------- ThemeService：JSON 文件 CRUD ---------- */
const cfgState = {
  themeId: DEFAULT_THEME_ID,
  workspaces: [
    { id: 'ws-1', path: '/tmp/ws-1', name: '工作区一', openedAt: 0 },
    { id: 'ws-2', path: '/tmp/ws-2', name: '工作区二', openedAt: 0 }
  ],
  activeWorkspaceId: 'ws-1',
  themeByWorkspace: {}
};
const fakeConfig = {
  get: () => cfgState,
  update: (patch) => {
    Object.assign(cfgState, patch);
  }
};
const svc = new ThemeService(path.join(tmp, 'userData'), fakeConfig);

const created = svc.create('夜蓝');
assert.equal(created.id, 'theme', '中文名 id 回退 theme');
assert.equal(created.colors['bg-canvas'], dark.colors['bg-canvas'], '新建=复制默认深色');
const createdFile = path.join(svc.dir, 'theme.json');
const createdText = fs.readFileSync(createdFile, 'utf8');
assert.ok(createdText.includes('\n  "colors"'), '新主题文件是格式化 JSON');
assert.ok(!createdText.includes('\n  "id"'), '文件不含 id 字段');

const second = svc.create('Night Blue');
assert.equal(second.id, 'night-blue');

// 保存改动：回读生效 + 文件保持格式化
const modified = { ...created, name: '夜蓝改', colors: { ...created.colors, 'bg-canvas': '#0f172a' } };
const saved = svc.save(modified);
assert.ok(saved.ok, '保存自定义主题成功');
assert.equal(svc.get('theme').colors['bg-canvas'], '#0f172a', '保存后读取到新色值');
assert.ok(fs.readFileSync(createdFile, 'utf8').includes('\n    "bg-canvas": "#0f172a"'), '文件更新且保持缩进');

// 校验闸门：坏色值 / 覆盖内置均拒绝
const badSave = svc.save({ ...created, colors: { ...created.colors, green: 'oops' } });
assert.equal(badSave.ok, false);
assert.ok(svc.save({ ...dark }).ok === false, '内置主题不可覆盖保存');

// 激活与删除：内置保护；删除级联清理引用而非拒绝
assert.equal(svc.remove('dark').ok, false, '内置主题不可删除');
assert.ok(svc.activate('theme').ok, '激活自定义主题');
assert.equal(cfgState.themeId, 'theme');
assert.ok(svc.remove('night-blue').ok, '未使用的自定义主题可删除');
assert.equal(svc.get('night-blue'), undefined, '删除后读取不到');

assert.equal(svc.getActive().id, 'theme', '激活后 getActive 跟随');
assert.ok(svc.remove('theme').ok, '删除使用中的主题：级联清理引用');
assert.equal(cfgState.themeId, DEFAULT_THEME_ID, '全局默认指向被删主题时重置回深色');
cfgState.themeId = 'no-such-theme';
assert.equal(svc.getActive().id, 'dark', '配置指向缺失主题时回内置深色');

// 单个坏 JSON 文件不拖垮列表
fs.writeFileSync(path.join(svc.dir, 'broken.json'), '{ not json', 'utf8');
assert.equal(svc.list().some((m) => m.id === 'broken'), false, '坏文件被跳过');
assert.equal(svc.get('broken'), undefined);

/* ---------- 工作区独立主题：覆盖解析 / 指定工作区 / followGlobal / 级联清理 ---------- */
const wsTheme = svc.create('区色');
assert.equal(wsTheme.id, 'theme', 'theme 文件已删，slug 复用');
// 列表：内置在前 + 自定义在后 + 元信息带色卡预览
const metas = svc.list();
assert.deepEqual(metas.map((m) => m.id), ['dark', 'light', 'theme'], '内置在前、自定义在后');
assert.equal(metas[0].preview.bg, dark.colors['bg-panel'], '列表预览带面板色');
assert.ok(svc.activate(wsTheme.id, { scope: 'workspace' }).ok, '给当前工作区设独立主题');
assert.equal(cfgState.themeByWorkspace['ws-1'], wsTheme.id, '覆盖写入 themeByWorkspace');
assert.equal(svc.getActive().id, wsTheme.id, '活跃工作区生效=覆盖');
assert.equal(svc.getActive('ws-2').id, 'dark', '其他工作区仍跟随全局');
assert.equal(svc.getWorkspaceThemeId('ws-2'), undefined, '未设置的区无覆盖');
cfgState.themeId = 'light';
assert.equal(svc.getActive().id, wsTheme.id, '工作区覆盖优先于全局默认');
assert.equal(svc.getActive('ws-2').id, 'light', '无覆盖区跟随新全局');

const wsView = svc.payload();
assert.equal(wsView.activeId, wsTheme.id, 'payload.activeId=生效主题');
assert.equal(wsView.globalThemeId, 'light', 'payload.globalThemeId=全局默认');
assert.equal(wsView.workspaceThemeId, wsTheme.id, 'payload.workspaceThemeId=工作区覆盖');
assert.equal(wsView.activeWorkspaceId, 'ws-1');
assert.equal(wsView.activeWorkspaceName, '工作区一');

assert.ok(svc.activate('light', { scope: 'workspace', workspaceId: 'ws-2' }).ok, '可指定其他工作区');
assert.equal(svc.getActive('ws-2').id, 'light');
assert.equal(svc.activate(wsTheme.id, { scope: 'workspace', workspaceId: 'ws-x' }).ok, false, '未知工作区拒绝');

assert.ok(svc.activate('', { scope: 'workspace', followGlobal: true }).ok, 'followGlobal 清除当前区覆盖');
assert.equal(cfgState.themeByWorkspace['ws-1'], undefined);
assert.equal(svc.getActive().id, 'light', '清除后回到跟随全局');
assert.ok(svc.activate(wsTheme.id, { scope: 'workspace' }).ok, '重新设覆盖');
cfgState.themeId = 'dark';
assert.ok(svc.remove(wsTheme.id).ok, '删除被工作区引用的主题：级联清除覆盖');
assert.equal(cfgState.themeByWorkspace['ws-1'], undefined, '覆盖被级联清理');
assert.equal(svc.getActive().id, 'dark', '界面回落全局默认');
// 悬空覆盖（指向已不存在的主题）按跟随全局处理
cfgState.themeByWorkspace['ws-1'] = 'ghost';
assert.equal(svc.getActive().id, 'dark');
assert.equal(svc.getWorkspaceThemeId('ws-1'), undefined);
delete cfgState.themeByWorkspace['ws-1'];
delete cfgState.themeByWorkspace['ws-2'];

/* ---------- 色盘 UI：颜色解析 + 分组元数据 ---------- */
// parseCssColor / formatCssColor round-trip 覆盖内置主题全部单色值
for (const t of BUILTIN_THEMES) {
  for (const src of [t.colors, t.terminal]) {
    for (const v of Object.values(src)) {
      if (v === 'none' || v.startsWith('0 ') || v.includes('px')) continue; // box-shadow（含无阴影）跳过
      const c = parseCssColor(v);
      assert.ok(c, `应可解析 ${v}`);
      assert.equal(formatCssColor(c), v, `round-trip 不变形 ${v}`);
    }
  }
}
assert.equal(light.colors['bg-frame'], '#f0f3f9', '浅色导航框使用冷灰蓝');
assert.equal(light.colors['bg-input'], '#f2f3f5', '浅色输入控件使用冷灰白（输入阴影改造后自纯白调整）');
assert.equal(light.colors['shadow-input'], '0 2px 8px rgba(20, 24, 34, 0.04)', '浅色输入以轻微投影区分白色阅读面');
assert.equal(dark.colors['shadow-input'], 'none', '深色输入继续使用无投影材质');
// 路径穿越防护（审计 theme-system F-01）：越权 id 必须在校验层拒绝，不触磁盘
{
  const evil = '../../../config';
  const before = svc.list();
  assert.equal(svc.remove(evil).ok, false, '相对路径 id 不可删除（路径穿越拒绝）');
  assert.equal(svc.get(evil), undefined, '相对路径 id 读取同样拒绝');
  assert.equal(svc.list().length, before.length, '越权删除不改变主题列表');
}
for (const theme of BUILTIN_THEMES) {
  assert.equal(parseTheme(theme).ok, true, '输入阴影主题应能导出后重新解析');
}
assert.deepEqual(parseCssColor('#f53'), { r: 255, g: 85, b: 51, a: 1 }, '#rgb 展开');
assert.equal(parseCssColor('#11223380').a, Math.round(0x80 / 255 * 1000) / 1000, '#8 位 hex alpha');
assert.deepEqual(parseCssColor('rgb(1,2,3)').a, 1, 'rgb 无 alpha = 1');
// A2-8-1：% 后缀按 CSS 语义折算（通道 v*255/100、alpha v/100）；还原修复应转红
assert.deepEqual(
  parseCssColor('rgb(100%,0%,0%)'),
  { r: 255, g: 0, b: 0, a: 1 },
  'rgb 百分比通道折算'
);
assert.equal(parseCssColor('rgba(255,0,0,50%)').a, 0.5, 'rgba 百分比 alpha 折算');
assert.equal(parseCssColor('red'), null, '命名色拒绝');
assert.equal(parseCssColor('var(--x)'), null, 'var() 拒绝');
assert.equal(formatCssColor({ r: 11, g: 18, b: 32, a: 1 }), '#0b1220', '不透明输出 #hex');
assert.equal(formatCssColor({ r: 250, g: 250, b: 250, a: 0.05 }), 'rgba(250, 250, 250, 0.05)', '半透明输出 rgba');

// 分组覆盖：除两个阴影 token 外每个颜色键恰出现一次；terminal 全覆盖；无未知键
const SHADOW_EXCLUDED = new Set(['shadow-card', 'shadow-page', 'shadow-input', 'shadow-pop']);
const seenColors = new Map();
const seenTerminal = new Map();
for (const g of THEME_UI_GROUPS) {
  for (const item of g.keys) {
    const seen = g.section === 'colors' ? seenColors : seenTerminal;
    assert.ok(!seen.has(item.key), `UI 分组重复出现 ${item.key}`);
    seen.set(item.key, g.id);
  }
}
for (const k of THEME_COLOR_KEYS) {
  if (SHADOW_EXCLUDED.has(k)) {
    assert.ok(!seenColors.has(k), `阴影 token ${k} 不应进色盘 UI`);
  } else {
    assert.ok(seenColors.has(k), `色盘 UI 缺 colors.${k}`);
  }
}
for (const k of TERMINAL_COLOR_KEYS) {
  assert.ok(seenTerminal.has(k), `色盘 UI 缺 terminal.${k}`);
}
assert.equal(seenColors.size, THEME_COLOR_KEYS.length - SHADOW_EXCLUDED.size, '色盘 UI 无多余 colors 键');
assert.equal(seenTerminal.size, TERMINAL_COLOR_KEYS.length, '色盘 UI 无多余 terminal 键');

/* ---------- Agent 工具（themesHost）：同一 ThemeService 底座 ---------- */
const broadcasts = [];
const agentCtx = {
  themes: svc,
  getWindow: () => ({
    setBackgroundColor() {},
    setTitleBarOverlay() {},
    webContents: { send: (_ch, payload) => broadcasts.push(payload) }
  })
};
// 当前状态：上一节结尾重置为 dark；先切内置浅色再验证工具
themesHost['themes.activate'](agentCtx, { id: 'light' });
assert.equal(themesHost['themes.list'](agentCtx, {}).activeId, 'light');
assert.ok(themesHost['themes.get'](agentCtx, { id: 'dark' }).colors['bg-canvas'], 'get 返回全量');
assert.throws(() => themesHost['themes.get'](agentCtx, { id: 'nope' }), /不存在/, 'get 未知主题报错');
assert.throws(() => themesHost['themes.create'](agentCtx, { name: '  ' }), /name/, 'create 空名报错');
const agentMade = themesHost['themes.create'](agentCtx, { name: 'Agent 夜' });
assert.ok(broadcasts.some((b) => b.themes.some((t) => t.id === agentMade.id)), 'create 后广播');

// update：增量合并 + 校验闸门 + 内置保护
const updated = themesHost['themes.update'](agentCtx, {
  id: agentMade.id,
  colors: { 'bg-canvas': '#0b1220', ink: '#dde7ff' },
  terminal: { background: '#0b1220' }
});
assert.equal(updated.colors['bg-canvas'], '#0b1220', '增量写入');
assert.equal(updated.colors['bg-panel'], dark.colors['bg-panel'], '未传键保留');
assert.ok(
  fs.readFileSync(path.join(svc.dir, `${agentMade.id}.json`), 'utf8').includes('\n    "bg-canvas": "#0b1220"'),
  'Agent 改动同样落盘为格式化 JSON'
);
assert.throws(
  () => themesHost['themes.update'](agentCtx, { id: agentMade.id, colors: { green: 'oops' } }),
  /green/,
  '非法色值报错指名字段'
);
assert.throws(
  () => themesHost['themes.update'](agentCtx, { id: agentMade.id, colors: { 'bg-canvs': '#111111' } }),
  /bg-canvs/,
  '未知键报错'
);
assert.throws(
  () => themesHost['themes.update'](agentCtx, { id: 'dark', colors: { ink: '#ffffff' } }),
  /内置主题/,
  '内置主题不可改'
);

// activate / remove 与 UI 行为一致
const before = broadcasts.length;
const globalAct = themesHost['themes.activate'](agentCtx, { id: agentMade.id });
assert.equal(globalAct.scope, 'global', '缺省 scope=global');
assert.equal(globalAct.activeId, agentMade.id);
assert.ok(broadcasts.length > before, 'activate 广播');
assert.equal(cfgState.themeId, agentMade.id, 'activate 写 config');
assert.throws(() => themesHost['themes.remove'](agentCtx, { id: 'dark' }), /内置/, '内置不可删');
// 工作区作用域：scope=workspace 只写覆盖，全局默认不动
assert.equal(
  themesHost['themes.activate'](agentCtx, { id: agentMade.id, scope: 'workspace' }).scope,
  'workspace'
);
assert.equal(cfgState.themeByWorkspace['ws-1'], agentMade.id);
assert.equal(cfgState.themeId, agentMade.id, '全局默认不变');
themesHost['themes.activate'](agentCtx, { id: 'dark' });
assert.equal(cfgState.themeId, 'dark', '全局切换不影响工作区覆盖');
const listView = themesHost['themes.list'](agentCtx, {});
assert.equal(listView.activeId, agentMade.id, '生效主题=工作区覆盖');
assert.equal(listView.globalThemeId, 'dark');
assert.equal(listView.workspaceThemeId, agentMade.id);
const cleared = themesHost['themes.activate'](agentCtx, { scope: 'workspace', followGlobal: true });
assert.equal(cleared.scope, 'workspace');
assert.equal(cfgState.themeByWorkspace['ws-1'], undefined, 'followGlobal 清除覆盖');
assert.equal(themesHost['themes.list'](agentCtx, {}).activeId, 'dark', '清除后回到跟随全局');
// 删除级联：正被工作区覆盖引用的主题可删，覆盖一并清理
themesHost['themes.activate'](agentCtx, { id: agentMade.id, scope: 'workspace' });
assert.deepEqual(themesHost['themes.remove'](agentCtx, { id: agentMade.id }), { ok: true });
assert.equal(cfgState.themeByWorkspace['ws-1'], undefined, '删除级联清理工作区覆盖');
assert.equal(svc.get(agentMade.id), undefined, 'Agent 删除后读取不到');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('theme: ok');
