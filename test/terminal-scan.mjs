/**
 * 终端视口扫描实体自测。
 * 运行: node test/terminal-scan.mjs
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
const selectionEntry = path.join(root, 'src', 'shared', 'terminalSelectionText.ts');
const scanEntry = path.join(root, 'src', 'shared', 'terminalScan.ts');

function transpile(srcPath, importRewrite) {
  let src = fs.readFileSync(srcPath, 'utf8');
  if (importRewrite) {
    for (const [from, to] of importRewrite) {
      src = src.replace(from, to);
    }
  }
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: srcPath
  });
  return outputText;
}

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'term-scan-'));
  const selectionOut = path.join(tmp, 'terminalSelectionText.mjs');
  const scanOut = path.join(tmp, 'terminalScan.mjs');
  fs.writeFileSync(selectionOut, transpile(selectionEntry), 'utf8');
  fs.writeFileSync(
    scanOut,
    transpile(scanEntry, [["from './terminalSelectionText'", "from './terminalSelectionText.mjs'"]]),
    'utf8'
  );
  return { tmp, scanOut };
}

const { tmp, scanOut } = compile();
const { parsePathLocation, scanLinesForEntities, classifyPathKind, filterEntitiesByStat, scanEntityRanges } =
  await import(pathToFileURL(scanOut).href);

assert.deepEqual(parsePathLocation('src/a.ts:12'), {
  pathText: 'src/a.ts',
  line: 12,
  col: undefined
});
assert.deepEqual(parsePathLocation('src/a.ts:12:3'), {
  pathText: 'src/a.ts',
  line: 12,
  col: 3
});
assert.equal(parsePathLocation('https://x.com:443'), null);
assert.equal(parsePathLocation('D:\\a\\b'), null);

assert.equal(classifyPathKind('src/foo/'), 'dir');
assert.equal(classifyPathKind('src/foo'), 'file');

const hits = scanLinesForEntities(
  ['see https://example.com/x and src/foo.ts:10', 'path ./docs/a.md'],
  'D:\\ws'
);
assert.ok(hits.some((h) => h.kind === 'url' && h.text.includes('example.com')));
assert.ok(hits.some((h) => h.kind === 'loc' && h.line === 10 && h.pathText.includes('foo.ts')));
assert.ok(hits.some((h) => h.kind === 'file' && h.text.includes('docs')));

const bare = scanLinesForEntities(['Edited preview-example.html +44'], 'D:\\ws');
assert.ok(
  bare.some((h) => h.kind === 'file' && h.text === 'preview-example.html'),
  `bare=${JSON.stringify(bare)}`
);
assert.ok(
  scanLinesForEntities(['fix App.tsx:12'], 'D:\\ws').some(
    (h) => h.kind === 'loc' && h.pathText === 'App.tsx' && h.line === 12
  )
);

const dirs = scanLinesForEntities(['• docs/', '• src/', '• test/', '• package.json'], 'D:\\ws');
assert.ok(
  dirs.some((h) => h.kind === 'dir' && h.text === 'docs/'),
  `dirs=${JSON.stringify(dirs)}`
);
assert.ok(dirs.some((h) => h.kind === 'dir' && h.text === 'src/'));
assert.ok(dirs.some((h) => h.kind === 'dir' && h.text === 'test/'));
assert.ok(dirs.some((h) => h.kind === 'file' && h.text === 'package.json'));
assert.ok(
  !scanLinesForEntities(['cwd=./ done'], 'D:\\ws').some((h) => h.text === './'),
  'bare ./ must not match'
);

const annotated = scanLinesForEntities(
  [
    'E:\\Projects\\TestPerfomance\\release\\Setup.exe (约 121 MB，刚编完)',
    'E:\\Projects\\TestPerfomance\\release\\Setup.exe(约 121 MB，刚编完)',
    'E:\\Projects\\TestPerfomance\\release\\Setup.exe（约 121 MB，刚编完）'
  ],
  'D:\\ws'
);
assert.equal(
  annotated.filter((h) => h.pathText === 'E:\\Projects\\TestPerfomance\\release\\Setup.exe')
    .length,
  3,
  `annotated=${JSON.stringify(annotated)}`
);
assert.ok(!annotated.some((h) => (h.pathText ?? h.text).includes('约')));

const hiddenLine = '.cursor/skills/feishu-daily-report/SKILL.md';
const hiddenHits = scanLinesForEntities([hiddenLine], 'D:\\ws');
assert.ok(
  hiddenHits.some((h) => h.kind === 'file' && h.text === hiddenLine),
  `hiddenHits=${JSON.stringify(hiddenHits)}`
);
assert.ok(
  !hiddenHits.some((h) => h.text === '.cursor'),
  'scan must not stop at .cursor'
);

const mixed = scanLinesForEntities(
  ['https://example.com', 'ghost-nope.ts', 'package.json'],
  'D:\\ws'
);
const kept = filterEntitiesByStat(mixed, 'D:\\ws', {
  'D:\\ws\\ghost-nope.ts': { exists: false },
  'D:\\ws\\package.json': { exists: true, isFile: true, isDirectory: false },
  'D:\\ws\\docs\\': { exists: true, isDirectory: true }
});
assert.ok(kept.some((h) => h.kind === 'url'));
assert.ok(kept.some((h) => h.kind === 'file' && h.text === 'package.json'));
assert.ok(!kept.some((h) => h.text === 'ghost-nope.ts'));
assert.deepEqual(
  filterEntitiesByStat(
    [{ kind: 'dir', text: 'docs/', pathText: 'docs/', row: 0, start: 0, end: 5 }],
    'D:\\ws',
    { 'D:\\ws\\docs\\': { exists: true, isDirectory: true } }
  ).map((h) => h.kind),
  ['dir']
);

const row0 = hits.filter((h) => h.row === 0);
for (let i = 0; i < row0.length; i++) {
  for (let j = i + 1; j < row0.length; j++) {
    const a = row0[i];
    const b = row0[j];
    assert.ok(a.end <= b.start || b.end <= a.start, 'no overlap');
  }
}

// ---------- 2026-09 审查修复 ----------
// 中文紧贴相对路径（无 :line）也要出 file 实体
const glued = scanLinesForEntities(['已修改src/renderer/src/App.tsx组件'], 'D:\\ws');
assert.ok(
  glued.some((h) => h.kind === 'file' && h.text === 'src/renderer/src/App.tsx'),
  `glued=${JSON.stringify(glued)}`
);
// 绝对路径尾部粘全角标点须修剪后仍可识别
const fwTail = scanLinesForEntities(['完成E:\\ws\\a\\b.md，共 3 处'], 'D:\\ws');
assert.ok(
  fwTail.some((h) => h.kind === 'file' && h.text === 'E:\\ws\\a\\b.md'),
  `fwTail=${JSON.stringify(fwTail)}`
);
// localhost URL：url 实体携带 localPath（本地文件候选），stat 后挂 absPath 且 kind 不变
const localHit = scanLinesForEntities(
  ['预览 http://localhost:5188/docs/features/virtual-screen.md 生成'],
  'E:\\ws'
);
assert.ok(
  localHit.some(
    (h) => h.kind === 'url' && h.localPath === 'E:\\ws\\docs\\features\\virtual-screen.md'
  ),
  `localHit=${JSON.stringify(localHit)}`
);
const localFiltered = filterEntitiesByStat(localHit, 'E:\\ws', {
  'E:\\ws\\docs\\features\\virtual-screen.md': { exists: true, isFile: true, isDirectory: false }
});
assert.ok(
  localFiltered.some(
    (h) => h.kind === 'url' && h.absPath === 'E:\\ws\\docs\\features\\virtual-screen.md'
  ),
  `localFiltered=${JSON.stringify(localFiltered)}`
);
// localhost 本地不存在：保留为纯 url，不挂 absPath
const localMissed = filterEntitiesByStat(localHit, 'E:\\ws', {});
assert.ok(localMissed.some((h) => h.kind === 'url' && h.absPath == null));

// 含空格绝对路径：贪心候选经 stat 变体回填为最长存在前缀
const spaced = scanLinesForEntities(['启动 C:\\Program Files\\nodejs\\node.exe 失败'], 'E:\\ws');
const spacedFiltered = filterEntitiesByStat(spaced, 'E:\\ws', {
  'C:\\Program Files\\nodejs\\node.exe': { exists: true, isFile: true, isDirectory: false }
});
assert.ok(
  spacedFiltered.some((h) => h.kind === 'file' && h.text === 'C:\\Program Files\\nodejs\\node.exe'),
  `spaced=${JSON.stringify(spaced)} filtered=${JSON.stringify(spacedFiltered)}`
);
assert.ok(!spacedFiltered.some((h) => h.text === 'C:\\Program'));

// URL 尾部修剪：半角括号配平保留、全角括号截断
const urlTrim = scanLinesForEntities(
  ['访问 https://zh.wikipedia.org/wiki/函数_(数学) 以及 详见https://example.com/a（注意版本）'],
  'D:\\ws'
);
assert.ok(
  urlTrim.some((h) => h.kind === 'url' && h.text === 'https://zh.wikipedia.org/wiki/函数_(数学)'),
  `urlTrim=${JSON.stringify(urlTrim)}`
);
assert.ok(
  urlTrim.some((h) => h.kind === 'url' && h.text === 'https://example.com/a'),
  `urlTrim=${JSON.stringify(urlTrim)}`
);

// 纯 URL 行：不得再产出与 URL 重叠的路径/loc 实体
const urlOnly = scanLinesForEntities(
  ['clone https://github.com/me/repo/blob/main/src/App.tsx ok'],
  'D:\\ws'
);
assert.ok(
  urlOnly.every((h) => h.kind === 'url'),
  `urlOnly=${JSON.stringify(urlOnly)}`
);

// electron-builder artifactName 实际输出（Muster-Console-<version>-Setup.exe）：多段连字符 + 多个点的版本号，不能截成 release\\Muster-。
for (const file of ['Muster-Console-0.1.31-Setup.exe', 'Muster-Console-0.1.31-Setup.exe.blockmap']) {
  const p = `release\\${file}`;
  const found = filterEntitiesByStat(scanLinesForEntities([`building file=${p} archs=x64`], 'E:\\ws'), 'E:\\ws', {
    [`E:\\ws\\${p}`]: { exists: true, isFile: true }
  });
  assert.equal(found[0]?.text, p, `builder path: ${JSON.stringify(found)}`);
}

// 空格路径只在 stat 确认后回填；Windows、macOS/Linux 走同一实现。
for (const [cwd, p] of [['E:\\ws', 'release\\Muster Console-0.1.31.exe'], ['/home/ws', 'release/My App-0.1.31.dmg']]) {
  const abs = `${cwd}${cwd.startsWith('/') ? '/' : '\\'}${p}`;
  const found = filterEntitiesByStat(scanLinesForEntities([`file=${p} archs=x64`], cwd), cwd, {
    [abs]: { exists: true, isFile: true }
  });
  assert.equal(found[0]?.text, p);
}

// xterm 软折行只连 isWrapped 行；实体仍是一个，绘制按物理行投影。
const longPath = 'release\\win-unpacked\\resources\\app.asar.unpacked\\node_modules\\node-pty\\third_party\\conpty\\1.23.251008001\\win10-x64\\OpenConsole.exe';
const prefix = '  signing path=';
const cut = longPath.length - 12;
const wrapped = scanLinesForEntities([
  { text: prefix + longPath.slice(0, cut), row: 0, isWrapped: false },
  { text: longPath.slice(cut), row: 1, isWrapped: true }
], 'E:\\ws');
const wrappedFound = filterEntitiesByStat(wrapped, 'E:\\ws', {
  [`E:\\ws\\${longPath}`]: { exists: true, isFile: true }
});
assert.equal(wrappedFound.length, 1);
assert.equal(wrappedFound[0].text, longPath);
assert.deepEqual(scanEntityRanges(wrappedFound[0]), [
  { row: 0, start: prefix.length, end: prefix.length + cut },
  { row: 1, start: 0, end: longPath.length - cut }
]);
assert.equal(filterEntitiesByStat(scanLinesForEntities([
  prefix + longPath.slice(0, cut), longPath.slice(cut)
], 'E:\\ws'), 'E:\\ws', { [`E:\\ws\\${longPath}`]: { exists: true } }).length, 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('terminal-scan: ok');
