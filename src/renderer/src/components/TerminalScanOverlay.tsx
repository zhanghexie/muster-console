import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { copySelectionText, openSelectionUrl } from '../terminal/selectionActions';
import { openUiArtifactsInBrowser, uiArtifactLinksInScanHit } from '../terminal/uiArtifactOpen';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { getResolvedAppearance, subscribeAppearance } from '../theme';

export type ScanHitView = {
  id: string;
  kind: 'url' | 'file' | 'dir' | 'loc';
  text: string;
  absPath?: string;
  line?: number;
  col?: number;
  rects: { left: number; top: number; width: number; height: number }[];
};

export type ScanOrigin = {
  /** 相对 terminal-wrap / mask */
  left: number;
  top: number;
};

interface Props {
  hits: ScanHitView[];
  /** 打开扫描前 capturePage 的终端区域截图（含 WebGL） */
  snapshot: string | null;
  origin?: ScanOrigin | null;
  onClose: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
  onTip: (s: string) => void;
  onPreviewFile: (absPath: string, line?: number, col?: number) => void;
  linkOwner?: import('../chatSurface/chatLinkOwner').ChatLinkOwner;
}

type Bounds = { left: number; top: number; right: number; bottom: number };
type Hole = { x: number; y: number; w: number; h: number };

const HOLE_PAD = 4;
const BLUR_PX = 12;

function unionBounds(rects: ScanHitView['rects']): Bounds {
  if (rects.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  return { left, top, right, bottom };
}

function hitClass(kind: ScanHitView['kind']): string {
  if (kind === 'url') return 'is-url';
  if (kind === 'loc') return 'is-loc';
  return 'is-path';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('snapshot load failed'));
    img.src = src;
  });
}

/**
 * 截图 → 全图高斯模糊+压暗 → 命中矩形贴回清晰原图。
 * 返回 device-pixel canvas；失败返回 null。
 */
async function composeFromSnapshot(
  snapshotUrl: string,
  cssW: number,
  cssH: number,
  holes: Hole[],
  scrim: string
): Promise<HTMLCanvasElement | null> {
  if (cssW < 2 || cssH < 2 || !snapshotUrl) return null;
  let img: HTMLImageElement;
  try {
    img = await loadImage(snapshotUrl);
  } catch {
    return null;
  }
  if (img.naturalWidth < 2 || img.naturalHeight < 2) return null;

  const dpr = Math.max(1, img.naturalWidth / cssW);
  const outW = Math.max(1, Math.round(cssW * dpr));
  const outH = Math.max(1, Math.round(cssH * dpr));

  const sharp = document.createElement('canvas');
  sharp.width = outW;
  sharp.height = outH;
  const sctx = sharp.getContext('2d');
  if (!sctx) return null;
  sctx.drawImage(img, 0, 0, outW, outH);

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  // 在 CSS 像素空间做 blur，边缘与洞坐标一致
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.filter = `blur(${BLUR_PX}px)`;
  ctx.drawImage(sharp, 0, 0, cssW, cssH);
  ctx.filter = 'none';
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, cssW, cssH);

  for (const hole of holes) {
    const x = Math.max(0, hole.x);
    const y = Math.max(0, hole.y);
    const w = Math.min(hole.w, cssW - x);
    const h = Math.min(hole.h, cssH - y);
    if (w <= 0 || h <= 0) continue;
    ctx.drawImage(sharp, x * dpr, y * dpr, w * dpr, h * dpr, x, y, w, h);
  }

  return out;
}

function frostHoleClipPath(width: number, height: number, holes: Hole[]): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let d = `M0,0H${w}V${h}H0Z`;
  for (const hole of holes) {
    const x = Math.round(hole.x);
    const y = Math.round(hole.y);
    const r = Math.round(hole.x + hole.w);
    const b = Math.round(hole.y + hole.h);
    if (r <= x || b <= y) continue;
    d += `M${x},${y}H${r}V${b}H${x}Z`;
  }
  return `path(evenodd, "${d}")`;
}

const noStealFocus = {
  tabIndex: -1 as const,
  onMouseDown: (e: React.MouseEvent) => {
    e.preventDefault();
  }
};

export function TerminalScanOverlay({
  hits,
  snapshot,
  origin,
  onClose,
  onEscape,
  autoFocus = true,
  onTip,
  onPreviewFile,
  linkOwner
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [ready, setReady] = useState(false);
  const [appearance, setAppearance] = useState(getResolvedAppearance);
  useEffect(() => subscribeAppearance(setAppearance), []);

  const activeHit = useMemo(
    () => hits.find((h) => h.id === activeId) ?? null,
    [hits, activeId]
  );

  const flatHitOrder = useMemo(() => {
    const order: { hit: ScanHitView; rect: ScanHitView['rects'][number]; i: number }[] = [];
    let n = 0;
    for (const hit of hits) {
      for (let ri = 0; ri < hit.rects.length; ri++) {
        order.push({ hit, rect: hit.rects[ri]!, i: n++ });
      }
    }
    return order;
  }, [hits]);

  const scanNavIds = useMemo(
    () => flatHitOrder.map(({ hit }) => hit.id),
    [flatHitOrder]
  );

  const { onListKeyDown, getItemProps } = useListKeyboardNav({
    items: scanNavIds,
    selectedId: activeId,
    onSelect: setActiveId
  });

  const clearHoles = useMemo((): Hole[] => {
    return flatHitOrder.map(({ rect }) => ({
      x: Math.max(0, rect.left - HOLE_PAD),
      y: Math.max(0, rect.top - HOLE_PAD),
      w: rect.width + HOLE_PAD * 2,
      h: rect.height + HOLE_PAD * 2
    }));
  }, [flatHitOrder]);

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const sync = (): void => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const paint = paintRef.current;
    if (!paint || size.w < 2 || size.h < 2) return;

    setReady(false);
    void (async () => {
      if (!snapshot) {
        if (!cancelled) setReady(false);
        return;
      }
      const composed = await composeFromSnapshot(snapshot, size.w, size.h, clearHoles, appearance.cssVars['--scrim']!);
      if (cancelled || !composed || !paintRef.current) return;
      const target = paintRef.current;
      target.width = composed.width;
      target.height = composed.height;
      const ctx = target.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(composed, 0, 0);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshot, size.w, size.h, clearHoles, appearance]);

  useOverlayDismiss(true, onEscape ?? onClose);

  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

  // 初始落在命中行下方；容器 overflow:hidden，测量后钳制回可视区（底部命中时翻到上方）
  useLayoutEffect(() => {
    if (!activeHit) {
      setMenuPos(null);
      return;
    }
    const u = unionBounds(activeHit.rects);
    setMenuPos({ left: u.left, top: u.bottom + 6 });
  }, [activeHit]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menuPos || !activeHit) return;
    const u = unionBounds(activeHit.rects);
    const rect = el.getBoundingClientRect();
    let left = u.left;
    let top = u.bottom + 6;
    if (left + rect.width > size.w - 4) left = Math.max(4, size.w - rect.width - 4);
    if (top + rect.height > size.h - 4) top = Math.max(4, u.top - rect.height - 6);
    if (left !== menuPos.left || top !== menuPos.top) setMenuPos({ left, top });
  }, [activeHit, menuPos, size.w, size.h]);

  const rootStyle = useMemo((): React.CSSProperties => {
    const ox = origin && Number.isFinite(origin.left) ? origin.left : 0;
    const oy = origin && Number.isFinite(origin.top) ? origin.top : 0;
    return {
      ['--scan-ox' as string]: `${ox}px`,
      ['--scan-oy' as string]: `${oy}px`
    };
  }, [origin]);

  const fallbackClip = useMemo(
    () => frostHoleClipPath(size.w, size.h, clearHoles),
    [size.w, size.h, clearHoles]
  );

  const runAction = (fn: () => void | Promise<void>): void => {
    void Promise.resolve(fn()).catch(() => undefined);
  };

  const copyPath = (hit: ScanHitView): void => {
    void copySelectionText(hit.absPath ?? hit.text, onTip);
  };

  const revealPath = async (absPath: string): Promise<void> => {
    const res = await window.api.shell.revealPath(absPath);
    if (!res.ok) onTip(res.error || t('无法打开路径'));
  };

  const renderMenuItems = (hit: ScanHitView): React.ReactNode => {
    // ma-ui 部件链接命中（agent-sessions/<sid>/ui/*.inline|browser.html，实体文本或
    // absPath 任一命中）：菜单前置「在网页区打开」（普通 .html/路径不出，见判定函数）
    const uiLinks = uiArtifactLinksInScanHit(hit);
    return (
      <>
        {uiLinks.length > 0 ? (
          <button
            type="button"
            className="ui-btn tiny"
            {...noStealFocus}
            onClick={() => runAction(() => openUiArtifactsInBrowser(uiLinks, onTip, linkOwner))}
          >
            {t('在网页区打开')}
          </button>
        ) : null}
        {renderKindMenuItems(hit)}
      </>
    );
  };

  const renderKindMenuItems = (hit: ScanHitView): React.ReactNode => {
    switch (hit.kind) {
      case 'url':
        return (
          <>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => runAction(() => openSelectionUrl(hit.text, onTip))}
            >
              {t('打开链接')}
            </button>
            {/* localhost 家族 URL 命中本地文件：追加文件操作（stat 已确认存在） */}
            {hit.absPath ? (
              <>
                <button
                  type="button"
                  className="ui-btn tiny"
                  {...noStealFocus}
                  onClick={() => runAction(() => onPreviewFile(hit.absPath!, hit.line, hit.col))}
                >
                  {t('在文件区预览')}
                </button>
                <button
                  type="button"
                  className="ui-btn tiny"
                  {...noStealFocus}
                  onClick={() => runAction(() => revealPath(hit.absPath!))}
                >
                  {t('资源管理器')}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => runAction(() => copySelectionText(hit.text, onTip))}
            >
              {t('复制')}
            </button>
          </>
        );
      case 'file':
        return (
          <>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => {
                if (hit.absPath) runAction(() => onPreviewFile(hit.absPath!, hit.line, hit.col));
                else onTip(t('无法解析路径'));
              }}
            >
              {t('在文件区预览')}
            </button>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => {
                if (hit.absPath) runAction(() => revealPath(hit.absPath!));
                else onTip(t('无法解析路径'));
              }}
            >
              {t('资源管理器')}
            </button>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => runAction(() => copyPath(hit))}
            >
              {t('复制路径')}
            </button>
          </>
        );
      case 'dir':
        return (
          <>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => {
                if (hit.absPath) runAction(() => revealPath(hit.absPath!));
                else onTip(t('无法解析路径'));
              }}
            >
              {t('资源管理器')}
            </button>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => runAction(() => copyPath(hit))}
            >
              {t('复制路径')}
            </button>
          </>
        );
      case 'loc':
        return (
          <>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => {
                if (hit.absPath) runAction(() => onPreviewFile(hit.absPath!, hit.line, hit.col));
                else onTip(t('无法解析路径'));
              }}
            >
              {t('在文件区预览（跳行）')}
            </button>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => {
                if (hit.absPath) runAction(() => revealPath(hit.absPath!));
                else onTip(t('无法解析路径'));
              }}
            >
              {t('资源管理器')}
            </button>
            <button
              type="button"
              className="ui-btn tiny"
              {...noStealFocus}
              onClick={() => runAction(() => copyPath(hit))}
            >
              {t('复制路径')}
            </button>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div
      ref={rootRef}
      className="term-scan-mask"
      role="presentation"
      style={rootStyle}
      tabIndex={0}
      onKeyDown={onListKeyDown}
    >
      {/* 主路径：截图合成（真实高斯模糊）；失败则仅压暗挖洞 */}
      <canvas
        ref={paintRef}
        className={`term-scan-composite${ready ? ' is-on' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      {!ready ? (
        <div
          className="term-scan-frost-fallback"
          style={{ clipPath: fallbackClip }}
          onMouseDown={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
      ) : null}

      {flatHitOrder.map(({ hit, rect, i }) => (
        <div
          key={`${hit.id}-${i}`}
          {...getItemProps(hit.id)}
          className={`term-scan-hit ${hitClass(hit.kind)}${activeId === hit.id ? ' is-active' : ''}`}
          data-hit-id={hit.id}
          style={
            {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              ['--scan-i' as string]: String(i)
            } as React.CSSProperties
          }
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            rootRef.current?.focus();
            setActiveId(hit.id);
          }}
        />
      ))}

      {activeHit && menuPos ? (
        <div
          key={activeHit.id}
          ref={menuRef}
          className="term-scan-menu"
          role="toolbar"
          aria-label={t('扫描命中操作')}
          style={menuPos}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {renderMenuItems(activeHit)}
        </div>
      ) : null}
    </div>
  );
}
