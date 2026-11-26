/**
 * 判断 fs:changed 上报的相对路径是否意味着「Git 仓集合可能变化」，
 * 从而需要强制重扫工作区（绕过扫描缓存）。
 *
 * 仓集合变化 = .git 目录本身出现/消失（init / clone / rm -rf）。
 * 仅 .git 内部文件变化（index / refs / logs 等）不算仓集合变化——
 * 它们由 summary 缓存的 mtime 失效机制处理，无需全量 listRepos。
 *
 * 抽到 shared 便于单元测试锁定契约（漏判信号会导致新仓不出现）。
 */
export function shouldRefreshRepoList(rels: string[]): boolean {
  return rels.some((rel) => {
    if (!rel) return true;
    const n = rel.replace(/\\/g, '/');
    if (n === '.git' || n.endsWith('/.git')) return true;
    // 新仓 init 必创建 config；某些 fs.watch 实现只报内部文件不报目录本身
    if (n === '.git/config' || n.endsWith('/.git/config')) return true;
    return false;
  });
}
