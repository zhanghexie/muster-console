/**
 * 渲染层全部 CSS 的语法完整性守卫：用 postcss（与 vite 同款解析器）逐个解析
 * src/renderer/src 下的 .css 文件，任何未闭合块/非法语法即红。
 * 移除左栏调度条目时，曾误删 left.css 末尾
 * `.sessions-hot-ghost:hover .sessions-hot-ghost-inner` 规则的闭合 `}`，
 * vite dev 对 styles.css 直接 500、渲染层无法启动；typecheck/单测都不解析 CSS，
 * 门禁对此类错误全盲。本用例补上这一层（进 npm test 全量即进 pre-commit）。
 * 运行: node test/css-syntax.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src/renderer/src');

/** 递归收集 .css 文件 */
function collectCss(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCss(p));
    else if (entry.name.endsWith('.css')) out.push(p);
  }
  return out;
}

const files = collectCss(srcDir);
assert.ok(files.length > 0, '未找到任何 CSS 文件（目录结构变了？）');

const failures = [];
for (const file of files) {
  const css = fs.readFileSync(file, 'utf8');
  try {
    postcss.parse(css, { from: file });
  } catch (err) {
    // CssSyntaxError 带 line/column/reason，原样透出便于定位
    failures.push(
      `${path.relative(root, file)}: ${err.reason ?? err.message}（${err.line ?? '?'}:${err.column ?? '?'}）`
    );
  }
}

// index.html 内联 <style>（启动骨架）：未闭合块同样会吞掉后续规则
const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
for (const match of indexHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
  try {
    postcss.parse(match[1], { from: 'src/renderer/index.html <style>' });
  } catch (err) {
    failures.push(`src/renderer/index.html <style>: ${err.reason ?? err.message}（${err.line ?? '?'}:${err.column ?? '?'}）`);
  }
}

assert.deepEqual(
  failures,
  [],
  `CSS 语法错误（vite dev 会对样式入口 500、渲染层起不来）：\n  ${failures.join('\n  ')}`
);

console.log(`css-syntax: ${files.length} 个 CSS 文件全部解析通过`);
