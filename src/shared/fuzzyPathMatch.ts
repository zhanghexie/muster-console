/**
 * 与 workspaceFiles.scoreMatch 同思路的模糊打分；<0 表示不匹配。
 */
export function scoreFuzzyPath(relPath: string, query: string): number {
  const q = query.trim().toLowerCase();
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  if (!q) return 0;
  if (p === q) return 1000;
  const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
  if (base.startsWith(q)) return 800 - base.length;
  if (base.includes(q)) return 600 - base.length;
  if (p.includes(q)) return 400 - p.length;
  let i = 0;
  for (const ch of p) {
    if (ch === q[i]) i++;
    if (i >= q.length) return 200 - p.length;
  }
  return -1;
}

export function rankFuzzyPaths(paths: string[], query: string, limit: number): string[] {
  const q = query.trim();
  if (!q) return paths.slice(0, Math.max(0, limit));
  const scored: { path: string; score: number }[] = [];
  for (const p of paths) {
    const score = scoreFuzzyPath(p, q);
    if (score < 0) continue;
    scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, Math.max(0, limit)).map((s) => s.path);
}
