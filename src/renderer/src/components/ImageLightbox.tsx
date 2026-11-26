import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  fitMermaidView,
  MERMAID_ZOOM_STEP,
  zoomMermaidToward
} from '../../../shared/mermaidView';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconClose, IconMinus, IconPlus } from './icons';
import { usePresence } from './motion';

interface ImageLightboxProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

/**
 * 聊天图片大图查看器：复用 mermaid 查看器的缩放/平移数学与 overlay 骨架
 * （滚轮缩放、拖动平移、Esc 关闭、适应窗口）。此前消息缩略图点击走
 * window.open(data:)，被主进程 setWindowOpenHandler 一律 deny——死交互。
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const open = Boolean(src);
  const presence = usePresence(open);
  useOverlayDismiss(open && presence.mounted && presence.stage !== 'out', onClose);
  if (!presence.mounted) return null;

  return createPortal(
    // Portal 事件仍沿组件树冒泡，拦住灯箱点击，避免触发消息宿主的行为。
    <div
      className="md-mermaid-overlay"
      data-overlay-root=""
      {...presence.spread}
      role="dialog"
      aria-modal="true"
      aria-label={t('图片查看')}
      aria-hidden={!open || undefined}
      {...(!open ? { inert: '' } : {})}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mp-scrim-layer backdrop-blur-overlay mp-scrim" {...presence.spread} aria-hidden />
      {src ? <ImageLightboxContent src={src} alt={alt} onClose={onClose} /> : null}
    </div>,
    document.body
  );
}

function ImageLightboxContent(props: ImageLightboxProps & { src: string }): React.JSX.Element {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number; content: boolean } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // 首帧定位完成前隐藏舞台：初始 view 是原点，等 fit() 算好居中再显示，防左上角闪帧
  const [fitted, setFitted] = useState(false);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img) return;
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    setNatural({ w, h });
    setView(fitMermaidView(vp.clientWidth, vp.clientHeight, w, h));
    setFitted(true);
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [props.src, fit]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const factor = e.deltaY < 0 ? MERMAID_ZOOM_STEP : 1 / MERMAID_ZOOM_STEP;
      setView((cur) =>
        zoomMermaidToward(cur, cur.scale * factor, e.clientX - rect.left, e.clientY - rect.top)
      );
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBtn = (dir: 1 | -1): void => {
    const vp = viewportRef.current;
    if (!vp) return;
    const factor = dir > 0 ? MERMAID_ZOOM_STEP : 1 / MERMAID_ZOOM_STEP;
    setView((cur) =>
      zoomMermaidToward(cur, cur.scale * factor, vp.clientWidth / 2, vp.clientHeight / 2)
    );
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    // img 本身 pointer-events:none，图上点击实际命中的是舞台层 div，故按 stage 包含判定
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      x: view.x,
      y: view.y,
      content: e.target instanceof Element && e.target.closest('.md-mermaid-stage') !== null
    };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    setView((cur) => ({
      ...cur,
      x: drag.x + (e.clientX - drag.px),
      y: drag.y + (e.clientY - drag.py)
    }));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    // 点击图片外空白关闭：未拖动（<4px）且落点不在图上（stage 内）；pointercancel 不当点击
    if (e.type === 'pointerup' && !drag.content && Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < 4) {
      props.onClose();
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <div
        ref={viewportRef}
        className={`md-mermaid-viewport${dragging ? ' is-dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          className="md-mermaid-stage"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            visibility: fitted ? undefined : 'hidden'
          }}
        >
          <img
            ref={imgRef}
            src={props.src}
            alt={props.alt ?? ''}
            onLoad={fit}
            draggable={false}
          />
        </div>
      </div>
      <div className="md-mermaid-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="git-btn ghost" aria-label={t('缩小')} onClick={() => zoomBtn(-1)}>
          <IconMinus size={14} />
        </button>
        <span className="md-mermaid-zoom-label">{Math.round(view.scale * 100)}%</span>
        <button type="button" className="git-btn ghost" aria-label={t('放大')} onClick={() => zoomBtn(1)}>
          <IconPlus size={14} />
        </button>
        {natural ? (
          <span className="md-mermaid-hint">
            {natural.w}×{natural.h}
          </span>
        ) : null}
        <button type="button" className="git-btn ghost" title={t('适应窗口')} onClick={fit}>
          {t('适应')}
        </button>
        <span className="md-mermaid-hint">{t('滚轮缩放 · 拖动移动 · 点击空白或 Esc 关闭')}</span>
        <button type="button" className="git-btn ghost" aria-label={t('关闭')} onClick={props.onClose}>
          <IconClose size={14} />
        </button>
      </div>
    </>
  );
}
