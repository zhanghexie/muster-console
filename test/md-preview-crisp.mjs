/**
 * 文件预览 Markdown 锐度守卫：预览链不得残留会糊化文字的合成层。
 *
 * 根因（2026-09-21）：.md-body 的 contain:layout paint 是聊天气泡隔离，
 * 整篇预览沿用后叠在虚拟屏 h-strip translate3d/will-change 上，文字按位图缩放发虚。
 * 另：margin:auto 在奇数宽父级上会把整篇推到 0.5px。
 *
 * 自查：把 markdown.css 里预览 override 的 contain:none 删掉，本用例应转红。
 * 运行：node test/md-preview-crisp.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const styles = path.join(root, 'src/renderer/src/styles');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] });
  }
  return out;
}

function hasCompositingHint(body) {
  const hits = [];
  if (/transform\s*:\s*(?!none\b)[^;]*\b(?:scale|translateZ|translate3d)\b/i.test(body)) {
    hits.push('transform scale/translateZ/translate3d');
  }
  if (/will-change\s*:\s*(?!auto\b)[^;]*\btransform\b/i.test(body)) {
    hits.push('will-change:transform');
  }
  if (/translateZ\s*\(/i.test(body)) hits.push('translateZ()');
  if (/\bzoom\s*:\s*(?!1\b|normal\b|unset\b|auto\b)[^;]+/i.test(body)) {
    hits.push('non-identity zoom');
  }
  return hits;
}

const markdownCss = stripComments(fs.readFileSync(path.join(styles, 'markdown.css'), 'utf8'));
const filesCss = stripComments(fs.readFileSync(path.join(styles, 'files.css'), 'utf8'));
const mobileCss = stripComments(fs.readFileSync(path.join(styles, 'mobile.css'), 'utf8'));
const editorSrc = fs.readFileSync(
  path.join(root, 'src/renderer/src/components/FileEditor.tsx'),
  'utf8'
);

assert.match(
  editorSrc,
  /file-editor-preview-md/,
  'FileEditor 必须挂 .file-editor-preview-md（预览链选择器锚点）'
);
assert.match(
  editorSrc,
  /file-editor-md-body/,
  'FileEditor 必须把 className=file-editor-md-body 传给 MarkdownBody'
);

const mdRules = rules(markdownCss);
const genericMd = mdRules.find((r) => r.sel === '.md-body');
assert.ok(genericMd, 'markdown.css 须有 .md-body');
assert.match(
  genericMd.body,
  /contain\s*:\s*layout\s+paint/,
  '聊天气泡隔离（contain:layout paint）不得误删；预览用更高选择器覆盖'
);

const previewContain = mdRules.filter((r) =>
  /file-editor-md-body|file-editor-preview-md|ma-files-detail/.test(r.sel)
);
assert.ok(
  previewContain.some((r) => /contain\s*:\s*none/.test(r.body)),
  '预览链必须显式 contain:none，覆盖气泡 paint 隔离'
);
assert.ok(
  previewContain.some((r) => /\.md-body\.file-editor-md-body|\.file-editor-md-body/.test(r.sel)),
  'contain:none 选择器必须能压过单类 .md-body（双类或后代）'
);

const previewSels = /file-editor-preview-md|file-editor-md-body|\.file-editor-preview\b/;
const chainRules = [...rules(filesCss), ...mdRules, ...rules(mobileCss)].filter((r) =>
  previewSels.test(r.sel)
);
assert.ok(chainRules.length >= 2, '预览链样式规则过少，选择器可能被改名');

for (const r of chainRules) {
  const hits = hasCompositingHint(r.body);
  assert.equal(
    hits.length,
    0,
    `预览链残留糊化因素 ${hits.join(', ')} @ ${r.sel}`
  );
}

const mdBodyRule = rules(filesCss).find((r) => /file-editor-md-body/.test(r.sel));
assert.ok(mdBodyRule, 'files.css 须有 .file-editor-md-body 排版');
assert.match(
  mdBodyRule.body,
  /round\s*\(/,
  '预览正文居中必须 round() 到整数 CSS 像素（还原成 margin:auto 即红）'
);

console.log('md-preview-crisp: 预览链无合成层残留，contain:none + 整数居中已就位');
