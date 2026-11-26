import { ErrorTip } from '../components/ErrorTip';
import { BrandLoading } from '../components/BrandLoader';
import { useScopedGit } from './gitpanel/GitWorkspaceScope';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitFileChange, GitGraphBranch, GitGraphCommit } from '../../../shared/types';
import { getResolvedLocale } from '../../../shared/i18n';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { SplitPane } from '../components/SplitPane';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { FileDiffView } from './FileDiffView';
import { GitChangeTree } from './GitChangeTree';
import {
  appendCommits,
  emptyGraphState,
  type GraphIncrementalState,
  type GraphLink,
  type GraphRow
} from './gitGraphLayout';

const noopPaths = (_paths: string[]): void => {};

const PAGE = 80;
const ROW_H = 30;
const LANE_W = 14;
const DOT_R = 3.5;
const PAD_L = 12;
const GRAPH_PAD_R = 10;
/** 文案与该行最右图线之间的间距 */
const TEXT_GAP = 8;
/** 虚拟滚动：可视区上下各多渲染的行数，避免快速滚动出现空白 */
const VIRTUAL_OVERSCAN = 8;

/** 计算所有行涉及的最大泳道列数（用于 SVG 宽度） */
function computeMaxColumns(rows: GraphRow[]): number {
  let columns = 0;
  for (const row of rows) {
    columns = Math.max(columns, row.col + 1);
    for (const link of row.topLinks) {
      columns = Math.max(columns, link.from + 1, link.to + 1);
    }
    for (const link of row.bottomLinks) {
      columns = Math.max(columns, link.from + 1, link.to + 1);
    }
  }
  return columns;
}

/** 该行涉及的最右泳道（节点 + 上下连线） */
function rowOuterCol(row: GraphRow): number {
  let max = row.col;
  for (const l of row.topLinks) max = Math.max(max, l.from, l.to);
  for (const l of row.bottomLinks) max = Math.max(max, l.from, l.to);
  return max;
}

function rowTextLeft(row: GraphRow): number {
  return PAD_L + rowOuterCol(row) * LANE_W + DOT_R + TEXT_GAP;
}

function formatDate(d: string): string {
  try {
    // 跟随应用界面语言（原来硬编码 zh-CN）
    return new Date(d).toLocaleString(getResolvedLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return d;
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function branchLabel(name: string): string {
  return name.replace(/^remotes\//, '');
}

function linkPath(
  fromCol: number,
  toCol: number,
  y0: number,
  y1: number
): string {
  const x0 = PAD_L + fromCol * LANE_W;
  const x1 = PAD_L + toCol * LANE_W;
  if (fromCol === toCol) {
    return `M ${x0} ${y0} L ${x1} ${y1}`;
  }
  const mid = (y0 + y1) / 2;
  return `M ${x0} ${y0} C ${x0} ${mid}, ${x1} ${mid}, ${x1} ${y1}`;
}

function GraphSvg({
  rows,
  columns,
  startIdx,
  endIdx
}: {
  rows: GraphRow[];
  columns: number;
  /** 可见行 [startIdx, endIdx) 半开区间，虚拟滚动时只渲染窗口内 SVG 元素 */
  startIdx: number;
  endIdx: number;
}): React.JSX.Element {
  const width = PAD_L + Math.max(columns, 1) * LANE_W + GRAPH_PAD_R;
  const totalH = Math.max(rows.length * ROW_H, ROW_H);
  const parts: React.ReactNode[] = [];

  const lo = Math.max(0, startIdx);
  const hi = Math.min(rows.length, endIdx);

  const drawLinks = (links: GraphLink[], y0: number, y1: number, keyPrefix: string) => {
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      parts.push(
        <path
          key={`${keyPrefix}-${i}-${link.from}-${link.to}`}
          d={linkPath(link.from, link.to, y0, y1)}
          stroke={link.color}
          strokeWidth={1.6}
          fill="none"
        />
      );
    }
  };

  for (let y = lo; y < hi; y++) {
    const row = rows[y];
    const yTop = y * ROW_H;
    const yMid = yTop + ROW_H / 2;
    const yBot = yTop + ROW_H;
    drawLinks(row.topLinks, yTop, yMid, `t${y}`);
    drawLinks(row.bottomLinks, yMid, yBot, `b${y}`);
    const cx = PAD_L + row.col * LANE_W;
    parts.push(
      <circle
        key={`d${y}`}
        cx={cx}
        cy={yMid}
        r={DOT_R}
        fill={row.color}
        stroke="var(--canvas)"
        strokeWidth={1.5}
      />
    );
  }

  return (
    <svg className="git-hist-svg" width={width} height={totalH}>
      {parts}
    </svg>
  );
}

/** HEAD | --all | 本地分支名 */
type HistScope = string;

export function GitHistory({
  repoPath,
  currentBranch,
  active
}: {
  repoPath: string;
  currentBranch?: string;
  active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const git = useScopedGit();
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [branchHeads, setBranchHeads] = useState<GitGraphBranch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<HistScope>('HEAD');
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeQuery, setScopeQuery] = useState('');
  const [files, setFiles] = useState<GitFileChange[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  /** 虚拟滚动可见行范围 [visibleStart, visibleEnd) */
  const [visibleStart, setVisibleStart] = useState(0);
  const [visibleEnd, setVisibleEnd] = useState(PAGE);
  const loadingMore = useRef(false);
  const repoRef = useRef(repoPath);
  const scopeRef = useRef(scope);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scopeMenuRef = useRef<HTMLDivElement | null>(null);
  const filesGen = useRef(0);
  const diffGen = useRef(0);
  const historyGen = useRef(0);

  /** 根据 scrollTop / clientHeight 更新可见行范围（虚拟滚动） */
  const updateVisibleRange = useCallback((el: HTMLElement) => {
    const top = el.scrollTop;
    const h = el.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW_H) - VIRTUAL_OVERSCAN);
    const end = Math.min(
      commits.length,
      Math.ceil((top + h) / ROW_H) + VIRTUAL_OVERSCAN
    );
    setVisibleStart((prev) => (prev !== start ? start : prev));
    setVisibleEnd((prev) => (prev !== end ? end : prev));
  }, [commits.length]);

  // commits 变化时重算可见范围（切仓/翻页后可见区可能失效）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) updateVisibleRange(el);
  }, [commits.length, updateVisibleRange]);

  const clearDetail = useCallback(() => {
    setFiles([]);
    setFilesError(null);
    setFilesLoading(false);
    setSelectedFile(null);
    setDiffText('');
    setDiffError(null);
  }, []);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const loadBranches = useCallback(async (path: string) => {
    try {
      const list = await git.listBranches(path);
      setLocalBranches(list.local.map((b) => b.name));
    } catch {
      setLocalBranches([]);
    }
  }, [git]);

  const loadInitial = useCallback(async (path: string, ref: HistScope) => {
    const request = ++historyGen.current;
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const page = await git.log(path, 0, PAGE, ref);
      if (request !== historyGen.current) return;
      setCommits(page.commits);
      setBranchHeads(page.branchHeads);
      setHasMore(page.hasMore);
      // 初始化 graph：用 appendCommits 从空 state 累积，同时拿到 rows 和 lanes 末态
      const { newRows, state } = appendCommits(
        page.commits.map((c) => ({
          hash: c.sha,
          parents: c.parents.map((p) => p.sha)
        })),
        emptyGraphState()
      );
      graphStateRef.current = state;
      setGraphRows(newRows);
      setGraphColumns(computeMaxColumns(newRows));
    } catch (err) {
      if (request !== historyGen.current) return;
      setCommits([]);
      setBranchHeads([]);
      setHasMore(false);
      setError(String(err));
      graphStateRef.current = emptyGraphState();
      setGraphRows([]);
      setGraphColumns(0);
    } finally {
      if (request === historyGen.current) setLoading(false);
    }
  }, [git]);

  useEffect(() => {
    repoRef.current = repoPath;
    setScope('HEAD');
    setScopeOpen(false);
    setScopeQuery('');
    setSelected(null);
    clearDetail();
    // 重置增量 graph 状态，避免上次仓的 lanes 污染新仓
    graphStateRef.current = emptyGraphState();
    setGraphRows([]);
    setGraphColumns(0);
    setVisibleStart(0);
    setVisibleEnd(PAGE);
  }, [repoPath, clearDetail]);

  useEffect(() => {
    if (!active) {
      setSelected(null);
      setError(null);
      clearDetail();
      return;
    }
    void loadBranches(repoPath);
    void loadInitial(repoPath, scope);
    return () => { historyGen.current += 1; };
  }, [repoPath, active, scope, loadInitial, loadBranches, clearDetail]);

  useEffect(() => {
    if (!active || !selected) return;
    const commitFiles = git?.commitFiles;
    if (typeof commitFiles !== 'function') {
      setFilesError(t('Git API 未就绪，请重启应用'));
      setFilesLoading(false);
      return;
    }
    const gen = ++filesGen.current;
    setFilesLoading(true);
    setFilesError(null);
    setFiles([]);
    setSelectedFile(null);
    setDiffText('');
    setDiffError(null);
    void commitFiles(repoPath, selected)
      .then((res) => {
        if (filesGen.current !== gen) return;
        const mapped: GitFileChange[] = (res.files ?? []).map((f) => ({
          path: f.path,
          index: (f.status && f.status[0]) || 'M',
          working_dir: ' '
        }));
        setFiles(mapped);
        setSelectedFile(mapped[0]?.path ?? null);
      })
      .catch((err) => {
        if (filesGen.current !== gen) return;
        setFiles([]);
        setFilesError(String(err));
      })
      .finally(() => {
        if (filesGen.current === gen) setFilesLoading(false);
      });
  }, [git, active, selected, repoPath]);

  useEffect(() => {
    if (!active || !selected || !selectedFile) {
      setDiffText('');
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    const commitDiff = git?.commitDiff;
    if (typeof commitDiff !== 'function') {
      setDiffError(t('Git API 未就绪，请重启应用'));
      return;
    }
    const gen = ++diffGen.current;
    setDiffError(null);
    setDiffLoading(true);
    void commitDiff(repoPath, selected, selectedFile)
      .then((res) => {
        if (diffGen.current !== gen) return;
        setDiffText(res.diff ?? '');
        setDiffLoading(false);
      })
      .catch((err) => {
        if (diffGen.current !== gen) return;
        setDiffText('');
        setDiffError(String(err));
        setDiffLoading(false);
      });
  }, [git, active, selected, selectedFile, repoPath]);

  useEffect(() => {
    if (!scopeOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (!scopeMenuRef.current?.contains(e.target as Node)) setScopeOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [scopeOpen]);

  const filteredLocals = useMemo(() => {
    const q = scopeQuery.trim().toLowerCase();
    if (!q) return localBranches;
    return localBranches.filter((n) => n.toLowerCase().includes(q));
  }, [localBranches, scopeQuery]);

  const pickScope = (v: HistScope) => {
    setScope(v);
    setScopeOpen(false);
    setScopeQuery('');
  };

  const onSelectCommit = (sha: string) => {
    if (selected === sha) {
      setSelected(null);
      clearDetail();
      return;
    }
    setSelected(sha);
  };

  const commitNavIds = useMemo(() => commits.map((c) => c.sha), [commits]);
  const { onListKeyDown: onCommitListKeyDown, getItemProps: getCommitItemProps } =
    useListKeyboardNav({
      items: commitNavIds,
      selectedId: selected,
      // Keyboard must not toggle-deselect when Arrow stays on same row (boundary).
      onSelect: setSelected
    });

  // 增量 graph 状态：保留 lanes，翻页时只对新 commit 生成新行，避免全量重算。
  // 切仓 / 切 scope 时重置为空，由 loadInitial 重新填充。
  const [graphRows, setGraphRows] = useState<GraphRow[]>([]);
  const [graphColumns, setGraphColumns] = useState(0);
  const graphStateRef = useRef<GraphIncrementalState>(emptyGraphState());

  const loadMore = useCallback(() => {
    if (!active || loadingMore.current || !hasMore) return;
    loadingMore.current = true;
    const path = repoRef.current;
    const ref = scopeRef.current;
    const request = historyGen.current;
    const skip = commits.length;
    void git
      .log(path, skip, PAGE, ref)
      .then((page) => {
        if (historyGen.current !== request || repoRef.current !== path || scopeRef.current !== ref) return;
        setCommits((prev) => {
          const seen = new Set(prev.map((c) => c.sha));
          const fresh = page.commits.filter((c) => !seen.has(c.sha));
          // 增量追加 graph 行：复用上次 lanes 状态，只算新 commit
          if (fresh.length > 0) {
            const { newRows, state } = appendCommits(
              fresh.map((c) => ({
                hash: c.sha,
                parents: c.parents.map((p) => p.sha)
              })),
              graphStateRef.current
            );
            graphStateRef.current = state;
            setGraphRows((prevRows) => {
              const all = [...prevRows, ...newRows];
              setGraphColumns(computeMaxColumns(all));
              return all;
            });
          }
          return [...prev, ...fresh];
        });
        setBranchHeads(page.branchHeads);
        setHasMore(page.hasMore);
      })
      .catch((err) => { if (historyGen.current === request) setError(String(err)); })
      .finally(() => {
        loadingMore.current = false;
      });
  }, [git, active, hasMore, commits.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateVisibleRange(el);
    if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 120) loadMore();
  }, [hasMore, loadMore]);

  const graphWidth = PAD_L + Math.max(graphColumns, 1) * LANE_W + GRAPH_PAD_R;

  const headsBySha = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of branchHeads) {
      const list = m.get(b.commit.sha) ?? [];
      list.push(b.name);
      m.set(b.commit.sha, list);
    }
    return m;
  }, [branchHeads]);

  const selectedCommit = useMemo(
    () => (selected ? commits.find((c) => c.sha === selected) ?? null : null),
    [commits, selected]
  );
  const selectedMsg = selectedCommit?.commit.message.split('\n')[0] || '';

  if (!active) return <div className="git-history-pane" />;

  const scopeLabel =
    scope === 'HEAD'
      ? currentBranch
        ? t('当前（{{branch}}）', { branch: currentBranch })
        : t('当前分支')
      : scope === '--all'
        ? t('所有分支')
        : scope;

  const commitList = (
    <div className="git-hist-list-wrap">
      {loading && commits.length === 0 ? (
        <div className="empty-hint"><BrandLoading>{t('加载提交历史…')}</BrandLoading></div>
      ) : commits.length === 0 ? (
        error ? null : <div className="empty-hint">{t('暂无提交')}</div>
      ) : (
        <div
          ref={scrollRef}
          className="git-history-scroll"
          tabIndex={0}
          onScroll={onScroll}
          onKeyDown={onCommitListKeyDown}
        >
          <div className="git-hist-body" style={{ minHeight: commits.length * ROW_H }}>
            <div
              className="git-hist-graph"
              style={{ width: graphWidth, height: commits.length * ROW_H }}
            >
              <GraphSvg
                rows={graphRows}
                columns={graphColumns}
                startIdx={visibleStart}
                endIdx={visibleEnd}
              />
            </div>
            <div className="git-hist-rows">
              {/* 虚拟滚动：上下用空 div 占位，只渲染可见窗口内的行，避免改 CSS 定位 */}
              <div style={{ height: visibleStart * ROW_H }} aria-hidden />
              {commits.slice(visibleStart, visibleEnd).map((c, i) => {
                const y = visibleStart + i;
                const row = graphRows[y];
                const msg = c.commit.message.split('\n')[0] || '';
                const author = c.commit.author.name;
                const date = formatDate(c.commit.author.date);
                const sha = shortSha(c.sha);
                const textLeft = row ? rowTextLeft(row) : graphWidth;
                const branches = (headsBySha.get(c.sha) ?? [])
                  .slice()
                  .sort((a, b) => {
                    const score = (n: string) => {
                      if (
                        currentBranch &&
                        (n === currentBranch || n.endsWith('/' + currentBranch))
                      )
                        return 0;
                      if (n.startsWith('remotes/')) return 2;
                      return 1;
                    };
                    return score(a) - score(b) || a.localeCompare(b);
                  });
                const isSel = selected === c.sha;

                return (
                  <button
                    key={c.sha}
                    type="button"
                    {...getCommitItemProps(c.sha)}
                    className={`git-hist-row${isSel ? ' is-selected' : ''}`}
                    style={{ height: ROW_H, paddingLeft: textLeft }}
                    onClick={() => onSelectCommit(c.sha)}
                  >
                    <span className="git-hist-main">
                      {branches.slice(0, 3).map((name) => {
                        const cur =
                          !!currentBranch &&
                          (name === currentBranch || name.endsWith('/' + currentBranch));
                        return (
                          <span
                            key={name}
                            className={`git-hist-branch${cur ? ' is-current' : ''}`}
                            style={{
                              borderColor: row?.color ?? 'var(--fg-muted)',
                              color: cur ? 'var(--status-info-fg)' : 'var(--fg-secondary)'
                            }}
                            title={name}
                          >
                            {branchLabel(name)}
                          </span>
                        );
                      })}
                      {branches.length > 3 ? (
                        <span className="git-hist-branch-more">+{branches.length - 3}</span>
                      ) : null}
                      <span className="git-hist-msg" title={msg}>
                        {msg}
                      </span>
                    </span>
                    <span className="git-hist-meta">
                      <span className="git-hist-author" title={author}>
                        {author}
                      </span>
                      <span className="git-hist-sha">{sha}</span>
                      <span className="git-hist-date">{date}</span>
                    </span>
                  </button>
                );
              })}
              <div style={{ height: Math.max(0, (commits.length - visibleEnd) * ROW_H) }} aria-hidden />
            </div>
          </div>
          {hasMore ? <div className="git-hist-more">{t('滚动加载更多…')}</div> : null}
        </div>
      )}
    </div>
  );

  const commitDetail = selected ? (
    <div className="git-hist-detail">
      <div className="git-hist-detail-head">
        <span className="git-hist-sha">{shortSha(selected)}</span>
        <span className="git-hist-msg" title={selectedMsg}>
          {selectedMsg}
        </span>
      </div>
      <SplitPane
        axis="row"
        className="git-hist-detail-body"
        defaultPrimaryRatio={0.38}
        minPrimary={120}
        minSecondary={160}
        reverse
        aria-label={t('拖动调整文件列表与 Diff 宽度')}
      >
        <div className="git-hist-files">
          {filesLoading ? (
            <div className="empty-hint"><BrandLoading>{t('加载变更…')}</BrandLoading></div>
          ) : filesError ? (
            <ErrorTip message={filesError} />
          ) : (
            <GitChangeTree
              files={files}
              zone="staged"
              selectedFile={selectedFile}
              activeZone
              busy={false}
              readOnly
              badgeOf={(f) => f.index.trim() || 'M'}
              onSelectFile={(f) => setSelectedFile(f.path)}
              onTogglePaths={noopPaths}
              repoPath={repoPath}
            />
          )}
        </div>
        <div className="git-hist-diff">
          {diffError ? (
            <ErrorTip message={diffError} />
          ) : (
            <div className="git-diff-scroll">
              <ErrorBoundary label="Commit Diff">
                <FileDiffView diffText={diffText} loading={diffLoading} />
              </ErrorBoundary>
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  ) : null;

  return (
    <div className={`git-history-pane${selected ? ' has-detail' : ''}`}>
      <div className="git-hist-toolbar">
        <span className="git-hist-scope-label">{t('范围')}</span>
        <div className="git-hist-scope-wrap" ref={scopeMenuRef}>
          <button
            type="button"
            className={`git-hist-scope-btn${scopeOpen ? ' is-open' : ''}`}
            title={scopeLabel}
            onClick={() => setScopeOpen((v) => !v)}
          >
            <span className="git-hist-scope-text">{scopeLabel}</span>
            <span className="git-branch-caret" aria-hidden>
              ▾
            </span>
          </button>
          {scopeOpen ? (
            <div className="git-hist-scope-menu">
              <button
                type="button"
                className={`git-hist-scope-option${scope === 'HEAD' ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickScope('HEAD')}
              >
                {currentBranch ? t('当前（{{branch}}）', { branch: currentBranch }) : t('当前分支')}
              </button>
              <button
                type="button"
                className={`git-hist-scope-option${scope === '--all' ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickScope('--all')}
              >
                {t('所有分支')}
              </button>
              <div className="git-hist-scope-group">{t('本地分支')}</div>
              <input
                className="git-hist-scope-search"
                type="search"
                placeholder={t('搜索本地分支…')}
                value={scopeQuery}
                autoFocus
                onChange={(e) => setScopeQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setScopeOpen(false);
                }}
              />
              <div className="git-hist-scope-list">
                {filteredLocals.length === 0 ? (
                  <div className="git-hist-scope-empty">{t('无匹配')}</div>
                ) : (
                  filteredLocals.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`git-hist-scope-option${scope === name ? ' is-active' : ''}`}
                      title={name}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickScope(name)}
                    >
                      <span className="git-hist-scope-option-name">{name}</span>
                      {name === currentBranch ? (
                        <span className="git-hist-scope-badge">{t('当前')}</span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {error ? <ErrorTip message={error} /> : null}
      {selected && commitDetail ? (
        <SplitPane
          axis="column"
          className="git-hist-split-body"
          defaultPrimaryRatio={0.55}
          minPrimary={100}
          minSecondary={120}
          aria-label={t('拖动调整历史与变更高度')}
        >
          {commitList}
          {commitDetail}
        </SplitPane>
      ) : (
        <div className="git-hist-split-body">{commitList}</div>
      )}
    </div>
  );
}
