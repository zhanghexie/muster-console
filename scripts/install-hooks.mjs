/**
 * 把 git hooks 指向仓库内受版本控制的 scripts/githooks。
 *
 * 仅 npm run hooks:install 显式启用；npm install 不安装测试钩子。
 *
 * 失败一律不阻断安装：CI、无 git 环境、以 tarball 形式安装时都可能没有 .git。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = path.join(root, 'scripts', 'githooks');

if (process.env.npm_lifecycle_event === 'prepare') {
  console.log('hooks: 默认不安装测试钩子；需要时显式运行 npm run hooks:install。');
  process.exit(0);
}

try {
  if (!fs.existsSync(hooksDir)) {
    throw new Error(`缺少 ${hooksDir}`);
  }
  // git worktree 里 .git 是文件不是目录，故用 rev-parse 判定而非 existsSync('.git')
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', 'scripts/githooks'], { cwd: root });
  // Unix 下 hook 需可执行位；Windows 上 chmod 是空操作，忽略即可
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    try {
      fs.chmodSync(path.join(hooksDir, hook), 0o755);
    } catch {
      /* Windows 无 POSIX 权限位 */
    }
  }
  console.log('hooks: core.hooksPath -> scripts/githooks（提交门禁 pre-commit + 合入门禁 pre-merge-commit 已启用）');
} catch (e) {
  console.log(`hooks: 跳过安装（${e.message}）`);
}
