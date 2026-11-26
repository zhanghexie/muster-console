import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../../../shared/workspaceUiPersist';

export type SplitAxis = 'row' | 'column';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clampRatio(n: number): number {
  return clamp(n, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX);
}

/** 落盘前去掉 0.4+0.02 这类二进制尘，避免 workspace.json 写出 0.42000000000000004 */
function snapRatio(n: number): number {
  return Math.round(clampRatio(n) * 10000) / 10000;
}

/**
 * 两栏可拖分割。拖动跟手；松手 / 键盘微调后才 `onRatioCommit`（调用方再 patch）。
 * `primaryRatio`：第一子节点占比；`axis=row` 为左右，`column` 为上下。
 */
export function SplitPane({
  axis,
  defaultPrimaryRatio,
  primaryRatio: primaryRatioProp,
  onRatioCommit,
  minPrimary,
  minSecondary,
  className,
  reverse,
  children,
  'aria-label': ariaLabel
}: {
  axis: SplitAxis;
  /** 0–1，默认第一栏占比 */
  defaultPrimaryRatio: number;
  /** 受控：外部持久化值；拖动中用本地态，外部变更（切工作区）时同步 */
  primaryRatio?: number;
  /** 松手或键盘提交，供落盘。拖动过程不调用 */
  onRatioCommit?: (ratio: number) => void;
  minPrimary: number;
  minSecondary: number;
  className?: string;
  /** 视觉上把主栏换到次栏另一侧（如右栏面板让内容靠屏幕内侧、列表贴外缘） */
  reverse?: boolean;
  /** 恰好两个子节点：主栏 / 次栏 */
  children: React.ReactNode;
  'aria-label'?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const panes = React.Children.toArray(children);
  const primary = panes[0] ?? null;
  const secondary = panes[1] ?? null;
  const [primaryRatio, setPrimaryRatio] = useState(() =>
    clampRatio(primaryRatioProp ?? defaultPrimaryRatio)
  );
  const [hot, setHot] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [axisLength, setAxisLength] = useState(0);
  const dragging = useRef(false);
  const ratioRef = useRef(primaryRatio);
  ratioRef.current = primaryRatio;
  const onRatioCommitRef = useRef(onRatioCommit);
  onRatioCommitRef.current = onRatioCommit;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      const rect = body.getBoundingClientRect();
      setAxisLength(axis === 'row' ? rect.width : rect.height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [axis]);

  useEffect(() => {
    if (dragging.current) return;
    if (primaryRatioProp == null) return;
    setPrimaryRatio(clampRatio(primaryRatioProp));
  }, [primaryRatioProp]);

  const applyFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = bodyRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const split = 6;
      if (axis === 'row') {
        const usable = rect.width - split;
        if (usable <= minPrimary + minSecondary) return;
        // reverse 时主栏在视觉右侧，按指针到右缘的距离算主栏宽
        const raw = reverse ? rect.right - clientX : clientX - rect.left;
        const primary = clamp(raw, minPrimary, usable - minSecondary);
        setPrimaryRatio(clampRatio(primary / usable));
      } else {
        const usable = rect.height - split;
        if (usable <= minPrimary + minSecondary) return;
        const primary = clamp(clientY - rect.top, minPrimary, usable - minSecondary);
        setPrimaryRatio(clampRatio(primary / usable));
      }
    },
    [axis, minPrimary, minSecondary, reverse]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragging.current = true;
      setHot(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
      applyFromPointer(e.clientX, e.clientY);
    },
    [applyFromPointer]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      applyFromPointer(e.clientX, e.clientY);
    },
    [applyFromPointer]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setHot(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onRatioCommitRef.current?.(snapRatio(ratioRef.current));
  }, []);

  // 键盘可调：方向键 ±2%，Home/End 到端点（separator 角色的标准交互）
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 0.02;
      const isRow = axis === 'row';
      let delta = 0;
      // reverse 时主栏在右：向左调 = 主栏变宽
      if (isRow && e.key === 'ArrowLeft') delta = reverse ? step : -step;
      else if (isRow && e.key === 'ArrowRight') delta = reverse ? -step : step;
      else if (!isRow && e.key === 'ArrowUp') delta = -step;
      else if (!isRow && e.key === 'ArrowDown') delta = step;
      else if (e.key === 'Home') {
        e.preventDefault();
        setPrimaryRatio(SPLIT_RATIO_MIN);
        onRatioCommitRef.current?.(snapRatio(SPLIT_RATIO_MIN));
        return;
      } else if (e.key === 'End') {
        e.preventDefault();
        setPrimaryRatio(SPLIT_RATIO_MAX);
        onRatioCommitRef.current?.(snapRatio(SPLIT_RATIO_MAX));
        return;
      } else return;
      e.preventDefault();
      setPrimaryRatio((r) => {
        const next = snapRatio(r + delta);
        onRatioCommitRef.current?.(next);
        return next;
      });
    },
    [axis, reverse]
  );

  const usable = Math.max(0, axisLength - 6);
  // A narrow host cannot satisfy both pixel minima. Fit proportionally, while
  // retaining the user's saved ratio for when the host grows again.
  const minimumTotal = minPrimary + minSecondary;
  const minimumScale = usable > 0 && minimumTotal > 0 ? Math.min(1, usable / minimumTotal) : 1;
  const primaryMinimum = minPrimary * minimumScale;
  const secondaryMinimum = minSecondary * minimumScale;
  const displayedRatio = usable > 0
    ? clamp(primaryRatio, primaryMinimum / usable, 1 - secondaryMinimum / usable)
    : primaryRatio;
  const minKey = axis === 'row' ? 'minWidth' : 'minHeight';

  return (
    <div
      ref={bodyRef}
      className={`split-pane split-pane-${axis}${reverse ? ' is-reversed' : ''}${className ? ` ${className}` : ''}`}
    >
      <div
        className="split-pane-panel split-pane-primary"
        style={{ flex: `1 1 calc((100% - 6px) * ${displayedRatio})`, [minKey]: primaryMinimum }}
      >
        {primary}
      </div>
      <div
        className={`split-pane-handle split-pane-handle-${axis}${hot ? ' is-hot' : ''}`}
        role="separator"
        tabIndex={0}
        aria-orientation={axis === 'row' ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(displayedRatio * 100)}
        aria-label={ariaLabel ?? t('拖动调整面板大小')}
        title={t('拖动调整大小（方向键微调）')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="split-pane-handle-line" />
      </div>
      <div
        className="split-pane-panel split-pane-secondary"
        style={{ flex: `0 0 calc((100% - 6px) * ${1 - displayedRatio})`, [minKey]: secondaryMinimum }}
      >
        {secondary}
      </div>
    </div>
  );
}
