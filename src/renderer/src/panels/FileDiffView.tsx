import { BrandLoading } from '../components/BrandLoader';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Diff, Hunk, markEdits, parseDiff, tokenize, type RenderGutter } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { languageFromPath, refractor } from './gitDiffHighlight';

type ParsedFile = ReturnType<typeof parseDiff>[number];
type ParsedHunk = NonNullable<ParsedFile['hunks']>[number];

interface DiffFileTokens {
  file: ParsedFile;
  hunks: ParsedHunk[];
  tokens: ReturnType<typeof tokenize> | undefined;
}

/** 大 diff 保护：超过该行数只渲染前 N 行（hunk 粒度截断），底部按钮展开剩余 */
const MAX_RENDER_ROWS = 1500;

/** 行数预算内截取 hunks；最后一个 hunk 可能略超预算（无法拆半个 hunk） */
function sliceFilesByRows(
  files: ParsedFile[],
  limit: number
): { files: { file: ParsedFile; hunks: ParsedHunk[] }[]; hiddenRows: number } {
  let total = 0;
  for (const f of files) {
    for (const h of f.hunks ?? []) total += h.changes.length;
  }
  let used = 0;
  const kept: { file: ParsedFile; hunks: ParsedHunk[] }[] = [];
  if (total > limit) {
    for (const file of files) {
      const hunks = file.hunks ?? [];
      const take: ParsedHunk[] = [];
      for (const h of hunks) {
        if (used >= limit) break;
        take.push(h);
        used += h.changes.length;
      }
      if (take.length > 0) kept.push({ file, hunks: take });
      if (used >= limit) break;
    }
  } else {
    for (const file of files) kept.push({ file, hunks: file.hunks ?? [] });
    used = total;
  }
  return { files: kept, hiddenRows: Math.max(0, total - used) };
}

export type DiffLinePick = { file: string; line: number; original: string };

/** 统一视图只显示一列：删除行用旧行号，其他行用新行号。 */
const renderUnifiedGutter: RenderGutter = ({ change, side }) => {
  if (side === 'old') return null;
  return change.type === 'normal' ? change.newLineNumber : change.lineNumber;
};

function lineFromRow(row: HTMLElement): number | null {
  const gutters = [...row.querySelectorAll('.diff-gutter')];
  const nums = gutters
    .map((g) => Number((g.textContent ?? '').trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? nums[nums.length - 1]! : null;
}

function originalFromRow(row: HTMLElement): string {
  const code = row.querySelector('.diff-code');
  return (code?.textContent ?? '').replace(/\u00a0/g, ' ');
}

export function FileDiffView({
  diffText,
  loading = false,
  commentMode = false,
  onPickLine
}: {
  diffText: string;
  loading?: boolean;
  /** T1.7：点击行累积评论 */
  commentMode?: boolean;
  onPickLine?: (pick: DiffLinePick) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // parseDiff 很贵，只在 diffText 真变时重算
  const files = useMemo(() => {
    if (!diffText.trim()) return [];
    try {
      return parseDiff(diffText);
    } catch {
      return [];
    }
  }, [diffText]);

  // 大 diff 行数截断；换 diffText 后重置回默认预算
  const [rowLimit, setRowLimit] = useState(MAX_RENDER_ROWS);
  useEffect(() => {
    setRowLimit(MAX_RENDER_ROWS);
  }, [diffText]);

  const sliced = useMemo(() => sliceFilesByRows(files, rowLimit), [files, rowLimit]);

  // tokenize（refractor 语法高亮）只对保留下来的 hunks 做，同样只在输入真变时重算
  const tokenized = useMemo<DiffFileTokens[]>(() => {
    if (sliced.files.length === 0) return [];
    return sliced.files.map(({ file, hunks }, i) => {
      const path = file.newPath || file.oldPath || `file-${i}`;
      const language = languageFromPath(path);
      let tokens: ReturnType<typeof tokenize> | undefined;
      try {
        tokens = tokenize(hunks, {
          ...(language
            ? { highlight: true as const, refractor, language }
            : { highlight: false as const }),
          enhancers: [markEdits(hunks, { type: 'block' })]
        });
      } catch {
        tokens = undefined;
      }
      return { file, hunks, tokens };
    });
  }, [sliced]);

  // 加载优先于空态：请求飞行期间 diffText 仍是空串，不能闪「无差异」；
  // 骨架按内容区高度铺 shimmer（复用 skel.css 体系）
  if (loading) {
    return (
      <div className="git-diff-skel brand-loading-panel" data-sel-area="diff">
        <BrandLoading size={32}>{t('正在读取 Diff…')}</BrandLoading>
      </div>
    );
  }
  if (!diffText.trim()) {
    return (
      <div className="git-diff-empty file-diff-empty" data-sel-area="diff">
        {t('无差异')}
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <pre className="git-diff-raw" data-sel-area="diff">
        {diffText}
      </pre>
    );
  }

  const onDiffClick = (e: React.MouseEvent, filePath: string): void => {
    if (!commentMode || !onPickLine) return;
    const target = e.target as HTMLElement | null;
    const row = target?.closest('tr');
    if (!row) return;
    const line = lineFromRow(row);
    if (line == null) return;
    onPickLine({ file: filePath, line, original: originalFromRow(row) });
  };

  return (
    <div
      className={`git-diff-view is-unified${commentMode ? ' is-comment-mode' : ''}`}
      data-sel-area="diff"
      data-comment-mode={commentMode ? '1' : undefined}
    >
      {tokenized.map(({ file, hunks, tokens }, i) => {
        const path = file.newPath || file.oldPath || `file-${i}`;
        return (
          <div
            key={`${file.oldRevision ?? ''}:${file.newRevision ?? ''}:${path}:${i}`}
            data-diff-path={path}
            onClick={(e) => onDiffClick(e, path)}
          >
            <Diff viewType="unified" diffType={file.type} hunks={hunks} tokens={tokens} renderGutter={renderUnifiedGutter}>
              {(hs) =>
                hs.map((hunk, hi) => (
                  <Hunk key={hunk.content || `h-${hi}`} hunk={hunk} />
                ))
              }
            </Diff>
          </div>
        );
      })}
      {sliced.hiddenRows > 0 ? (
        <button
          type="button"
          className="git-btn ghost tiny git-diff-expand"
          onClick={() => setRowLimit(Number.POSITIVE_INFINITY)}
        >
          {t('展开剩余 {{n}} 行', { n: sliced.hiddenRows })}
        </button>
      ) : null}
    </div>
  );
}
