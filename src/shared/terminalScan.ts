/**
 * 终端视口行扫描的实体组装与 stat 过滤。
 * 识别全部复用 terminalSelectionText（唯一正则源）：URL（含 localhost→本地文件映射）、
 * path:line、路径实体（带分隔符的路径携带跨空格贪心扩展，由 stat 变体回填最长存在前缀）。
 */
import {
  detectLocEntities,
  detectPathEntities,
  detectUrlEntities,
  greedyPathTextAt,
  localFileFromUrl,
  looksLikeFileName,
  pathStatVariants,
  resolvePathCandidate
} from './terminalSelectionText';

export type ScanEntityKind = 'url' | 'file' | 'dir' | 'loc';

export type ScanEntity = {
  kind: ScanEntityKind;
  text: string;
  pathText?: string;
  line?: number;
  col?: number;
  row: number;
  start: number;
  end: number;
  /** url：localhost 家族 URL 映射出的本地文件绝对路径（待 stat 确认） */
  localPath?: string;
  /** stat 确认存在的本地绝对路径（url 映射命中本地文件时挂载，kind 仍为 url） */
  absPath?: string;
  /** file/dir：跨空格贪心扩展的候选文本（含未确认吃进的词，经 pathStatVariants 回退） */
  greedyText?: string;
  greedyEnd?: number;
  /** 逻辑行对应的物理行区间；start/end 仍为逻辑行 UTF-16 下标。 */
  sourceRows?: { row: number; start: number; end: number }[];
};

export function parsePathLocation(
  raw: string
): { pathText: string; line: number; col?: number } | null {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return null;
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(t);
  if (!m) return null;
  const pathText = m[1]!;
  const hasSep = /[\\/]/.test(pathText) || /^[A-Za-z]:/.test(pathText);
  if (!hasSep && !looksLikeFileName(pathText)) return null;
  const line = Number(m[2]);
  if (!Number.isFinite(line) || line < 1) return null;
  const col = m[3] != null ? Number(m[3]) : undefined;
  if (col != null && (!Number.isFinite(col) || col < 1)) return null;
  return { pathText, line, col };
}

export function classifyPathKind(pathText: string): 'file' | 'dir' {
  return /[\\/]$/.test(pathText) ? 'dir' : 'file';
}

type RawHit = Omit<ScanEntity, 'row'>;

function collectLineHits(line: string, cwd?: string): RawHit[] {
  const raw: RawHit[] = [];
  // 1) URLs（localhost 家族附带本地文件映射候选）
  for (const u of detectUrlEntities(line)) {
    raw.push({
      kind: 'url',
      text: u.text,
      start: u.start,
      end: u.end,
      localPath: localFileFromUrl(u.text, cwd) ?? undefined
    });
  }
  // 2) path:line[:col]
  for (const l of detectLocEntities(line)) {
    raw.push({
      kind: 'loc',
      text: l.text,
      pathText: l.pathText,
      line: l.line,
      col: l.col,
      start: l.start,
      end: l.end
    });
  }
  // 3) file/dir（保守实体附带跨空格贪心扩展，供 stat 变体回填）
  for (const p of detectPathEntities(line)) {
    // 扫描有 stat 闸口，相对/Unix 路径也可安全尝试跨空格补全。
    if (/[\\/]/.test(p.text)) {
      const g = greedyPathTextAt(line, p.start, p.end);
      if (g.text.length > p.text.length) {
        raw.push({
          kind: p.kind,
          text: p.text,
          pathText: p.text,
          start: p.start,
          end: p.end,
          greedyText: g.text,
          greedyEnd: g.end
        });
        continue;
      }
    }
    raw.push({ kind: p.kind, text: p.text, pathText: p.text, start: p.start, end: p.end });
  }
  // 去重叠：按 start 升序，同 start 时 url < loc < path；跳过与已采纳相交者
  const priority = (k: ScanEntityKind): number => (k === 'url' ? 0 : k === 'loc' ? 1 : 2);
  raw.sort((a, b) => a.start - b.start || priority(a.kind) - priority(b.kind) || b.end - a.end);
  const out: RawHit[] = [];
  let cover = -1;
  for (const h of raw) {
    if (h.start < cover) continue;
    // 相对路径无 cwd 无法解析 → 丢弃（盘符/msys/UNC/Unix 根 resolvePathCandidate 原样放行）
    if (h.kind !== 'url' && !resolvePathCandidate(h.pathText ?? h.text, cwd)) continue;
    out.push(h);
    cover = h.end;
  }
  return out;
}

export type ScanBufferRow = { text: string; isWrapped: boolean; row: number };

export function scanLinesForEntities(lines: (string | ScanBufferRow)[], cwd?: string): ScanEntity[] {
  const all: ScanEntity[] = [];
  let text = '';
  let sourceRows: NonNullable<ScanEntity['sourceRows']> = [];
  const flush = (): void => {
    for (const h of collectLineHits(text, cwd)) {
      all.push({ ...h, row: sourceRows[0]!.row, sourceRows: [...sourceRows] });
    }
  };
  lines.forEach((line, index) => {
    const entry = typeof line === 'string' ? { text: line, isWrapped: false, row: index } : line;
    if (!entry.isWrapped && sourceRows.length) {
      flush();
      text = '';
      sourceRows = [];
    }
    sourceRows.push({ row: entry.row, start: text.length, end: text.length + entry.text.length });
    text += entry.text;
  });
  if (sourceRows.length) flush();
  return all;
}

/** stat 回填后再投影，避免长候选回退到短路径时遗留多余高亮。 */
export function scanEntityRanges(e: ScanEntity): { row: number; start: number; end: number }[] {
  if (!e.sourceRows) return [{ row: e.row, start: e.start, end: e.end }];
  return e.sourceRows.flatMap((r) => {
    const start = Math.max(e.start, r.start);
    const end = Math.min(e.end, r.end);
    return end > start ? [{ row: r.row, start: start - r.start, end: end - r.start }] : [];
  });
}

export type PathStatInfo = {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
};

/**
 * 用磁盘 stat 过滤与回填：
 * - url：localPath 存在 → 挂 absPath（kind 不变，菜单在「打开链接」外加文件操作）；
 * - file/dir：贪心候选经 pathStatVariants 回填为最长存在前缀；都不存在则丢弃；
 * - loc：解析出的绝对路径必须存在；
 * - file/dir 存在时按 isDirectory 纠正 kind。
 */
export function filterEntitiesByStat(
  entities: ScanEntity[],
  cwd: string | undefined,
  stats: Record<string, PathStatInfo>
): ScanEntity[] {
  const out: ScanEntity[] = [];
  for (const e of entities) {
    if (e.kind === 'url') {
      if (e.localPath && stats[e.localPath]?.exists) {
        out.push({ ...e, absPath: e.localPath });
      } else {
        out.push(e);
      }
      continue;
    }
    if (e.kind === 'loc') {
      const abs = resolvePathCandidate(e.pathText ?? e.text, cwd);
      if (!abs || !stats[abs]?.exists) continue;
      out.push(e);
      continue;
    }
    const greedy = e.greedyText ?? e.pathText ?? e.text;
    const variants = e.greedyText ? pathStatVariants(greedy) : [greedy];
    let chosen: { v: string; st: PathStatInfo } | null = null;
    for (const v of variants) {
      const abs = resolvePathCandidate(v, cwd);
      if (!abs) continue;
      const st = stats[abs];
      if (!st?.exists) continue;
      if (!chosen) chosen = { v, st };
    }
    if (!chosen) continue;
    out.push({
      ...e,
      kind: chosen.st.isDirectory ? 'dir' : 'file',
      text: chosen.v,
      pathText: chosen.v,
      end: e.start + chosen.v.length
    });
  }
  return out;
}
