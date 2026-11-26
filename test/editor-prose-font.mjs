/**
 * 编辑器/终端字体接线守卫（2026-09-21 排版优化批次）：
 * 1) Markdown 源编辑的文档感模式——FileEditor 给 .file-editor-cm 挂 is-prose，
 *    files.css 用 var(--font-sans) 比例栈 + 正文字号 + 阅读行高；
 * 2) --font-mono 等宽栈含 OPPO Sans 中文回落（否则编辑器/代码块中文落系统雅黑）；
 * 3) CM 高亮 t.monospace 走 --font-mono（prose 模式下行内代码仍等宽），且不再用 bold；
 * 4) 终端 xterm 字体栈与 --font-mono 同源（含 OPPO Sans）；fit 重试使用单一代次调度。
 * 还原任一接线即红。运行: node test/editor-prose-font.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const fileEditor = read('src/renderer/src/components/FileEditor.tsx');
const filesCss = read('src/renderer/src/styles/files.css');
const baseCss = read('src/renderer/src/styles/base.css');
const cmTheme = read('src/renderer/src/editor/workbenchCmTheme.ts');
const terminalView = read('src/renderer/src/components/TerminalView.tsx');

/* 1) is-prose 接线：md 文件才挂，且挂在 .file-editor-cm 上 */
assert.match(
  fileEditor,
  /file-editor-cm\$\{[^}]*mdHtmlKind === 'markdown'[^}]*is-prose/,
  'FileEditor 需对 markdown 文件给 .file-editor-cm 挂 is-prose'
);

/* 2) files.css 的 prose 规则：比例栈 + 正文字号 */
assert.match(filesCss, /\.file-editor-cm\.is-prose \.cm-scroller/, 'files.css 缺少 is-prose 规则');
assert.match(filesCss, /\.file-editor-cm\.is-prose \.cm-scroller\s*\{[^}]*font-family:\s*var\(--font-sans\)/s, 'is-prose 应用 var(--font-sans)');
assert.match(filesCss, /\.file-editor-cm\.is-prose \.cm-scroller\s*\{[^}]*font-size:\s*var\(--font-body\)/s, 'is-prose 应用 var(--font-body)');

/* 3) base.css：--font-sans token 存在且 body 引用；--font-mono 含 OPPO Sans 中文回落 */
assert.match(baseCss, /--font-sans:\s*'OPPO Sans'/, 'base.css 缺少 --font-sans token（OPPO Sans 首选）');
assert.match(baseCss, /body\s*\{[^}]*font-family:\s*var\(--font-sans\)/s, 'body 应引用 var(--font-sans)');
assert.match(
  baseCss,
  /--font-mono:\s*'Cascadia Mono', 'Cascadia Code', Consolas, 'OPPO Sans'/,
  '--font-mono 需在 Consolas 后含 OPPO Sans 中文回落'
);

/* 4) CM 高亮：t.monospace 走等宽；不再用 bold（700 暗底发糊，上限 500） */
assert.match(cmTheme, /tag:\s*t\.monospace,\s*fontFamily:\s*'var\(--font-mono\)'/, 'CM 高亮需把 t.monospace 映射到 --font-mono');
assert.ok(!/fontWeight:\s*'bold'/.test(cmTheme), "CM 高亮不应再用 'bold'（上限 500）");

/* 5) 终端字体走 getTerminalFontFamily()（栈内容固定纯等宽，由 ui-font.mjs 校验） */
assert.match(terminalView, /fontFamily:\s*getTerminalFontFamily\(\)/, '终端字体需走 getTerminalFontFamily()');
assert.match(terminalView, /fitGeneration/, '终端 fit 重试需要单一 generation 取消过期调度');
assert.doesNotMatch(terminalView, /FIT_RETRY_MS\.map/, '终端 fit 不应为一次布局创建多组并行 timer');

/* 6) gutter：行号右对齐 + 等宽（prose 模式比例字体不进 gutter） */
assert.match(cmTheme, /'\.cm-lineNumbers \.cm-gutterElement':\s*\{[^}]*textAlign:\s*'right'/s, '行号需右对齐');
assert.match(cmTheme, /'\.cm-gutters':\s*\{[^}]*fontFamily:\s*'var\(--font-mono\)'/s, 'gutter 需等宽字体');

console.log('editor-prose-font: 接线守卫全部通过');
