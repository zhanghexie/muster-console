/**
 * 终端选区文本工具自测。
 * 运行: node test/terminal-selection-text.mjs
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
const entry = path.join(root, 'src', 'shared', 'terminalSelectionText.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'term-sel-text-'));
  const outFile = path.join(tmp, 'terminalSelectionText.mjs');
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
const {
  buildSearchUrl,
  detectFirstUrl,
  detectPathCandidates,
  localFileFromUrl,
  resolvePathCandidate,
  tokenizeForBang,
  joinTokens,
  primaryPathCandidate,
  firstPreviewablePath,
  MAX_BANG_TOKENS
} = await import(pathToFileURL(outFile).href);

assert.equal(MAX_BANG_TOKENS, 500);
assert.equal(buildSearchUrl('a b'), 'https://www.bing.com/search?q=a%20b');
assert.equal(detectFirstUrl('见 https://example.com/x 结束'), 'https://example.com/x');
assert.ok(detectPathCandidates('日志 D:\\MetaApp\\a\\b.log').some((p) => p.includes('MetaApp')));
assert.ok(detectPathCandidates('见 src/foo/bar.ts 结束').includes('src/foo/bar.ts'));
assert.ok(detectPathCandidates('./docs/a.md').includes('./docs/a.md'));
assert.ok(detectPathCandidates('..\\parent\\x').includes('..\\parent\\x'));
assert.ok(detectPathCandidates('• docs/').includes('docs/'));
assert.ok(detectPathCandidates('src/').includes('src/'));
assert.ok(!detectPathCandidates('cwd=./ ').includes('./'));
assert.ok(!detectPathCandidates('see ./ ').includes('./'));
assert.ok(detectPathCandidates('path=./src').includes('./src'));
assert.ok(detectPathCandidates('Edited preview-example.html +44').includes('preview-example.html'));
assert.ok(detectPathCandidates('打开 App.tsx 看看').includes('App.tsx'));
assert.ok(!detectPathCandidates('version 1.2.3 released').includes('1.2.3'));
// 路径后粘说明文字：半角/全角括号、有无空格都应收成纯路径
const annotatedWin =
  'E:\\Projects\\TestPerfomance\\release\\Setup.exe (约 121 MB，刚编完)';
assert.deepEqual(
  detectPathCandidates(annotatedWin).filter((p) => p.startsWith('E:\\')),
  ['E:\\Projects\\TestPerfomance\\release\\Setup.exe']
);
assert.deepEqual(
  detectPathCandidates(
    'E:\\Projects\\TestPerfomance\\release\\Setup.exe(约 121 MB，刚编完)'
  ).filter((p) => p.startsWith('E:\\')),
  ['E:\\Projects\\TestPerfomance\\release\\Setup.exe']
);
assert.deepEqual(
  detectPathCandidates(
    'E:\\Projects\\TestPerfomance\\release\\Setup.exe（约 121 MB，刚编完）'
  ).filter((p) => p.startsWith('E:\\')),
  ['E:\\Projects\\TestPerfomance\\release\\Setup.exe']
);
assert.ok(
  !detectPathCandidates(
    'D:\\a\\b.exe(约 1 MB)'
  ).some((p) => p.includes('约') || p.includes('(') || p.includes('（'))
);
assert.equal(resolvePathCandidate('preview-example.html', 'D:\\ws'), 'D:\\ws\\preview-example.html');
assert.equal(resolvePathCandidate('logs\\a.log', 'D:\\ws'), 'D:\\ws\\logs\\a.log');
assert.equal(resolvePathCandidate('src/foo.ts', 'D:\\ws'), 'D:\\ws\\src\\foo.ts');
assert.equal(resolvePathCandidate('docs/', 'D:\\ws'), 'D:\\ws\\docs\\');
assert.equal(resolvePathCandidate('/e/Projects/x', 'D:\\ws'), 'E:\\Projects\\x');
assert.equal(resolvePathCandidate('D:\\abs\\x', 'D:\\ws'), 'D:\\abs\\x');
assert.equal(resolvePathCandidate('src/foo.ts', undefined), null);
assert.equal(resolvePathCandidate('/E:/Projects/image.png', 'D:/ws'), 'E:/Projects/image.png');
assert.equal(resolvePathCandidate('/e:\\Projects\\image.png'), 'e:\\Projects\\image.png');
assert.equal(resolvePathCandidate('/etc/hosts'), '/etc/hosts');
assert.equal(resolvePathCandidate('//server/share/image.png'), '//server/share/image.png');

const toks = tokenizeForBang('https://a.com 以及 D:\\x\\y.log 会话失败');
assert.ok(toks.some((t) => t.startsWith('https://')), `tokens=${JSON.stringify(toks)}`);
assert.ok(toks.some((t) => t.includes('y.log')), `tokens=${JSON.stringify(toks)}`);
const relToks = tokenizeForBang('打开 src/renderer/App.tsx 看看');
assert.ok(
  relToks.some((t) => t.includes('src/renderer') || t === 'src/renderer/App.tsx'),
  `relToks=${JSON.stringify(relToks)}`
);
// 英文词边界拼回自动补空格（分词时丢掉的空白）
assert.equal(joinTokens(['a', 'b', 'c'], [2, 0]), 'a c');
assert.equal(joinTokens(['hello', 'world'], [0, 1]), 'hello world');
assert.equal(joinTokens(['at', 'src/x/y.log'], [0, 1]), 'at src/x/y.log');
// CJK 相邻 / 数字夹 CJK / 标点边界不补空格
assert.equal(joinTokens(['会话', '失败'], [0, 1]), '会话失败');
assert.equal(joinTokens(['第', '3', '条'], [0, 1, 2]), '第3条');
assert.equal(joinTokens(['hello', ','], [0, 1]), 'hello,');
assert.equal(joinTokens(['(', 'test'], [0, 1]), '(test');

// 滑动选中拆开的相对路径片段拼接后仍可识别
assert.ok(detectPathCandidates(joinTokens(['src', '/', 'foo', '.', 'ts'], [0, 1, 2, 3, 4])).includes('src/foo.ts') ||
  detectPathCandidates('src/foo.ts').includes('src/foo.ts'));
assert.ok(detectPathCandidates(joinTokens(['src', '/', 'foo.ts'], [0, 1, 2])).includes('src/foo.ts'));

const hiddenRel = '.cursor/skills/feishu-daily-report/SKILL.md';
assert.ok(
  detectPathCandidates(hiddenRel).includes(hiddenRel),
  `hiddenRel cands=${JSON.stringify(detectPathCandidates(hiddenRel))}`
);
assert.equal(primaryPathCandidate(`see ${hiddenRel} please`), hiddenRel);
assert.ok(detectPathCandidates('foo/.gitignore').includes('foo/.gitignore'));
assert.ok(detectPathCandidates('.gitignore').includes('.gitignore'));
const hiddenToks = tokenizeForBang(`打开 ${hiddenRel}`);
assert.ok(
  hiddenToks.includes(hiddenRel),
  `hiddenToks=${JSON.stringify(hiddenToks)}`
);

assert.deepEqual(firstPreviewablePath(hiddenRel, 'D:\\ws'), {
  absPath: `D:\\ws\\${hiddenRel.replace(/\//g, '\\')}`
});
assert.deepEqual(firstPreviewablePath('src/foo.ts:12:3', 'D:\\ws'), {
  absPath: 'D:\\ws\\src\\foo.ts',
  line: 12,
  col: 3
});
assert.equal(firstPreviewablePath('docs/', 'D:\\ws'), null);
assert.equal(firstPreviewablePath('hello world', 'D:\\ws'), null);

// ---------- 2026-09 审查修复：中文/标点边界 ----------
// 中文紧贴相对路径（无空格）必须可识别
assert.ok(
  detectPathCandidates('已修改src/renderer/src/App.tsx组件').includes('src/renderer/src/App.tsx'),
  `cands=${JSON.stringify(detectPathCandidates('已修改src/renderer/src/App.tsx组件'))}`
);
// 绝对路径尾部粘 CJK 字符 / 全角标点须修剪
assert.ok(detectPathCandidates('在E:\\ws\\a\\b.md里修改').includes('E:\\ws\\a\\b.md'));
assert.ok(detectPathCandidates('完成E:\\ws\\a\\b.md，共 3 处').includes('E:\\ws\\a\\b.md'));
assert.ok(detectPathCandidates('已生成E:\\ws\\a\\b.md。').includes('E:\\ws\\a\\b.md'));
// 全角/半角冒号、表格竖线、星号包裹都应视为左边界
assert.ok(detectPathCandidates('文件：src/app.ts').includes('src/app.ts'));
assert.ok(detectPathCandidates('文件:src/app.ts').includes('src/app.ts'));
assert.ok(detectPathCandidates('|src/app.ts|done|').includes('src/app.ts'));
assert.ok(detectPathCandidates('已更新**src/app.ts**').includes('src/app.ts'));
// 中文散文里的斜杠（末段无扩展名）不得误报为路径
assert.ok(
  !detectPathCandidates('他/她都行').some((p) => p.includes('/')),
  `prose cands=${JSON.stringify(detectPathCandidates('他/她都行'))}`
);

// ---------- 引号包裹的含空格路径 ----------
assert.ok(
  detectPathCandidates("Cannot find module 'E:\\Projects\\my app\\src\\App.tsx'").includes(
    'E:\\Projects\\my app\\src\\App.tsx'
  )
);
assert.ok(detectPathCandidates('打开 "E:\\My Docs\\a.md"').includes('E:\\My Docs\\a.md'));

// ---------- UNC 路径 ----------
assert.ok(
  detectPathCandidates('\\\\wsl$\\Ubuntu\\home\\dev\\a.ts').includes('\\\\wsl$\\Ubuntu\\home\\dev\\a.ts'),
  `unc cands=${JSON.stringify(detectPathCandidates('\\\\wsl$\\Ubuntu\\home\\dev\\a.ts'))}`
);
assert.ok(detectPathCandidates('\\\\fileserver\\share\\logs\\app.log').includes('\\\\fileserver\\share\\logs\\app.log'));
assert.ok(detectPathCandidates('\\\\?\\C:\\very\\long\\path.txt').includes('\\\\?\\C:\\very\\long\\path.txt'));
assert.equal(resolvePathCandidate('\\\\fileserver\\share\\a.log', 'D:\\ws'), '\\\\fileserver\\share\\a.log');

// ---------- 段字符：@scope、~、+、中文段 ----------
assert.ok(
  detectPathCandidates('依赖 node_modules/@scope/pkg/dist/index.js 损坏').includes(
    'node_modules/@scope/pkg/dist/index.js'
  )
);
assert.ok(detectPathCandidates('配置在 ~/projects/app/main.ts').includes('~/projects/app/main.ts'));
assert.ok(detectPathCandidates('产物 dist/foo+bar.js').includes('dist/foo+bar.js'));
assert.ok(detectPathCandidates('整理到 文档/会议纪要.md 里').includes('文档/会议纪要.md'));

// ---------- 无扩展名白名单与长扩展名 ----------
assert.ok(detectPathCandidates('更新了Dockerfile和Makefile').includes('Dockerfile'));
assert.ok(detectPathCandidates('更新了Dockerfile和Makefile').includes('Makefile'));
assert.ok(
  detectPathCandidates('归档 archive.abcdefghijklmnopqrst 存好').includes(
    'archive.abcdefghijklmnopqrst'
  )
);

// ---------- URL 尾部修剪与边界 ----------
assert.equal(
  detectFirstUrl('访问 https://zh.wikipedia.org/wiki/函数_(数学) 查看'),
  'https://zh.wikipedia.org/wiki/函数_(数学)'
);
assert.equal(detectFirstUrl('详见https://example.com/a（注意版本）'), 'https://example.com/a');
assert.equal(detectFirstUrl("https://example.com/x'y"), 'https://example.com/x');
assert.equal(detectFirstUrl('看 https://a.com/b).'), 'https://a.com/b');

// ---------- URL 与路径互斥、裸域名护栏 ----------
assert.ok(
  !detectPathCandidates('https://github.com/me/repo/blob/main/src/App.tsx').some((p) =>
    p.includes('github.com')
  ),
  `url-overlap cands=${JSON.stringify(detectPathCandidates('https://github.com/me/repo/blob/main/src/App.tsx'))}`
);
assert.ok(
  !detectPathCandidates('镜像 registry.npmjs.org/@scope/pkg').some((p) => p.includes('registry')),
  `domain cands=${JSON.stringify(detectPathCandidates('镜像 registry.npmjs.org/@scope/pkg'))}`
);
// 末段带扩展名时不按域名让步（app.dev/config.ts 仍是路径形态）
assert.ok(detectPathCandidates('配置在 app.dev/config.ts').includes('app.dev/config.ts'));

// ---------- localhost URL → 本地文件映射 ----------
assert.equal(
  localFileFromUrl('http://localhost:5188/docs/features/virtual-screen.md', 'E:\\ws'),
  'E:\\ws\\docs\\features\\virtual-screen.md'
);
assert.equal(
  localFileFromUrl('http://127.0.0.1:8080/a/b.ts?x=1#frag', 'E:\\ws'),
  'E:\\ws\\a\\b.ts'
);
assert.equal(localFileFromUrl('https://example.com/docs/a.md', 'E:\\ws'), null);
assert.equal(localFileFromUrl('http://localhost:5173/', 'E:\\ws'), null);
assert.deepEqual(
  firstPreviewablePath('http://localhost:5188/docs/features/virtual-screen.md', 'E:\\ws'),
  { absPath: 'E:\\ws\\docs\\features\\virtual-screen.md' }
);

// ---------- 散文斜杠 /word 不当 Unix 绝对路径（CJK 左边界后跟斜杠组合词） ----------
// `本仓/pi`、`页数/token`、`文本/Markdown` 曾被 UNIX_PATH_RE 切成 /pi /token /Markdown
assert.deepEqual(detectPathCandidates('本仓/pi 的实证'), []);
assert.deepEqual(detectPathCandidates('大小/页数/token 预算截断'), []);
assert.deepEqual(detectPathCandidates('换成文本/Markdown 拼进'), []);
// 多段、带扩展名、尾分隔符、点开头的 Unix 路径不回归
assert.ok(detectPathCandidates('配置在 /etc/hosts 里').includes('/etc/hosts'));
assert.ok(detectPathCandidates('装在 /usr/local/bin').includes('/usr/local/bin'));
assert.ok(detectPathCandidates('日志在 /var/log/ 下').includes('/var/log'));
assert.ok(detectPathCandidates('看 /.bashrc').includes('/.bashrc'));

// ---------- 宽松段不放行箭头/数学符号（zip→slideN.xml 曾整体成「文件名」） ----------
{
  const cands = detectPathCandidates('自研 pptxOutline（zip→slideN.xml → a:t 文本）');
  assert.ok(
    cands.every((p) => !p.includes('→')),
    `箭头不入候选段: ${JSON.stringify(cands)}`
  );
  const math = detectPathCandidates('满足 a≥b 的路径');
  assert.ok(math.every((p) => !p.includes('≥')), `数学符号不入候选段: ${JSON.stringify(math)}`);
}
// CJK 路径识别不回归
assert.ok(detectPathCandidates('整理到 文档/会议纪要.md').includes('文档/会议纪要.md'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('terminal-selection-text: ok');
