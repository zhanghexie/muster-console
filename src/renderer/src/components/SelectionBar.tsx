import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { beginSelectionDrag } from '../terminal/selectionActions';
import { MOTION, usePresence } from './motion';
import { overlayViewportOrigin, stripOverlayHost } from '../hooks/useDismissOnPagePeek';

/** 浮条菜单项；动作是否收起浮条由动作自己经 ctx.dismiss 决定（对齐终端旧行为：复制/搜索后浮条保留） */
export interface SelectionBarItem {
  id: string;
  label: string;
  primary?: boolean;
  run: (ctx: SelectionBarActionCtx) => void;
}

export interface SelectionBarActionCtx {
  /** 动作发起时浮条的视口矩形（「爆炸」贴位用） */
  barRect: DOMRect | null;
  /** 收起浮条 */
  dismiss: () => void;
  /** 清宿主选区（xterm clearSelection / DOM removeAllRanges） */
  clearSelection: () => void;
}

interface Props {
  text: string;
  /** 视口坐标：划词松手时的指针位置 */
  anchor: { x: number; y: number };
  anchorElement?: Element;
  hidden?: boolean;
  retiring?: boolean;
  items: SelectionBarItem[];
  /** 拖拽选区时解析路径用的工作目录 */
  dragCwd?: string;
  dismiss: () => void;
  clearSelection: () => void;
  /** 每个动作后的统一收尾（终端：还焦点给 xterm） */
  onAfterAction?: () => void;
}

/** 划词浮条按视口翻转定位，再随选区所在的虚拟屏移动。 */
export function SelectionBar({
  text,
  anchor,
  anchorElement,
  hidden = false,
  retiring = false,
  items,
  dragCwd,
  dismiss,
  clearSelection,
  onAfterAction
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);
  const host = stripOverlayHost(anchorElement ?? null);
  const presence = usePresence(!hidden, MOTION.microMs);

  // 阻止按钮获得焦点（快捷键继续进终端/编辑器）；也避免点按钮时拖起整条
  const noStealFocus = {
    tabIndex: -1 as const,
    draggable: false as const,
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
    }
  };

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || retiring) return;
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x + 10;
    let top = anchor.y + 10;
    if (left + bw > vw - 8) left = Math.max(8, anchor.x - bw - 10);
    if (top + bh > vh - 8) top = Math.max(8, anchor.y - bh - 10);
    left = Math.max(8, Math.min(left, vw - bw - 8));
    top = Math.max(8, Math.min(top, vh - bh - 8));
    const origin = overlayViewportOrigin(host);
    bar.style.left = `${left - origin.left}px`;
    bar.style.top = `${top - origin.top}px`;
  }, [anchor.x, anchor.y, text, items, presence.mounted, host, retiring]);

  if (!presence.mounted) return <></>;

  return createPortal(
    <div
      ref={barRef}
      className="sel-bar mp-pop"
      data-mp-stage={retiring ? 'out' : presence.stage}
      data-h-strip-overlay=""
      style={{ visibility: hidden ? 'hidden' : undefined, pointerEvents: hidden ? 'none' : undefined }}
      aria-hidden={hidden || retiring || undefined} {...(retiring ? { inert: '' } : {})}
      data-overlay-root
      role="toolbar"
      aria-label={t('选区操作')}
      draggable
      onDragStart={(e) => beginSelectionDrag(e.dataTransfer, text, dragCwd)}
    >
      <span
        className="sel-bar-drag"
        draggable
        title={t('拖到文件区、Git、Agent 或终端')}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.stopPropagation();
          beginSelectionDrag(e.dataTransfer, text, dragCwd);
        }}
      >
        {text}
      </span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`ui-btn tiny${item.primary ? ' primary' : ''}`}
          {...noStealFocus}
          onClick={() => {
            const bar = barRef.current;
            item.run({ barRect: bar?.getBoundingClientRect() ?? null, dismiss, clearSelection });
            onAfterAction?.();
          }}
        >
          {t(item.label)}
        </button>
      ))}
    </div>,
    host
  );
}
