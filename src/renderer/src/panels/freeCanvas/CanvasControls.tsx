/**
 * 自由视图画布 · 屏幕层控件：框选矩形（屏幕系）、悬浮工具条（自动布局/打组/解散）、
 * 缩放条（− / 百分比重置 / ＋ / 适配）、左下操作提示、自动布局撤销 toast（mp-pop 进出场）、
 * 拉线落空白的 ContextMenu（Fork / 交接 / 思路便签）。
 * JSX 从 FreeCanvas.tsx 原样拆出；.fc-ui 元素不受视口手势影响的行为不变。
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clampZoom } from '../freeViewGeom';
import { updateFreeViewLayout } from '../freeViewStore';
import type { MutableRefObject } from 'react';
import { ContextMenu } from '../../components/ContextMenu';
import type { Presence } from '../../components/motion';
import { MOTION, usePresence } from '../../components/motion';
import type { LinkMenuPayload } from './types';
import type { FreeCanvasItem } from './types';

export function CanvasHelp({ hint }: { hint: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, MOTION.microMs);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return <div className="fc-ui fc-help" ref={root}>
    <button type="button" className="fc-help-toggle" ref={button} aria-label={t('操作说明')}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>?</button>
    {presence.mounted && <div id={id} role="note" className="fc-help-content mp-pop" {...presence.spread}
      aria-hidden={!open}>{hint}</div>}
  </div>;
}

export interface CanvasControlsProps {
  /** 框选矩形（屏幕系，不随 zoom 缩放） */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  zoomPct: number;
  canGroup: boolean;
  inAnyGroup: boolean;
  runAutoArrange: () => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  zoomAt: (cx: number, cy: number, factor: number) => void;
  fitView: () => void;
  vpRef: MutableRefObject<HTMLDivElement | null>;
  toastPresence: Presence;
  undoArrange: () => void;
  linkMenu: LinkMenuPayload | null;
  sourceById: Map<string, FreeCanvasItem>;
  onLinkMenu: (id: string) => void;
  closeLinkMenu: () => void;
}

export function CanvasControls(props: CanvasControlsProps): React.JSX.Element {
  const {
    marquee,
    zoomPct,
    canGroup,
    inAnyGroup,
    runAutoArrange,
    groupSelection,
    ungroupSelection,
    zoomAt,
    fitView,
    vpRef,
    toastPresence,
    undoArrange,
    linkMenu,
    sourceById,
    onLinkMenu,
    closeLinkMenu
  } = props;
  const { t } = useTranslation();
  const hint = t('空白拖动框选 · 空格或右键拖动平移 · 滚轮缩放 · 双击空白新建 · 从节点圆点拉到空白可 fork / 交接 / 落便签');

  return (
    <>
      {/* 框选矩形（屏幕系） */}
      {marquee ? (
        <div
          className="fc-marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0)
          }}
        />
      ) : null}

      {/* 悬浮工具条 */}
      <div className="fc-ui fc-toolbar">
        <button
          type="button"
          className="fc-tool-btn"
          title={t('Ctrl+Shift+L 按工作区聚簇重排全部节点')}
          onClick={runAutoArrange}
        >
          {t('自动布局')}
        </button>
        <button
          type="button"
          className="fc-tool-btn"
          disabled={!canGroup}
          title={t('Ctrl+G 打组选中节点')}
          onClick={groupSelection}
        >
          {t('打组')}
        </button>
        <button
          type="button"
          className="fc-tool-btn"
          disabled={!inAnyGroup}
          title={t('Ctrl+Shift+D 解散分组')}
          onClick={ungroupSelection}
        >
          {t('解散分组')}
        </button>
      </div>
      <div className="fc-ui fc-zoombar">
        <button
          type="button"
          className="fc-zoom-btn"
          title={t('缩小')}
          onClick={() => {
            const el = vpRef.current;
            if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1 / 1.2);
          }}
        >
          −
        </button>
        <button
          type="button"
          className="fc-zoom-btn fc-zoom-val"
          title={t('重置缩放')}
          onClick={() => {
            const el = vpRef.current;
            if (!el) return;
            updateFreeViewLayout((l) => {
              const z = clampZoom(1);
              const cx = el.clientWidth / 2;
              const cy = el.clientHeight / 2;
              const wx = (cx - l.pan.x) / l.zoom;
              const wy = (cy - l.pan.y) / l.zoom;
              return { ...l, zoom: z, pan: { x: cx - wx * z, y: cy - wy * z } };
            });
          }}
        >
          {zoomPct}%
        </button>
        <button
          type="button"
          className="fc-zoom-btn"
          title={t('放大')}
          onClick={() => {
            const el = vpRef.current;
            if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.2);
          }}
        >
          ＋
        </button>
        <button type="button" className="fc-zoom-btn fc-zoom-fit" title={t('适配内容')} onClick={fitView}>
          {t('适配')}
        </button>
      </div>
      <CanvasHelp hint={hint} />
      {/* 自动布局撤销 toast（mp-pop 进出场；6 秒自动消失 / 画布操作提前收起） */}
      {toastPresence.mounted ? (
        <div className="fc-toast-wrap">
          <div className="fc-ui fc-toast mp-pop" {...toastPresence.spread}>
            <span>{t('已自动布局')}</span>
            <button type="button" className="fc-tool-btn" onClick={undoArrange}>
              {t('撤销')}
            </button>
          </div>
        </div>
      ) : null}
      {linkMenu ? (
        <ContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          items={[
            {
              id: 'fork',
              label: t('Fork'),
              disabled: (sourceById.get(linkMenu.from)?.forkSupport ?? 'none') === 'none',
              title:
                (sourceById.get(linkMenu.from)?.forkSupport ?? 'none') === 'none'
                  ? t('该类型暂不支持')
                  : undefined
            },
            {
              id: 'handover',
              label: t('交接'),
              disabled: (sourceById.get(linkMenu.from)?.forkSupport ?? 'none') === 'none',
              title:
                (sourceById.get(linkMenu.from)?.forkSupport ?? 'none') === 'none'
                  ? t('该类型暂不支持')
                  : undefined
            },
            { id: 'note', label: t('思路便签') }
          ]}
          onSelect={onLinkMenu}
          onClose={closeLinkMenu}
        />
      ) : null}
    </>
  );
}
