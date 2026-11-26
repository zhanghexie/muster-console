/**
 * 界面字体设置（shared/appearanceFonts.ts）纯逻辑 + 接线守卫。
 * 覆盖：id/scale 解析坏值回落、sans/mono/终端三栈映射、三档字阶数值（standard 与 base.css
 * 真对照）、渲染层 CSS 字重规约（禁 600）；
 * 接线：字体 CSS 由 uiFont.ts 按选中字体注入（index.html 禁静态外链）、main.tsx 挂 initUiFont、
 * config.ts 缺省/解析/save 落盘、TerminalView 走 getTerminalFontFamily。
 * 运行: node test/ui-font.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'appearanceFonts.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-font-'));
const outFile = path.join(tmp, 'appearanceFonts.mjs');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: entry
});
fs.writeFileSync(outFile, outputText, 'utf8');
const m = await import(pathToFileURL(outFile).href);

/* ---------- 解析：坏值回落默认 ---------- */
assert.equal(m.parseUiFontId('misans'), 'misans');
assert.equal(m.parseUiFontId('harmonyos'), 'harmonyos');
assert.equal(m.parseUiFontId('system'), 'system');
assert.equal(m.parseUiFontId('oppo'), 'oppo');
assert.equal(m.parseUiFontId('comic-sans'), 'oppo', '未知字体回落 oppo');
assert.equal(m.parseUiFontId(undefined), 'oppo');
assert.equal(m.parseUiFontScale('compact'), 'compact');
assert.equal(m.parseUiFontScale('comfortable'), 'comfortable');
assert.equal(m.parseUiFontScale('huge'), 'standard', '未知档位回落 standard');
assert.equal(m.parseUiFontScale(null), 'standard');

/* ---------- 字体栈映射 ---------- */
assert.ok(m.uiFontSansStack('oppo').startsWith("'OPPO Sans'"), 'oppo 栈首选 OPPO Sans');
assert.ok(m.uiFontSansStack('misans').startsWith("'MiSans'"), 'misans 栈首选 MiSans');
assert.ok(m.uiFontSansStack('harmonyos').startsWith("'HarmonyOS Sans SC'"), 'harmonyos 栈首选 HarmonyOS Sans SC');
assert.ok(!m.uiFontSansStack('system').includes('OPPO'), 'system 栈不含三方字体');
assert.ok(m.uiFontMonoStack('misans').includes("Consolas, 'MiSans'"), 'mono 栈中文回落随设置（编辑器/代码块）');
assert.ok(!m.uiFontMonoStack('system').includes('MiSans'), 'system mono 栈无三方回落');
// 终端栈固定纯等宽、不随界面字体（比例 UI 字体被 xterm 按 'W' 定列宽、行盒定行高，
// 横竖间隙显著大于等宽；2026-10-26 修复，还原即红）
assert.ok(m.uiFontTerminalStack().includes('"Courier New"'), '终端栈保持等宽回落链');
for (const f of ['OPPO Sans', 'MiSans', 'HarmonyOS']) {
  assert.ok(!m.uiFontTerminalStack().includes(f), `终端栈不得含 UI 字体 ${f}`);
}
assert.ok(!m.uiFontTerminalStack().includes("'"), '终端栈不含单引号');

/* ---------- 三档字阶 ---------- */
assert.equal(m.UI_FONT_SCALES.compact.body, 14, 'compact=上移前的旧字阶');
assert.equal(m.UI_FONT_SCALES.comfortable.body, 16);
assert.ok(m.UI_FONT_SCALES.compact.micro >= 10, 'micro 不跌破 10px');

/* ---------- 接线守卫（还原即红） ---------- */
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// 字体 CSS 按需注入：index.html 禁止静态外链（渲染阻塞 + 未选中也在启动路径上），
// URL 单源在 uiFont.ts 的 FONT_CSS_URLS，选中才注入
const indexHtml = read('src/renderer/index.html');
assert.doesNotMatch(
  (indexHtml.match(/<link\b[^>]*>/gi) ?? []).join('\n'),
  /cdn-font\.hyperos\.mi\.com|jsdelivr\.net/,
  'index.html 不得静态外链字体 CSS（渲染阻塞）；应走 uiFont.ts 按需注入'
);
const uiFontSrc = read('src/renderer/src/uiFont.ts');
assert.match(uiFontSrc, /family=MiSans/, 'uiFont.ts 需注册 MiSans 官方 CDN');
assert.match(uiFontSrc, /harmonyos-sans-webfont-splitted@[\d.]+.*Regular\.css/, 'uiFont.ts 需注册 HarmonyOS Sans SC Regular');
assert.match(uiFontSrc, /HarmonyOS_Sans_SC\/Medium\.css/, 'uiFont.ts 需注册 HarmonyOS Sans SC Medium');
assert.match(uiFontSrc, /HarmonyOS_Sans_SC\/Bold\.css/, 'uiFont.ts 需注册 HarmonyOS Sans SC Bold');
assert.match(uiFontSrc, /ensureFontCss\(next\.font\)/, 'apply 需按选中字体注入字体 CSS');
assert.match(read('src/renderer/src/main.tsx'), /initUiFont\(\)/, 'main.tsx 需挂 initUiFont()');
const configSrc = read('src/main/config.ts');
assert.match(configSrc, /uiFont:\s*parseUiFontId/, 'config.ts 需解析 uiFont');
assert.match(configSrc, /uiFontScale:\s*parseUiFontScale/, 'config.ts 需解析 uiFontScale');
assert.match(configSrc, /uiFont:\s*this\.config\.uiFont/, 'config.save() 落盘 payload 必须含 uiFont（漏字段会被静默丢弃）');
assert.match(configSrc, /uiFontScale:\s*this\.config\.uiFontScale/, 'config.save() 落盘 payload 必须含 uiFontScale');
assert.match(read('src/renderer/src/components/TerminalView.tsx'), /fontFamily:\s*getTerminalFontFamily\(\)/, '终端字体需走 getTerminalFontFamily()');

/* ---------- standard 档与 base.css 默认字阶真对照（解析 CSS，防两处真值源漂移；
 * 这里是 standard 数值的唯一断言——不另存硬编码副本，任一侧漂移即红） ---------- */
const baseCss = read('src/renderer/src/styles/base.css');
const cssScale = {};
for (const token of Object.keys(m.UI_FONT_SCALES.standard)) {
  const hit = baseCss.match(new RegExp(`--font-${token}:\\s*(\\d+)px`));
  assert.ok(hit, `base.css 缺 --font-${token} 定义`);
  cssScale[token] = Number(hit[1]);
}
assert.deepEqual(m.UI_FONT_SCALES.standard, cssScale, 'standard 档与 base.css 默认字阶漂移');

/* ---------- 字重规约守卫：渲染层 CSS 禁 600（design.md §5 只用 400/500；
 * OPPO Sans 无 600 档，600 被浏览器上行 700 暗底发糊。700 仅 base.css @font-face 注册行；
 * TSX 侧另有 FileTypeIcon SVG 字标 700 豁免，不在本守卫扫描面） ---------- */
function collectCss(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCss(p));
    else if (entry.name.endsWith('.css')) out.push(p);
  }
  return out;
}
for (const file of collectCss(path.join(root, 'src/renderer/src'))) {
  const lines = read(path.relative(root, file)).split('\n');
  lines.forEach((line, i) => {
    assert.doesNotMatch(
      line,
      /font-weight:\s*600\b/,
      `${path.relative(root, file)}:${i + 1} 用了 600 字重（design.md §5：只用 400/500）`
    );
  });
}

console.log('ui-font: 解析/栈映射/字阶/接线守卫全部通过');
fs.rmSync(tmp, { recursive: true, force: true });
