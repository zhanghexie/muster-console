/**
 * Git 仓库列表搜索：按仓库名或路径子串匹配（大小写不敏感）。
 * 从 GitPanel 抽出，换皮时行为保持不变。
 */

export function repoMatchesSearchQuery(
  repo: { name: string; path: string },
  q: string
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return repo.name.toLowerCase().includes(needle) || repo.path.toLowerCase().includes(needle);
}
