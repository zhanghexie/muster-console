import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnRailStop } from '../../../shared/chatTurnRail';
import { showTip } from '../tips';

type HistoryFavorite = Pick<TurnRailStop, 'id' | 'ts' | 'prompt'>;
const EMPTY_FAVORITES: HistoryFavorite[] = [];
const favoriteChanges = new EventTarget();

function readFavorites(key: string): HistoryFavorite[] {
  const favorites: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
  if (!Array.isArray(favorites)) return [];
  return favorites.filter((entry): entry is HistoryFavorite =>
    typeof entry?.id === 'string' && Number.isFinite(entry.ts) && typeof entry.prompt === 'string'
  );
}

/** Shares the saved favorites for one transcript between its message and history controls. */
export function useHistoryFavorites(historyId: string) {
  const { t } = useTranslation();
  const key = `muster.chat-history-favorites.v1:${historyId}`;
  const [snapshot, setSnapshot] = useState<{ key: string; favorites: HistoryFavorite[] }>();
  const favorites = snapshot?.key === key ? snapshot.favorites : EMPTY_FAVORITES;

  useEffect(() => {
    const load = (): void => {
      try {
        setSnapshot({ key, favorites: readFavorites(key) });
      } catch {
        showTip(t('无法读取会话历史收藏'), { tone: 'error' });
      }
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === key || event.key === null) load();
    };
    const onChange = (event: Event): void => {
      setSnapshot({ key, favorites: (event as CustomEvent<HistoryFavorite[]>).detail });
    };
    load();
    favoriteChanges.addEventListener(key, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      favoriteChanges.removeEventListener(key, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [key, t]);

  const setFavorite = useCallback((entry: HistoryFavorite, favorite: boolean): boolean => {
    try {
      const saved = readFavorites(key);
      const next = saved.filter((item) => item.id !== entry.id);
      if (favorite) {
        const { id, ts, prompt } = entry;
        next.push({ id, ts, prompt: prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt });
      }
      if (next.length) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
      favoriteChanges.dispatchEvent(new CustomEvent(key, { detail: next }));
      return true;
    } catch {
      showTip(t('无法保存会话历史收藏'), { tone: 'error' });
      return false;
    }
  }, [key, t]);

  const favoriteIds = useMemo(() => new Set(favorites.map((entry) => entry.id)), [favorites]);
  return { favorites, favoriteIds, setFavorite };
}
