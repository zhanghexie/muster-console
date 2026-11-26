import { ErrorTip } from './ErrorTip';
import { BrandLoading } from './BrandLoader';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useFileRootUse } from '../hooks/useFileRootUse';
import { isWebGateway } from '../webGatewayEnvironment';
import { t } from '../../../shared/i18n';
import {
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Text
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  WidgetType,
  type DecorationSet
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { cpp } from '@codemirror/lang-cpp';
import { languageIdForPath, type EditorLanguageId } from '../../../shared/editorLanguages';
import type { WorkspaceFileRef } from '../../../shared/types';
import {
  isParsePreviewKind,
  isTextPreviewKind,
  previewKindForPath
} from '../../../shared/filePreview';
import { HtmlFilePreview } from './HtmlFilePreview';
import { PeekPointerShield } from './PeekPointerShield';
import { resolveDocLink, joinUnderRoot } from '../../../shared/workspaceRelPath';
import type { FsChangedPayload, FsDirEntry, FsWriteResult } from '../../../shared/types';
import { requireSourceRoot, workspaceFileKey } from '../../../shared/workspaceRoots';
import { useAutoSave, type AutoSaveStatus } from '../hooks/useAutoSave';
import { registerFileNoteSource } from '../agentChat/noteBridge';
import {
  promoteNoteAnchor,
  unwrapNoteAnchor,
  wrapNoteAnchor
} from '../agentChat/noteAnchors';
import { openFileNoteEdit } from './fileNoteEntry';
import {
  placePendingFileNoteMarkCM,
  placePendingFileNoteMarkPreview,
  registerFileNoteMarks
} from './fileNoteMarks';
import { MarkdownBody } from './MarkdownBody';
import { FileMediaPreview } from './FileMediaPreview';
import { FileDocPreview } from './FileDocPreview';
import { FileTypeIcon } from './FileTypeIcon';
import { FindFloatBar } from './FindFloatBar';
import { IconFolder, IconFile, IconLocate, IconPencil, IconEye, IconGlobe, IconSearch, IconCopy, IconSave, IconLayout } from './icons';
import { AppLogo } from './AppLogo';
import { workbenchAppearanceTheme, workbenchEditorTheme, workbenchSyntaxHighlighting } from '../editor/workbenchCmTheme';
import { getResolvedAppearance, subscribeAppearance } from '../theme';
import { useWorkspaceStore } from '../store';
import { registerFileEditorState } from '../fileEditorState';
import { MOTION, usePresence } from './motion';

type ViewMode = 'edit' | 'preview';
type MdHtmlKind = 'markdown' | 'html';
type MarkdownHeading = { id: string; level: number; text: string };

function collectMarkdownHeadings(root: HTMLElement): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
    const text = (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const id = `md-heading-${headings.length + 1}`;
    heading.id = id;
    headings.push({ id, level: Number(heading.tagName.slice(1)), text });
  }
  return headings;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ---------- 当前文件内查找（Ctrl+F）：命中高亮走 CM Decoration，无新增依赖 ---------- */

/** 命中数上限：防超长文件爆装饰节点；超出只高亮前 N 条 */
const MAX_FIND_MATCHES = 2000;

type FindMatch = { from: number; to: number };

function findMatchesInDoc(
  doc: Text,
  query: string,
  caseSensitive: boolean
): FindMatch[] {
  const q = caseSensitive ? query : query.toLowerCase();
  if (!q) return [];
  const out: FindMatch[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = caseSensitive ? line.text : line.text.toLowerCase();
    let idx = 0;
    while (out.length < MAX_FIND_MATCHES) {
      const hit = text.indexOf(q, idx);
      if (hit < 0) break;
      out.push({ from: line.from + hit, to: line.from + hit + q.length });
      idx = hit + q.length;
    }
    if (out.length >= MAX_FIND_MATCHES) break;
  }
  return out;
}

function buildFindDecorations(matches: FindMatch[], activeIdx: number): DecorationSet {
  if (matches.length === 0) return Decoration.none;
  const ranges = matches.map((m, i) =>
    Decoration.mark({
      class: i === activeIdx ? 'cm-find-match is-active' : 'cm-find-match'
    }).range(m.from, m.to)
  );
  return RangeSet.of(ranges);
}

/** 由 React 侧计算命中后整包下发（文档编辑时随 docChanged 重算） */
const setFindMatches = StateEffect.define<DecorationSet>();

/** 跳转目标行高亮闪烁（revealLine 应用时下发；行号 1-based，null=熄灭） */
const flashLineEffect = StateEffect.define<number | null>();
const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        if (e.value == null) return Decoration.none;
        const line = tr.state.doc.line(Math.min(Math.max(1, e.value), tr.state.doc.lines));
        return Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(line.from)]);
      }
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f)
});

const findDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFindMatches)) next = e.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

// ---- 文件批注标记：文件批注的文件内留痕（与会话批注角标同款观感） ----

interface FileNoteMark {
  /** 待定期为标记 key，确认后为批注 id */
  id: string;
  from: number;
  to: number;
  pending: boolean;
  /** 批注序号（确认后回填；驱动尾部计数角标） */
  seq: number | null;
}

const addNoteMarkEffect = StateEffect.define<FileNoteMark>();
const resolveNoteMarkEffect = StateEffect.define<{ from: string; to: string; seq: number }>();
const removeNoteMarkEffect = StateEffect.define<string>();

/** 批注计数角标（缀在被批注文字末尾，同会话角标观感）；点击开二次编辑气泡 */
class NoteBadgeWidget extends WidgetType {
  constructor(
    readonly noteId: string,
    readonly seq: number
  ) {
    super();
  }
  override eq(other: NoteBadgeWidget): boolean {
    return other.noteId === this.noteId && other.seq === this.seq;
  }
  override toDOM(): HTMLElement {
    const b = document.createElement('span');
    b.className = 'msg-note-badge is-inline';
    b.textContent = String(this.seq);
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFileNoteEdit(this.noteId);
    });
    return b;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const noteMarksField = StateField.define<FileNoteMark[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(addNoteMarkEffect)) {
        next = next.filter((m) => m.id !== e.value.id);
        next = [...next, e.value];
      } else if (e.is(resolveNoteMarkEffect)) {
        next = next.map((m) =>
          m.id === e.value.from ? { ...m, id: e.value.to, pending: false, seq: e.value.seq } : m
        );
      } else if (e.is(removeNoteMarkEffect)) {
        next = next.filter((m) => m.id !== e.value);
      }
    }
    if (tr.docChanged) {
      next = next.map((m) => ({
        ...m,
        from: tr.changes.mapPos(m.from),
        to: tr.changes.mapPos(m.to)
      }));
    }
    return next === value && !tr.docChanged ? value : next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (marks) => {
      if (!marks.length) return Decoration.none;
      const specs: Array<{ deco: Decoration; from: number; to: number }> = [];
      for (const m of marks) {
        const lo = Math.min(m.from, m.to);
        const hi = Math.max(m.from, m.to);
        specs.push({
          deco: Decoration.mark({
            class: `msg-note-anchor${m.pending ? ' is-pending' : ''}`,
            attributes: { 'data-note-id': m.id }
          }),
          from: lo,
          to: hi
        });
        if (m.seq != null) {
          specs.push({
            deco: Decoration.widget({
              widget: new NoteBadgeWidget(m.id, m.seq),
              side: 1
            }),
            from: hi,
            to: hi
          });
        }
      }
      return Decoration.set(
        specs.map((s) => s.deco.range(s.from, s.to)),
        true
      );
    })
});

function languageExtension(id: EditorLanguageId) {
  switch (id) {
    case 'javascript':
      return javascript();
    case 'typescript':
      return javascript({ typescript: true });
    case 'json':
      return json();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    case 'css':
      return css();
    case 'html':
      return html();
    case 'cpp':
      return cpp();
    default:
      return [];
  }
}

function mdHtmlKindForPath(filePath: string | null): MdHtmlKind | null {
  if (!filePath) return null;
  const id = languageIdForPath(filePath);
  if (id === 'markdown') return 'markdown';
  if (id === 'html') return 'html';
  return null;
}

function statusLabel(status: AutoSaveStatus): string | null {
  if (status === 'saving') return t('保存中…');
  if (status === 'saved') return t('已保存');
  if (status === 'error') return t('保存失败');
  return null;
}

export type FileEditorHandle = {
  flush: () => Promise<void>;
  /** 查找条已开着时，把焦点拉回输入框（重复 Ctrl+F 用） */
  focusFindBar: () => void;
};

export const FileEditor = forwardRef<
  FileEditorHandle,
  {
    workspaceId: string;
    rootId?: string;
    path: string | null;
    revealLine?: number | null;
    revealNonce?: number;
    active?: boolean;
    compactToolbar?: boolean;
    toolbarHost?: HTMLElement | null;
    locationHost?: HTMLElement | null;
    onKeep?: () => void;
    onFind?: () => void;
    /** path 是目录：渲染文件夹概览（子目录/文件计数 + 子项列表）而非编辑器 */
    isDirectory?: boolean;
    /** path 是工作区外的绝对路径：只读预览（readExternal，无编辑/保存/树定位） */
    isExternal?: boolean;
    /** 文件夹概览里点子项时回调（文件继续进编辑器、子目录继续文件夹概览）；line 为 1-based 跳转行 */
    onOpenPath?: (relativePath: string, line?: number) => void;
    onOpenFileRef?: (ref: WorkspaceFileRef, line?: number) => void;
    /** 在文件树中定位当前文件（展开祖先链并滚动到该行） */
    onRevealInTree?: () => void;
    /** 当前文件内查找条（Ctrl+F）：开关由父层持有，命中计算与高亮在编辑器内 */
    findBarOpen: boolean;
    onFindBarClose: () => void;
  }
>(function FileEditor(
  { workspaceId, rootId, path, revealLine, revealNonce, active = true, compactToolbar, toolbarHost, locationHost, onKeep, onFind, isDirectory, isExternal, onOpenPath, onOpenFileRef, onRevealInTree, findBarOpen, onFindBarClose },
  ref
) {
  const { t } = useTranslation();
  const { workspaces } = useWorkspaceStore();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const rootsRevision = workspace?.rootsRevision ?? 0;
  let sourceRoot: ReturnType<typeof requireSourceRoot> | undefined;
  try { if (workspace && !isExternal) sourceRoot = requireSourceRoot(workspace, rootId); } catch { /* 错误由文件 API 显示，不回退默认根。 */ }
  const fileRef = useMemo(() => rootId !== undefined && path !== null ? { workspaceId, rootId, relativePath: path } : null, [workspaceId, rootId, path]);
  const rootUse = useFileRootUse(!isExternal && path !== null && sourceRoot ?
    { workspaceId, rootId: sourceRoot.id, relativePath: path } : null);
  const rootUseReadyRef = useRef(rootUse.ready);
  rootUseReadyRef.current = rootUse.ready;
  const fileIdentity = JSON.stringify([workspaceId, fileRef ? workspaceFileKey(fileRef) : path, isExternal]);
  const fileIdentityRef = useRef(fileIdentity);
  fileIdentityRef.current = fileIdentity;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const onChangeRef = useRef<() => void>(() => undefined);
  const suppressDocChangeRef = useRef(false);
  const onKeepRef = useRef(onKeep); onKeepRef.current = onKeep;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  // 默认只读预览（md/html 走专门预览，其余代码文件 = 只读 CM）；点「编辑」才可写
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [previewText, setPreviewText] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const [tocHeadings, setTocHeadings] = useState<MarkdownHeading[]>([]);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const loadGenRef = useRef(0);
  const loadedContentRef = useRef<string | null>(null);
  const contentIdentity = JSON.stringify([fileIdentity, sourceRoot?.path, isDirectory]);
  const [dirEntries, setDirEntries] = useState<FsDirEntry[] | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const fileContextRef = useRef({ path, onOpenPath });
  fileContextRef.current = { path, onOpenPath };

  // 当前文件内查找（Ctrl+F）
  const [findQuery, setFindQuery] = useState('');  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const findMatchesRef = useRef<FindMatch[]>([]);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findApplyTimerRef = useRef<number | null>(null);
  const findReapplyTimerRef = useRef<number | null>(null);
  /** updateListener 里调用（view 创建期闭包）：文档编辑后防抖重算命中 */
  const findDirtyRef = useRef<() => void>(() => undefined);
  const findBarOpenRef = useRef(findBarOpen);
  findBarOpenRef.current = findBarOpen;

  const mdHtmlKind = mdHtmlKindForPath(path);
  // 全格式预览分流（工作区外文件也分类——媒体/文档族经 muster-ext:// 只读服务）
  const kind = path ? previewKindForPath(path) : null;
  /** 非文本族/文件夹/外部文件只读：不交给 autosave，避免任何写盘路径 */
  const autoSavePath =
    path && kind && isTextPreviewKind(kind) && !isDirectory && !isExternal ? path : null;

  // ---- 外部修改保护：mtime 基线 + fs:changed 监听 ----
  /** 最后一次读取/写入时的磁盘 mtime，作为写盘乐观锁基线 */
  const baselineMtimeRef = useRef<number | null>(null);
  /** 在途写盘数：期间忽略该路径的 fs:changed，避免读到写前旧内容 */
  const savesInFlightRef = useRef(0);
  /** 冲突横幅的「覆盖保存」置位：下一次 flush 跳过乐观锁 */
  const forceSaveRef = useRef(false);
  /** 磁盘上有外部修改且本地未合并（有 dirty 或保存冲突） */
  const [diskChanged, setDiskChanged] = useState(false);
  const pathRef = useRef<string | null>(path);
  pathRef.current = path;
  const noteLocationRef = useRef<{ path: string | null; fileRef: typeof fileRef }>({ path, fileRef });
  noteLocationRef.current = { path: rootId !== undefined && sourceRoot && path ? joinUnderRoot(sourceRoot.path, path) : path, fileRef };
  const loadingRef = useRef(false);
  const isDirectoryRef = useRef(isDirectory);
  isDirectoryRef.current = isDirectory;

  // ---- 文件批注：向 noteBridge 注册「当前选区 → 路径+行号」解析器 ----
  // 编辑态选区在 CodeMirror 内容里，posAtDOM 映射出行号并落待定标记（装饰）；
  // md/html 预览是渲染后的 DOM，无行号映射，用包裹 span 落待定标记。
  // 媒体/文件夹概览无可批注文本，直接拒绝。
  useEffect(() => {
    if (!active) return;
    registerFileNoteSource(() => {
      const p = pathRef.current;
      if (!p || isDirectoryRef.current || !isTextPreviewKind(previewKindForPath(p))) return null;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (!rootRef.current?.contains(node) || !rootRef.current.contains(range.endContainer)) return null;
      const el = node instanceof Element ? node : node.parentElement;
      const view = viewRef.current;
      if (el?.closest('.cm-content') && view) {
        try {
          const from = view.posAtDOM(node, range.startOffset);
          const to = view.posAtDOM(range.endContainer, range.endOffset);
          const lo = Math.min(from, to);
          const hi = Math.max(from, to);
          const line = view.state.doc.lineAt(lo).number;
          // 选区止于某行行首时按互斥端点归到上一行（整行选区不虚报一行）
          let endLine: number | null = null;
          if (hi > lo) {
            const endPos = view.state.doc.lineAt(hi).from === hi ? hi - 1 : hi;
            const n = view.state.doc.lineAt(endPos).number;
            endLine = n > line ? n : null;
          }
          const markKey = placePendingFileNoteMarkCM({ from: lo, to: hi });
          return { path: noteLocationRef.current.path ?? p, ...(noteLocationRef.current.fileRef ? { fileRef: noteLocationRef.current.fileRef } : {}), line, endLine, markKey };
        } catch {
          return { path: noteLocationRef.current.path ?? p, ...(noteLocationRef.current.fileRef ? { fileRef: noteLocationRef.current.fileRef } : {}), line: null, endLine: null, markKey: null };
        }
      }
      // 预览态：包裹 span 留痕（跨块选区包不上则无标记，批注仍可用）
      const markKey = placePendingFileNoteMarkPreview(range);
      return { path: noteLocationRef.current.path ?? p, ...(noteLocationRef.current.fileRef ? { fileRef: noteLocationRef.current.fileRef } : {}), line: null, endLine: null, markKey };
    });
    return () => registerFileNoteSource(null);
  }, [active]);

  // 文件内标记 API：待定（装饰/包裹）→ 确认回填批注 id 与序号 / 取消摘除；按 id 删除
  useEffect(() => {
    if (!active) return;
    const badgeSeqRef = { n: 0 };
    registerFileNoteMarks({
      placePendingCM: (r) => {
        const view = viewRef.current;
        if (!view || r.to <= r.from) return null;
        const key = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        view.dispatch({
          effects: addNoteMarkEffect.of({
            id: key,
            from: r.from,
            to: r.to,
            pending: true,
            seq: null
          })
        });
        return key;
      },
      placePendingPreview: (range) => {
        const key = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const span = wrapNoteAnchor(range, key);
        if (!span) return null;
        return key;
      },
      confirmMark: (key, noteId, seq) => {
        const n = seq ?? ++badgeSeqRef.n;
        const view = viewRef.current;
        if (view?.state.field(noteMarksField, false)?.some((m) => m.id === key)) {
          view.dispatch({ effects: resolveNoteMarkEffect.of({ from: key, to: noteId, seq: n }) });
        }
        // 预览态包裹片段：按待定 key 全量转正，并在末片段缀计数角标（点击开二次编辑）
        promoteNoteAnchor(key, noteId);
        const nodes = document.querySelectorAll<HTMLElement>(
          `.msg-note-anchor[data-note-id="${noteId}"]`
        );
        const last = nodes.length ? nodes[nodes.length - 1] : null;
        if (last) {
          const b = document.createElement('span');
          b.className = 'msg-note-badge is-inline';
          b.textContent = String(n);
          b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFileNoteEdit(noteId);
          });
          last.appendChild(b);
        }
      },
      cancelMark: (key) => {
        viewRef.current?.dispatch({ effects: removeNoteMarkEffect.of(key) });
        unwrapNoteAnchor(key);
      },
      removeMark: (noteId) => {
        viewRef.current?.dispatch({ effects: removeNoteMarkEffect.of(noteId) });
        unwrapNoteAnchor(noteId);
      }
    });
    return () => registerFileNoteMarks(null);
  }, [active]);

  const getContent = useMemo(
    () => () => viewRef.current?.state.doc.toString() ?? '',
    []
  );

  const { status, error: saveError, flush, onChange, markPristine, isDirty, hasUnsavedChanges } = useAutoSave({
    path: autoSavePath,
    identity: fileIdentity,
    getContent,
    write: async (p, content): Promise<FsWriteResult> => {
      if (!rootUseReadyRef.current) return { ok: false, error: rootUse.error || t('源文件夹连接尚未就绪，请重试') };
      if (!isTextPreviewKind(previewKindForPath(p))) {
        return { ok: false, error: t('媒体文件只读，不能保存') };
      }
      const expected = forceSaveRef.current ? null : baselineMtimeRef.current;
      savesInFlightRef.current += 1;
      const identity = fileIdentityRef.current;
      const generation = loadGenRef.current;
      try {
        const res = fileRef
          ? await window.api.fs.writeTextRef({ ...fileRef, relativePath: p }, content, expected)
          : await window.api.fs.writeText(workspaceId, p, content, expected);
        if (fileIdentityRef.current !== identity || loadGenRef.current !== generation) return res;
        if (res.ok) {
          baselineMtimeRef.current = res.mtimeMs ?? baselineMtimeRef.current;
          setDiskChanged(false);
        } else if (res.conflict) {
          setDiskChanged(true);
        }
        return res;
      } finally {
        savesInFlightRef.current -= 1;
      }
    }
  });

  const stateLocationRef = useRef({ workspaceId, path, fileRef, active });
  stateLocationRef.current = { workspaceId, path, fileRef, active };
  useEffect(() => registerFileEditorState(() => {
    const current = stateLocationRef.current;
    const unsaved = hasUnsavedChanges();
    const editing = viewModeRef.current === 'edit';
    if (!current.path || (!editing && !unsaved)) return null;
    return { workspaceId: current.workspaceId, path: current.path, ...(current.fileRef ? { fileRef: current.fileRef } : {}),
      active: current.active, editing, unsaved };
  }), [hasUnsavedChanges]);

  onChangeRef.current = onChange;

  const dispatchProgrammatic = useCallback(
    (spec: Parameters<EditorView['dispatch']>[0]) => {
      const view = viewRef.current;
      if (!view) return;
      suppressDocChangeRef.current = true;
      try {
        view.dispatch(spec);
      } finally {
        suppressDocChangeRef.current = false;
      }
    },
    []
  );

  const focusFindBar = useCallback((): void => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  useImperativeHandle(ref, () => ({ flush: async () => {
    await flush();
    if (isDirty()) throw new Error(saveError || t('保存失败，请先保存或处理冲突'));
  }, focusFindBar }), [flush, isDirty, saveError, focusFindBar]);

  /** md 预览里的相对/路径链接：按当前文件所在目录解析后交给 onOpenPath
   *  （FilesPanel 闸口打开；不接的话裸 <a> 会按应用页面源解析成 http://localhost:…） */
  const onMdLink = useCallback(
    (href: string) => {
      // Navigation context changes independently of Markdown content (e.g. virtual screens).
      const { path, onOpenPath } = fileContextRef.current;
      if (!path || !onOpenPath) return;
      const target = resolveDocLink(path, href);
      if (target) onOpenPath(target);
    },
    []
  );

  // ---- 当前文件内查找 ----

  /** 供只随文档变化触发的 effect 读取最新查询（避免把 query 放进 deps 打掉防抖） */
  const findStateRef = useRef({ query: '', caseSensitive: false, index: 0 });
  findStateRef.current = {
    query: findQuery,
    caseSensitive: findCaseSensitive,
    index: findActiveIndex
  };

  /** 重算命中、下发高亮并（默认）滚动到活动命中 */
  const applyFind = useCallback(
    (q: string, cs: boolean, preferIdx: number, scroll = true): void => {
      const view = viewRef.current;
      if (!view) return;
      if (!q) {
        findMatchesRef.current = [];
        setFindMatchCount(0);
        setFindActiveIndex(0);
        view.dispatch({ effects: setFindMatches.of(Decoration.none) });
        return;
      }
      const matches = findMatchesInDoc(view.state.doc, q, cs);
      findMatchesRef.current = matches;
      setFindMatchCount(matches.length);
      const idx = matches.length > 0 ? Math.min(Math.max(preferIdx, 0), matches.length - 1) : 0;
      setFindActiveIndex(idx);
      const active = matches[idx];
      if (active && scroll) {
        view.dispatch({
          selection: { anchor: active.from, head: active.to },
          effects: [
            setFindMatches.of(buildFindDecorations(matches, idx)),
            EditorView.scrollIntoView(active.from, { y: 'center' })
          ]
        });
      } else {
        view.dispatch({ effects: setFindMatches.of(buildFindDecorations(matches, idx)) });
      }
    },
    []
  );

  const scheduleFindApply = useCallback(
    (q: string, cs: boolean): void => {
      if (findApplyTimerRef.current != null) window.clearTimeout(findApplyTimerRef.current);
      findApplyTimerRef.current = window.setTimeout(() => {
        findApplyTimerRef.current = null;
        applyFind(q, cs, 0);
      }, 120);
    },
    [applyFind]
  );

  /** 上/下一个命中（环形），同步高亮与滚动 */
  const gotoMatch = useCallback(
    (delta: 1 | -1): void => {
      const matches = findMatchesRef.current;
      if (matches.length === 0) return;
      const next = (findActiveIndex + delta + matches.length) % matches.length;
      setFindActiveIndex(next);
      const m = matches[next];
      if (!m) return;
      viewRef.current?.dispatch({
        selection: { anchor: m.from, head: m.to },
        effects: [
          setFindMatches.of(buildFindDecorations(matches, next)),
          EditorView.scrollIntoView(m.from, { y: 'center' })
        ]
      });
    },
    [findActiveIndex]
  );

  const closeFindBar = useCallback((): void => {
    onFindBarClose();
    findMatchesRef.current = [];
    setFindMatchCount(0);
    setFindActiveIndex(0);
    viewRef.current?.dispatch({ effects: setFindMatches.of(Decoration.none) });
    viewRef.current?.focus();
  }, [onFindBarClose]);

  // 查找条打开：聚焦输入框；已有关键字立即重高亮一次（关闭不清关键字）
  useEffect(() => {
    if (!findBarOpen) return;
    const { query, caseSensitive } = findStateRef.current;
    if (query) applyFind(query, caseSensitive, 0);
    const timer = window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [findBarOpen, applyFind]);

  // 查找条跨文件保持打开：新文档就绪后重算；落到媒体/目录/错误态则收起
  useEffect(() => {
    if (!findBarOpen) return;
    if (!path || !kind || !isTextPreviewKind(kind) || isDirectory || loadError) {
      onFindBarClose();
      return;
    }
    if (loading) return;
    if (mdHtmlKind && viewModeRef.current !== 'edit') setViewMode('edit');
    const { query, caseSensitive } = findStateRef.current;
    applyFind(query, caseSensitive, 0);
  }, [findBarOpen, path, loading, kind, isDirectory, loadError, mdHtmlKind, onFindBarClose, applyFind]);

  // 文档被编辑（查找条开着）：防抖重算命中，保持活动序号
  findDirtyRef.current = () => {
    if (!findBarOpenRef.current) return;
    if (findReapplyTimerRef.current != null) window.clearTimeout(findReapplyTimerRef.current);
    findReapplyTimerRef.current = window.setTimeout(() => {
      findReapplyTimerRef.current = null;
      const { query, caseSensitive, index } = findStateRef.current;
      applyFind(query, caseSensitive, index);
    }, 160);
  };

  useEffect(
    () => () => {
      if (findApplyTimerRef.current != null) window.clearTimeout(findApplyTimerRef.current);
      if (findReapplyTimerRef.current != null) window.clearTimeout(findReapplyTimerRef.current);
    },
    []
  );

  // 换文件默认回到只读预览
  useEffect(() => {
    setViewMode('preview');
    setPreviewText('');
  }, [path]);

  // 持久 EditorView
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const appearanceCompartment = new Compartment();
    const initialAppearance = getResolvedAppearance();

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          foldGutter(),
          indentOnInput(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
          appearanceCompartment.of(workbenchAppearanceTheme(initialAppearance)),
          workbenchEditorTheme,
          workbenchSyntaxHighlighting,
          findDecorations,
          flashLineField,
          noteMarksField,
          langCompartment.current.of([]),
          editableCompartment.current.of(EditorView.editable.of(false)),
          EditorView.updateListener.of((update) => {
            if (suppressDocChangeRef.current) return;
            if (update.docChanged) {
              onKeepRef.current?.();
              onChangeRef.current();
              findDirtyRef.current();
            }
          })
        ]
      }),
      parent: host
    });
    viewRef.current = view;
    view.dom.dataset.appearanceRevision = String(initialAppearance.revision);
    const stopAppearance = subscribeAppearance(appearance => {
      view.dispatch({ effects: appearanceCompartment.reconfigure(workbenchAppearanceTheme(appearance)) });
      view.dom.dataset.appearanceRevision = String(appearance.revision);
    });
    setReady(true);

    return () => {
      stopAppearance();
      view.destroy();
      viewRef.current = null;
      setReady(false);
    };
  }, []);

  // 打开 / 关闭文件（媒体/文档/目录不走文本读取）
  useEffect(() => {
    if (!ready) return;
    const view = viewRef.current;
    if (!view) return;
    // 根改名、排序与默认 cwd 变化不改变当前文档，不能清空尚未保存的编辑。
    if (loadedContentRef.current === contentIdentity) return;
    loadedContentRef.current = null;
    const gen = ++loadGenRef.current;

    // 换文件/清空：旧文件的批注标记位置不再有意义，整批摘除（预览包裹 span 随内容重渲自然消失）
    const stale = view.state.field(noteMarksField, false);
    if (stale?.length) {
      view.dispatch({ effects: stale.map((m) => removeNoteMarkEffect.of(m.id)) });
    }

    if (!path || !kind || isDirectory || !isTextPreviewKind(kind)) {
      loadedContentRef.current = contentIdentity;
      markPristine();
      baselineMtimeRef.current = null;
      setDiskChanged(false);
      loadingRef.current = false;
      setLoadError(null);
      setLoading(false);
      dispatchProgrammatic({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
        effects: [
          langCompartment.current.reconfigure([]),
          editableCompartment.current.reconfigure(EditorView.editable.of(false))
        ]
      });
      markPristine();
      return;
    }

    setLoading(true);
    loadingRef.current = true;
    baselineMtimeRef.current = null;
    setDiskChanged(false);
    setLoadError(null);
    markPristine();
    // 清场：加载期间不残留上一个文件的内容
    dispatchProgrammatic({
      changes: { from: 0, to: view.state.doc.length, insert: '' },
      effects: [editableCompartment.current.reconfigure(EditorView.editable.of(false))]
    });

    void (async () => {
      const res = isExternal
        ? await window.api.fs.readExternal(path)
        : fileRef ? await window.api.fs.readTextRef(fileRef) : await window.api.fs.readText(workspaceId, path);
      if (gen !== loadGenRef.current || !viewRef.current) return;
      const v = viewRef.current;

      if (!res.ok) {
        setLoadError(res.error);
        setLoading(false);
        loadingRef.current = false;
        baselineMtimeRef.current = null;
        dispatchProgrammatic({
          changes: { from: 0, to: v.state.doc.length, insert: '' },
          effects: [
            langCompartment.current.reconfigure([]),
            editableCompartment.current.reconfigure(EditorView.editable.of(false))
          ]
        });
        markPristine();
        return;
      }

      const langId = languageIdForPath(path);
      dispatchProgrammatic({
        changes: { from: 0, to: v.state.doc.length, insert: res.content },
        effects: [
          langCompartment.current.reconfigure(languageExtension(langId)),
          editableCompartment.current.reconfigure(
            EditorView.editable.of(viewModeRef.current === 'edit' && rootUseReadyRef.current)
          )
        ]
      });
      markPristine();
      setLoadError(null);
      setLoading(false);
      loadingRef.current = false;
      baselineMtimeRef.current = res.mtimeMs;
      setPreviewText(res.content);
      loadedContentRef.current = contentIdentity;
    })();
  }, [workspaceId, path, fileRef, rootsRevision, contentIdentity, ready, markPristine, kind, isDirectory, isExternal, dispatchProgrammatic]);

  /** 从磁盘静默重读当前文件：无本地修改时原地刷新内容/预览/基线；期间产生编辑则转冲突提示 */
  const refreshFromDisk = useCallback(async (): Promise<void> => {
    const p = pathRef.current;
    if (
      !p ||
      isExternal ||
      !isTextPreviewKind(previewKindForPath(p)) ||
      loadingRef.current ||
      savesInFlightRef.current > 0
    ) {
      return;
    }
    const gen = loadGenRef.current;
    const res = fileRef ? await window.api.fs.readTextRef({ ...fileRef, relativePath: p }) : await window.api.fs.readText(workspaceId, p);
    if (gen !== loadGenRef.current || pathRef.current !== p || !viewRef.current) return;
    if (isDirty()) {
      setDiskChanged(true);
      return;
    }
    if (!res.ok) return; // 读取失败（如文件刚被删）：交给文件树与错误态处理
    baselineMtimeRef.current = res.mtimeMs;
    const v = viewRef.current;
    const docText = v.state.doc.toString();
    // 内容没变只刷基线，不动文档——避免自己保存触发的事件造成光标/滚动重置
    if (docText !== res.content) {
      const diskDoc = v.state.toText(res.content);
      const diskText = diskDoc.toString();
      if (docText !== diskText) {
        // 保留共同前后缀，让 CodeMirror 复用未变化的节点并映射选区与装饰。
        let from = 0;
        let to = docText.length;
        let diskTo = diskText.length;
        const sharedLength = Math.min(to, diskTo);
        while (from < sharedLength && docText[from] === diskText[from]) from++;
        while (to > from && diskTo > from && docText[to - 1] === diskText[diskTo - 1]) {
          to--;
          diskTo--;
        }
        dispatchProgrammatic({ changes: { from, to, insert: diskDoc.slice(from, diskTo) } });
      }
    }
    setPreviewText(res.content);
  }, [workspaceId, fileRef, isExternal, isDirty, dispatchProgrammatic]);

  /** 冲突横幅：放弃本地修改、载入磁盘最新内容 */
  const reloadFromDisk = useCallback((): void => {
    markPristine();
    void refreshFromDisk();
  }, [markPristine, refreshFromDisk]);

  /** 冲突横幅：以编辑器当前内容覆盖磁盘（下一次 flush 跳过乐观锁） */
  const overwriteFromEditor = useCallback((): void => {
    forceSaveRef.current = true;
    void flush().finally(() => {
      forceSaveRef.current = false;
    });
  }, [flush]);

  // 外部修改监听：无本地修改→静默刷新；有→提示冲突，绝不自动覆盖
  useEffect(() => {
    return window.api.on('fs:changed', (payload: FsChangedPayload) => {
      if (payload.workspaceId !== workspaceId) return;
      if (payload.rootsRevision !== undefined && payload.rootsRevision !== rootsRevision) return;
      const eventRoot = payload.rootId ?? workspace?.defaultRootId;
      if (rootId !== undefined && eventRoot !== undefined && eventRoot !== rootId) return;
      const p = pathRef.current;
      if (!p || !isTextPreviewKind(previewKindForPath(p))) return;
      if (!payload.relativePaths.includes('') && !payload.relativePaths.includes(p)) return;
      if (savesInFlightRef.current > 0) return;
      if (isDirty()) {
        setDiskChanged(true);
        return;
      }
      void refreshFromDisk();
    });
  }, [workspaceId, rootId, rootsRevision, workspace?.defaultRootId, isDirty, refreshFromDisk]);

  // 文件夹概览：子项列表 + 计数（目录在前，同 FileTree 排序）
  useEffect(() => {
    if (!isDirectory || !path) {
      setDirEntries(null);
      setDirError(null);
      setDirLoading(false);
      return;
    }
    let alive = true;
    setDirLoading(true);
    setDirError(null);
    void (async () => {
      const res = fileRef ? await window.api.fs.listDirRef(fileRef) : await window.api.fs.listDir(workspaceId, path);
      if (!alive) return;
      setDirLoading(false);
      if (res.error) {
        setDirEntries(null);
        setDirError(res.error);
        return;
      }
      setDirEntries(
        [...res.entries].sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        })
      );
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, path, fileRef, rootsRevision, isDirectory]);

  // CM 可编辑态跟随模式：预览=只读（代码文件的预览形态），编辑=可写；加载完成后也重新同步一次
  // 外部文件恒只读
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !ready || loading) return;
    dispatchProgrammatic({
      effects: editableCompartment.current.reconfigure(
        EditorView.editable.of(viewMode === 'edit' && !isExternal && rootUse.ready)
      )
    });
  }, [viewMode, ready, loading, path, isExternal, rootUse.ready, dispatchProgrammatic]);

  // 跳转目标行闪烁：亮→灭→再亮→灭（滚动落定后仍能认出目标行）；纯 JS 定时 + 静态背景，无 CSS 时长字面量
  const flashTimersRef = useRef<number[]>([]);
  const flashLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) return;
    for (const id of flashTimersRef.current) window.clearTimeout(id);
    flashTimersRef.current = [];
    const set = (v: number | null) => view.dispatch({ effects: flashLineEffect.of(v) });
    set(line);
    flashTimersRef.current.push(
      window.setTimeout(() => set(null), 450),
      window.setTimeout(() => set(line), 750),
      window.setTimeout(() => set(null), 1600)
    );
  }, []);
  useEffect(
    () => () => {
      for (const id of flashTimersRef.current) window.clearTimeout(id);
    },
    []
  );

  // revealLine：md/html 预览无法定位行才切回编辑；代码文件预览（只读 CM）原地滚动
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !path || loadError || loading || !ready) return;
    if (revealLine == null || revealLine < 1) return;

    if (mdHtmlKind && !isExternal) setViewMode('edit');
    const line = Math.min(revealLine, view.state.doc.lines);
    const lineInfo = view.state.doc.line(line);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' })
    });
    flashLine(line);
  }, [path, revealLine, revealNonce, loadError, loading, ready, mdHtmlKind, isExternal, flashLine]);

  useEffect(() => {
    return () => {
      void flush();
    };
  }, [flush]);

  const saveLabel = statusLabel(status);
  const fileName = path
    ? path.includes('/')
      ? path.slice(path.lastIndexOf('/') + 1)
      : path
    : null;

  const showEmpty = !path;
  const showMedia = Boolean(path && (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf'));
  const showDoc = Boolean(path && kind && isParsePreviewKind(kind));
  const showUnsupported = Boolean(path && kind === 'unsupported');
  const showFolder = Boolean(path && isDirectory);
  const showError = Boolean(
    path && !showMedia && !showDoc && !showUnsupported && !isDirectory && loadError
  );
  /** 文本文件预览态：md/html 用专门预览，其余代码文件预览 = 只读 CM（showEditor 仍为真） */
  const inTextPreview = Boolean(
    path &&
      kind &&
      isTextPreviewKind(kind) &&
      !isDirectory &&
      !loadError &&
      !loading &&
      viewMode === 'preview'
  );
  const plainReading = Boolean(inTextPreview && path && languageIdForPath(path) === 'plaintext');
  const readingSurface = (inTextPreview && mdHtmlKind === 'markdown') || plainReading;
  useEffect(() => {
    if (!inTextPreview || mdHtmlKind !== 'markdown') {
      setTocHeadings([]);
      setTocOpen(false);
      return;
    }
    const body = rootRef.current?.querySelector<HTMLElement>('.file-editor-md-body');
    if (!body) {
      setTocHeadings([]);
      return;
    }
    setTocHeadings(collectMarkdownHeadings(body));
  }, [inTextPreview, mdHtmlKind, previewText]);
  const tocPresence = usePresence(tocOpen && tocHeadings.length > 0, MOTION.exitMs);
  const jumpToHeading = useCallback((id: string): void => {
    const heading = rootRef.current?.querySelector<HTMLElement>(`#${id}`);
    heading?.scrollIntoView({ block: 'start' });
  }, []);
  const showLoading = Boolean(
    path && kind && isTextPreviewKind(kind) && !isDirectory && !loadError && loading
  );
  const dirCount = dirEntries?.filter((e) => e.isDirectory).length ?? 0;
  const fileCount = dirEntries ? dirEntries.length - dirCount : 0;

  const switchToPreview = (): void => {
    setPreviewText(getContent());
    setViewMode('preview');
  };
  const browserPreviewButton = kind === 'html' && !isDirectory && !isExternal && !isWebGateway() && path && sourceRoot ? (
    <button type="button" className={compactToolbar ? 'right-icon' : 'git-btn ghost tiny'}
      aria-label={t('浏览器预览')} title={t('在右侧浏览器中预览磁盘上已保存的 HTML')}
      onClick={async () => {
        try {
          const result = await window.api.fs.openBrowserPreview({ workspaceId, rootId: sourceRoot.id, relativePath: path });
          if (!result.ok) throw new Error(result.error || t('无法打开浏览器预览'));
        } catch (error) {
          void window.api.notify.toast({ workspaceId, label: t('浏览器预览'), text: error instanceof Error ? error.message : String(error) });
        }
      }}>
      {compactToolbar ? <IconGlobe size={14} /> : t('浏览器预览')}
    </button>
  ) : null;
  const tocButton = mdHtmlKind === 'markdown' && inTextPreview && tocHeadings.length > 0 ? (
    <button
      type="button"
      className={`right-icon${tocOpen ? ' is-on' : ''}`}
      aria-label={tocOpen ? t('隐藏文档目录') : t('显示文档目录')}
      title={tocOpen ? t('隐藏文档目录') : t('显示文档目录')}
      aria-pressed={tocOpen}
      onClick={() => setTocOpen((open) => !open)}
    >
      <IconLayout size={14} />
    </button>
  ) : null;

  // 「在资源管理器中显示」：unsupported/错误卡片的兜底动作（外部文件即自身路径）
  const wsRoot = sourceRoot?.path ?? null;
  const pathSeparator = wsRoot?.includes('\\') ? '\\' : '/';
  const fullPath = path ? isExternal || !wsRoot ? path : `${wsRoot.replace(/[\\/]+$/, '')}${pathSeparator}${path.replace(/[\\/]/g, pathSeparator)}` : '';
  const saveFailureTip = <ErrorTip message={status === 'error' ? (saveError ? t('保存失败：{{error}}', { error: saveError }) : t('保存失败')) : null} />;
  const locationBar = <div className="right-file-location"><FileTypeIcon name={path ?? ''} size={14}/><span className="right-full-path" title={fullPath}>{fullPath}</span><span className="right-file-status" title={saveError ?? undefined}>{rootUse.error || (isExternal ? t('外部文件 · 只读') : loading ? <BrandLoading>{t('加载中…')}</BrandLoading> : saveLabel)}</span></div>;
  const revealCurrentFile = useCallback((): void => {
    if (!path) return;
    if (isExternal) {
      void window.api.shell.revealPath(path);
      return;
    }
    if (wsRoot) {
      void window.api.shell.revealPath(`${wsRoot.replace(/[\\/]+$/, '')}/${path}`);
    }
  }, [path, isExternal, wsRoot]);

  const [unsupportedSize, setUnsupportedSize] = useState<number | null>(null);
  useEffect(() => {
    if (!showUnsupported || !path || isExternal) {
      setUnsupportedSize(null);
      return;
    }
    let alive = true;
    setUnsupportedSize(null);
    void (fileRef ? window.api.fs.statRef(fileRef) : window.api.fs.stat(workspaceId, path)).then((st) => {
      if (alive && st.ok && st.isFile) setUnsupportedSize(st.size);
    });
    return () => {
      alive = false;
    };
  }, [path, showUnsupported, isExternal, workspaceId, fileRef, rootsRevision]);

  return (
    <div className="file-editor" ref={rootRef} data-sel-area="file-editor">
      {saveFailureTip}
      {compactToolbar && path ? <>
        {locationHost ? createPortal(locationBar, locationHost) : null}
        {toolbarHost ? createPortal(<>
          {kind && isTextPreviewKind(kind) && !isDirectory && !isExternal ? <div className="right-tool-group right-mode-tools">
            <button type="button" className={`right-icon${viewMode === 'preview' ? ' is-on' : ''}`} aria-label={t('预览')} title={t('预览')} aria-pressed={viewMode === 'preview'} onClick={switchToPreview}><IconEye size={14}/></button>
            {browserPreviewButton}
            <button type="button" className={`right-icon${viewMode === 'edit' ? ' is-on' : ''}`} aria-label={t('编辑')} title={t('编辑')} aria-pressed={viewMode === 'edit'} disabled={!rootUse.ready || !!loadError || loading} onClick={() => { onKeepRef.current?.(); setViewMode('edit'); }}><IconPencil size={14}/></button>
          </div> : null}
          <div className="right-tool-group">
            {kind && isTextPreviewKind(kind) && !isDirectory && !isExternal ? <button type="button" className="right-icon" aria-label={status === 'error' ? t('重试') : t('保存')} title={status === 'error' ? t('重试') : t('保存')} disabled={!rootUse.ready || loading || status === 'saving'} onClick={() => void flush()}>{status === 'saving' ? <BrandLoading size={18}/> : <IconSave size={14}/>}</button> : null}
            {tocButton}
            {kind && isTextPreviewKind(kind) && !isDirectory ? <button type="button" className="right-icon" aria-label={t('当前文件内查找')} title={t('当前文件内查找')} onClick={onFind}><IconSearch size={14}/></button> : null}
            <button type="button" className="right-icon" aria-label={t('复制完整路径')} title={t('复制完整路径')} onClick={() => void navigator.clipboard.writeText(fullPath)}><IconCopy size={14}/></button>
            {!isExternal ? <button type="button" className="right-icon" aria-label={t('在文件树中定位当前文件')} title={t('在文件树中定位当前文件')} onClick={onRevealInTree}><IconLocate size={14}/></button> : null}
          </div>
        </>, toolbarHost) : null}
      </> : null}
      {path && !compactToolbar ? (
        <div className="file-editor-header">
          <div className="file-editor-path" title={path}>
            <span className="file-editor-name">{fileName}</span>
            <span className="file-editor-rel">{rootId && workspace?.roots && workspace.roots.length > 1 ? `${sourceRoot?.label || sourceRoot?.path || rootId} / ${path}` : path}</span>
          </div>
          <div className="file-editor-status">
            {rootUse.error ? <span className="file-editor-status-text" role="alert">{rootUse.error}</span> : null}
            {path && !isExternal && onRevealInTree ? (
              <button
                type="button"
                className="git-btn ghost tiny file-editor-locate-btn"
                title={t('在文件树中定位当前文件')}
                onClick={onRevealInTree}
              >
                <IconLocate size={13} />
              </button>
            ) : null}
            {isExternal ? (
              <span className="file-editor-status-text" title={t('工作区外的文件，只读预览（不提供编辑与保存）')}>
                {t('外部文件 · 只读')}
              </span>
            ) : null}
            {kind && isTextPreviewKind(kind) && !isDirectory && !isExternal && !loadError && !loading ? (
              <div className="file-editor-mode" role="tablist" aria-label={t('编辑预览')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'edit'}
                  disabled={!rootUse.ready}
                  className={`file-editor-mode-btn${viewMode === 'edit' ? ' is-active' : ''}`}
                  onClick={() => { onKeepRef.current?.(); setViewMode('edit'); }}
                >
                  {t('编辑')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'preview'}
                  className={`file-editor-mode-btn${viewMode === 'preview' ? ' is-active' : ''}`}
                  onClick={switchToPreview}
                >
                  {t('预览')}
                </button>
              </div>
            ) : null}
            {browserPreviewButton}
            {tocButton}
            {isDirectory ? (
              <span className="file-editor-status-text" title={t('文件夹概览：左侧树已定位并展开')}>
                {t('文件夹')} ·{' '}
                {dirEntries ? t('{{n}} 个子文件夹 · {{m}} 个文件', { n: dirCount, m: fileCount }) : t('读取中…')}
              </span>
            ) : null}
            {showMedia ? (
              <span className="file-editor-status-text" title={t('媒体文件只读预览，不会自动保存')}>
                {kind === 'image'
                  ? t('图片 · 只读')
                  : kind === 'audio'
                    ? t('音频 · 只读')
                    : kind === 'video'
                      ? t('视频 · 只读')
                      : t('PDF · 只读')}
              </span>
            ) : null}
            {showDoc ? (
              <span className="file-editor-status-text" title={t('只读预览：解析文件内容渲染，不会自动保存')}>
                {kind === 'word'
                  ? t('Word 文档 · 只读')
                  : kind === 'sheet'
                    ? t('表格 · 只读')
                    : kind === 'slides'
                      ? t('幻灯片 · 只读')
                      : t('压缩包 · 只读')}
              </span>
            ) : null}
            {showUnsupported ? (
              <span className="file-editor-status-text">{t('暂不支持预览此格式')}</span>
            ) : null}
            {loading ? <BrandLoading>{t('加载中…')}</BrandLoading> : null}
            {!loading && kind && isTextPreviewKind(kind) && !isExternal && saveLabel ? (
              <span
                className="file-editor-status-text"
                title={saveError ?? undefined}
              >
                {saveLabel}
              </span>
            ) : null}
            {!loading && kind && isTextPreviewKind(kind) && status === 'error' && !diskChanged ? (
              <button
                type="button"
                className="git-btn ghost tiny"
                onClick={() => void flush()}
              >
                {t('重试')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {diskChanged && path && kind && isTextPreviewKind(kind) && !isDirectory ? (
        <div className="file-editor-conflict" role="alert">
          <span className="file-editor-conflict-text">
            {t('文件已在磁盘上被其他程序修改')}
          </span>
          <button
            type="button"
            className="git-btn ghost tiny"
            title={t('放弃未保存的本地修改，载入磁盘上的最新内容')}
            onClick={reloadFromDisk}
          >
            {t('重新加载')}
          </button>
          <button
            type="button"
            className="git-btn ghost tiny"
            title={t('用编辑器当前内容覆盖磁盘上的文件')}
            onClick={overwriteFromEditor}
          >
            {t('覆盖保存')}
          </button>
          <button
            type="button"
            className="git-btn ghost tiny"
            title={t('暂时忽略；再次检测到修改或保存冲突时会重新提示')}
            onClick={() => setDiskChanged(false)}
          >
            ×
          </button>
        </div>
      ) : null}

      {showEmpty ? (
        <div className="file-editor-empty-inner">
          <div className="empty-logo" aria-hidden>
            <AppLogo size={56} />
          </div>
          <p className="file-editor-empty-title">{t('从左侧打开文件')}</p>
          <p className="file-editor-empty-desc">
            {t('单击文件树中的文件，或使用 Ctrl/Cmd+P 快速打开')}
          </p>
        </div>
      ) : null}

      {showMedia && kind ? (
        <FileMediaPreview
          key={fileIdentity}
          workspaceId={workspaceId}
          rootId={rootId}
          path={path!}
          kind={kind as 'image' | 'audio' | 'video' | 'pdf'}
          external={isExternal}
        />
      ) : null}

      {showDoc && kind && isParsePreviewKind(kind) ? (
        <FileDocPreview key={fileIdentity} workspaceId={workspaceId} rootId={rootId} path={path!} kind={kind} external={isExternal} />
      ) : null}

      {showUnsupported ? (
        <div className="file-media file-media-error">
          <span className="file-editor-unsupported-icon">
            <FileTypeIcon name={path ?? ''} size={28} />
          </span>
          <p className="file-media-error-title">{t('暂不支持预览此格式')}</p>
          <p className="file-media-error-desc">
            {t('{{name}} 是二进制或专用格式，本应用无法渲染其内容', { name: fileName })}
          </p>
          <p className="file-media-error-meta">
            {unsupportedSize != null ? t('大小：{{size}}', { size: formatBytes(unsupportedSize) }) : null}
          </p>
          <button type="button" className="git-btn ghost tiny file-media-reveal-btn" onClick={revealCurrentFile}>
            {t('在资源管理器中显示')}
          </button>
        </div>
      ) : null}

      {showFolder ? (
        <div className="file-editor-folder">
          {dirLoading ? <p className="file-editor-folder-note">{t('读取中…')}</p> : null}
          <ErrorTip message={dirError} />
          {dirEntries ? (
            dirEntries.length === 0 ? (
              <p className="file-editor-folder-note">{t('空文件夹')}</p>
            ) : (
              <>
                <p className="file-editor-folder-counts">
                  {t('{{n}} 个文件夹 · {{m}} 个文件', { n: dirCount, m: fileCount })}
                </p>
                <ul className="file-editor-folder-list">
                  {dirEntries.map((e) => (
                    <li key={e.relativePath}>
                      <button
                        type="button"
                        className="file-editor-folder-item"
                        onClick={() => onOpenPath?.(e.relativePath)}
                        title={e.relativePath}
                      >
                        {e.isDirectory ? (
                          <IconFolder size={13} />
                        ) : (
                          <IconFile size={13} />
                        )}
                        <span className="file-editor-folder-name">{e.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : null}
        </div>
      ) : null}

      {showError ? (
        <div className="file-media file-media-error">
          <p className="file-media-error-title">{t('无法预览此文件')}</p>
          <p className="file-media-error-desc">{loadError}</p>
          <button type="button" className="git-btn ghost tiny file-media-reveal-btn" onClick={revealCurrentFile}>
            {t('在资源管理器中显示')}
          </button>
        </div>
      ) : null}

      {showLoading ? (
        <div className="file-editor-error-state">
          <p className="file-editor-folder-note">{t('读取文件内容…')}</p>
        </div>
      ) : null}

      {/* 编辑器↔预览：双视图常驻叠放淡切（.xfade）——CM 保活，切预览不卸载、
          切回不重建（undo 栈/滚动位置保留）；md/html 预览按 kind 二选一。
          容器必须常驻（非文本态只 display:none 让位）：EditorView 在挂载时一次性
          创建、依赖 host 已在 DOM；若条件卸载，首次挂载是空态时 effect 拿不到
          host 且不会重跑，此后所有文本文件都空白 */}
      <div
        className={`file-editor-main xfade-stack${readingSurface ? ' is-reading-surface' : ''}`}
        style={
          showEmpty ||
          showMedia ||
          showDoc ||
          showUnsupported ||
          showFolder ||
          showError ||
          showLoading
            ? { display: 'none' }
            : undefined
        }
      >
        <div
          className={`file-editor-pane xfade${!inTextPreview || !mdHtmlKind ? ' is-shown' : ''}`}
        >
          <div
            className={`file-editor-cm${mdHtmlKind === 'markdown' ? ' is-prose' : ''}${plainReading ? ' is-plain-reading' : ''}`}
            ref={hostRef}
          />
        </div>
        {mdHtmlKind ? (
          <div className={`file-editor-pane xfade${inTextPreview ? ' is-shown' : ''}`}>
            {mdHtmlKind === 'markdown' ? (
              <div className="file-editor-markdown-layout">
                <div className="file-editor-preview file-editor-preview-md">
                  <MarkdownBody
                    text={previewText}
                    className="file-editor-md-body"
                    onFileLink={onMdLink}
                  />
                </div>
                {tocPresence.mounted ? (
                  <aside className="file-editor-toc mp-panel" {...tocPresence.spread} aria-label={t('文档目录')}>
                    <div className="file-editor-toc-header">
                      <strong>{t('文档目录')}</strong>
                      <button
                        type="button"
                        className="right-icon"
                        aria-label={t('隐藏文档目录')}
                        title={t('隐藏文档目录')}
                        onClick={() => setTocOpen(false)}
                      >
                        <IconLayout size={13} />
                      </button>
                    </div>
                    <nav className="file-editor-toc-list" aria-label={t('标题目录')}>
                      {tocHeadings.map((heading, index) => (
                        <button
                          key={heading.id}
                          type="button"
                          className="file-editor-toc-item"
                          style={{ paddingLeft: `${8 + Math.max(0, heading.level - 1) * 12}px` }}
                          onClick={() => jumpToHeading(heading.id)}
                          data-toc-index={index}
                        >
                          {heading.text}
                        </button>
                      ))}
                    </nav>
                  </aside>
                ) : null}
              </div>
            ) : inTextPreview ? (<>
              <HtmlFilePreview
                content={previewText}
                label={t('HTML 预览')}
                rootsRevision={rootsRevision}
                fileRef={!isExternal && sourceRoot && path ? { workspaceId, rootId: sourceRoot.id, relativePath: path } : undefined}
              />
              <PeekPointerShield className="file-editor-html-peek" />
            </>) : null}
          </div>
        ) : null}
      </div>

      <div className="chat-find-pos find-in-file-float" data-overlay-root="">
        <div className="chat-find-layer">
          <FindFloatBar
            open={findBarOpen}
            query={findQuery}
            onQueryChange={(q) => {
              setFindQuery(q);
              scheduleFindApply(q, findCaseSensitive);
            }}
            placeholder={t('在当前文件中查找…')}
            ariaLabel={t('在当前文件中查找')}
            matchIndex={findActiveIndex}
            matchTotal={findMatchCount}
            onPrev={() => gotoMatch(-1)}
            onNext={() => gotoMatch(1)}
            onClose={closeFindBar}
            inputRef={findInputRef}
            extraTrailing={
              <button
                type="button"
                className={`search-bar-btn${findCaseSensitive ? ' is-on' : ''}`}
                title={t('区分大小写')}
                aria-label={t('区分大小写')}
                aria-pressed={findCaseSensitive}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const next = !findCaseSensitive;
                  setFindCaseSensitive(next);
                  applyFind(findQuery, next, 0);
                }}
              >
                Aa
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
});
