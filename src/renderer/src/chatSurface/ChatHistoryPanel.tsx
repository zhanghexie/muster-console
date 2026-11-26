/**
 * 会话历史面板：右键点击用户消息气泡弹出，悬于转写中央（无遮罩，点面板外/Escape/✕ 关闭）。
 * 列表只列用户消息（每轮一条，单行截断）。交互：悬浮条目**不**动转写，只在面板
 * 上方统一显示该条完整提问与该轮 AI 回复的末段正文；点击条目平滑滚动跳转且面板**不**自动关闭
 * （方便连续翻看）；关闭只走点面板外空白/Escape/✕。
 * 收藏按转写保存到本机，未加载的收藏通过原有消息导航回填。进出场由宿主 presence 驱动。
 */
import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnRailStop } from '../../../shared/chatTurnRail';
import { MOTION, usePresence, type PresenceStage } from '../components/motion';
import { MarkdownBody } from '../components/MarkdownBody';
import { IconBookmark } from '../components/icons';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { useHistoryFavorites } from './useHistoryFavorites';

type HistoryEntry = Pick<TurnRailStop, 'id' | 'ts' | 'prompt'> & { reply?: string };

export function ChatHistoryPanel(props: {
  /** 宿主 presence 三态：面板进出场动画（mp-panel 骨架） */
  stage: PresenceStage;
  historyId: string;
  stops: TurnRailStop[];
  origin?: { id: string; sequence: number } | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Transcript-owned bounded navigation (standalone consumers retain fallback). */
  onNavigate?: (messageId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { stage, historyId, stops, origin, scrollRef, onClose, onNavigate } = props;
  const { t } = useTranslation();
  const titleId = useId();
  const { favorites, favoriteIds, setFavorite } = useHistoryFavorites(historyId);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const filterRef = useRef<HTMLButtonElement>(null);
  const historyListRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const visibleStops = useMemo<HistoryEntry[]>(() => {
    if (!favoritesOnly) return stops;
    const loaded = stops.filter((stop) => favoriteIds.has(stop.id));
    if (loaded.length === favoriteIds.size) return loaded;
    const loadedIds = new Set(loaded.map((stop) => stop.id));
    const unloaded = favorites.filter((entry) => !loadedIds.has(entry.id));
    return [...loaded, ...unloaded].sort((a, b) => a.ts - b.ts);
  }, [favorites, favoriteIds, favoritesOnly, stops]);

  React.useLayoutEffect(() => {
    if (origin) filterRef.current?.focus({ preventScroll: true });
    const list = historyListRef.current;
    const item = origin && itemRefs.current.get(origin.id);
    if (!list || !item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    list.scrollTop += itemRect.top - listRect.top - (list.clientHeight - itemRect.height) / 2;
  }, [origin]);
  /** 悬浮中的条目：驱动面板上方的内容预览气泡（null = 不显示） */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hovered = visibleStops.find((stop) => stop.id === hoveredId) ?? null;
  // 预览气泡进出场（mp-pop 三态）；条目间移动时保持挂载只换文案，离开列表淡出
  const previewPresence = usePresence(hovered != null, MOTION.menuMs);
  const lastHoveredRef = useRef<HistoryEntry | null>(null);
  if (hovered) lastHoveredRef.current = hovered;
  const previewStop = hovered ?? (previewPresence.mounted ? lastHoveredRef.current : null);

  const toggleFavorite = (stop: HistoryEntry, button: HTMLButtonElement): void => {
    const removing = favoriteIds.has(stop.id);
    if (setFavorite(stop, !removing) && removing && favoritesOnly) {
      setHoveredId(null);
      if (document.activeElement === button) filterRef.current?.focus();
    }
  };

  const scrollToStop = useCallback(
    (stop: HistoryEntry): void => {
      if (onNavigate) { onNavigate(stop.id); return; }
      const list = scrollRef.current;
      if (!list) return;
      const el = list?.querySelector(`[data-mid="${stop.id}"]`);
      if (!el) {
        // 长转录窗口裁剪（R-23）：目标回合在未挂载区，请转写层先扩窗
        // （ChatTranscript 监听该事件，扩窗渲染后自行滚动定位到目标锚点）
        list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: stop.id }));
        return;
      }
      const top =
        el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      list.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    },
    [scrollRef, onNavigate]
  );

  // 点面板以外区域关闭（无遮罩：转写就在面板下层，点哪都关；预览气泡不接指针
  // 事件，点击不会落在它身上，无需豁免）
  useOverlayDismiss(stage !== 'out', onClose);
  React.useEffect(() => {
    if (stage === 'out') return;
    const onDocMousedown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest?.('.chat-history')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMousedown);
    return () => document.removeEventListener('mousedown', onDocMousedown);
  }, [onClose, stage]);

  return (
    /* 居中层只负责定位（pointer-events 关，让面板外的点击落回转写），动画在内层；
       列锚在会话区底部，预览气泡叠在面板上方（同层列布局） */
    <div className="chat-history-pos">
      {previewStop ? (
        <div
          className="chat-history-preview mp-pop"
          data-mp-stage={previewPresence.stage}
          aria-label={t('内容预览')}
        >
          <MarkdownBody className="chat-history-preview-prompt" text={previewStop.prompt || t('图片')} displayOnly />
          {previewStop.reply ? (
            <MarkdownBody className="chat-history-preview-reply" text={previewStop.reply} displayOnly />
          ) : null}
        </div>
      ) : null}
      <div
        className="chat-history mp-panel"
        data-mp-stage={stage}
        role="dialog"
        aria-labelledby={titleId}
        {...(stage === 'out' ? { inert: '' } : {})}
      >
        <div className="chat-history-head">
          <h2 id={titleId} className="chat-history-title">{t('会话历史')}</h2>
          <button
            ref={filterRef}
            type="button"
            className="chat-history-filter"
            aria-pressed={favoritesOnly}
            onClick={() => {
              setFavoritesOnly((current) => !current);
              setHoveredId(null);
              if (historyListRef.current) historyListRef.current.scrollTop = 0;
            }}
          >
            <IconBookmark size={14} />
            {t('仅看收藏')}
          </button>
          <button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div ref={historyListRef} className="chat-history-list" onMouseLeave={() => setHoveredId(null)}>
          {favoritesOnly && !visibleStops.length && <p className="chat-history-empty">{t('暂无收藏的消息')}</p>}
          <ol className="chat-history-entries" role="list">
            {visibleStops.map((stop) => {
              const prompt = stop.prompt || t('图片');
              const favorite = favoriteIds.has(stop.id);
              return (
                <li key={stop.id} className="chat-history-row" onMouseEnter={() => setHoveredId(stop.id)}>
                  <button
                    type="button"
                    className="chat-history-item"
                    ref={(element) => {
                      if (element) itemRefs.current.set(stop.id, element);
                      else itemRefs.current.delete(stop.id);
                    }}
                    onClick={() => scrollToStop(stop)}
                  >
                    {origin?.id === stop.id ? <span key={origin.sequence} className="chat-history-origin-flash" aria-hidden="true" /> : null}
                    <span className="chat-history-item-text">{prompt}</span>
                  </button>
                  <button
                    type="button"
                    className="chat-history-bookmark"
                    aria-label={t('收藏消息「{{prompt}}」', { prompt })}
                    aria-pressed={favorite}
                    title={favorite ? t('取消收藏') : t('收藏')}
                    onClick={(event) => toggleFavorite(stop, event.currentTarget)}
                  >
                    <IconBookmark size={16} />
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
