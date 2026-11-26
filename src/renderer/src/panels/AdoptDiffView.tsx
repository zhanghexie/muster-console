import { BrandLoading } from '../components/BrandLoader';
/**
 * 部分采纳预览：worktree 相对 merge-base 的完整 diff，按 hunk 勾选。
 * 渲染层 hunk 键（oldStart/oldLines/newStart/newLines + newPath）与主进程
 * filterPatchByHunks 同源（同一 diff 文本、同一 @@ 头解析），勾选结果经
 * git:adoptHunks 原子落主仓。二进制文件段无 @@ hunk，不出现（不可勾选）。
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Diff, Hunk, markEdits, parseDiff, tokenize } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import type { GitAdoptHunkKey } from '../../../shared/types';
import { adoptHunkKeyId } from '../../../shared/gitAdopt';
import { languageFromPath, refractor } from './gitDiffHighlight';

type ParsedFile = ReturnType<typeof parseDiff>[number];
type ParsedHunk = NonNullable<ParsedFile['hunks']>[number];

export interface AdoptHunkToggle {
  key: GitAdoptHunkKey;
  id: string;
}

function hunkKeyOf(file: string, hunk: ParsedHunk): GitAdoptHunkKey {
  return {
    file,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines
  };
}

/** 大 diff 保护与 FileDiffView 同策略：超预算只渲染前 N 行（hunk 粒度截断） */
const MAX_RENDER_ROWS = 1500;

export function AdoptDiffView({
  diffText,
  loading = false,
  selectedIds,
  onToggleHunk,
  onToggleFile
}: {
  diffText: string;
  loading?: boolean;
  /** 勾选中的 hunk id 集（adoptHunkKeyId 序列化） */
  selectedIds: ReadonlySet<string>;
  onToggleHunk: (k: GitAdoptHunkKey, checked: boolean) => void;
  /** 文件级全选/取消：传该文件全部 hunk 键 */
  onToggleFile: (keys: GitAdoptHunkKey[], checked: boolean) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const files = useMemo(() => {
    if (!diffText.trim()) return [];
    try {
      return parseDiff(diffText);
    } catch {
      return [];
    }
  }, [diffText]);

  const tokenized = useMemo(() => {
    if (files.length === 0) return [];
    // 大 diff 保护与 FileDiffView 同策略：超行数预算只保留前 N 个 hunk（tokenize 同步只算可见部分）
    let budget = MAX_RENDER_ROWS;
    const out: { file: ParsedFile; hunks: ParsedHunk[]; tokens: ReturnType<typeof tokenize> | undefined; path: string }[] = [];
    for (const file of files) {
      const visible: ParsedHunk[] = [];
      for (const h of file.hunks ?? []) {
        if (budget <= 0) break;
        visible.push(h);
        budget -= h.changes.length;
      }
      if (visible.length === 0) continue;
      const path = file.newPath || file.oldPath || `file-${out.length}`;
      const language = languageFromPath(path);
      let tokens: ReturnType<typeof tokenize> | undefined;
      try {
        tokens = tokenize(visible, {
          ...(language
            ? { highlight: true as const, refractor, language }
            : { highlight: false as const }),
          enhancers: [markEdits(visible, { type: 'block' })]
        });
      } catch {
        tokens = undefined;
      }
      out.push({ file, hunks: visible, tokens, path });
    }
    return out;
  }, [files]);

  const hiddenHunks = useMemo(() => {
    const total = files.reduce((n, f) => n + (f.hunks?.length ?? 0), 0);
    const shown = tokenized.reduce((n, e) => n + e.hunks.length, 0);
    return Math.max(0, total - shown);
  }, [files, tokenized]);

  if (loading) {
    return (
      <div className="git-diff-skel brand-loading-panel" data-sel-area="diff"><BrandLoading size={32}>{t('正在读取 Diff…')}</BrandLoading></div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="git-diff-empty file-diff-empty" data-sel-area="diff">
        {diffText.trim() ? t('无法解析 diff') : t('无差异')}
      </div>
    );
  }
  // 有文件段但零 hunk（二进制改动段 / 非常规输入）：无可勾选项
  const totalHunks = files.reduce((n, f) => n + (f.hunks?.length ?? 0), 0);
  if (totalHunks === 0) {
    return (
      <div className="git-diff-empty file-diff-empty" data-sel-area="diff">
        {t('没有可勾选的文本 hunk（二进制文件改动不可部分采纳）')}
      </div>
    );
  }

  return (
    <div className="git-diff-view adopt-diff-view" data-sel-area="diff">
      {tokenized.map(({ file, hunks, tokens, path }) => {
        const fileKeys = hunks.map((h) => hunkKeyOf(path, h));
        const fileAllOn =
          fileKeys.length > 0 && fileKeys.every((k) => selectedIds.has(adoptHunkKeyId(k)));
        return (
          <div className="adopt-file" key={`${file.oldRevision ?? ''}:${file.newRevision ?? ''}:${path}`}>
            <div className="adopt-file-head">
              <label className="adopt-hunk-check adopt-file-check">
                <input
                  type="checkbox"
                  checked={fileAllOn}
                  onChange={(e) => onToggleFile(fileKeys, e.target.checked)}
                />
                <span className="adopt-file-path" title={path}>
                  {path}
                </span>
                <span className="adopt-file-count">{hunks.length}</span>
              </label>
            </div>
            <Diff
              viewType="unified"
              diffType={file.type}
              hunks={hunks}
              tokens={tokens}
            >
              {(hs) =>
                hs.flatMap((hunk, hi) => {
                  const k = hunkKeyOf(path, hunk);
                  const id = adoptHunkKeyId(k);
                  return [
                    <tr className="adopt-hunk-row" key={`adopt-${hi}`}>
                      <td colSpan={2}>
                        <label className="adopt-hunk-check">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(id)}
                            onChange={(e) => onToggleHunk(k, e.target.checked)}
                          />
                          <code className="adopt-hunk-head">{hunk.content.trim()}</code>
                        </label>
                      </td>
                    </tr>,
                    <Hunk key={hunk.content || `h-${hi}`} hunk={hunk} />
                  ];
                })
              }
            </Diff>
          </div>
        );
      })}
      {hiddenHunks > 0 ? (
        <div className="adopt-truncated">{t('diff 过大，仍有 {{n}} 个 hunk 未显示', { n: hiddenHunks })}</div>
      ) : null}
    </div>
  );
}
