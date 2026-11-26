/**
 * node:sqlite FTS5 可用性探测（memory-* 系测试的环境跳过依据）。
 *
 * 为什么存在：memory 库的派生态 db（main/memory/db.ts）用
 * `CREATE VIRTUAL TABLE … USING fts5` 建全文索引，而部分 Node 构建包（实测
 * Node 22.15.0 官方 win-x64）的 node:sqlite 编译时未带 FTS5 扩展，建库即报
 * `no such module: fts5`。这是运行环境能力缺失，不是代码回归——按仓库惯例
 * （参见 git-worktree.mjs / multi-repo-worktree.mjs 的环境 skip）打印原因后
 * 以退出码 0 跳过，让全量门禁在这类机器上保持绿；带 fts5 的 Node 上用例照跑。
 *
 * 用法（放在被测模块 import 之前，越早越好）：
 *   import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';
 *   if (!(await sqliteFts5Supported())) {
 *     console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展（如 22.x 官方构建），记忆库用例无法运行');
 *     process.exit(0);
 *   }
 */
export async function sqliteFts5Supported() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE probe_fts5 USING fts5(text)');
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
