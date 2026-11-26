import { ErrorTip } from './ErrorTip';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { rankWorkspaceFiles } from '../../../shared/workspaceQuery';
import { sourceRootsFor, workspaceFileKey, workspaceRootLabel } from '../../../shared/workspaceRoots';
import {
  PALETTE_FILTERS,
  collectGotoHits,
  collectSettingsHits,
  cyclePaletteFilter,
  effectivePaletteFilter,
  initialPaletteQuery,
  isPaletteRowEnabled,
  markPreviewHits,
  modeToFilter,
  paletteConfirmAction,
  paletteNeedsContent,
  paletteNeedsFiles,
  parsePaletteQuery,
  setPaletteMode,
  splitHighlight,
  themeGroupsToSettingsItems,
  type GotoHit,
  type PaletteFilter,
  type PaletteMode,
  type SettingsHit,
  type SettingsTabId
} from '../../../shared/commandPalette';
import type { WorkspaceFileRef, WorkspaceQueryRootStatus } from '../../../shared/types';
import { THEME_UI_GROUPS } from '../../../shared/theme';
import {
  eventToChord,
  formatChordSerialized,
  matchKeybindingSearch,
  serializeChord
} from '../../../shared/keybindings';
import { joinUnderRoot } from '../../../shared/workspaceRelPath';
import { useKeybindings, useOverlayDismiss } from '../keybindings/KeybindingHost';
import { useSessionStore, useUiStore, useWorkspaceStore } from '../store';
import { useWorkspaceTransitSwitch } from '../workspaceTransit';
import { jumpToSession } from '../sessionJump';
import type { PresenceStage } from './motion';
import { useQuickOpenContent, useQuickOpenFiles } from './useQuickOpenQueries';

const RESULT_LIMIT = 40;

type GotoItem = { key: string; kind: 'workspace' | 'session'; hit: GotoHit };
type FileItem = { key: string; kind: 'file'; path: string; fileRef: WorkspaceFileRef; absolutePath: string };
type CommandItem = {
  key: string;
  kind: 'command';
  id: string;
  title: string;
  chord: string | null;
  enabled: boolean;
};
type SuggestItem = {
  key: string;
  kind: 'suggest';
  id: 'session.newTask';
  title: string;
  enabled: boolean;
};
type SettingItem = { key: string; kind: 'setting'; hit: SettingsHit };
type ContentItem = {
  key: string;
  kind: 'content';
  path: string;
  line: number;
  preview: string;
  fileRef: WorkspaceFileRef;
};
type NavItem = GotoItem | FileItem | CommandItem | SuggestItem | SettingItem | ContentItem;

function isGotoItem(item: NavItem): item is GotoItem {
  return item.kind === 'workspace' || item.kind === 'session';
}

function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  const parts = splitHighlight(text, query);
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="quick-open-mark">
            {p.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        )
      )}
    </>
  );
}

function fileBaseName(rel: string): string {
  return rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
}

export function QuickOpen({
  workspaceId,
  mode,
  seq,
  stage = 'in',
  onRequestMode,
  onOpenSettings,
  onClose
}: {
  workspaceId: string;
  mode: PaletteMode;
  seq: number;
  /** presence 进出场阶段（App 侧 usePresence 驱动；缺省 in 兼容直接挂载） */
  stage?: PresenceStage;
  onRequestMode: (mode: PaletteMode) => void;
  onOpenSettings: (tab: SettingsTabId, focusId?: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState(() => initialPaletteQuery(mode));
  const [filter, setFilter] = useState<PaletteFilter>(() => modeToFilter(mode));
  const [selection, setSelection] = useState<{ scope: string; key: string | null } | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { sessions, activeId } = useSessionStore();
  const { workspaces, activeWorkspaceId, switchWorkspace: switchDirect } = useWorkspaceStore();
  const switchWorkspace = useWorkspaceTransitSwitch(switchDirect);
  const { requestOpenWorkspaceFile, flashTip } = useUiStore();
  const { rows, handlerEpoch, isActionRegistered, runAction, resolvedChord } = useKeybindings();

  const search = parsePaletteQuery(query).search;
  const activeFilter = effectivePaletteFilter(query, filter);
  const needFiles = paletteNeedsFiles(activeFilter, search);
  const needContent = paletteNeedsContent(activeFilter);
  const workspace = workspaces.find(w => w.id === workspaceId);
  const revision = workspace?.rootsRevision ?? 0;
  let roots: ReturnType<typeof sourceRootsFor> = [];
  try { if (workspace) roots = sourceRootsFor(workspace); } catch { /* 无效配置不提供文件导航 */ }
  const filesQuery = useQuickOpenFiles(workspaceId, revision, needFiles && stage !== 'out' && !!workspace);
  const contentQuery = useQuickOpenContent(workspaceId, revision, needContent && stage !== 'out' && !!workspace, search.trim(), caseSensitive);
  const validRef = (ref: WorkspaceFileRef | undefined): ref is WorkspaceFileRef =>
    !!ref && ref.workspaceId === workspaceId && roots.some(root => root.id === ref.rootId);
  const displayPath = (ref: WorkspaceFileRef): string => {
    const root = roots.find(root => root.id === ref.rootId);
    return roots.length > 1 && root ? `${workspaceRootLabel(root)}/${ref.relativePath}` : ref.relativePath;
  };
  const rootFailures = (statuses?: WorkspaceQueryRootStatus[]): string => statuses?.filter(root => root.error || root.timedOut)
    .map(status => {
      const root = roots.find(root => root.id === status.rootId);
      return root ? `${workspaceRootLabel(root)} (${root.path})` : status.rootId;
    }).join(', ') ?? '';
  const loading = filesQuery.loading;
  const contentLoading = contentQuery.loading;
  const error = filesQuery.error ?? filesQuery.result?.error;
  const contentError = contentQuery.error ?? contentQuery.result?.error;
  const fileFailures = rootFailures(filesQuery.result?.roots);
  const contentFailures = rootFailures(contentQuery.result?.roots);

  useEffect(() => {
    setQuery((q) => setPaletteMode(q, mode));
    setFilter(modeToFilter(mode));
  }, [mode, seq]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const files = (filesQuery.result?.items ?? []).filter(file => validRef(file.fileRef));
  const ranked = needFiles ? rankWorkspaceFiles(files, search, RESULT_LIMIT) : [];
  const contentHits = (contentQuery.result?.items ?? []).filter(hit => validRef(hit.fileRef));

  const commandHits = useMemo(() => {
    void handlerEpoch;
    return matchKeybindingSearch(search, rows).map((row) => ({
      ...row,
      enabled: isPaletteRowEnabled(row.id, isActionRegistered(row.id))
    }));
  }, [search, rows, handlerEpoch, isActionRegistered]);

  const themeSettingItems = useMemo(() => themeGroupsToSettingsItems(THEME_UI_GROUPS), []);
  const settingsHits = useMemo(
    () => collectSettingsHits(search, themeSettingItems),
    [search, themeSettingItems]
  );

  const gotoHits = useMemo(
    () => collectGotoHits(workspaces, sessions, search, activeWorkspaceId, activeId),
    [workspaces, sessions, search, activeWorkspaceId, activeId]
  );

  const resultItems = useMemo((): NavItem[] => {
    const items: NavItem[] = [];
    const wantWs = activeFilter === 'all' || activeFilter === 'workspaces';
    const wantSess = activeFilter === 'all' || activeFilter === 'sessions';
    const wantFiles = activeFilter === 'files' || (activeFilter === 'all' && !!search.trim());
    const wantCmd = activeFilter === 'commands' || (activeFilter === 'all' && !!search.trim());
    const wantSettings = activeFilter === 'settings' || (activeFilter === 'all' && !!search.trim());
    const wantContent = activeFilter === 'content';

    if (wantWs) {
      for (const hit of gotoHits.workspaces) {
        items.push({ key: `ws:${hit.id}`, kind: 'workspace', hit });
      }
    }
    if (wantSess) {
      for (const hit of gotoHits.sessions) {
        items.push({ key: `sess:${hit.id}`, kind: 'session', hit });
      }
    }
    if (wantCmd) {
      for (const row of commandHits) {
        items.push({
          key: `cmd:${row.id}`,
          kind: 'command',
          id: row.id,
          title: row.title,
          chord: row.chord,
          enabled: row.enabled
        });
      }
    }
    if (wantSettings) {
      for (const hit of settingsHits) {
        items.push({ key: `set:${hit.id}`, kind: 'setting', hit });
      }
    }
    if (wantFiles) {
      for (const file of ranked) {
        items.push({ key: `file:${workspaceFileKey(file.fileRef)}`, kind: 'file', path: file.path, fileRef: file.fileRef, absolutePath: file.absolutePath });
      }
    }
    if (wantContent) {
      for (let i = 0; i < contentHits.length; i++) {
        const hit = contentHits[i]!;
        items.push({
          key: `content:${workspaceFileKey(hit.fileRef)}:${hit.line}:${i}`,
          kind: 'content',
          path: hit.path,
          line: hit.line,
          preview: hit.preview,
          fileRef: hit.fileRef
        });
      }
    }
    return items;
  }, [activeFilter, gotoHits, commandHits, settingsHits, ranked, search, contentHits]);

  const suggestNewTask =
    (activeFilter === 'all' || activeFilter === 'sessions') &&
    isActionRegistered('session.newTask');

  const suggestItems = useMemo((): SuggestItem[] => {
    if (!suggestNewTask) return [];
    const q = search.trim();
    return [
      {
        key: 'suggest:new-task',
        kind: 'suggest',
        id: 'session.newTask',
        title: q ? t('新建任务：「{{q}}」', { q }) : t('新建任务'),
        enabled: true
      }
    ];
  }, [suggestNewTask, search, t]);

  const navItems = useMemo(
    () => [...resultItems, ...suggestItems],
    [resultItems, suggestItems]
  );

  const selectionScope = JSON.stringify([workspaceId, revision, query, activeFilter, seq]);
  const selectedIdx = selection?.scope === selectionScope && selection.key !== null
    ? navItems.findIndex(item => item.key === selection.key) : -1;
  // 新范围或候选消失时在渲染中复位，避免晚到的 effect 覆盖刚按下的方向键。
  if (selection?.scope !== selectionScope || (selection.key !== null && selectedIdx < 0)) {
    setSelection({ scope: selectionScope, key: null });
  }
  const activeIdx = Math.max(0, selectedIdx);
  const selectIndex = (index: number): void => {
    setSelection({ scope: selectionScope, key: navItems[index]?.key ?? null });
  };
  const moveSelection = (delta: number): void => {
    setSelection(current => {
      const index = current?.scope === selectionScope && current.key !== null
        ? navItems.findIndex(item => item.key === current.key) : -1;
      const next = Math.max(0, Math.min(Math.max(0, index) + delta, navItems.length - 1));
      return { scope: selectionScope, key: navItems[next]?.key ?? null };
    });
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, activeFilter]);

  const pickFile = useCallback(
    (ref: WorkspaceFileRef, line?: number, source: 'preview' | 'keep' = 'keep') => {
      const ws = workspaces.find(w => w.id === workspaceId);
      if (!ws || activeWorkspaceId !== workspaceId) {
        flashTip(t('请先打开工作区'));
        return;
      }
      const root = sourceRootsFor(ws).find(root => root.id === ref.rootId);
      if (!root || ref.workspaceId !== ws.id) return;
      requestOpenWorkspaceFile({ path: joinUnderRoot(root.path, ref.relativePath), fileRef: ref, source, scope: 'workspace', replacePreview: source === 'keep', ...(line ? { line } : {}) });
      if (source === 'keep') onClose();
    },
    [workspaces, workspaceId, activeWorkspaceId, flashTip, requestOpenWorkspaceFile, onClose, t]
  );

  const pickGoto = useCallback(
    (hit: GotoHit) => {
      onClose();
      if (hit.kind === 'workspace') {
        if (hit.id === activeWorkspaceId) return;
        void (async () => {
          const r = await switchWorkspace(hit.id);
          if (!r.ok) flashTip(t('无法跳转：{{message}}', { message: r.message ?? t('工作区可能已关闭') }));
        })();
        return;
      }
      void (async () => {
        const s = sessions.find((x) => x.id === hit.id);
        const r = await jumpToSession({
          sessionId: hit.id,
          workspaceId: s?.workspaceId,
          activeWorkspaceId,
          switchWorkspace
        });
        if (!r.ok) {
          flashTip(t('无法跳转：{{message}}', { message: r.message ?? t('工作区可能已关闭') }));
        }
      })();
    },
    [onClose, activeWorkspaceId, switchWorkspace, flashTip, sessions, t]
  );

  const runCommand = useCallback(
    (id: string, enabled: boolean) => {
      if (!enabled) return;
      const action = paletteConfirmAction(id);
      if (action.kind === 'switch-mode') {
        onRequestMode(action.mode);
        return;
      }
      if (action.kind === 'close') {
        onClose();
        return;
      }
      if (runAction(id)) onClose();
    },
    [onRequestMode, onClose, runAction]
  );

  const activate = useCallback(
    (item: NavItem, source: 'preview' | 'keep' = 'keep') => {
      if (isGotoItem(item)) {
        pickGoto(item.hit);
        return;
      }
      if (item.kind === 'file') {
        pickFile(item.fileRef, undefined, source);
        return;
      }
      if (item.kind === 'content') {
        pickFile(item.fileRef, item.line, source);
        return;
      }
      if (item.kind === 'command') {
        runCommand(item.id, item.enabled);
        return;
      }
      if (item.kind === 'setting') {
        onOpenSettings(item.hit.tab, item.hit.id);
        onClose();
        return;
      }
      if (item.enabled && runAction(item.id)) onClose();
    },
    [pickGoto, pickFile, runCommand, runAction, onOpenSettings, onClose]
  );

  useOverlayDismiss(stage !== 'out', onClose);

  const gotoChord = resolvedChord('palette.goto');
  const fileChord = resolvedChord('files.quickOpen');
  const contentChord = resolvedChord('files.findInFiles');

  const filePending = needFiles && loading;
  const emptyHint =
    activeFilter === 'content'
      ? t('无匹配内容')
      : activeFilter === 'files'
        ? t('无匹配文件')
        : activeFilter === 'commands'
          ? t('无匹配命令')
          : activeFilter === 'settings'
            ? t('无匹配设置项')
            : t('无匹配结果');

  return createPortal(
    <div
      className="quick-open-mask mp-fly-overlay"
      data-mp-stage={stage}
      role="presentation"
      {...(stage === 'out' ? { inert: '' } : {})}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mp-scrim-layer backdrop-blur-overlay mp-scrim" data-mp-stage={stage} aria-hidden />
      <div
        className="quick-open mp-panel mp-panel-fly"
        data-mp-stage={stage}
        role="dialog"
        aria-label={t('搜索')}
      >
        <input
          ref={inputRef}
          className="quick-open-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-listbox"
          aria-activedescendant={
            navItems[activeIdx] ? `quick-open-opt-${activeIdx}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder={
            activeFilter === 'content'
              ? t('搜索所有文件内容…')
              : t('搜索会话、工作区、文件、内容、命令、设置…')
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const chord = eventToChord(e);
            const serialized = chord ? serializeChord(chord) : '';
            if (serialized && gotoChord && serialized === gotoChord) {
              e.preventDefault();
              e.stopPropagation();
              onRequestMode('goto');
              return;
            }
            if (serialized && fileChord && serialized === fileChord) {
              e.preventDefault();
              e.stopPropagation();
              onRequestMode('file');
              return;
            }
            if (serialized && contentChord && serialized === contentChord) {
              e.preventDefault();
              e.stopPropagation();
              onRequestMode('content');
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              setQuery((q) => parsePaletteQuery(q).search);
              setFilter((cur) =>
                cyclePaletteFilter(effectivePaletteFilter(query, cur), e.shiftKey ? -1 : 1)
              );
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              moveSelection(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              moveSelection(-1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const hit = navItems[activeIdx];
              if (hit) activate(hit);
            }
          }}
        />
        <div className="quick-open-tabs" role="tablist" aria-label={t('筛选')}>
          {PALETTE_FILTERS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeFilter === tab.id}
              className={`quick-open-tab${activeFilter === tab.id ? ' is-active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery((q) => parsePaletteQuery(q).search);
                setFilter(tab.id);
              }}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
        <div className="quick-open-list" ref={listRef} role="listbox" id="quick-open-listbox">
          <div className="quick-open-section-title">{t('结果')}</div>
          {filePending || (needContent && contentLoading) ? (
            <div
              className="quick-open-loading"
              role="status"
              aria-label={filePending ? t('枚举文件中…') : t('搜索中…')}
            >
              <span className="quick-open-loading-label">
                {filePending ? t('枚举文件中…') : t('搜索中…')}
              </span>
              <div className="ws-skel-block quick-open-loading-row w90" />
              <div className="ws-skel-block quick-open-loading-row w70" />
              <div className="ws-skel-block quick-open-loading-row w82" />
              <div className="ws-skel-block quick-open-loading-row w60" />
            </div>
          ) : null}
          {needFiles && error ? <ErrorTip message={error} /> : null}
          {needFiles && fileFailures ? <ErrorTip message={t('部分文件夹搜索失败：{{folders}}', { folders: fileFailures })} /> : null}
          {needFiles && filesQuery.result?.truncated ? <div className="quick-open-hint">{t('搜索结果已截断，请缩小范围')}</div> : null}
          {needContent && contentError ? <ErrorTip message={contentError} /> : null}
          {needContent && contentFailures ? <ErrorTip message={t('部分文件夹搜索失败：{{folders}}', { folders: contentFailures })} /> : null}
          {needContent && contentQuery.result?.truncated ? <div className="quick-open-hint">{t('搜索结果已截断，请缩小范围')}</div> : null}
          {resultItems.length === 0 &&
          !filePending &&
          !loading &&
          !(needContent && contentLoading) ? (
            <div className="quick-open-hint">
              {needContent && !search.trim() ? t('输入关键字开始搜索') : emptyHint}
            </div>
          ) : null}
          {resultItems.map((item, idx) => {
            const disabled = item.kind === 'command' && !item.enabled;
            const stacked = item.kind === 'content';
            return (
              <button
                key={item.key}
                type="button"
                id={`quick-open-opt-${idx}`}
                data-idx={idx}
                role="option"
                aria-selected={idx === activeIdx}
                aria-disabled={disabled}
                className={`quick-open-item${stacked ? '' : ' is-row'}${
                  idx === activeIdx ? ' is-active' : ''
                }${disabled ? ' is-disabled' : ''}`}
                onMouseEnter={() => selectIndex(idx)}
                onClick={() => activate(item, 'preview')}
                onDoubleClick={() => activate(item, 'keep')}
              >
                {isGotoItem(item) ? (
                  <>
                    <span className="quick-open-item-name">
                      <Highlighted text={item.hit.title} query={search} />
                      {item.hit.current ? t(' · 当前') : ''}
                    </span>
                    <span className="quick-open-item-meta">{item.hit.detail}</span>
                  </>
                ) : item.kind === 'file' ? (
                  <>
                    <span className="quick-open-item-name">
                      <Highlighted text={fileBaseName(item.path)} query={search} />
                    </span>
                    <span className="quick-open-item-meta" title={item.absolutePath}>{displayPath(item.fileRef)}</span>
                  </>
                ) : item.kind === 'command' ? (
                  <>
                    <span className="quick-open-item-name">
                      <Highlighted text={item.title} query={search} />
                    </span>
                    {item.chord ? (
                      <span className="quick-open-item-meta">{formatChordSerialized(item.chord)}</span>
                    ) : null}
                  </>
                ) : item.kind === 'setting' ? (
                  <>
                    <span className="quick-open-item-name">
                      <Highlighted text={item.hit.title} query={search} />
                    </span>
                    <span className="quick-open-item-meta">{item.hit.detail}</span>
                  </>
                ) : item.kind === 'content' ? (
                  <>
                    <span className="quick-open-item-name">
                      <Highlighted text={fileBaseName(item.path)} query={search} />
                    </span>
                    <span className="quick-open-item-path">
                      {displayPath(item.fileRef)}:{item.line}
                    </span>
                    <span className="quick-open-item-preview">
                      {markPreviewHits(item.preview, search, caseSensitive).map((p, i) =>
                        p.mark ? (
                          <mark key={i}>{p.text}</mark>
                        ) : (
                          <React.Fragment key={i}>{p.text}</React.Fragment>
                        )
                      )}
                    </span>
                  </>
                ) : null}
              </button>
            );
          })}
          {suggestItems.length > 0 ? (
            <>
              <div className="quick-open-section-title">{t('建议')}</div>
              {suggestItems.map((item, i) => {
                const idx = resultItems.length + i;
                return (
                  <button
                    key={item.key}
                    type="button"
                    id={`quick-open-opt-${idx}`}
                    data-idx={idx}
                    role="option"
                    aria-selected={idx === activeIdx}
                    className={`quick-open-item is-row${idx === activeIdx ? ' is-active' : ''}`}
                    onMouseEnter={() => selectIndex(idx)}
                    onClick={() => activate(item, 'preview')}
                onDoubleClick={() => activate(item, 'keep')}
                  >
                    <span className="quick-open-item-name">+ {item.title}</span>
                  </button>
                );
              })}
            </>
          ) : null}
        </div>
        <div className="quick-open-footer">
          {needContent ? (
            <button
              type="button"
              className={`quick-open-case${caseSensitive ? ' is-on' : ''}`}
              aria-pressed={caseSensitive}
              title={t('区分大小写')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
          ) : null}
          <span>
            <kbd>↑↓</kbd> {t('选择')}
          </span>
          <span>
            <kbd>Enter</kbd> {t('打开')}
          </span>
          <span>
            <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> {t('切换分类')}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
