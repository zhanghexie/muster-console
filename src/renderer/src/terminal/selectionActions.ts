import { t } from '../../../shared/i18n';
import { setPathDragData } from '../../../shared/fileDropPaths';
import {
  buildSearchUrl,
  detectFirstUrl,
  firstPreviewablePath,
  greedyPathTextAt,
  isGreedyEligible,
  pathStatVariants,
  primaryPathCandidate,
  resolvePathCandidate
} from '../../../shared/terminalSelectionText';

export async function copySelectionText(
  text: string,
  tip: (s: string) => void
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    tip(t('复制失败'));
  }
}

export async function searchSelectionText(
  text: string,
  tip: (s: string) => void
): Promise<void> {
  const res = await window.api.shell.openExternal(buildSearchUrl(text));
  if (!res.ok) tip(res.error || t('无法打开浏览器'));
}

export async function openSelectionUrl(text: string, tip: (s: string) => void): Promise<void> {
  const u = detectFirstUrl(text);
  if (!u) return;
  const res = await window.api.shell.openExternal(u);
  if (!res.ok) tip(res.error || t('无法打开链接'));
}

/**
 * 含空格的未引号绝对路径：保守候选在原文位置贪心扩展后，逐空格前缀 stat，
 * 取最长存在者。都不存在返回 null（调用方退回保守候选，由 revealPath 报错）。
 */
async function statBestSpacePath(text: string, cwd: string | undefined): Promise<string | null> {
  const raw = primaryPathCandidate(text);
  if (!raw || !raw.includes(' ') || !isGreedyEligible(raw)) return null;
  const idx = text.indexOf(raw);
  if (idx < 0) return null;
  const greedy = greedyPathTextAt(text, idx, idx + raw.length).text;
  if (!greedy.includes(' ')) return null;
  const absVariants = [
    ...new Set(pathStatVariants(greedy).map((v) => resolvePathCandidate(v, cwd) ?? v))
  ];
  try {
    const stats = await window.api.shell.statPaths(absVariants);
    for (const a of absVariants) {
      if (stats[a]?.exists) return a;
    }
  } catch {
    // 主进程 stat 不可用：退回保守候选
  }
  return null;
}

export async function revealSelectionPath(
  text: string,
  cwd: string | undefined,
  tip: (s: string) => void
): Promise<void> {
  const raw = primaryPathCandidate(text);
  if (!raw) return;
  const base = resolvePathCandidate(raw, cwd) ?? raw;
  const abs = (await statBestSpacePath(text, cwd)) ?? base;
  const res = await window.api.shell.revealPath(abs);
  if (!res.ok) tip(res.error || t('无法打开路径'));
}

export function selectionHasPreviewablePath(text: string, cwd?: string): boolean {
  return firstPreviewablePath(text, cwd) != null;
}

export function previewSelectionPath(
  text: string,
  cwd: string | undefined,
  preview: (absPath: string, line?: number, col?: number) => void,
  tip: (s: string) => void
): void {
  const cand = firstPreviewablePath(text, cwd);
  if (!cand) {
    tip(t('无法解析路径'));
    return;
  }
  // localhost URL 映射：点击时 stat 确认，不存在则提示改用「打开链接」
  if (/^https?:\/\//i.test(text.trim())) {
    void (async () => {
      try {
        const stats = await window.api.shell.statPaths([cand.absPath]);
        if (stats[cand.absPath]?.exists) {
          preview(cand.absPath, cand.line, cand.col);
        } else {
          tip(t('文件不存在，可改用「打开链接」'));
        }
      } catch {
        preview(cand.absPath, cand.line, cand.col);
      }
    })();
    return;
  }
  // 含空格路径：贪心扩展 stat 回退，取最长存在前缀
  void (async () => {
    const best = await statBestSpacePath(text, cwd);
    preview(best ?? cand.absPath, cand.line, cand.col);
  })();
}

/** 选中文本拖出：整段是路径则走文件树 MIME，否则纯文本 */
export function beginSelectionDrag(
  dt: DataTransfer,
  text: string,
  cwd?: string
): void {
  const trimmed = text.trim();
  const preview = firstPreviewablePath(trimmed, cwd);
  const raw = primaryPathCandidate(trimmed);
  const abs =
    preview?.absPath ?? (raw ? resolvePathCandidate(raw, cwd) ?? raw : null);
  const wholeIsPath = Boolean(
    abs &&
      raw &&
      (trimmed === raw || trimmed === abs || trimmed.startsWith(`${raw}:`))
  );
  if (wholeIsPath && abs) {
    setPathDragData(dt, [abs]);
    try {
      window.api.shell.startPathDrag?.(abs);
    } catch {
      // HTML5 MIME 仍可用
    }
    return;
  }
  dt.effectAllowed = 'copy';
  dt.setData('text/plain', text);
}

/** 绝对路径，或相对路径且有 cwd 可解析时为 true */
export function selectionHasPath(text: string, cwd?: string): boolean {
  const raw = primaryPathCandidate(text);
  return raw != null && resolvePathCandidate(raw, cwd) != null;
}
