import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { MOTION, usePresence } from './motion';
import type { HoverPinHold } from '../hooks/useHoverPinMenu';
import { isOverlayPageSwitch, overlayViewportOrigin, stripOverlayHost, useDismissOnPagePeek, type PageOverlayAnchor } from '../hooks/useDismissOnPagePeek';

export type ContextMenuPoint = { x: number; y: number; anchor: Element };

export type ContextMenuItem = {
  id: string;
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 灰置项的原因（原生 title，TooltipHost 接管） */
  title?: string;
  /** 勾选态：菜单里任一项定义了该字段，全部条目前都占一个 ✓ 槽位（不勾为空槽，保证左缘对齐） */
  checked?: boolean;
  /** 分隔线（仍需唯一 id 作 key；键盘导航与悬停高亮自动跳过） */
  separator?: boolean;
  /** 二级子菜单（悬停/点击展开；选中项 id 直报，不拼父 id） */
  children?: ContextMenuItem[];
};

const MARGIN = 8;
const ENABLED_ITEM = 'button:not([aria-disabled="true"])';

export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
  anchor = null,
  excludeCloseRef,
  onHoverEnter,
  onHoverLeave,
  hold
}: {
  /** 视口坐标（通常来自 MouseEvent.clientX/Y） */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: (reason?: 'page-peek') => void;
  /** The DOM trigger owns the menu even when it is docked on a different page. */
  anchor?: PageOverlayAnchor;
  /**
   * 点这些节点不关菜单（触发器与 portal 浮层不在同一子树）。
   * 否则 pointerdown 先关、click 再开，表现为「再点不关闭」。
   */
  excludeCloseRef?: RefObject<Element | null> | Array<RefObject<Element | null>>;
  /** 悬停预览：指针进入/离开菜单本体（与触发器一起算在场） */
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  /** 悬停预览 / 点击固定，仅写 data-menu-hold 供测试与样式 */
  hold?: HoverPinHold;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [activeIdx, setActiveIdx] = useState(() => items.findIndex((it) => !it.disabled && !it.separator));
  /** 展开子菜单的父项序号（null=无） */
  const [flyoutIdx, setFlyoutIdx] = useState<number | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const pendingFlyoutFocusRef = useRef<number | null>(null);
  /** flyout 实测定位（null=尚未实测，渲染期按回退宽 180 估位） */
  const [flyoutLeft, setFlyoutLeft] = useState<number | null>(null);
  const host = stripOverlayHost(anchor);
  const [leaving, setLeaving] = useState(false);
  const presence = usePresence(!leaving, MOTION.microMs);
  useDismissOnPagePeek(!leaving, anchor, () => setLeaving(true));
  useLayoutEffect(() => {
    if (leaving && !presence.mounted) onClose('page-peek');
  }, [leaving, presence.mounted, onClose]);

  const closeFlyout = useCallback((): void => {
    if (flyoutIdx == null) return;
    const parentItem = ref.current?.children[flyoutIdx] as HTMLButtonElement | undefined;
    parentItem?.focus({ preventScroll: true });
    setFlyoutIdx(null);
  }, [flyoutIdx]);

  const openFlyoutWithFocus = useCallback((index: number): void => {
    if (flyoutIdx === index && flyoutRef.current) {
      flyoutRef.current.querySelector<HTMLButtonElement>(ENABLED_ITEM)?.focus();
      return;
    }
    pendingFlyoutFocusRef.current = index;
    setFlyoutIdx(index);
  }, [flyoutIdx]);

  useLayoutEffect(() => {
    if (flyoutIdx == null || pendingFlyoutFocusRef.current !== flyoutIdx) return;
    pendingFlyoutFocusRef.current = null;
    flyoutRef.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM)?.focus();
  }, [flyoutIdx]);

  useOverlayDismiss(!leaving, () => {
    if (flyoutRef.current?.contains(document.activeElement)) closeFlyout();
    else onClose();
  });

  // 方向键循环导航（跳过 disabled），Enter/Space 触发，Home/End 跳首尾
  useEffect(() => {
    if (leaving) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.defaultPrevented || ev.key === 'Escape' || ev.isComposing || ev.keyCode === 229) return;
      // 焦点已在子菜单内：主菜单键盘导航让位（Enter/方向键由子菜单按钮自身处理）
      if (flyoutRef.current?.contains(document.activeElement)) {
        if (ev.key === 'ArrowLeft') {
          ev.preventDefault();
          closeFlyout();
        }
        return;
      }
      const enabled = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.disabled && !it.separator);
      if (!enabled.length) return;
      const curEnabledPos = enabled.findIndex(({ i }) => i === activeIdx);
      const target = enabled[curEnabledPos]?.it;
      const move = (delta: number): void => {
        const next = enabled[(curEnabledPos + delta + enabled.length) % enabled.length];
        setActiveIdx(next.i);
        ref.current?.children[next.i]?.scrollIntoView({ block: 'nearest' });
      };
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        move(1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        move(-1);
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        setActiveIdx(enabled[0].i);
      } else if (ev.key === 'End') {
        ev.preventDefault();
        setActiveIdx(enabled[enabled.length - 1].i);
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (target) {
          if (target.children?.length) {
            openFlyoutWithFocus(activeIdx);
            return;
          }
          onSelect(target.id);
          onClose();
        }
      } else if (ev.key === 'ArrowRight' && target?.children?.length) {
        ev.preventDefault();
        openFlyoutWithFocus(activeIdx);
      } else if (ev.key === 'ArrowLeft') {
        setFlyoutIdx(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, activeIdx, onSelect, onClose, closeFlyout, openFlyoutWithFocus, leaving]);

  useEffect(() => {
    if (leaving) return;
    const onDown = (ev: PointerEvent): void => {
      if (isOverlayPageSwitch(anchor, ev.target)) return;
      const node = ev.target as Node;
      if (ref.current?.contains(node)) return;
      // 子菜单和主菜单同挂浮层宿主，分别判断命中。
      if (flyoutRef.current?.contains(node)) return;
      const excludes = excludeCloseRef
        ? Array.isArray(excludeCloseRef)
          ? excludeCloseRef
          : [excludeCloseRef]
        : [];
      if (excludes.some((r) => r.current?.contains(node))) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
    // excludeCloseRef 是 useRef 产物，事件里读 .current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, anchor, leaving]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || leaving) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - MARGIN) left = Math.max(MARGIN, vw - rect.width - MARGIN);
    if (top + rect.height > vh - MARGIN) top = Math.max(MARGIN, vh - rect.height - MARGIN);
    if (left < MARGIN) left = MARGIN;
    if (top < MARGIN) top = MARGIN;
    const origin = overlayViewportOrigin(host);
    setPos({ left: left - origin.left, top: top - origin.top });
  }, [x, y, items, host, leaving]);

  // 子菜单位置：父项右侧（右缘不够则左侧），顶部对齐父项。
  // 渲染期按回退宽 180 估位；flyout 挂载后由下方 layout effect 依实测
  // offsetWidth 重定位（宽子菜单贴近视口右缘时估宽会让「右缘不够」判断失真溢出）。
  const computeFlyoutLeft = (flyoutW: number): number => {
    const parentItem = ref.current?.children[flyoutIdx ?? -1];
    if (!parentItem) return pos.left + 200;
    const hostRect = parentItem.getBoundingClientRect();
    const parentRight = hostRect.right;
    const vw = window.innerWidth;
    const left = parentRight + flyoutW > vw - MARGIN ? Math.max(MARGIN, hostRect.left - flyoutW) : parentRight;
    return left - overlayViewportOrigin(host).left;
  };

  // flyout 打开/主菜单移位后：挂载实测宽二次定位（F-01）
  useLayoutEffect(() => {
    if (leaving) return;
    if (flyoutIdx == null) {
      setFlyoutLeft(null);
      return;
    }
    const w = flyoutRef.current?.offsetWidth;
    if (!w) return; // jsdom 等无布局环境保持估位
    setFlyoutLeft(computeFlyoutLeft(w));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyoutIdx, pos.left, pos.top, items, host, leaving]);

  // 有任一可勾选项时所有项都留勾选槽，否则只有该项文字右移、左缘对不齐
  const hasChecks = items.some((it) => !it.separator && it.checked !== undefined);

  if (!presence.mounted) return null;
  const inactive = leaving ? { inert: '', 'aria-hidden': true } : {};
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu mp-pop"
      data-mp-stage={presence.stage}
      data-menu-hold={hold}
      data-overlay-root=""
      data-h-strip-overlay=""
      {...inactive}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-activedescendant={items[activeIdx] ? `ctx-item-${items[activeIdx].id}` : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={onHoverEnter}
      onPointerLeave={onHoverLeave}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={it.id} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={it.id}
            id={`ctx-item-${it.id}`}
            type="button"
            className={`ctx-item${it.danger ? ' is-danger' : ''}${it.children?.length ? ' has-flyout' : ''}${i === activeIdx ? ' is-active' : ''}${flyoutIdx === i ? ' is-flyout-open' : ''}`}
            role="menuitemcheckbox"
            aria-checked={it.checked}
            aria-disabled={it.disabled || undefined}
            aria-haspopup={it.children?.length ? 'menu' : undefined}
            aria-expanded={it.children?.length ? flyoutIdx === i : undefined}
            title={it.title}
            tabIndex={-1}
            onMouseEnter={() => {
              if (!it.disabled) setActiveIdx(i);
              // 悬停切换父项时收起旧子菜单；悬停无子项的项也收起
              setFlyoutIdx(it.children?.length && !it.disabled ? i : null);
            }}
            onClick={() => {
              if (it.disabled) return;
              if (it.children?.length) {
                openFlyoutWithFocus(i);
                return;
              }
              onSelect(it.id);
              onClose();
            }}
          >
            {hasChecks ? (
              <span className="ctx-check" aria-hidden>
                {it.checked ? '✓' : ''}
              </span>
            ) : null}
            {it.label}
            {it.children?.length ? <span className="ctx-flyout-arrow" aria-hidden>›</span> : null}
          </button>
        )
      )}
      {flyoutIdx != null && items[flyoutIdx]?.children?.length ? createPortal(
        <div
          ref={flyoutRef}
          className="ctx-menu ctx-flyout mp-pop"
          data-mp-stage={leaving ? 'out' : 'in'}
          data-overlay-root=""
          data-h-strip-overlay=""
          {...inactive}
          style={{ left: flyoutLeft ?? computeFlyoutLeft(180), top: pos.top }}
          role="menu"
          aria-label={items[flyoutIdx].label}
          onPointerDown={(e) => e.stopPropagation()}
          // 子菜单键盘导航（F-02）：↑↓ 在可选项间循环移动焦点，
          // Enter/Space 由聚焦按钮原生触发；← / Esc 返回父级。
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const btns = Array.from(
              flyoutRef.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEM) ?? []
            );
            if (!btns.length) return;
            e.preventDefault();
            e.stopPropagation();
            const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            const next = btns[(cur + delta + btns.length) % btns.length];
            next.focus();
          }}
        >
          {items[flyoutIdx].children!.map((child) =>
            child.separator ? (
              <div key={child.id} className="ctx-sep" role="separator" />
            ) : (
              <button
                key={child.id}
                type="button"
                className={`ctx-item${child.danger ? ' is-danger' : ''}`}
                role="menuitem"
                aria-disabled={child.disabled || undefined}
                title={child.title}
                tabIndex={-1}
                onClick={() => {
                  if (child.disabled) return;
                  onSelect(child.id);
                  onClose();
                }}
              >
                {child.label}
              </button>
            )
          )}
        </div>,
        host
      ) : null}
    </div>,
    host
  );
}
