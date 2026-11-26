import { useEffect, useMemo } from 'react';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../../shared/chatSurface';
import type { MemoryCuratorApi, MemoryCuratorSnapshot } from '../../../shared/memoryCurator';
import { getResolvedLocale, subscribeLocale } from '../../../shared/i18n';
import { localizeKnowledgeProgress } from '../../../shared/knowledgeDisplayText';
import { getOrchestratorSurface } from './orchestratorSurface';

export interface MemoryCuratorViewState {
  snapshot: MemoryCuratorSnapshot | null;
  loading: boolean;
  error: string;
}

export interface MemoryCuratorSurface extends ChatSurface {
  getViewState(): MemoryCuratorViewState;
  attach(): () => void;
  dispose(): void;
  refresh(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
}

/** A separate purpose store. Read-only state loads never start or resume a model. */
export function createMemoryCuratorSurface(
  workspaceId: string,
  api: () => MemoryCuratorApi = () => window.api.memoryCurator
): MemoryCuratorSurface {
  let view: MemoryCuratorViewState = { snapshot: null, loading: false, error: '' };
  let chat: ChatSurfaceSnapshot = {
    messages: [], busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null
  };
  let epoch = 0;
  let pushes = 0;
  let references = 0;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeLocale: (() => void) | null = null;
  const modelSurface = getOrchestratorSurface(workspaceId);
  let unsubscribeModel: (() => void) | null = null;
  let projectedSource: MemoryCuratorSnapshot['messages'] | undefined;
  let projectedLocale: string | undefined;
  let projectedMessages: MemoryCuratorSnapshot['messages'] = [];
  const listeners = new Set<() => void>();
  const publish = (): void => {
    const snapshot = view.snapshot;
    const locale = getResolvedLocale();
    if (snapshot?.messages !== projectedSource || locale !== projectedLocale) {
      projectedSource = snapshot?.messages;
      projectedLocale = locale;
      projectedMessages = (snapshot?.messages ?? []).map(message => {
        if (!message.host || message.role !== 'user') return message;
        let changed = false;
        const parts = message.parts.map(part => {
          if (part.kind !== 'text') return part;
          const text = localizeKnowledgeProgress(part.text);
          if (text === part.text) return part;
          changed = true;
          return { ...part, text };
        });
        return changed ? { ...message, parts } : message;
      });
    }
    chat = {
      messages: projectedMessages,
      busy: snapshot?.running ?? false,
      queuedCount: 0,
      queuedItems: [],
      status: modelSurface.getSnapshot().status,
      mode: null,
      preset: null,
      historyLoading: view.loading && !snapshot,
      historyError: view.error || undefined
    };
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown): void => {
    view = { ...view, loading: false, error: String(error instanceof Error ? error.message : error) };
    publish();
  };
  const apply = (incoming: MemoryCuratorSnapshot): void => {
    if (!incoming || incoming.workspaceId !== workspaceId) return;
    const current = view.snapshot;
    if (current && (incoming.generation < current.generation ||
      (incoming.generation === current.generation && incoming.updatedAt < current.updatedAt))) return;
    // Private reasoning is never part of this role's visible transcript.
    const snapshot = {
      ...incoming,
      messages: incoming.messages.map(message => ({
        ...message, parts: message.parts.filter(part => part.kind !== 'thinking')
      }))
    };
    view = { snapshot, loading: false, error: '' };
    publish();
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const requestEpoch = epoch;
    const pushVersion = pushes;
    view = { ...view, loading: true, error: '' };
    publish();
    try {
      const incoming = await api().state(workspaceId);
      if (requestEpoch !== epoch) return;
      // A full push received while history was in flight is already authoritative.
      if (pushVersion !== pushes) {
        view = { ...view, loading: false };
        publish();
        return;
      }
      if (!incoming || incoming.workspaceId !== workspaceId || !Array.isArray(incoming.messages)) {
        throw new Error('Invalid memory session state.');
      }
      apply(incoming);
    } catch (error) { if (requestEpoch === epoch) fail(error); }
  };
  const setPaused = async (paused: boolean): Promise<void> => {
    if (disposed) return;
    const requestEpoch = epoch;
    try {
      const incoming = await api().setPaused(workspaceId, paused);
      if (requestEpoch === epoch) apply(incoming);
    } catch (error) { if (requestEpoch === epoch) fail(error); }
  };
  const surface: MemoryCuratorSurface = {
    get sessionId() { return `memory:${workspaceId}:${view.snapshot?.generation ?? 0}`; },
    caps: {
      surfaceKind: 'gui-session', draftKey: `memory:${workspaceId}`,
      images: false, plusMenu: false, bgTasks: false, fork: false, notes: false,
      presets: false, localCommands: false, manualCompact: false, modeOrder: [],
      modelPickerTarget: { dispatch: { workspaceId } }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => chat,
    getViewState: () => view,
    refresh,
    setPaused,
    dispose() {
      disposed = true;
      epoch++;
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeLocale?.();
      unsubscribeLocale = null;
      unsubscribeModel?.();
      unsubscribeModel = null;
      view = { snapshot: null, loading: false, error: '' };
      publish();
    },
    attach() {
      if (disposed) return () => undefined;
      references++;
      if (references === 1) {
        epoch++;
        const listenerEpoch = epoch;
        const stop = api().onChanged(incoming => {
          if (listenerEpoch !== epoch || incoming.workspaceId !== workspaceId) return;
          pushes++;
          apply(incoming);
        });
        unsubscribe = typeof stop === 'function' ? stop : null;
        unsubscribeLocale = subscribeLocale(publish);
        unsubscribeModel = modelSurface.subscribe(publish);
        void refresh();
      }
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        references--;
        if (references === 0) {
          epoch++;
          unsubscribe?.();
          unsubscribe = null;
          unsubscribeLocale?.();
          unsubscribeLocale = null;
          unsubscribeModel?.();
          unsubscribeModel = null;
        }
      };
    },
    actions: {
      async send(text, images) {
        if (disposed || !text.trim() || images?.length || view.snapshot?.paused) return false;
        const requestEpoch = epoch;
        try {
          const response = await api().send(workspaceId, text);
          if (requestEpoch !== epoch) return false;
          if (!response?.accepted) return false;
          void refresh();
          return true;
        } catch {
          // P3 chat-surface F-05：发送失败只走 sendError 通道（返回 false →
          // MemoryCuratorView 提示「消息未发送，草稿已保留」）；不写 view.error——
          // 那是 state/history 读取失败面，写它会把欢迎区换成「重新读取记忆会话」，
          // 一次发送失败出现两个语义冲突的恢复入口。
          return false;
        }
      },
      stop() { void setPaused(true); },
      async clear() {
        if (disposed) return;
        const requestEpoch = epoch;
        try {
          const incoming = await api().clear(workspaceId);
          if (requestEpoch === epoch) apply(incoming);
        } catch (error) { if (requestEpoch === epoch) fail(error); throw error; }
      },
      retry() { void refresh(); },
      cancelQueued() { /* The curator's queue is governed by the host, not a composer queue. */ },
      setThinking: level => modelSurface.actions.setThinking?.(level) ?? Promise.resolve({ ok: false, error: 'Thinking levels are unavailable' }),
      setModel: model => modelSurface.actions.setModel?.(model),
      setModelConfiguration: input => modelSurface.actions.setModelConfiguration?.(input) ?? Promise.resolve({ ok: false, error: 'Model configuration is unavailable' })
    }
  };
  return surface;
}

const surfaces = new Map<string, MemoryCuratorSurface>();
export function evictMemoryCuratorWorkspaces(liveWorkspaceIds: readonly string[]): void {
  const live = new Set(liveWorkspaceIds);
  for (const [workspaceId, surface] of surfaces) {
    if (live.has(workspaceId)) continue;
    surface.dispose();
    surfaces.delete(workspaceId);
  }
}

export function useMemoryCuratorSurface(workspaceId: string | null, enabled: boolean): MemoryCuratorSurface | null {
  const surface = useMemo(() => {
    if (!workspaceId) return null;
    let existing = surfaces.get(workspaceId);
    if (!existing) {
      existing = createMemoryCuratorSurface(workspaceId);
      surfaces.set(workspaceId, existing);
    }
    return existing;
  }, [workspaceId]);
  useEffect(() => enabled ? surface?.attach() : undefined, [surface, enabled]);
  return surface;
}
