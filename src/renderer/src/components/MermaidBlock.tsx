import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { contrastMermaidLabels, fitMermaidView, MERMAID_ZOOM_STEP, normalizeMermaidSvg, zoomMermaidToward } from '../../../shared/mermaidView';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconClose, IconMinus, IconPlus } from './icons';

interface Props {
  source: string;
}

let peleLoad: Promise<typeof import('pele')> | null = null;

function loadPele(): Promise<typeof import('pele')> {
  if (!peleLoad) peleLoad = import('pele');
  return peleLoad;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function renderPeleSvg(source: string): Promise<string> {
  const pele = await loadPele();
  // pele 同步渲染、无临时 DOM；主题色经 SVG 内联 var(--pele-*) 引用容器映射（见 markdown.css），切主题无需重渲。
  // contrastMermaidLabels：源码 classDef 字面浅色填充配对比文字色（深色主题浅底浅字不可读）。
  // normalizeMermaidSvg 剥掉 pele 内联的 max-width/height，交给 .md-mermaid / 全屏 stage 的 CSS 管尺寸。
  const { svg } = pele.render(source, { fontFamily: cssVar('--font-sans') || 'sans-serif' });
  return normalizeMermaidSvg(contrastMermaidLabels(svg));
}

function sizeFromSvg(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.viewBox?.baseVal;
  const w = (vb && vb.width) || svg.clientWidth || svg.getBBox().width || 1;
  const h = (vb && vb.height) || svg.clientHeight || svg.getBBox().height || 1;
  svg.style.maxWidth = 'none';
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  return { w, h };
}

function MermaidLightbox({ svg, onClose }: { svg: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number; content: boolean } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // 首帧定位完成前隐藏舞台：初始 view 是原点，等 rAF 里的 fit() 算好居中再显示，
  // 否则图会在左上角闪一帧才跳到中间
  const [fitted, setFitted] = useState(false);

  useOverlayDismiss(true, onClose);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    const svgEl = contentRef.current?.querySelector('svg');
    if (!vp || !svgEl) return;
    const { w, h } = sizeFromSvg(svgEl);
    setView(fitMermaidView(vp.clientWidth, vp.clientHeight, w, h));
    setFitted(true);
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [svg, fit]);

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
    // svg 本身 pointer-events:none，图上点击实际命中的是舞台层 div，故按 stage 包含判定
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
    // 点击图外空白关闭：未拖动（<4px）且落点不在图上（stage 内）；pointercancel 不当点击
    if (e.type === 'pointerup' && !drag.content && Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < 4) {
      onClose();
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return createPortal(
    <div className="md-mermaid-overlay backdrop-blur-overlay" role="dialog" aria-modal="true" aria-label={t('mermaid 图查看')}>
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
          ref={contentRef}
          className="md-mermaid-stage"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            visibility: fitted ? undefined : 'hidden'
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="md-mermaid-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="git-btn ghost" aria-label={t('缩小')} onClick={() => zoomBtn(-1)}>
          <IconMinus size={14} />
        </button>
        <span className="md-mermaid-zoom-label">{Math.round(view.scale * 100)}%</span>
        <button type="button" className="git-btn ghost" aria-label={t('放大')} onClick={() => zoomBtn(1)}>
          <IconPlus size={14} />
        </button>
        <button type="button" className="git-btn ghost" title={t('适应窗口')} onClick={fit}>
          {t('适应')}
        </button>
        <span className="md-mermaid-hint">{t('滚轮缩放 · 拖动移动 · 点击空白或 Esc 关闭')}</span>
        <button type="button" className="git-btn ghost" aria-label={t('关闭')} onClick={onClose}>
          <IconClose size={14} />
        </button>
      </div>
    </div>,
    document.body
  );
}

/**
 * mermaid 围栏（pele 渲染）：懒加载 pele、同步 render、160ms 流式防抖，
 * 半成品解析失败回退源码；主题色走 CSS 变量（--pele-* 映射），仅字体就绪后重渲一次。
 * 点击预览弹出可缩放查看器。
 */
export function MermaidBlock({ source }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [themeStamp, setThemeStamp] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      if (alive) setThemeStamp((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const trimmed = source.trim();
    if (!trimmed) {
      setSvg(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void renderPeleSvg(trimmed)
        .then((out) => {
          if (cancelled) return;
          setSvg(out);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setSvg(null);
          setFailed(true);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, themeStamp]);

  if (svg) {
    return (
      <>
        <div
          className="md-mermaid is-openable"
          role="button"
          tabIndex={0}
          aria-label={t('点击放大 mermaid 图')}
          title={t('点击放大')}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(true);
            }
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {open ? <MermaidLightbox svg={svg} onClose={() => setOpen(false)} /> : null}
      </>
    );
  }

  return (
    <pre
      className={failed ? 'md-mermaid-fallback is-error' : 'md-mermaid-fallback'}
      title={failed ? t('图表语法尚未完整或无法解析') : undefined}
    >
      <code className="language-mermaid">{source}</code>
    </pre>
  );
}
