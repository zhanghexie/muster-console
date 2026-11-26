import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconChevronLeft, IconChevronRight, IconCursor, IconLayout, IconMinus, IconMouse, IconPlus } from './icons';
import { MOTION, usePresence, usePresenceValue } from './motion';

export type HSwitchMode = 'hover' | 'click';
type MenuDrop = HSwitchMode | 'focus';

const H_SWITCH_MODE_KEY = 'muster.hSwitchMode';
const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 6;
const AXIS_LOCK_PX = 8;
const MENU_WIDTH = 196;
const MENU_ROW = 32;
const MENU_INSET = 5;
const MENU_HEIGHT = 4 * MENU_ROW + 2 * MENU_INSET;
const VIEWPORT_INSET = 8;

export function loadHSwitchMode(): HSwitchMode {
  try {
    const value = localStorage.getItem(H_SWITCH_MODE_KEY);
    if (value === 'click' || value === 'hover') return value;
  } catch {
    /* ignore */
  }
  return 'hover';
}

export function saveHSwitchMode(mode: HSwitchMode): void {
  try {
    localStorage.setItem(H_SWITCH_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

type Props = {
  hVs: boolean;
  focusMode?: boolean;
  /** 把手相对全高热区的位置。 */
  along: number;
  switchMode: HSwitchMode;
  visible: boolean;
  onAlong: (t: number) => void;
  onHotChange: (hot: boolean) => void;
  onSwitchMode: (mode: HSwitchMode) => void;
  onToggleFocus: () => void;
  onBtnPointerActive: (active: boolean) => void;
  /** 当前分割边界的视口 X。 */
  barX?: number;
  /** 向右拖时，激活侧是变宽还是变窄。 */
  growSign: 1 | -1;
  onDragAxis?: (axis: 'size' | 'mode' | 'none') => void;
  onResizeStart: () => void;
  onResizeMove: (pointerX: number) => void;
  onResizeEnd: (canceled: boolean) => void;
};

type MenuLayout = {
  left: number;
  top: number;
  rows: (MenuDrop | 'grip')[];
};

type Press = {
  pointerId: number;
  x: number;
  y: number;
  originX: number;
  originY: number;
  layout: MenuLayout;
  picking: boolean;
};

type Drag = { x: number; target: MenuDrop | null };

function layoutMenu(x: number, y: number, frame: DOMRect): MenuLayout {
  const roomAbove = y - Math.max(frame.top, 0);
  const roomBelow = Math.min(frame.bottom, window.innerHeight) - y;
  const gripOffset = (row: number): number => MENU_INSET + (row + 0.5) * MENU_ROW;
  const fitsAroundGrip = roomAbove >= gripOffset(2) && roomBelow >= MENU_HEIGHT - gripOffset(2);
  const rows: MenuLayout['rows'] = ['click', 'hover', 'focus'];
  const gripRow = fitsAroundGrip ? 2 : roomAbove > roomBelow ? 3 : 0;
  rows.splice(gripRow, 0, 'grip');
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const left = Math.max(VIEWPORT_INSET, Math.min(x - MENU_WIDTH / 2, viewportWidth - MENU_WIDTH - VIEWPORT_INSET));
  return { left: left - x, top: -gripOffset(gripRow), rows };
}

function hitMode(press: Press, x: number, y: number): MenuDrop | null {
  const localX = x - press.originX - press.layout.left;
  if (localX < MENU_INSET || localX >= MENU_WIDTH - MENU_INSET) return null;
  const row = Math.floor((y - press.originY - press.layout.top - MENU_INSET) / MENU_ROW);
  const target = press.layout.rows[row];
  return target && target !== 'grip' ? target : null;
}

/** 分割条长按后纵向选切屏方式，横向拖动调宽。 */
export function SplitExpandControl({
  hVs,
  focusMode = false,
  along,
  switchMode,
  visible,
  onAlong,
  onHotChange,
  onSwitchMode,
  onToggleFocus,
  onBtnPointerActive,
  barX,
  growSign,
  onDragAxis,
  onResizeStart,
  onResizeMove,
  onResizeEnd
}: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const modeItems = {
    click: { label: t('鼠标点击切屏'), Icon: IconMouse },
    hover: { label: t('鼠标悬浮切屏'), Icon: IconCursor },
    focus: { label: t('关闭虚拟屏'), Icon: IconLayout }
  } as const;
  const currentMode = focusMode ? 'focus' : switchMode;
  const menuId = useId();
  const hitRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<Press | null>(null);
  const dragAxisRef = useRef<'size' | 'mode' | null>(null);
  const longTimer = useRef<number | null>(null);
  const moveFrame = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  const [hintHover, setHintHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [keyboardMenu, setKeyboardMenu] = useState<MenuLayout | null>(null);
  const dragAxis = drag ? dragAxisRef.current : null;

  const showHandle = visible || pressed || focused || keyboardMenu !== null;
  const handlePresence = usePresence(showHandle, MOTION.microMs);
  const hintPresence = usePresence(visible && hintHover && !pressed && !keyboardMenu, MOTION.microMs);
  const resizePresence = usePresence(drag !== null || keyboardMenu !== null, MOTION.microMs);
  const pointerMenu = drag && dragAxis !== 'size' ? pressRef.current?.layout : null;
  const menuLayout = keyboardMenu ?? pointerMenu;
  const { presence: menuPresence, value: menu } = usePresenceValue(
    menuLayout ? { layout: menuLayout, target: drag?.target, currentMode } : null,
    MOTION.microMs
  );

  const clearLongTimer = useCallback(() => {
    if (longTimer.current !== null) window.clearTimeout(longTimer.current);
    longTimer.current = null;
  }, []);

  const cancelMoveFrame = useCallback(() => {
    if (moveFrame.current !== null) window.cancelAnimationFrame(moveFrame.current);
    moveFrame.current = null;
    pendingMove.current = null;
  }, []);

  useEffect(() => () => {
    clearLongTimer();
    cancelMoveFrame();
  }, [clearLongTimer, cancelMoveFrame]);

  useEffect(() => {
    if (!visible) setHintHover(false);
  }, [visible]);

  const applyMode = useCallback((mode: MenuDrop) => {
    if (mode !== 'focus') onSwitchMode(mode);
    else if (!focusMode) onToggleFocus();
  }, [focusMode, onSwitchMode, onToggleFocus]);

  const endPress = useCallback((mode: MenuDrop | null, canceled = false) => {
    const press = pressRef.current;
    if (!press) return;
    const wasResizing = dragAxisRef.current === 'size';
    pressRef.current = null;
    dragAxisRef.current = null;
    clearLongTimer();
    cancelMoveFrame();
    setPressed(false);
    setDrag(null);
    onBtnPointerActive(false);
    // 清除手势后再释放捕获，正常松手派发的 lostpointercapture 不会重复收尾。
    const button = buttonRef.current;
    if (button?.hasPointerCapture?.(press.pointerId)) button.releasePointerCapture(press.pointerId);
    if (wasResizing) onResizeEnd(canceled);
    else if (press.picking) onDragAxis?.('none');
    if (mode) applyMode(mode);
  }, [applyMode, cancelMoveFrame, clearLongTimer, onBtnPointerActive, onDragAxis, onResizeEnd]);

  const closeKeyboardMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
    setKeyboardMenu(null);
    onBtnPointerActive(false);
  }, [onBtnPointerActive]);

  useEffect(() => {
    if (!pressed && !keyboardMenu) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (pressRef.current) endPress(null, true);
      else closeKeyboardMenu(true);
    };
    const onBlur = (): void => {
      if (pressRef.current) endPress(null, true);
      if (keyboardMenu) closeKeyboardMenu(false);
    };
    const onOutside = (event: PointerEvent): void => {
      if (keyboardMenu && !hitRef.current?.contains(event.target as Node)) closeKeyboardMenu(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onOutside, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', onOutside, true);
    };
  }, [closeKeyboardMenu, endPress, keyboardMenu, pressed]);

  useLayoutEffect(() => {
    if (keyboardMenu && menuPresence.mounted) {
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    }
  }, [keyboardMenu, menuPresence.mounted]);

  const updateAnchor = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (pressRef.current || keyboardMenu) return;
    const { top, height } = event.currentTarget.getBoundingClientRect();
    if (height) onAlong(Math.min(1, Math.max(0, (event.clientY - top) / height)));
    if (!visible) onHotChange(true);
  };

  const applyMove = (x: number, y: number): void => {
    const press = pressRef.current;
    if (!press?.picking) return;
    const dx = Math.abs(x - press.x);
    const dy = Math.abs(y - press.y);
    const relativeY = y - press.originY;
    const inResizeRow = relativeY >= -MENU_ROW / 2 && relativeY < MENU_ROW / 2;
    // 选项预览允许回到胶囊所在行重新调宽。调宽开始后则只随横向位移。
    if (dragAxisRef.current !== 'size' && inResizeRow && dx > AXIS_LOCK_PX) {
      dragAxisRef.current = 'size';
      onResizeStart();
      onDragAxis?.('size');
    } else if (!dragAxisRef.current && Math.max(dx, dy) > AXIS_LOCK_PX) {
      dragAxisRef.current = 'mode';
      onDragAxis?.('mode');
    }
    if (dragAxisRef.current === 'size') onResizeMove(press.originX + x - press.x);
    const target = dragAxisRef.current === 'mode' ? hitMode(press, x, y) : null;
    setDrag(previous => previous?.x === x && previous.target === target ? previous : { x, target });
  };

  const onBtnDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || pressRef.current || !hitRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    pressRef.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX, originY, picking: false,
      layout: layoutMenu(originX, originY, hitRef.current.getBoundingClientRect())
    };
    setKeyboardMenu(null);
    setPressed(true);
    onBtnPointerActive(true);
    onHotChange(true);
    button.setPointerCapture(event.pointerId);
    longTimer.current = window.setTimeout(() => {
      longTimer.current = null;
      const press = pressRef.current;
      if (!press) return;
      press.picking = true;
      setDrag({ x: press.originX, target: currentMode });
    }, LONG_PRESS_MS);
  };

  const onBtnMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!press.picking) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_CANCEL_PX) clearLongTimer();
      return;
    }
    pendingMove.current = { x: event.clientX, y: event.clientY };
    if (moveFrame.current !== null) return;
    moveFrame.current = window.requestAnimationFrame(() => {
      moveFrame.current = null;
      const move = pendingMove.current;
      pendingMove.current = null;
      if (move) applyMove(move.x, move.y);
    });
  };

  const onBtnUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const press = pressRef.current;
    if (press?.pointerId !== event.pointerId) return;
    const move = pendingMove.current;
    if (move) applyMove(move.x, move.y);
    const mode = press.picking && dragAxisRef.current === 'mode' ? hitMode(press, event.clientX, event.clientY) : null;
    endPress(mode);
  };

  const openKeyboardMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.detail !== 0 || pressRef.current || !hitRef.current) return;
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    setKeyboardMenu(layoutMenu(left + width / 2, top + height / 2, hitRef.current.getBoundingClientRect()));
    onBtnPointerActive(true);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowUp' ? (current - 1 + rows.length) % rows.length
      : event.key === 'ArrowDown' ? (current + 1) % rows.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    rows[next]?.focus();
  };

  if (!hVs && !focusMode) return null;

  const menuInteractive = keyboardMenu !== null && menuPresence.stage !== 'out';
  const sizeDelta = dragAxis === 'size' && drag && pressRef.current ? drag.x - pressRef.current.x : 0;
  const resizeDirection = sizeDelta < -AXIS_LOCK_PX ? 'left' : sizeDelta > AXIS_LOCK_PX ? 'right' : undefined;
  const LeftSizeIcon = growSign < 0 ? IconPlus : IconMinus;
  const RightSizeIcon = growSign > 0 ? IconPlus : IconMinus;
  const label = t('虚拟屏操作');

  return (
    <div
      ref={hitRef}
      className="pane-split-hit"
      onPointerEnter={updateAnchor}
      onPointerMove={updateAnchor}
      onPointerLeave={() => {
        if (!pressRef.current && !keyboardMenu) onHotChange(false);
      }}
      onBlur={(event) => {
        if (keyboardMenu && !event.currentTarget.contains(event.relatedTarget)) closeKeyboardMenu(false);
      }}
    >
      <div className="split-expand-anchor" style={{ '--split-along': `${along * 100}%` } as React.CSSProperties}>
        <button
          ref={buttonRef}
          type="button"
          className="split-expand-btn"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={!!menuLayout}
          aria-controls={menuInteractive ? menuId : undefined}
          data-pointer-active={showHandle ? '' : undefined}
          data-pressed={pressed ? '' : undefined}
          data-direction={resizeDirection}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPointerEnter={() => {
            setHintHover(true);
            onBtnPointerActive(true);
            onHotChange(true);
          }}
          onPointerLeave={() => {
            setHintHover(false);
            if (!pressRef.current && !keyboardMenu) onBtnPointerActive(false);
          }}
          onPointerDown={onBtnDown}
          onPointerMove={onBtnMove}
          onPointerUp={onBtnUp}
          onPointerCancel={(event) => {
            if (pressRef.current?.pointerId === event.pointerId) endPress(null, true);
          }}
          onLostPointerCapture={(event) => {
            if (pressRef.current?.pointerId === event.pointerId) endPress(null, true);
          }}
          onClick={openKeyboardMenu}
        >
          {handlePresence.mounted && (
            <span className="split-expand-grip mp-pop" {...handlePresence.spread}>
              <span className="split-expand-glyph">
                <IconChevronLeft size={12} />
                <IconChevronRight size={12} />
              </span>
            </span>
          )}
        </button>
        {hintPresence.mounted && (
          <div className="split-hint-position" data-side={barX !== undefined && barX < 250 ? 'right' : undefined} aria-hidden>
            <div className="split-hint-drop mp-pop" {...hintPresence.spread}>{t('长按选择切屏方式，左右拖动调宽')}</div>
          </div>
        )}
        {menuPresence.mounted && menu && (
          <div className="split-menu-position" style={{
            left: menu.layout.left,
            top: menu.layout.top,
            width: MENU_WIDTH,
            '--split-menu-row': `${MENU_ROW}px`,
            '--split-menu-inset': `${MENU_INSET}px`,
            '--split-menu-x': `${-menu.layout.left}px`,
            '--split-menu-y': `${-menu.layout.top}px`
          } as React.CSSProperties}>
            <div
              ref={menuRef}
              id={menuId}
              className="split-mode-menu ui-menu mp-pop"
              role="menu"
              aria-label={label}
              aria-hidden={!menuInteractive}
              {...(!menuInteractive ? { inert: '' } : {})}
              data-interactive={menuInteractive ? '' : undefined}
              {...menuPresence.spread}
              onKeyDown={onMenuKeyDown}
            >
              {menu.layout.rows.map((mode) => {
                if (mode === 'grip') return <div key={mode} aria-hidden />;
                const { Icon, label: itemLabel } = modeItems[mode];
                const checked = menu.currentMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    className={`split-mode-drop${checked ? ' is-current' : ''}${menu.target === mode ? ' is-armed' : ''}`}
                    data-mode={mode}
                    onClick={() => {
                      if (!menuInteractive) return;
                      closeKeyboardMenu(true);
                      applyMode(mode);
                    }}
                  >
                    <Icon size={14} />
                    <span>{itemLabel}</span>
                    {checked && <IconCheck size={13} />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {resizePresence.mounted && (
          <div className="split-resize-position" aria-hidden>
            <div className="split-menu-resize mp-pop" data-direction={resizeDirection} {...resizePresence.spread}>
              <LeftSizeIcon size={13} />
              <RightSizeIcon size={13} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
