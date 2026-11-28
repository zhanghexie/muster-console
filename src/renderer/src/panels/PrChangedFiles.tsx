import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrFile, PrInlineDraft } from '../../../shared/githubPr';
import { FileTypeIcon } from '../components/FileTypeIcon';
import { IconDiff, IconPlus } from '../components/icons';
import { SplitPane } from '../components/SplitPane';

function patchRows(patch: string) {
  let left = 0;
  let right = 0;
  return patch.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      return { text, line: 0, side: 'RIGHT' as const, kind: 'hunk' };
    }
    if (text.startsWith('+')) return { text, line: right++, side: 'RIGHT' as const, kind: 'add' };
    if (text.startsWith('-')) return { text, line: left++, side: 'LEFT' as const, kind: 'remove' };
    if (text.startsWith(' ')) {
      left++;
      return { text, line: right++, side: 'RIGHT' as const, kind: 'context' };
    }
    return { text, line: 0, side: 'RIGHT' as const, kind: 'context' };
  });
}

function Patch({ file, canComment, onPick }: { file: PrFile; canComment: boolean; onPick: (line: PrInlineDraft) => void }) {
  const { t } = useTranslation();
  const rows = useMemo(() => file.patch ? patchRows(file.patch) : [], [file.patch]);
  if (!file.patch) return <p className="pr-patch-note pr-muted">{t('GitHub 未提供此文件的文本补丁')}</p>;

  return <>
    <div className="pr-patch" role="region" aria-label={file.path} tabIndex={0}
      aria-description={canComment ? t('选择行号可添加行内评论') : undefined}>
      {rows.map(({ text, side, line, kind }, index) => {
        const selectable = !!line && canComment && !(file.truncated && index === rows.length - 1);
        return <div className={`pr-patch-row is-${kind}`} key={index}>
          {selectable
            ? <button type="button" className="pr-patch-number" aria-label={t('评论第 {{line}} 行', { line })}
                onClick={() => onPick({ path: file.path, line, side, body: '' })}>
                <IconPlus className="pr-patch-comment-icon" size={12} />{line}
              </button>
            : <span className="pr-patch-number">{line || ''}</span>}
          <code>{text}</code>
        </div>;
      })}
    </div>
    {file.truncated && <p className="pr-patch-note pr-muted">{t('此处仅显示部分补丁，请在 GitHub 查看完整变更')}</p>}
  </>;
}

export function PrChangedFiles({ files, hasMore, loadingMore, onLoadMore, canComment, onPickLine }: {
  files: PrFile[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  canComment: boolean;
  onPickLine: (line: PrInlineDraft) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const heading = useId();
  const [selectedPath, setSelectedPath] = useState<string>();
  const selected = files.find(file => file.path === selectedPath) ?? files[0];
  if (!selected && !hasMore) return <section className="pr-review-section" aria-labelledby={heading}>
    <h3 id={heading}>{t('变更文件')}</h3>
    <p className="pr-muted">{t('没有变更文件')}</p>
  </section>;

  return <section className="pr-review-section" aria-labelledby={heading}>
    <SplitPane axis="row" className="pr-files-split" defaultPrimaryRatio={0.3} minPrimary={168} minSecondary={238}
      aria-label={t('拖动调整变更列表与 Diff 宽度')}>
      <div className="pr-files-sidebar">
        <header className="pr-files-bar">
          <IconDiff size={14} />
          <h3 id={heading}>{t('变更文件')}</h3>
          <span className="pr-files-count">{files.length}{hasMore ? '+' : ''}</span>
        </header>
        <ul className="pr-file-list" aria-labelledby={heading}>
          {files.map(file => {
            const lastSlash = file.path.lastIndexOf('/');
            return <li key={file.path}>
              <button type="button" className="pr-file-row" aria-label={file.path}
                aria-current={file.path === selected?.path ? 'true' : undefined} title={file.path}
                onClick={() => setSelectedPath(file.path)}>
                <FileTypeIcon name={file.path} size={16} />
                <span className="pr-file-label">
                  <span>{file.path.slice(lastSlash + 1)}</span>
                  {lastSlash > 0 && <small>{file.path.slice(0, lastSlash)}</small>}
                </span>
                <span className="pr-file-stats">
                  {file.additions > 0 && <span className="pr-file-added">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="pr-file-removed">−{file.deletions}</span>}
                </span>
              </button>
            </li>;
          })}
          {hasMore && <li className="pr-file-list-more">
            <button type="button" className="git-btn ghost tiny" disabled={loadingMore} onClick={onLoadMore}>
              {t('加载更多文件')}
            </button>
          </li>}
        </ul>
      </div>
      <div className="pr-file-preview">
        {selected ? <>
          <header className="pr-files-bar">
            <code className="pr-file-path" title={selected.path}>{selected.path}</code>
          </header>
          <Patch key={selected.path} file={selected} canComment={canComment} onPick={onPickLine} />
        </> : <p className="pr-patch-note pr-muted">{t('没有变更文件')}</p>}
      </div>
    </SplitPane>
  </section>;
}
