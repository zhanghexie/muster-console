/**
 * 助手 Markdown 路径链接化自测（Windows 盘符 / path:line / 裸文件名 / 代码块保护 / 幂等）。
 * 运行: node test/gui-worker-paths.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-paths-'));

function transpile(srcPath, rewrites = []) {
  let src = fs.readFileSync(srcPath, 'utf8');
  for (const [from, to] of rewrites) src = src.replaceAll(from, to);
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: srcPath
  });
  return outputText;
}

fs.writeFileSync(path.join(tmp, 'terminalSelectionText.mjs'), transpile(path.join(root, 'src/shared/terminalSelectionText.ts')), 'utf8');
fs.writeFileSync(
  path.join(tmp, 'terminalScan.mjs'),
  transpile(path.join(root, 'src/shared/terminalScan.ts'), [["from './terminalSelectionText'", "from './terminalSelectionText.mjs'"]]),
  'utf8'
);
const linkifyOut = path.join(tmp, 'linkifyWorkspacePaths.mjs');
fs.writeFileSync(
  linkifyOut,
  transpile(path.join(root, 'src/shared/linkifyWorkspacePaths.ts'), [
    ["from './terminalSelectionText'", "from './terminalSelectionText.mjs'"],
    ["from './terminalScan'", "from './terminalScan.mjs'"]
  ]),
  'utf8'
);

const {
  linkifyWorkspacePaths,
  findWorkspacePathLinks,
  buildWorkspaceFileHref,
  parseWorkspaceFileHref
} = await import(pathToFileURL(linkifyOut).href);

const SCHEME = 'muster-file:';

// ---------- 基础 href 构建与解析 ----------
{
  const href = buildWorkspaceFileHref('src/foo.ts', 12, 3);
  assert.ok(href.startsWith(SCHEME));
  const parsed = parseWorkspaceFileHref(href);
  assert.deepEqual(parsed, { path: 'src/foo.ts', line: 12, col: 3 });
  assert.equal(parseWorkspaceFileHref('https://example.com'), null);
}

// ---------- src/foo.ts:12 → 带行号链接 ----------
{
  const out = linkifyWorkspacePaths('改了 `src/foo.ts:12` 附近逻辑。');
  assert.ok(out.includes(`[${SCHEME}`) || out.includes(`](muster-file:`), `产出链接: ${out}`);
  const parsed = parseWorkspaceFileHref(out.match(/\]\((muster-file:[^)]+)\)/)?.[1] ?? '');
  assert.equal(parsed?.path, 'src/foo.ts');
  assert.equal(parsed?.line, 12);
}

// ---------- 反引号代码里的路径也链接（可点是 v1 必须项） ----------
{
  const out = linkifyWorkspacePaths('见 `src/foo.ts`。');
  assert.ok(out.includes('](muster-file:'), '反引号内路径被链接');
}

// ---------- 代码块不动 ----------
{
  const md = '```ts\nconst x = "src/foo.ts:9";\n```';
  assert.equal(linkifyWorkspacePaths(md), md, '围栏代码块原样保留');
}

// ---------- Windows 盘符路径 ----------
{
  const out = linkifyWorkspacePaths('看 E:\\ws\\proj\\src\\App.tsx:33');
  assert.ok(out.includes('](muster-file:'), 'Windows 绝对路径被链接');
  const href = out.match(/\]\((muster-file:[^)]+)\)/)?.[1] ?? '';
  const parsed = parseWorkspaceFileHref(href);
  assert.equal(parsed?.path, 'E:\\ws\\proj\\src\\App.tsx');
  assert.equal(parsed?.line, 33);
}

// ---------- 裸文件名 ----------
{
  const out = linkifyWorkspacePaths('问题在 App.tsx 里。');
  assert.ok(out.includes('](muster-file:'), '裸文件名被链接');
}

// ---------- URL 不链接 ----------
{
  const md = '参考 https://example.com/src/foo.ts 文档';
  assert.ok(!linkifyWorkspacePaths(md).includes(SCHEME), 'URL 不被链接');
}

// ---------- 幂等（重复 linkify 不嵌套） ----------
{
  const once = linkifyWorkspacePaths('改了 src/foo.ts:12。');
  const twice = linkifyWorkspacePaths(once);
  assert.equal(once, twice, '重复链接化幂等');
}

// ---------- findWorkspacePathLinks 基础 ----------
{
  const links = findWorkspacePathLinks('A src/a.ts:5 B docs/readme.md C');
  assert.ok(links.some((l) => l.path.endsWith('a.ts') && l.line === 5));
  assert.ok(links.some((l) => l.path.includes('readme.md')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] gui-worker-paths');
