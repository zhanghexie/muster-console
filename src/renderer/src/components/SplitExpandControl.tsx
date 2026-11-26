import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type HSwitchMode = 'hover' | 'click';

const H_SWITCH_MODE_KEY = 'muster.hSwitchMode';
const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 6;
/** ＋/－ 落点中心相对按钮原点的横向偏移（px） */
const SIZE_DROP_OFFSET_PX = 44;
/** 悬停/点击落点：同类（切页模式），纵向堆叠在把手上侧——悬停在原点上方 48px、
 *  点击在其正上 96px。横向并排会占住左右调大小的拖动轴（一斜拖就被判成 size 轴、
 *  落点藏掉），2026-09-09 改纵向：纵向=选模式（上两位）、正下=专注、左右=调大小 */
const MODE_ROW_OFFSET_PX = 48;
const MODE_ROW2_OFFSET_PX = 96;
/** 「关闭虚拟屏」落点偏移：与悬浮/点击平行，恒在把手正下方（行为=原专注模式，仅改名） */
const FOCUS_DROP_OFFSET_PX = 48;
/** 落点命中半径（px）：最近落点间距 48（悬停↔点击纵向相邻），24 恰不重叠 */
const HIT_RADIUS_PX = 24;

/** 长按菜单落点：切屏方式两轴 + 关闭虚拟屏（内部名 focus——行为即原专注模式，仅改名） */
export type MenuDrop = HSwitchMode | 'focus';
/** |dx| 超过该值点亮左右调节指示 */
const SIZE_ARM_PX = 8;

export function loadHSwitchMode(): HSwitchMode {
  try {
    const v = localStorage.getItem(H_SWITCH_MODE_KEY);
    if (v === 'click' || v === 'hover') return v;
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
  /**
   * 专注模式（混合手势）：短按=退出；按住不动 400ms=弹菜单（悬停/点击/专注三落点
   * 平行，当前模式高亮，拖到任一落点即切）；按住后左右拖=边界跟手调会话/右侧比例
   * （无切页模式轴）
   */
  focusMode?: boolean;
  /** 0～1，相对中间热区 */
  along: number;
  switchMode: HSwitchMode;
  visible: boolean;
  onAlong: (t: number) => void;
  onHotChange: (hot: boolean) => void;
  onSwitchMode: (mode: HSwitchMode) => void;
  /** 「关闭虚拟屏」落点（原「专注」，仅改名）：切换双栏全屏态（focusMode），
   *  已在该态时重复提交为空操作 */
  onToggleFocus: () => void;
  /** 按钮指针进出：避免热区 leave 卸掉按钮 */
  onBtnPointerActive: (active: boolean) => void;
  /** 当前分割边界中心的视口 X（跟手渲染用；hVs/专注皆关时 undefined） */
  barX?: number;
  /** 拖动向右时主区在变大 → 1，反之 -1（决定 ＋/－ 图标摆放） */
  growSign: 1 | -1;
  /** 拖动轴变化上报：父层据此切换「被调侧模糊 + 等比例指示卡」 */
  onDragAxis?: (axis: 'size' | 'mode' | 'none') => void;
  /** 长按拖拽水平轴：指针 X 即边界 X，实时调当前主态页宽（仅 hVs/专注开启时触发） */
  onResizeStart: () => void;
  onResizeMove: (pointerX: number) => void;
  /** canceled=true（Escape / 指针取消）回滚拖拽前的大小 */
  onResizeEnd: (canceled: boolean) => void;
};

type DragState = {
  originX: number;
  originY: number;
  dx: number;
  dy: number;
  hoverTarget: MenuDrop | null;
};

function hitMode(
  clientX: number,
  clientY: number,
  originX: number,
  originY: number
): MenuDrop | null {
  // 悬浮/点击切屏纵向堆叠在把手上侧、关闭虚拟屏在正下：纵向=选切屏方式、
  // 左右=调大小，轴互不打架
  const hits: { mode: MenuDrop; x: number; y: number }[] = [
    { mode: 'hover', x: originX, y: originY - MODE_ROW_OFFSET_PX },
    { mode: 'click', x: originX, y: originY - MODE_ROW2_OFFSET_PX },
    { mode: 'focus', x: originX, y: originY + FOCUS_DROP_OFFSET_PX }
  ];
  for (const h of hits) {
    const dx = clientX - h.x;
    const dy = clientY - h.y;
    if (dx * dx + dy * dy <= HIT_RADIUS_PX * HIT_RADIUS_PX) return h.mode;
  }
  return null;
}

/**
 * 分割条把手：无短按动作（开/关虚拟屏与顶栏右栏开关重复，2026-10-10 用户定稿
 * 去除；「关闭虚拟屏」态的恢复走菜单落点或右栏开关）；长按弹出三平行落点
 * （鼠标悬浮切屏/鼠标点击切屏/关闭虚拟屏），拖到任一落点即切。「关闭虚拟屏」
 * =双栏全屏并肩（原专注模式，2026-10-10 仅改名，行为不变）。当前态高亮：
 * 双栏全屏态高亮「关闭虚拟屏」、此时两切屏方式落点不高亮（用户定稿）；否则
 * 高亮现行切屏方式。该态下拖到悬浮/点击由宿主一步退出并应用切屏方式。
 * 长按后左右拖 = 边界跟手，实时调当前主态页宽（双栏全屏态调左/右比例）。
 * 两轴交互互斥显示：水平拖显示 ＋/－（指示变大变小）与实时比例读数、隐藏切屏胶囊；
 * 纵向拖则反之；未拖动时都显示。悬浮/点击同类（切屏方式），纵向堆叠在把手上侧
 * （悬浮近、点击远）；「关闭虚拟屏」另一类，恒在正下方。
 */
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
  /** 水平拖调边界是否可用：虚拟屏开启或专注模式 */
  const dragEnabled = hVs || focusMode;
  const [picking, setPicking] = useState(false);
  // 悬停提示（自绘，替代原生 title——捕获中 title 无法消散）：悬停显示、按下/菜单即隐
  const [hintHover, setHintHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** 拖动轴锁：首次越过阈值即锁定（size/mode），整个手势期间不再换轴 */
  const dragAxisRef = useRef<'size' | 'mode' | null>(null);
  const longTimerRef = useRef<number | null>(null);
  const pressRef = useRef<{
    x: number;
    y: number;
    originX: number;
    originY: number;
    moved: boolean;
    picking: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const moveFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const clearLongTimer = useCallback(() => {
    if (longTimerRef.current != null) {
      window.clearTimeout(longTimerRef.current);
      longTimerRef.current = null;
    }
  }, []);

  const cancelMoveFrame = useCallback(() => {
    if (moveFrameRef.current != null) {
      window.cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
    pendingMoveRef.current = null;
  }, []);

  const endPick = useCallback(
    (commit: MenuDrop | null, canceled = false) => {
      clearLongTimer();
      cancelMoveFrame();
      pressRef.current = null;
      setPicking(false);
      setPressed(false);
      setDrag(null);
      dragAxisRef.current = null;
      onBtnPointerActive(false);
      // 拖拽中边界/条带跟指针走，松手时指针通常仍压在条上：保持热态（线体加亮
      // + 按钮召出），等指针真正离开条带再熄
      onHotChange(true);
      if (dragEnabled) onResizeEnd(canceled);
      // 三落点（悬浮/点击切屏/关闭虚拟屏）：拖到非当前落点即切，「关闭虚拟屏」
      // 已在该态时由宿主空操作；该态下拖到悬浮/点击由宿主一步退出并应用
      if (commit === 'focus') {
        if (!focusMode) onToggleFocus();
      } else if (commit) onSwitchMode(commit);
    },
    [
      clearLongTimer,
      cancelMoveFrame,
      onBtnPointerActive,
      onHotChange,
      onSwitchMode,
      onToggleFocus,
      dragEnabled,
      focusMode,
      onResizeEnd
    ]
  );

  useEffect(
    () => () => {
      clearLongTimer();
      cancelMoveFrame();
    },
    [clearLongTimer, cancelMoveFrame]
  );

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        suppressClickRef.current = true;
        endPick(null, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, endPick]);

  // 截图/录屏等工具会抢走指针捕获或窗口焦点：不收尾的话拖拽永远停在 picking、
  // 快照遮罩退不出去（2026-10-10 用户反馈）。捕获丢失与窗口失焦都按取消收尾并
  // 回滚。正常松手释放捕获也会触发 lostpointercapture——pressRef 已清即为正常路径。
  const onLostCapture = useCallback((): void => {
    if (pressRef.current) endPick(null, true);
  }, [endPick]);

  useEffect(() => {
    if (!picking) return;
    const onBlur = (): void => endPick(null, true);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [picking, endPick]);

  const onHitEnter = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (picking) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    onAlong(Math.min(1, Math.max(0, ratio)));
    onHotChange(true);
  };

  const onHitMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (picking) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    onAlong(Math.min(1, Math.max(0, ratio)));
  };

  const applyPickMove = useCallback((clientX: number, clientY: number): void => {
    const p = pressRef.current;
    if (!p?.picking) return;
    const dx = clientX - p.originX;
    const dy = clientY - p.originY;
    if (!dragAxisRef.current && (Math.abs(dx) > SIZE_ARM_PX || Math.abs(dy) > SIZE_ARM_PX)) {
      dragAxisRef.current = Math.abs(dx) >= Math.abs(dy) ? 'size' : 'mode';
    }
    if (dragEnabled) {
      onResizeMove(dragAxisRef.current === 'mode' ? p.originX : clientX);
    }
    setDrag({
      originX: p.originX,
      originY: p.originY,
      dx,
      dy,
      hoverTarget: hitMode(clientX, clientY, p.originX, p.originY)
    });
  }, [dragEnabled, onResizeMove]);

  const flushPendingMove = useCallback((): void => {
    const move = pendingMoveRef.current;
    cancelMoveFrame();
    if (move) applyPickMove(move.clientX, move.clientY);
  }, [applyPickMove, cancelMoveFrame]);

  const onBtnDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const br = btn.getBoundingClientRect();
    const originX = br.left + br.width / 2;
    const originY = br.top + br.height / 2;
    pressRef.current = {
      x: e.clientX,
      y: e.clientY,
      originX,
      originY,
      moved: false,
      picking: false
    };
    dragAxisRef.current = null;
    suppressClickRef.current = false;
    setPressed(true);
    onBtnPointerActive(true);
    onHotChange(true);
    clearLongTimer();
    btn.setPointerCapture(e.pointerId);
    longTimerRef.current = window.setTimeout(() => {
      longTimerRef.current = null;
      const p = pressRef.current;
      if (!p || p.moved) return;
      p.picking = true;
      setPicking(true);
      if (dragEnabled) onResizeStart();
      setDrag({
        originX: p.originX,
        originY: p.originY,
        dx: 0,
        dy: 0,
        // 菜单初开即预亮当前态落点（双栏全屏态预亮「关闭虚拟屏」）
        hoverTarget: focusMode ? 'focus' : switchMode
      });
    }, LONG_PRESS_MS);
  };

  const onBtnMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const p = pressRef.current;
    if (!p) return;
    const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (!p.picking && dist > MOVE_CANCEL_PX) {
      p.moved = true;
      clearLongTimer();
    }
    if (!p.picking) return;
    pendingMoveRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (moveFrameRef.current == null) {
      moveFrameRef.current = window.requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const move = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (move) applyPickMove(move.clientX, move.clientY);
      });
    }
  };

  const onBtnUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    clearLongTimer();
    flushPendingMove();
    setPressed(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // 捕获释放可能同步触发 lostpointercapture（已按取消收尾）：以现值为准，
    // 不用进函数时的旧引用，避免二次 endPick
    const p = pressRef.current;
    if (!p) {
      onBtnPointerActive(false);
      return;
    }
    if (p.picking) {
      // 调大小轴锁定的松手不提交落点（落点早已隐藏，指针也可能恰好停在
      // 某落点的旧位置上）
      const mode =
        dragAxisRef.current === 'size'
          ? null
          : hitMode(e.clientX, e.clientY, p.originX, p.originY);
      suppressClickRef.current = true;
      endPick(mode);
      return;
    }
    // 短按已去功能（2026-10-10 用户定稿）：开/关虚拟屏与顶栏右栏开关重复，
    // 把手只承担长按菜单与左右拖调宽；suppressClick 仍防拖后误触
    pressRef.current = null;
    onBtnPointerActive(false);
  };

  const onBtnCancel = (e: React.PointerEvent<HTMLButtonElement>): void => {
    clearLongTimer();
    cancelMoveFrame();
    setPressed(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!pressRef.current) {
      onBtnPointerActive(false);
      return;
    }
    if (picking) {
      suppressClickRef.current = true;
      endPick(null, true);
      return;
    }
    pressRef.current = null;
    onBtnPointerActive(false);
  };

  const show = visible || picking;
  // 按钮脱离悬停/热态即复位提示，防止按钮重挂载后旧 hover 态残显示
  useEffect(() => {
    if (!show) setHintHover(false);
  }, [show]);
  const sizeArmed =
    picking && dragEnabled && drag
      ? drag.dx < -SIZE_ARM_PX
        ? -1
        : drag.dx > SIZE_ARM_PX
          ? 1
          : 0
      : 0;
  // 拖动轴互斥（锁定制）：首次越阈定轴后整手势不变——调大小轴藏切屏落点、
  // 只显示 ＋/－；切屏方式轴反之；未越阈两者都显示
  const dragAxis: 'size' | 'mode' | 'none' =
    picking && drag ? dragAxisRef.current ?? 'none' : 'none';

  useEffect(() => {
    if (picking) onDragAxis?.(dragAxis);
  }, [picking, dragAxis, onDragAxis]);

  // 拖大小跟手：边界本身已随指针移动，按钮只需补上「指针位置 − 当前边界」的偏差；
  // 未跟手场景（选模式 / 虚拟屏与专注皆关）维持按钮直接跟随指针
  const btnDx =
    picking && drag && dragEnabled && barX != null ? drag.originX + drag.dx - barX : drag?.dx ?? 0;
  // 把手不挂原生 title（onBtnDown 的 preventDefault 抑制兼容鼠标事件，捕获中
  // tooltip 控制器收不到通知、属性摘掉也不重算，提示会常驻到松手）；改为自绘
  // 悬停提示：悬停显示、按下/长按菜单即隐。
  const modeLabel = switchMode === 'hover' ? t('鼠标悬浮切屏') : t('鼠标点击切屏');
  const hint = focusMode
    ? t('虚拟屏已关闭（双栏全屏）· 长按拖到落点选切屏方式恢复，左右拖调整比例')
    : hVs
      ? t('长按选切屏方式（当前：{{mode}}），左右拖调大小', { mode: modeLabel })
      : t('长按选切屏方式');

  // 根节点 = 全高检测带兼触发区：整条压线即召出按钮，按钮锚点随指针纵向位置
  // （along）落点。旧版只有竖直居中一小段触发区 + 幽灵胶囊指示器——两屏贴死
  // 年代怕热区难触发才单独留块；页缝已有框色间隔后整条即热区，胶囊指示删除。
  // 离开条带时连带清掉按钮热态，避免指针从按钮滑出后按钮残留。
  if (!hVs && !focusMode) return null;

  return (
    <div
      className="pane-split-hit"
      onPointerEnter={onHitEnter}
      onPointerMove={onHitMove}
      onPointerLeave={() => {
        if (picking || pressRef.current) return;
        onHotChange(false);
      }}
    >
      {show && (
        <div className="split-expand-anchor" style={{ top: `${along * 100}%` }}>
          {hintHover && !picking && !pressed && (
            <div className="split-hint-drop">{hint}</div>
          )}
          {picking && (
            <>
              {/* ＋/－ 尺寸指示：普通模式水平主导时显示；专注下只在真拖水平轴时显示
                  （按住不动弹的是模式菜单） */}
              {dragEnabled && dragAxis !== 'mode' && (
                <>
                  <div
                    className={`split-size-drop${sizeArmed < 0 ? ' is-armed' : ''}`}
                    style={{ transform: `translate(calc(-50% - ${SIZE_DROP_OFFSET_PX}px), -50%)` }}
                  >
                    {growSign < 0 ? '＋' : '－'}
                  </div>
                  <div
                    className={`split-size-drop${sizeArmed > 0 ? ' is-armed' : ''}`}
                    style={{ transform: `translate(calc(-50% + ${SIZE_DROP_OFFSET_PX}px), -50%)` }}
                  >
                    {growSign > 0 ? '＋' : '－'}
                  </div>
                </>
              )}
              {dragAxis !== 'size' && (
                <>
                  {/* is-current = 当前态指示：双栏全屏态高亮「关闭虚拟屏」、
                      两切屏方式落点不高亮（用户定稿）；否则高亮现行切屏方式 */}
                  <div
                    className={`split-mode-drop${
                      !focusMode && switchMode === 'hover' ? ' is-current' : ''
                    }${drag?.hoverTarget === 'hover' ? ' is-armed' : ''}`}
                    style={{
                      transform: `translate(-50%, calc(-50% - ${MODE_ROW_OFFSET_PX}px))`
                    }}
                  >
                    {t('鼠标悬浮切屏')}
                  </div>
                  <div
                    className={`split-mode-drop${
                      !focusMode && switchMode === 'click' ? ' is-current' : ''
                    }${drag?.hoverTarget === 'click' ? ' is-armed' : ''}`}
                    style={{
                      transform: `translate(-50%, calc(-50% - ${MODE_ROW2_OFFSET_PX}px))`
                    }}
                  >
                    {t('鼠标点击切屏')}
                  </div>
                </>
              )}
              {/* 「关闭虚拟屏」落点（原「专注」，仅改名）：与悬浮/点击同一轴互斥——
                  水平真拖（调大小）时三落点一并让位给 ＋/－；当前态高亮 */}
              {dragAxis !== 'size' && (
                <div
                  className={`split-mode-drop${focusMode ? ' is-current' : ''}${
                    drag?.hoverTarget === 'focus' ? ' is-armed' : ''
                  }`}
                  style={{
                    transform: `translate(-50%, calc(-50% + ${FOCUS_DROP_OFFSET_PX}px))`
                  }}
                >
                  {t('关闭虚拟屏')}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className={`split-expand-btn${dragEnabled ? ' is-on' : ''}${picking ? ' is-picking' : ''}`}
            style={
              picking && drag
                ? {
                    transform: `translate(calc(-50% + ${btnDx}px), calc(-50% + ${drag.dy}px))`
                  }
                : undefined
            }
            onPointerEnter={() => {
              setHintHover(true);
              onBtnPointerActive(true);
              onHotChange(true);
            }}
            onPointerLeave={() => {
              setHintHover(false);
              if (!picking && !pressRef.current) onBtnPointerActive(false);
            }}
            onPointerDown={onBtnDown}
            onPointerMove={onBtnMove}
            onPointerUp={onBtnUp}
            onPointerCancel={onBtnCancel}
            onLostPointerCapture={onLostCapture}
          >
            {dragEnabled ? '◂▸' : '↔'}
          </button>
        </div>
      )}
    </div>
  );
}
