/**
 * PR merged 检测的纯逻辑（R-19，零 process）：PR 页轮询拉的是「我开的 open PR」列表，
 * 某 PR 从列表消失即离开了 open 态（merged / closed / 其他）。merged 的精确判定
 * 主进程经 GitHub API 复核消失项的合并状态。
 */

/**
 * 上轮 open 集合 → 本轮 open 集合的差分：上轮在、本轮不在的 PR 号。
 * prev 为 null（首轮，无基线）时返回空——首轮不能把「本来就 merged 的历史 PR」
 * 误判为刚合并。
 */
export function diffVanishedPrNumbers(
  prev: readonly number[] | null,
  next: readonly number[]
): number[] {
  if (prev === null) return [];
  const cur = new Set(next);
  const out: number[] = [];
  for (const n of prev) {
    if (!cur.has(n)) out.push(n);
  }
  return out;
}
