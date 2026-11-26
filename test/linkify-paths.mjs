/**
 * linkifyWorkspacePaths 行为自测：反引号路径可点化（不再落进 code span）、幂等、
  * 普通裸路径/LOC/path:line 不回归。
 * 运行: node test/linkify-paths.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkify-'));

for (const f of ['terminalScan', 'terminalSelectionText', 'linkifyWorkspacePaths']) {
  const entry = path.join(root, 'src/shared', `${f}.ts`);
  let { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: entry
  });
  outputText = outputText.replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(tmp, `${f}.mjs`), outputText);
}
const { linkifyWorkspacePaths, parseWorkspaceFileHref } = await import(
  pathToFileURL(path.join(tmp, 'linkifyWorkspacePaths.mjs')).href
);

// ---------- 反引号路径：包成 [`x`](href)，不留在 code span 里 ----------
{
  const out = linkifyWorkspacePaths('行内代码路径 `README.md` 结束');
  assert.equal(out, '行内代码路径 [`README.md`](muster-file:README.md) 结束');
}

// ---------- 反引号带分隔符路径同型 ----------
{
  const out = linkifyWorkspacePaths('见 `src/main/index.ts` 处');
  assert.equal(out, '见 [`src/main/index.ts`](muster-file:src%2Fmain%2Findex.ts) 处');
}

// ---------- 幂等：已链接（含反引号形态）不再二次包装 ----------
{
  const once = linkifyWorkspacePaths('路径 `README.md` 好');
  const twice = linkifyWorkspacePaths(once);
  assert.equal(twice, once, 'linkify 二次调用幂等');
}

// ---------- 普通裸路径 / loc 不回归 ----------
{
  assert.equal(
    linkifyWorkspacePaths('看 src/app.ts 与 src/main.ts:42:7'),
    '看 [src/app.ts](muster-file:src%2Fapp.ts) 与 [src/main.ts:42:7](muster-file:src%2Fmain.ts?line=42&col=7)'
  );
}

// ---------- 版本号数字不误链 ----------
{
  assert.equal(linkifyWorkspacePaths('版本 v1.2.3 发布'), '版本 v1.2.3 发布');
}

// ---------- 2026-09 审查修复 ----------
// 中文紧贴的相对路径可链接化
{
  assert.equal(
    linkifyWorkspacePaths('已修改src/app.ts组件'),
    '已修改[src/app.ts](muster-file:src%2Fapp.ts)组件'
  );
}
// 绝对路径尾部粘 CJK 修剪后链接化
{
  assert.equal(
    linkifyWorkspacePaths('在E:\\a\\b.md里修改'),
    '在[E:\\a\\b.md](muster-file:E%3A%5Ca%5Cb.md)里修改'
  );
}
// 裸域名（末段无扩展名）不当作工作区路径链接化
{
  assert.equal(linkifyWorkspacePaths('镜像 registry.npmjs.org/@scope/pkg'), '镜像 registry.npmjs.org/@scope/pkg');
}
// localhost URL 受 URL 保护，不当路径化
{
  assert.equal(
    linkifyWorkspacePaths('看 http://localhost:5188/docs/features/virtual-screen.md'),
    '看 http://localhost:5188/docs/features/virtual-screen.md'
  );
}

// ---------- 2026-09-11 误识别修复：exists 二次校验（调用方 stat 把关） ----------
// 语法像路径但磁盘不存在的斜杠组合词，在 exists 全否时不产出任何链接
{
  const src = '本地把 PDF/DOCX/PPTX 换成文本拼进 message，办法是 Marker/pdftotext';
  assert.equal(linkifyWorkspacePaths(src, { exists: () => false }), src);
}
// 真实存在的路径照常链接，同段的垃圾候选被 exists 拦下
{
  const out = linkifyWorkspacePaths('对比 shared/filePreview.ts 与 Marker/pdftotext 的差别', {
    exists: (p) => p === 'shared/filePreview.ts'
  });
  assert.equal(
    out,
    '对比 [shared/filePreview.ts](muster-file:shared%2FfilePreview.ts) 与 Marker/pdftotext 的差别'
  );
}
// loc 候选同样受 exists 把关（按 path 部分判定）
{
  const src = '改 src/foo.ts:12 逻辑';
  assert.equal(linkifyWorkspacePaths(src, { exists: () => false }), src);
  const out = linkifyWorkspacePaths(src, { exists: (p) => p === 'src/foo.ts' });
  assert.ok(out.includes('](muster-file:src%2Ffoo.ts?line=12)'), `loc 放行: ${out}`);
}
// 不传 exists 保持纯语法通道（向后兼容）：斜杠组合词仍会包装，由调用方决定是否把关
{
  assert.ok(linkifyWorkspacePaths('一堆 PDF/DOCX/PPTX 缩写').includes('](muster-file:'));
}

// ---------- 重复词定位：两处同名候选各归其位（曾是 indexOf 双包嵌套损坏） ----------
{
  const src = 'pi 不做 PDF/PPT 解析，附件支持 PDF/PPT 再说。';
  const out = linkifyWorkspacePaths(src, { exists: () => true });
  assert.equal(
    (out.match(/\]\(muster-file:/g) ?? []).length,
    2,
    `两处各自成链: ${out}`
  );
  assert.ok(!out.includes('[['), `无嵌套双包: ${out}`);
  for (const href of out.matchAll(/\]\((muster-file:[^)]+)\)/g)) {
    assert.equal(parseWorkspaceFileHref(href[1])?.path, 'PDF/PPT');
  }
  // 幂等：重复词文本二次链接化不再嵌套
  assert.equal(linkifyWorkspacePaths(out, { exists: () => true }), out);
}

// ---------- 2026-09-11 评审 F-01 嵌套双包（2026-10-26 卡片吸收排修） ----------
// 形如路径的 markdown 链接 label 不应被再包裹：href 是 http(s) URL 时，顶层 URL 保护段
// 把链接切断，MD_LINK_RE 整段保护失效、label 暴露成可包装文本，再包一层会产出
// `[[src/a.ts](muster-file:…)](https://…)` 损坏嵌套（渲染成裸链接源码）。
// 修复方向：对「前有未闭合 `[`」的候选跳过包裹。
{
  const src = '看这个 [src/a.ts](https://example.com/x) 的修改';
  const out = linkifyWorkspacePaths(src, { exists: () => true });
  assert.equal(out, src, `label 不被再包裹: ${out}`);
}
// loc 形态的 label 同样不包裹
{
  const src = '定位在 [src/a.ts:12](https://example.com/x)';
  const out = linkifyWorkspacePaths(src, { exists: () => true });
  assert.equal(out, src, `loc label 不被再包裹: ${out}`);
}
// 行内码 label（[`x`](url)）同样不包裹
{
  const src = '改 [`README.md`](https://example.com/r) 引用';
  const out = linkifyWorkspacePaths(src, { exists: () => true });
  assert.equal(out, src, `行内码 label 不被再包裹: ${out}`);
}
// 同段纯文本路径仍应正常包裹（防过度跳过）
{
  const src = '见 [src/a.ts](https://example.com/x) 与 docs/b.ts 两处';
  const out = linkifyWorkspacePaths(src, { exists: () => true });
  assert.equal(
    out,
    '见 [src/a.ts](https://example.com/x) 与 [docs/b.ts](muster-file:docs%2Fb.ts) 两处',
    `同段纯文本路径仍包裹: ${out}`
  );
}
// 已闭合的方括号（arr[0]）不算未闭合 `[`，其后路径照常包裹（防误伤）
{
  const src = '数组 arr[0] 与 src/a.ts 比较';
  const out = linkifyWorkspacePaths(src, { exists: () => true });
  assert.equal(
    out,
    '数组 arr[0] 与 [src/a.ts](muster-file:src%2Fa.ts) 比较',
    `成对方括号不误伤: ${out}`
  );
}

console.log('linkify-paths: all assertions passed');
