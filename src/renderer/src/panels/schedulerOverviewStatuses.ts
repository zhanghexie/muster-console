import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAccentHex, WORKSPACE_ACCENTS } from '../../../shared/workspaceAccent';
import { useUiActionsStore } from '../store';

export type SchedulerOverviewStatus = { id: string; color: string; name?: string };
type Translate = (key: string) => string;

const STORAGE_KEY = 'muster.schedulerOverviewStatuses.v1';
export const UNMARKED_STATUS: SchedulerOverviewStatus = { id: 'unmarked', color: WORKSPACE_ACCENTS[7] };
const BUILTIN_LABELS = new Map<string, (t: Translate) => string>([
  [UNMARKED_STATUS.id, t => t('未标记')],
  ['todo', t => t('待处理')],
  ['working', t => t('进行中')],
  ['done', t => t('已完成')],
  ['blocked', t => t('阻塞')]
]);
const DEFAULT_STATUS_KINDS: SchedulerOverviewStatus[] = [
  { id: 'todo', color: WORKSPACE_ACCENTS[5] },
  { id: 'working', color: WORKSPACE_ACCENTS[0] },
  { id: 'done', color: WORKSPACE_ACCENTS[6] },
  { id: 'blocked', color: WORKSPACE_ACCENTS[3] }
];

type Preferences = {
  kinds: SchedulerOverviewStatus[];
  assignments: Record<string, string>;
  hidden: string[];
};
const defaults: Preferences = { kinds: DEFAULT_STATUS_KINDS, assignments: {}, hidden: [] };

export function overviewStatusName(status: SchedulerOverviewStatus, t: Translate): string {
  return status.name ?? BUILTIN_LABELS.get(status.id)?.(t) ?? t('未标记');
}

export function assignedOverviewStatus(assignments: Preferences['assignments'], workspaceId: string): string {
  return Object.hasOwn(assignments, workspaceId) ? assignments[workspaceId] : UNMARKED_STATUS.id;
}

function readPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Preferences> | null;
    if (!Array.isArray(stored?.kinds)) return defaults;
    const validIds = new Set([UNMARKED_STATUS.id]);
    const kinds: SchedulerOverviewStatus[] = [];
    for (const entry of stored.kinds) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || validIds.has(entry.id) || !isAccentHex(entry.color)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : undefined;
      if (!name && !BUILTIN_LABELS.has(entry.id)) continue;
      validIds.add(entry.id);
      kinds.push({ id: entry.id, color: entry.color.toLowerCase(), name: name || undefined });
    }
    const assignments = Object.fromEntries(Object.entries(stored.assignments ?? {}).filter(([, id]) => validIds.has(id)));
    const hidden = Array.isArray(stored.hidden) ? stored.hidden.filter(id => validIds.has(id)) : [];
    return { kinds, assignments, hidden };
  } catch {
    return defaults;
  }
}

export function useSchedulerOverviewStatuses() {
  const { t } = useTranslation();
  const { flashTip } = useUiActionsStore();
  const [preferences, setPreferences] = useState(readPreferences);
  const lastSaved = useRef(preferences);
  const kinds = useMemo(() => [UNMARKED_STATUS, ...preferences.kinds], [preferences.kinds]);
  const hidden = useMemo(() => new Set(preferences.hidden), [preferences.hidden]);

  useEffect(() => {
    if (lastSaved.current === preferences) return;
    lastSaved.current = preferences;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      flashTip(t('面板状态保存失败'));
    }
  }, [flashTip, preferences, t]);

  const assign = useCallback((workspaceId: string, id: string) => {
    setPreferences(previous => {
      if (assignedOverviewStatus(previous.assignments, workspaceId) === id) return previous;
      const assignments = { ...previous.assignments, [workspaceId]: id };
      if (id === UNMARKED_STATUS.id) delete assignments[workspaceId];
      return { ...previous, assignments };
    });
  }, []);

  const setShown = (id: string, shown: boolean): void => {
    setPreferences(previous => ({
      ...previous,
      hidden: shown ? previous.hidden.filter(hiddenId => hiddenId !== id) : [...previous.hidden, id]
    }));
  };

  const showAll = (shown: boolean): void => {
    setPreferences(previous => ({ ...previous, hidden: shown ? [] : kinds.map(kind => kind.id) }));
  };

  const save = (status: SchedulerOverviewStatus): void => {
    setPreferences(previous => ({
      ...previous,
      kinds: previous.kinds.some(kind => kind.id === status.id)
        ? previous.kinds.map(kind => kind.id === status.id ? status : kind)
        : [...previous.kinds, status]
    }));
  };

  const remove = (id: string): void => {
    setPreferences(previous => ({
      kinds: previous.kinds.filter(kind => kind.id !== id),
      assignments: Object.fromEntries(Object.entries(previous.assignments).filter(([, assigned]) => assigned !== id)),
      hidden: previous.hidden.filter(hiddenId => hiddenId !== id)
    }));
  };

  return { kinds, hidden, assignments: preferences.assignments, assign, setShown, showAll, save, remove };
}

export type SchedulerOverviewStatuses = ReturnType<typeof useSchedulerOverviewStatuses>;
