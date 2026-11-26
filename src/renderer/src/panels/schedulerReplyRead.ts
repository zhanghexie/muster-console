import { useCallback, useMemo, useState } from 'react';

const STORAGE_KEY = 'muster.scheduler-reply-read.v1';

type ReadMap = Record<string, string>;

function load(): ReadMap {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string'));
  } catch {
    return {};
  }
}

export interface SchedulerReplyReadStore {
  isUnread: (workspaceId: string, messageId?: string) => boolean;
  markRead: (workspaceId: string, messageId?: string) => void;
  markUnread: (workspaceId: string, messageId?: string) => void;
}

/** Per-workspace assistant-message watermark. Status capsules do not participate in read state. */
export function useSchedulerReplyRead(): SchedulerReplyReadStore {
  const [read, setRead] = useState<ReadMap>(load);
  const update = useCallback((workspaceId: string, messageId: string | undefined): void => {
    if (!workspaceId) return;
    setRead(previous => {
      if (messageId ? previous[workspaceId] === messageId : !(workspaceId in previous)) return previous;
      const next = { ...previous };
      if (messageId) next[workspaceId] = messageId;
      else delete next[workspaceId];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* memory state remains authoritative for this mount */ }
      return next;
    });
  }, []);
  const markRead = useCallback((workspaceId: string, messageId?: string) => update(workspaceId, messageId), [update]);
  const markUnread = useCallback((workspaceId: string, messageId?: string) => update(workspaceId, messageId ? undefined : undefined), [update]);
  return useMemo(() => ({
    isUnread: (workspaceId: string, messageId?: string) => !!messageId && read[workspaceId] !== messageId,
    markRead,
    markUnread
  }), [markRead, markUnread, read]);
}

export function resetSchedulerReplyReadForTest(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
