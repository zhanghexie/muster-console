/**
 * shouldRefreshRepoList 契约测试。
 * 锁定「哪些 fs 信号触发强制重扫」——漏判会导致新仓不出现（Bugbot #2），
 * 误判会导致高频内部变化反复全量 listRepos（性能回归）。
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
const entry = path.join(root, 'src', 'shared', 'gitRefreshSignal.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-refresh-signal-'));
  const outFile = path.join(tmp, 'gitRefreshSignal.mjs');
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

const { outFile } = compile();
const { shouldRefreshRepoList } = await import(pathToFileURL(outFile).href);

// 1) 仓集合变化信号 → 必须触发重扫
assert.equal(shouldRefreshRepoList(['.git']), true, '.git 顶层应触发');
assert.equal(shouldRefreshRepoList(['sub/.git']), true, '子目录 .git 应触发');
assert.equal(shouldRefreshRepoList(['sub/deep/.git']), true, '深层 .git 应触发');
assert.equal(shouldRefreshRepoList(['.git/config']), true, '.git/config 应触发');
assert.equal(shouldRefreshRepoList(['sub/.git/config']), true, '子目录 .git/config 应触发');

// 2) 空路径（fs.watch 无 filename 时上报空串）→ 触发（保守）
assert.equal(shouldRefreshRepoList(['']), true, '空 rel 应触发');

// 3) .git 内部高频变化 → 不触发（由 summary mtime 缓存处理，避免性能回归）
assert.equal(shouldRefreshRepoList(['.git/index']), false, '.git/index 不应触发');
assert.equal(shouldRefreshRepoList(['.git/HEAD']), false, '.git/HEAD 不应触发');
assert.equal(shouldRefreshRepoList(['.git/refs/heads/main']), false, '.git/refs 不应触发');
assert.equal(shouldRefreshRepoList(['.git/logs/HEAD']), false, '.git/logs 不应触发');
assert.equal(shouldRefreshRepoList(['sub/.git/index']), false, '子目录 .git/index 不应触发');
assert.equal(shouldRefreshRepoList(['sub/.git/refs/heads/main']), false, '子目录 .git/refs 不应触发');

// 4) 普通工作区文件 → 不触发
assert.equal(shouldRefreshRepoList(['src/main.ts']), false, '普通文件不应触发');
assert.equal(shouldRefreshRepoList(['sub/file.txt']), false, '子目录普通文件不应触发');

// 5) 混合：只要有一个信号触发即触发
assert.equal(
  shouldRefreshRepoList(['src/main.ts', '.git/config']),
  true,
  '混合中含 .git/config 应触发'
);
assert.equal(
  shouldRefreshRepoList(['src/main.ts', '.git/index']),
  false,
  '混合中仅 .git/index 不应触发'
);

// 6) Windows 路径分隔符兼容
assert.equal(shouldRefreshRepoList(['sub\\.git']), true, 'Windows 分隔符 .git 应触发');
assert.equal(
  shouldRefreshRepoList(['sub\\.git\\config']),
  true,
  'Windows 分隔符 .git/config 应触发'
);
assert.equal(
  shouldRefreshRepoList(['sub\\.git\\index']),
  false,
  'Windows 分隔符 .git/index 不应触发'
);

console.log('git-refresh-signal: ok');
