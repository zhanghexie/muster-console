/**
 * 工作区相对路径助手自测（渲染层可用，无 node:path）。
 * 运行: node test/workspace-rel-path.mjs
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
const entry = path.join(root, 'src', 'shared', 'workspaceRelPath.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rel-'));
  const outFile = path.join(tmp, 'workspaceRelPath.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const { tryRelativizeToRoot, joinUnderRoot, resolveDocLink } = await import(
  pathToFileURL(outFile).href
);

assert.equal(tryRelativizeToRoot('D:\\MetaApp\\ws', 'D:\\MetaApp\\ws\\src\\a.ts'), 'src/a.ts');
assert.equal(tryRelativizeToRoot('D:/MetaApp/ws', 'D:/MetaApp/ws/src/a.ts'), 'src/a.ts');
assert.equal(tryRelativizeToRoot('D:\\ws', 'C:\\other\\x'), null);
assert.equal(tryRelativizeToRoot('D:\\ws', 'src/foo.ts'), 'src/foo.ts');

assert.equal(joinUnderRoot('D:\\MetaApp\\ws', 'src/a.ts'), 'D:\\MetaApp\\ws\\src\\a.ts');
assert.equal(joinUnderRoot('D:/MetaApp/ws/', 'src/a.ts'), 'D:/MetaApp/ws/src/a.ts');

// ---------- resolveDocLink：md 预览相对链接按当前文件目录解析 ----------
// 用户实证样本：预览 AGENTS.md（工作区根）里的 [docs/features/animation-system.md](…)
// 不再被当成 http://localhost:5188/… 打开
assert.equal(resolveDocLink('AGENTS.md', 'docs/features/animation-system.md'), 'docs/features/animation-system.md');
// 当前文件在子目录：相对链接以其所在目录为基，../ 上跳
assert.equal(resolveDocLink('docs/README.md', 'features/animation-system.md'), 'docs/features/animation-system.md');
assert.equal(resolveDocLink('docs/features/a.md', '../b/c.md'), 'docs/b/c.md');
assert.equal(resolveDocLink('docs/README.md', './x.md'), 'docs/x.md');
// 绝对当前文件（外部只读预览）：返回同形态 Windows 绝对路径
assert.equal(
  resolveDocLink('E:\\refs\\guide\\intro.md', 'images/pic.md'),
  'E:\\refs\\guide\\images\\pic.md'
);
// file:// URI 转本地路径（当前文件是工作区相对形态 → 正斜杠，下游 resolve 兼容）
assert.equal(resolveDocLink('docs/a.md', 'file:///E:/x/y.md'), 'E:/x/y.md');
assert.equal(resolveDocLink('E:\\refs\\a.md', 'file:///E:/x/y.md'), 'E:\\x\\y.md');
// URL 编码目标解码
assert.equal(resolveDocLink('docs/a.md', 'my%20doc.md'), 'docs/my doc.md');
// 非文件形态返回 null（http/锚点/空）
assert.equal(resolveDocLink('a.md', 'https://example.com/x'), null);
assert.equal(resolveDocLink('a.md', '#section'), null);
assert.equal(resolveDocLink('a.md', ''), null);
assert.equal(resolveDocLink(null, 'a.md'), null);

console.log('workspace-rel-path: ok');
fs.rmSync(tmp, { recursive: true, force: true });
