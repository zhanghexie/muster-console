/** Remove only this repository's opt-in test hooks; preserve custom hook paths. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function uninstallHooks(root, git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()) {
  let current;
  try { current = git(['config', '--local', '--get', 'core.hooksPath']); }
  catch (error) { if (error.status === 1) return '未安装仓库测试钩子'; throw error; }
  if (current.replace(/\\/g, '/').replace(/\/$/, '') !== 'scripts/githooks' && path.resolve(root, current) !== path.join(root, 'scripts', 'githooks')) {
    return `保留自定义 hooksPath：${current}`;
  }
  git(['config', '--local', '--unset', 'core.hooksPath']);
  return '已卸载仓库测试钩子';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`hooks: ${uninstallHooks(process.cwd())}`); }
  catch (error) { console.error(`hooks: 卸载失败：${error.message}`); process.exitCode = 1; }
}
