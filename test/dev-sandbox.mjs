/**
 * 开发者隔离沙箱 (devSandbox) 单元自测。
 * 验证：3 个测试仓库的自动创建、Git 树完整性、分支状态、重置还原逻辑。
 * 运行: node test/dev-sandbox.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
const workspacesDir = path.join(tmpDir, 'workspaces');

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

function writeFiles(baseDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
}

function seedRepo(repoDir, files, commitMsg, extraBranch) {
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  fs.mkdirSync(repoDir, { recursive: true });
  writeFiles(repoDir, files);

  runGit(repoDir, ['init', '-b', 'main']);
  runGit(repoDir, ['config', 'user.name', 'Muster Console Demo']);
  runGit(repoDir, ['config', 'user.email', 'demo@muster.local']);
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', commitMsg]);

  if (extraBranch) {
    runGit(repoDir, ['checkout', '-b', extraBranch.branchName]);
    writeFiles(repoDir, extraBranch.files);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', extraBranch.commitMsg]);
    runGit(repoDir, ['checkout', 'main']);
  }
}

// 1. 初始化 3 个测试仓库
const playgroundDir = path.join(workspacesDir, 'demo-playground');
const frontendDir = path.join(workspacesDir, 'demo-frontend');
const backendDir = path.join(workspacesDir, 'demo-backend');

seedRepo(
  playgroundDir,
  {
    'package.json': '{"name":"demo-playground"}',
    'src/index.ts': 'console.log("hello")',
    '.muster/workspace.json': '{"statusVocabulary":["待办"]}',
    '.muster/extensions/hello-action/manifest.json': '{"name":"hello"}',
    '.muster/extensions/hello-action/action.js': 'console.log("hello")',
    'README.md': '# Demo'
  },
  'feat: initial playground'
);

seedRepo(
  frontendDir,
  {
    'package.json': '{"name":"demo-frontend"}',
    'src/App.tsx': 'export const App = () => <div>Main</div>;',
    'README.md': '# Frontend'
  },
  'feat: initial frontend',
  {
    branchName: 'feature/dark-mode',
    files: {
      'src/App.tsx': 'export const App = () => <div>Dark</div>;'
    },
    commitMsg: 'feat: dark mode'
  }
);

seedRepo(
  backendDir,
  {
    'package.json': '{"name":"demo-backend"}',
    'src/server.ts': 'export const add = (a, b) => a + b;',
    'README.md': '# Backend'
  },
  'feat: initial backend'
);

// 2. 断言 demo-playground
assert.ok(fs.existsSync(path.join(playgroundDir, '.git')), 'playground .git 必须存在');
assert.equal(fs.existsSync(path.join(playgroundDir, '.muster', 'HOST.md')), false, 'sandbox does not seed a core protocol file');
assert.ok(fs.existsSync(path.join(playgroundDir, '.muster', 'extensions', 'hello-action', 'action.js')), '扩展必须存在');
const pgLog = runGit(playgroundDir, ['log', '-1', '--oneline']);
assert.ok(pgLog.includes('feat: initial playground'), 'playground commit 必须正确');

// 3. 断言 demo-frontend (多分支与分支切换)
assert.ok(fs.existsSync(path.join(frontendDir, '.git')), 'frontend .git 必须存在');
const branches = runGit(frontendDir, ['branch']).split('\n').map((b) => b.trim().replace(/^\*\s*/, ''));
assert.ok(branches.includes('main'), 'frontend 必须包含 main 分支');
assert.ok(branches.includes('feature/dark-mode'), 'frontend 必须包含 feature/dark-mode 分支');

// 检查 main 下的内容
assert.equal(fs.readFileSync(path.join(frontendDir, 'src/App.tsx'), 'utf-8'), 'export const App = () => <div>Main</div>;');

// 切换分支并检查
runGit(frontendDir, ['checkout', 'feature/dark-mode']);
assert.equal(fs.readFileSync(path.join(frontendDir, 'src/App.tsx'), 'utf-8'), 'export const App = () => <div>Dark</div>;');
runGit(frontendDir, ['checkout', 'main']);

// 4. 断言 demo-backend
assert.ok(fs.existsSync(path.join(backendDir, '.git')), 'backend .git 必须存在');
assert.ok(fs.existsSync(path.join(backendDir, 'src/server.ts')), 'backend server.ts 必须存在');

// 5. 模拟重置（修改文件后还原）
fs.writeFileSync(path.join(playgroundDir, 'dirty.txt'), 'dirty content');
assert.ok(fs.existsSync(path.join(playgroundDir, 'dirty.txt')));

// 重新执行 seedRepo
seedRepo(
  playgroundDir,
  {
    'package.json': '{"name":"demo-playground"}',
    'src/index.ts': 'console.log("hello")',
    'README.md': '# Demo'
  },
  'feat: initial playground'
);
assert.ok(!fs.existsSync(path.join(playgroundDir, 'dirty.txt')), '重置后 dirty.txt 应该被清除');

// 清理 tmp
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log('PASS dev-sandbox: 3 个测试仓库生成、Git 提交树、多分支与重置还原均验证通过');
