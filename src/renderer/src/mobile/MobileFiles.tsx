/**
 * 手机端文件抽屉：右侧 90% 宽侧栏（mp-panel 骨架 + 自右滑入）。L3「⋯」菜单
 * 与聊天文件链接共用——链接目标经与桌面 SideToolsPanel 同款闸口判定（工作区内
 * stat → 直开；完整绝对路径做磁盘级判断 → 外部只读；相对路径不做全盘寻找）。
 *
 * 只读预览：文本/代码（行号 + 目标行跳转/高亮）、md（MarkdownBody，相对链接按
 * 当前文件目录解析后继续下钻）、html（sandbox iframe，禁脚本）/图片/音视频/PDF
 * （网页网关经 /media 字节路由、cookie 鉴权；Electron 壳回落自定义协议）；
 * office/归档等重格式出提示卡。编辑与外部目录仍归电脑端。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FsDirEntry, WorkspaceFileRef, WorkspaceInfo } from '../../../shared/types';
import { buildExternalFileUrl, previewKindForPath } from '../../../shared/filePreview';
import { buildWorkspaceFileUrl } from '../../../shared/mediaKinds';
import { requireSourceRoot, sourceRootsFor, workspaceRootLabel } from '../../../shared/workspaceRoots';
import { resolveDocLink } from '../../../shared/workspaceRelPath';
import { isOutsideWorkspaceRootsResult } from '../../../shared/errors';
import { usePresence } from '../components/motion';
import { MarkdownBody } from '../components/MarkdownBody';
import { FileTypeIcon } from '../components/FileTypeIcon';
import { IconFolder } from '../components/icons';
import { HtmlFilePreview } from '../components/HtmlFilePreview';
import { filePreviewUrl } from '../filePreviewUrl';
import { useFileRootUse } from '../hooks/useFileRootUse';

/** 外部请求的打开目标（会话文件链接 / md 内链） */
export interface MobileFileTarget {
  path: string;
  line?: number;
  fileRef?: WorkspaceFileRef;
}

type FileView = {
  path: string;
  line?: number;
} & ({ external: true; fileRef?: never } | { external: false; fileRef: WorkspaceFileRef });

type FilesView = { kind: 'roots' } | { kind: 'list'; rootId: string; path: string } | ({ kind: 'file' } & FileView);

function baseName(p: string): string {
  const pos = p.replace(/\\/g, '/').lastIndexOf('/');
  return pos >= 0 ? p.slice(pos + 1) : p;
}

function parentDir(rel: string): string {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/');
}

function sortEntries(entries: FsDirEntry[]): FsDirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/** 媒体 src：网页网关走 /media 字节路由（cookie 鉴权、支持 Range）；Electron 壳回落自定义协议 */
function mediaSrc(view: FileView): string {
  return filePreviewUrl(view.external ? buildExternalFileUrl(view.path) : buildWorkspaceFileUrl(view.fileRef));
}

/* ---------- 文件详情 ---------- */

/** 行号 DOM 上限：超大文本退化为整块 pre（行号/跳转都让位，避免万行 div 卡手机） */
const LINE_DOM_CAP = 4000;

function FileDetail(props: {
  view: FileView;
  rootsRevision: number;
  active: boolean;
  onOpenTarget: (target: MobileFileTarget) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { view } = props;
  const rootUse = useFileRootUse(props.active && !view.external ? view.fileRef : null);
  const kind = previewKindForPath(view.path);

  /* 文本族（text/markdown）内容读取 */
  type TextState =
    | { phase: 'loading' }
    | { phase: 'ok'; content: string }
    | { phase: 'error'; error: string };
  const [text, setText] = useState<TextState>({ phase: 'loading' });
  useEffect(() => {
    if (!props.active || !['text', 'markdown', 'html'].includes(kind)) return;
    let cancelled = false;
    setText({ phase: 'loading' });
    void (async () => {
      try {
        const r = view.external
          ? await window.api.fs.readExternal(view.path)
          : await window.api.fs.readTextRef(view.fileRef);
        if (cancelled) return;
        if (r.ok) setText({ phase: 'ok', content: r.content });
        else setText({ phase: 'error', error: r.error });
      } catch (e) {
        if (!cancelled) setText({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.active, kind, view.path, view.external, view.fileRef, props.rootsRevision]);

  /* 链接目标行：进入视口中心 */
  const lineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (text.phase === 'ok' && view.line) lineRef.current?.scrollIntoView({ block: 'center' });
  }, [text, view.line]);

  /* md 内链：按当前文件所在目录解析（与桌面 md 预览同规则），经闸口继续下钻 */
  const onMdLink = useCallback(
    (href: string): void => {
      if (/^https?:\/\//i.test(href)) {
        window.open(href, '_blank', 'noopener');
        return;
      }
      const path = resolveDocLink(view.path, href) ?? href;
      props.onOpenTarget({ path, ...(!view.external && !isAbsolutePath(path) && view.fileRef
        ? { fileRef: { ...view.fileRef, relativePath: path } } : {}) });
    },
    [props.onOpenTarget, view.path, view.external, view.fileRef]
  );

  const src = mediaSrc(view);

  if (rootUse.error) return <div className="ma-files-note" role="alert">{rootUse.error}</div>;

  if (kind === 'html') {
    return (
      <div className="ma-files-detail">
        {text.phase === 'error' ? <div className="ma-files-note" role="alert">{text.error}</div> : text.phase !== 'ok'
          ? <div className="ma-files-note">{t('加载中…')}</div>
          : props.active ? <HtmlFilePreview content={text.content} fileRef={view.fileRef} rootsRevision={props.rootsRevision}
            label={baseName(view.path)} allowScripts={false} className="ma-files-frame" /> : null}
      </div>
    );
  }
  if (kind === 'image' || kind === 'audio' || kind === 'video') {
    const name = baseName(view.path);
    return (
      <div className="ma-files-detail ma-files-media">
        {kind === 'image' ? <img src={src} alt={name} /> : null}
        {kind === 'audio' ? <audio src={src} controls preload="metadata" /> : null}
        {kind === 'video' ? <video src={src} controls preload="metadata" /> : null}
      </div>
    );
  }
  if (kind === 'pdf') {
    return (
      <div className="ma-files-detail">
        <iframe className="ma-files-frame" src={src} title={baseName(view.path)} />
      </div>
    );
  }
  if (kind !== 'text' && kind !== 'markdown') {
    return (
      <div className="ma-files-detail">
        <div className="ma-files-note">{t('此格式请在电脑端预览')}</div>
      </div>
    );
  }

  if (text.phase === 'loading') {
    return (
      <div className="ma-files-detail">
        <div className="ma-files-note">{t('加载中…')}</div>
      </div>
    );
  }
  if (text.phase === 'error') {
    return (
      <div className="ma-files-detail">
        <div className="ma-files-note">{text.error || t('无法读取文件')}</div>
      </div>
    );
  }
  if (kind === 'markdown') {
    return (
      <div className="ma-files-detail">
        <MarkdownBody text={text.content} onFileLink={onMdLink} />
      </div>
    );
  }

  const lines = text.content.split('\n');
  if (lines.length > LINE_DOM_CAP) {
    return (
      <div className="ma-files-detail">
        <pre className="ma-files-pre">{text.content}</pre>
      </div>
    );
  }
  return (
    <div className="ma-files-detail">
      <div className="ma-files-code">
        {lines.map((ln, i) => {
          const n = i + 1;
          const isTarget = view.line === n;
          return (
            <div
              key={n}
              ref={isTarget ? lineRef : undefined}
              className={`ma-files-ln${isTarget ? ' is-target' : ''}`}
            >
              <span className="ma-files-ln-n">{n}</span>
              <span className="ma-files-ln-t">{ln.length ? ln : ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 抽屉主体 ---------- */

export function MobileFiles(props: {
  open: boolean;
  wsId: string;
  workspace?: WorkspaceInfo;
  /** 外部打开目标（菜单入口为 null=浏览根目录；会话链接=具体文件） */
  target?: MobileFileTarget | null;
  /** 同目标重复请求的强制触发器 */
  nonce: number;
  onClose: () => void;
  onTip: (text: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(props.open);

  const sources = useMemo(() => {
    try {
      if (!props.workspace || props.workspace.id !== props.wsId) throw new Error(t('工作区不存在'));
      return { roots: sourceRootsFor(props.workspace), error: '' };
    } catch (err) { return { roots: [], error: err instanceof Error ? err.message : String(err) }; }
  }, [props.workspace, props.wsId, t]);
  const scope = JSON.stringify([props.wsId, props.workspace?.rootsRevision, sources.roots.map(r => [r.id, r.path]), sources.error]);
  const initialView = useMemo<FilesView>(() => sources.roots.length === 1
    ? { kind: 'list', rootId: sources.roots[0].id, path: '' } : { kind: 'roots' }, [scope]);
  const [location, setLocation] = useState({ wsId: props.wsId, view: initialView });
  const view = location.wsId === props.wsId ? location.view : initialView;
  const current = useRef({ scope, open: props.open, seq: 0 });
  if (current.current.scope !== scope || current.current.open !== props.open) {
    current.current = { scope, open: props.open, seq: current.current.seq + 1 };
  }
  useEffect(() => {
    current.current.open = props.open;
    return () => { current.current.open = false; current.current.seq++; };
  }, [props.open]);
  const [openError, setOpenError] = useState<{ scope: string; message: string }>();
  const [refresh, setRefresh] = useState(0);
  const navigate = useCallback((next: FilesView): void => {
    current.current.seq++;
    setOpenError(undefined);
    setLocation({ wsId: props.wsId, view: next });
  }, [props.wsId]);
  const rootId = view.kind === 'list' ? view.rootId : view.kind === 'file' ? view.fileRef?.rootId : undefined;
  const root = sources.roots.find(r => r.id === rootId);
  const rootError = sources.error || (rootId !== undefined && !root ? 'source folder not found' : '');
  const listKey = JSON.stringify([scope, view, refresh]);
  const [list, setList] = useState<{ key: string; entries?: FsDirEntry[]; error?: string; watchError?: string }>();

  /* 列表加载（从详情返回列表时也重拉，落进 agent 新写的文件） */
  useEffect(() => {
    if (!props.open || view.kind !== 'list' || rootError) return;
    let cancelled = false;
    void window.api.fs
      .listDirRef({ workspaceId: props.wsId, rootId: view.rootId, relativePath: view.path })
      .then((r) => {
        if (cancelled) return;
        setList({ key: listKey, ...(r.error ? { error: r.error } : { entries: sortEntries(r.entries), watchError: r.watchError }) });
      })
      .catch((e: unknown) => {
        if (!cancelled) setList({ key: listKey, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.wsId, listKey, rootError]);

  /**
   * 打开闸口：FileRef/主进程解析 → 根内 stat；目录进列表，文件只读预览。
   * 仅确认在所有源根之外的绝对路径可做磁盘级判断；相对路径不寻盘。
   */
  const openTarget = useCallback(
    (target: MobileFileTarget): void => {
      const seq = ++current.current.seq;
      const stillCurrent = (): boolean => current.current.open && current.current.scope === scope && current.current.seq === seq;
      setOpenError(undefined);
      setLocation({ wsId: props.wsId, view: initialView });
      void (async () => {
        try {
          if (!props.workspace || sources.error) throw new Error(sources.error || t('工作区不存在'));
          const resolved = target.fileRef ? { ok: true as const, fileRef: target.fileRef }
            : await window.api.fs.resolveRef(props.wsId, target.path);
          if (!stillCurrent()) return;
          if (resolved.ok) {
            const ref = resolved.fileRef;
            if (ref.workspaceId !== props.wsId) throw new Error(t('工作区不存在'));
            requireSourceRoot(props.workspace, ref.rootId);
            const st = await window.api.fs.statRef(ref);
            if (!stillCurrent()) return;
            if (!st.ok) throw new Error(st.error || t('无法读取文件'));
            navigate(st.isDirectory ? { kind: 'list', rootId: ref.rootId, path: ref.relativePath }
              : { kind: 'file', path: ref.relativePath, fileRef: ref, external: false, line: target.line });
            return;
          }
          // 仅确认在所有源根之外的绝对路径才可进外部只读；错误身份/越界不降级。
          if (!target.fileRef && isAbsolutePath(target.path) && isOutsideWorkspaceRootsResult(resolved)) {
            const stats = await window.api.shell.statPaths([target.path]);
            const st = stats[target.path];
            if (!stillCurrent()) return;
            if (st?.exists && st.isFile) {
              navigate({ kind: 'file', path: target.path, external: true, line: target.line });
              return;
            }
            throw new Error(st?.exists ? t('外部目录请在电脑端查看') : t('文件不存在：{{path}}', { path: target.path }));
          }
          throw new Error(resolved.error);
        } catch (err) {
          if (!stillCurrent()) return;
          const message = err instanceof Error ? err.message : String(err);
          setOpenError({ scope, message });
          props.onTip(message);
        }
      })();
    },
    [props.wsId, props.workspace, sources.error, scope, initialView, props.onTip, navigate, t]
  );

  /* 新请求/重新打开才重置导航；元数据改名或排序保留当前位置，版本变化只让旧请求失效。
   * 初次元数据到位后补处理目标；target 缺省 = 「⋯」菜单浏览源根。 */
  const hasWorkspace = props.workspace?.id === props.wsId;
  useEffect(() => {
    if (!props.open) return;
    if (!props.target) {
      navigate(initialView);
      return;
    }
    openTarget(props.target);
  }, [props.open, props.target, props.nonce, props.wsId, hasWorkspace]);

  if (!presence.mounted) return null;

  const inFile = view.kind === 'file';
  const dir = view.kind === 'list' ? view.path : '';
  const title = inFile ? baseName(view.path) : dir ? baseName(dir) : t('文件');
  const subtitle = inFile ? view.path : dir ? `/${dir}` : '';
  const backLabel = inFile ? t('返回') : dir ? t('上一级') : root && sources.roots.length > 1 ? t('返回') : t('关闭');
  const onBack = (): void => {
    if (inFile) navigate(view.fileRef && root ? { kind: 'list', rootId: root.id, path: parentDir(view.path) } : initialView);
    else if (view.kind === 'list' && dir) navigate({ ...view, path: parentDir(dir) });
    else if (view.kind === 'list' && sources.roots.length > 1) navigate({ kind: 'roots' });
    else props.onClose();
  };
  const entries = list?.key === listKey ? list.entries : undefined;
  const listError = list?.key === listKey ? list.error || list.watchError : undefined;

  return (
    <div className="ma-files-layer">
      <div
        className="mp-scrim ma-files-scrim"
        data-mp-stage={presence.stage}
        onClick={props.onClose}
        aria-hidden
      />
      <div
        className="mp-panel mfiles"
        data-mp-stage={presence.stage}
        role="dialog"
        aria-label={t('文件列表')}
      >
        <header className="ma-files-head">
          <button type="button" className="ma-topbar-btn" aria-label={backLabel} onClick={onBack}>
            <span className="ma-icon-back" aria-hidden />
          </button>
          <div className="ma-files-head-info">
            <div className="ma-files-head-title">{title}</div>
            {subtitle ? <div className="ma-files-head-sub">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="ma-topbar-btn ma-files-close"
            aria-label={t('关闭')}
            onClick={props.onClose}
          >
            <span className="ma-files-icon-close" aria-hidden />
          </button>
        </header>
        {rootId !== undefined || (sources.roots.length > 1 && view.kind !== 'roots') ? (
          <div className="ma-files-source">
            <button type="button" className="ma-files-source-name" aria-label={t('源文件夹')}
              title={root?.path} onClick={() => navigate({ kind: 'roots' })}>
              <span>{root ? workspaceRootLabel(root) : t('源文件夹')}</span>
              {root ? <span className="ma-files-root-path">{root.path}</span> : null}
            </button>
            <button type="button" className="ma-topbar-btn" aria-label={t('刷新')} onClick={() => {
              const seq = ++current.current.seq;
              const retry = root ? window.api.fs.refreshWatch(props.wsId, root.id) : Promise.resolve();
              void retry.then(result => {
                if (result && !result.ok) throw new Error(result.error || t('无法读取文件'));
              }).catch(err => {
                if (current.current.open && current.current.scope === scope && current.current.seq === seq) setOpenError({ scope, message: String(err) });
              }).finally(() => {
                if (current.current.open && current.current.scope === scope && current.current.seq === seq) setRefresh(n => n + 1);
              });
            }}>{t('刷新')}</button>
          </div>
        ) : null}
        {openError?.scope === scope ? <div className="ma-files-note" role="alert">{openError.message}</div> : null}
        {rootError ? <div className="ma-files-note" role="alert">{rootError}</div> : view.kind === 'roots' ? (
          <div className="ma-files-list">
            {sources.roots.map(r => (
              <button key={r.id} type="button" className="ma-files-row" aria-label={workspaceRootLabel(r) + ' ' + r.path}
                onClick={() => navigate({ kind: 'list', rootId: r.id, path: '' })}>
                <IconFolder className="ma-files-ico" />
                <span className="ma-files-root-info"><span>{workspaceRootLabel(r)}</span><span className="ma-files-root-path">{r.path}</span></span>
                <span className="ma-files-chev" aria-hidden />
              </button>
            ))}
          </div>
        ) : view.kind === 'list' ? (
          <div className="ma-files-list">
            {listError ? <div className="ma-files-note" role="alert">{listError}</div> : null}
            {entries == null ? (
              !listError ?
              <div className="ma-files-note">{t('加载中…')}</div>
              : null
            ) : entries.length === 0 ? (
              <div className="ma-files-note">{t('目录为空')}</div>
            ) : (
              entries.map((e) => (
                <button
                  type="button"
                  key={e.relativePath}
                  className="ma-files-row"
                  onClick={() =>
                    e.isDirectory
                      ? navigate({ ...view, path: e.relativePath })
                      : navigate({ kind: 'file', path: e.relativePath, external: false,
                        fileRef: { workspaceId: props.wsId, rootId: view.rootId, relativePath: e.relativePath } })
                  }
                >
                  {e.isDirectory ? (
                    <IconFolder className="ma-files-ico" />
                  ) : (
                    <FileTypeIcon name={e.name} />
                  )}
                  <span className="ma-files-name">{e.name}</span>
                  {e.isDirectory ? <span className="ma-files-chev" aria-hidden /> : null}
                </button>
              ))
            )}
          </div>
        ) : (
          <FileDetail key={JSON.stringify([scope, view, refresh])} view={view} active={props.open}
            rootsRevision={props.workspace?.rootsRevision ?? 0} onOpenTarget={openTarget} />
        )}
      </div>
    </div>
  );
}
