import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BorderBeam } from 'border-beam';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../store';
import { isNeedsYouPeekSession } from '../../../shared/boardReview';
import { isGlobalBoardSession } from '../../../shared/boardStatus';
import type { SessionMeta } from '../../../shared/types';
import { BoardPanel } from './BoardPanel';
import { useBoardClock } from './boardClock';
import { MOTION, usePresence } from '../components/motion';
import { getResolvedAppearance, subscribeAppearance } from '../theme';
import { markNeedsUnread, retainNeedsRead, useNeedsRead } from './needsReadStore';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { isInsideOverlay } from '../keybindings/overlayStack';

/** 通知描边的视觉参数集中在这里；duration 仍从全局节拍换算为库要求的秒。 */
const PEEK_BEAM_PROPS = {
  size: 'line',
  colorVariant: 'colorful',
  strength: 1,
  brightness: 1.4,
  saturation: 1.8,
  glowSize: 1.5,
  // 固定库 line 原默认内部值，关闭 children 自动半径测量，避免业务卸载后读 bloom 并重写 @property。
  // 实际根/伪层/bloom 的圆角与裁剪仍由 board.css 继承 --radius-modal，非此数值决定。
  borderRadius: 16,
  duration: (MOTION.breathMs * 1.5) / 1000,
  // 在实例根保存当前动态宽度，光效层继承该计算值后放大，保留原有宽窄变化。
  css: `
    [data-beam="{id}"] {
      /* 使用彩色描边与柔光，避免库的白色光芯在增强亮度后盖过颜色。 */
      --board-beam-spectrum: linear-gradient(90deg, rgb(30, 185, 170), rgb(40, 140, 255) 35%, rgb(180, 40, 240) 65%, rgb(255, 50, 100));
      --beam-bloom-opacity: 0.6;
      --beam-inner-opacity: 2.4;
      --beam-stroke-opacity: 3;
      --board-beam-width-scale: 1.6;
      --board-beam-base-width: var(--beam-w-{id});
    }
    [data-beam="{id}"]::before,
    [data-beam="{id}"]::after,
    [data-beam="{id}"] [data-beam-bloom] {
      --beam-w-{id}: calc(var(--board-beam-base-width) * var(--board-beam-width-scale));
    }
    .g-board-peek-beam[data-beam="{id}"]::before { box-shadow: none; }
    .g-board-peek-beam[data-beam="{id}"]::after,
    .g-board-peek-beam[data-beam="{id}"] [data-beam-bloom] {
      background-image: var(--board-beam-spectrum);
    }
  `
} as const;

/** 与看板分桶同口径：可上板的会话（排除 shell / 归档 / 非 terminal） */
function isBoardSession(s: SessionMeta): boolean {
  return isGlobalBoardSession(s) && !s.archived;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenWorkerSettings?: () => void;
  /** 探出区域任意位置点击后请求展开（App 侧置 open） */
  onOpen: () => void;
}

/**
 * 全局看板浮层：从窗口最上方滑下的居中面板（非全屏，约 3/4 屏宽）。
 * 「需要你」探出：任一会话进入 needsYou 区（blocked/waiting/error/no_signal，
 * 与看板同一套读时推导）后，面板从顶缘探出并上下轻浮，同时以 Beam 描边提醒。
 * 探出区域任意位置点击、Enter/Space、顶栏图标钮、中键、快捷键均可展开；
 * 探出条和普通底栏共用数量摘要，不跳会话、不改变已读状态。
 * 展开后面板顶边贴在顶栏下沿，顶栏可点；
 * 持续语义：只要还有**未读**的 needsYou 项目就一直探出（展开/关闭看板都不打断提醒）；
 * 跳转到会话页（jumpToSession / sessions:reveal）即视为已读，全部已读探条收回、底栏未读数归零；
 * 会话重新进入需要你区是新边沿，清掉已读重新提醒；Esc 显式收起后等下一个新边沿
 * 再探出；启动存量不触发（`suppressed` 初值 true，与已读集合是否落盘无关）。
 * 展开态点外空白关闭：仍有未压制的 needsYou 项则收回探条，否则完全隐藏；
 * 探出态点外不响应（提醒不能被顺手点掉）。
 * 必须渲染在 App 根层级——.h-strip 的 transform 会劫持内部 fixed 坐标系。
 */
export function GlobalBoard({ open, onClose, onOpen, onOpenWorkerSettings }: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const { sessions } = useSessionStore();
  const now = useBoardClock();
  const appearance = useSyncExternalStore(subscribeAppearance, getResolvedAppearance);
  const sheetRef = useRef<HTMLDivElement>(null);
  /** 初始压制：启动存量不算「新出现」，首个边沿才探出；Esc 显式收起后重新压制 */
  const [suppressed, setSuppressed] = useState(true);
  /** 上一帧各会话是否 needsYou（null = 尚无快照，不判边沿） */
  const prevNeedsRef = useRef<Map<string, boolean> | null>(null);
  const prevCapsulesRef = useRef<Map<string, string>>(new Map());

  const needsItems = useMemo(() => {
    return sessions.filter((s) => isNeedsYouPeekSession(s, now));
  }, [sessions, now]);

  /** 未读的「需要你」项：探出与底栏未读数只认未读（跳转会话页即已读，见 needsReadStore） */
  const needsRead = useNeedsRead();
  const unreadNeeds = useMemo(
    () => needsItems.filter((s) => !needsRead.has(s.id)),
    [needsItems, needsRead]
  );

  // needsYou 边沿检测：新边沿解除压制并清掉已读（重新提醒）；探出由 visiblePeek
  // 读时推导——只要有未读项就持续显示。已读也用于左栏胶囊，只修剪已删除会话。
  useEffect(() => {
    const prev = prevNeedsRef.current;
    const next = new Map<string, boolean>();
    const sessionIds = sessions.map(s => s.id);
    const capsules = new Map<string, string>();
    const newEdges: string[] = [];
    let anyNeeds = false;
    let rearm = false;
    for (const s of sessions) {
      if (!isBoardSession(s)) continue;
      const capsule = JSON.stringify([s.liveStatus?.ts, s.liveStatus?.label, s.phase?.value,
        s.phase?.ts, s.status, s.lifecycle, s.activity?.kind]);
      capsules.set(s.id, capsule);
      const previousCapsule = prevCapsulesRef.current.get(s.id);
      if (previousCapsule !== undefined && previousCapsule !== capsule) newEdges.push(s.id);
      const isNeeds = isNeedsYouPeekSession(s, now);
      next.set(s.id, isNeeds);
      if (isNeeds) {
        anyNeeds = true;
        if (prev && !prev.get(s.id)) {
          rearm = true;
          newEdges.push(s.id);
        }
      }
    }
    // 首帧 store 仍是 []：不能当「零需要你」。retain([]) 会把落盘已读剪光，
    // 随后 sessions.list 到达又会被当成新边沿误探出。等拿到非空表（或之后
    // 真的清空）再建快照。prev===null 本身也不判边沿。
    if (prev === null && sessions.length === 0) return;
    prevNeedsRef.current = next;
    prevCapsulesRef.current = capsules;
    retainNeedsRead(sessionIds);
    if (newEdges.length > 0) markNeedsUnread(newEdges);
    if (rearm) setSuppressed(false);
    if (!anyNeeds) setSuppressed(false);
  }, [sessions, now]);

  // 展开期间不探出（面板本身在场）；关闭后若仍有未读项，探条自动回来
  const visiblePeek = unreadNeeds.length > 0 && !suppressed && !open;
  const presence = usePresence(open || visiblePeek);
  const scrim = usePresence(open);
  // 首次真实展示后仅保留 Beam 外壳及其 <style>/@property；业务内容仍按 presence 挂卸。
  // 不在启动时预挂载，避免把首次样式注册成本转移到应用启动。
  const beamRetainedRef = useRef(false);
  if (presence.mounted) beamRetainedRef.current = true;
  const lastVisible = useRef('open');
  if (open || visiblePeek) lastVisible.current = open ? 'open' : 'peek';
  const phase = open ? 'open' : visiblePeek ? 'peek' : lastVisible.current === 'peek' ? 'peek-out' : 'exiting';
  const beamActive = presence.mounted && visiblePeek && presence.stage === 'in';


  useOverlayDismiss(open || visiblePeek, () => {
    if (open) onClose();
    else setSuppressed(true);
  });

  // 展开态点外关闭（AgentFloat 同款捕获 + closest 豁免）：只认左键；面板自身、
  // 各类浮层与顶栏「全局看板」入口（自身是 toggle）不算「点外面」。顶栏其余按钮
  // 可点（展开态 overlay 让开顶栏），点下去会关看板再执行按钮。onClose 置 open=false
  // 后目标态自行分流——仍有未压制的 needsYou 项 → 收回到探出条（通知还在），
  // 否则完全隐藏。探出态点外不响应（提醒不能被顺手点掉）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const t = e.target;
      if (isInsideOverlay(t)) return;
      if (
        t instanceof Element &&
        t.closest(
          '.g-board-sheet, .session-details-card, .modal-mask, .app-confirm-mask, .new-task-overlay, .ctx-menu, .quick-open-mask, .chrome-gboard-btn'
        )
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, onClose]);

  if (!beamRetainedRef.current) return null;

  const peekText =
    unreadNeeds.length > 1
      ? t('{{n}} 个项目需要你', { n: unreadNeeds.length })
      : unreadNeeds[0]
        ? t('「{{name}}」需要你', { name: unreadNeeds[0].name })
        : t('项目需要你');

  return (
    <div
      className={`g-board-overlay is-${phase}`}
      {...presence.spread}
      hidden={!presence.mounted}
      {...(!presence.mounted ? { inert: '' } : {})}
      aria-hidden={!presence.mounted || undefined}
      role="dialog"
      aria-modal="false"
      aria-label={t('全局看板')}
    >
      {scrim.mounted && <div className="mp-scrim-layer backdrop-blur-overlay mp-scrim" {...scrim.spread} aria-hidden />}
      <div
        ref={sheetRef}
        className={`g-board-sheet mp-panel mp-panel-fly is-${phase}`}
        {...presence.spread}
      >
        {/* 样式/外壳保留；out 期间业务内容继续在场，完全关闭后销毁并在重开时重置。 */}
        <BorderBeam
          className="g-board-content g-board-peek-beam"
          {...PEEK_BEAM_PROPS}
          theme={appearance.appearance}
          strength={beamActive ? PEEK_BEAM_PROPS.strength : 0}
          data-board-beam-active={beamActive ? '' : undefined}
          {...(!open ? { inert: '' } : {})}
          aria-hidden={!open || undefined}
        >
          {presence.mounted ? <BoardPanel onClose={onClose} onOpenWorkerSettings={onOpenWorkerSettings} active={open} /> : null}
        </BorderBeam>
        {visiblePeek && (
          /* 无可见装饰的整面入口，覆盖浮动时露出的全部区域。
           * 下层内容 inert，隐藏的卡片/工具栏不会被 Tab 或点击激活。 */
          <button
            type="button"
            className="g-board-peek-trigger"
            aria-label={t('展开全局看板（{{peekText}}）', { peekText })}
            title={t('展开全局看板')}
            onClick={onOpen}
          />
        )}
      </div>
    </div>
  );
}
