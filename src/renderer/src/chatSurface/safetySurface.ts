import { useEffect, useMemo } from 'react';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../../shared/chatSurface';
import type { SafetySnapshot } from '../../../shared/safety';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { subscribeLocale, t } from '../../../shared/i18n';
import { safetyMessageDisplay } from './safetyMessageDisplay';
import { getOrchestratorSurface } from './orchestratorSurface';

export interface SafetySurface extends ChatSurface {
  getViewState(): { snapshot: SafetySnapshot | null; error: string; loading: boolean };
  attach(): () => void;
  refresh(): Promise<void>;
  sendMessage(text: string): Promise<boolean>;
  setRuleEnabled(id: string, enabled: boolean): Promise<void>;
}
export function createSafetySurface(workspaceId: string): SafetySurface {
  let view: ReturnType<SafetySurface['getViewState']> = { snapshot: null, error: '', loading: false };
  let chat: ChatSurfaceSnapshot = { messages: [], busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null };
  let epoch = 0, pushes = 0;
  const modelSurface = getOrchestratorSurface(workspaceId);
  let unsubscribeModel: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = () => {
    const messages: GuiChatMessage[] = (view.snapshot?.messages ?? []).map(message => ({
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      parts: message.parts?.length ? message.parts : [{ kind: 'text', text: safetyMessageDisplay(message) }],
      ts: message.createdAt,
      ...(message.error ? { error: message.error } : {}),
      ...(message.role === 'system' ? { host: true } : {})
    }));
    chat = { ...chat, messages, busy: !!view.snapshot?.busy, status: modelSurface.getSnapshot().status, historyLoading: view.loading && !view.snapshot };
    listeners.forEach(listener => listener());
  };
  const apply = (incoming: SafetySnapshot) => {
    if (incoming.workspaceId !== workspaceId || (view.snapshot && incoming.generation < view.snapshot.generation)) return;
    view = { snapshot: incoming, error: '', loading: false }; publish();
  };
  const request = async (action: () => Promise<SafetySnapshot>, invalidate = false): Promise<boolean> => {
    if (invalidate) epoch++;
    const token = epoch, version = pushes;
    try { const incoming = await action(); if (token !== epoch) return false; if (version === pushes) apply(incoming); return true; }
    catch (error) { if (token === epoch) { view = { ...view, loading: false, error: error instanceof Error ? error.message : String(error) }; publish(); } return false; }
  };
  const surface: SafetySurface = {
    get sessionId() { return `safety:${workspaceId}:${view.snapshot?.generation ?? 0}`; },
    caps: { surfaceKind: 'gui-session', draftKey: `safety:${workspaceId}`, images: false, plusMenu: false, bgTasks: false, fork: false, notes: false, presets: false, localCommands: false, manualCompact: false, modeOrder: [], modelPickerTarget: { dispatch: { workspaceId } } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => chat, getViewState: () => view,
    async refresh() { view = { ...view, loading: true }; publish(); await request(() => window.api.safety.snapshot(workspaceId)); if (view.loading) { view = { ...view, loading: false }; publish(); } },
    attach() { epoch++; const off = window.api.on('safety:changed', incoming => { if (incoming.workspaceId === workspaceId) { pushes++; apply(incoming); } }); const offLocale = subscribeLocale(publish); unsubscribeModel = modelSurface.subscribe(publish); void surface.refresh(); return () => { epoch++; off(); offLocale(); unsubscribeModel?.(); unsubscribeModel = null; }; },
    async setRuleEnabled(id, enabled) { await request(() => window.api.safety.setRuleEnabled(workspaceId, id, enabled, view.snapshot?.ruleRevision ?? 0)); },
    sendMessage(text) { return text.trim() ? request(() => window.api.safety.send(workspaceId, text, undefined)) : Promise.resolve(false); },
    actions: {
      send: text => surface.sendMessage(text),
      stop() { const token = ++epoch; void window.api.safety.stop(workspaceId).then(() => token === epoch ? surface.refresh() : undefined).catch(error => { if (token === epoch) { view = { ...view, error: String(error) }; publish(); } }); },
      async clear() {
        if (!await request(() => window.api.safety.clear(workspaceId), true)) throw new Error(view.error || t('审批会话已变化，请重新操作'));
      },
      retry() { void surface.refresh(); }, cancelQueued() {},
      setThinking: level => modelSurface.actions.setThinking?.(level) ?? Promise.resolve({ ok: false, error: 'Thinking levels are unavailable' }),
      setModel: model => modelSurface.actions.setModel?.(model),
      setModelConfiguration: input => modelSurface.actions.setModelConfiguration?.(input) ?? Promise.resolve({ ok: false, error: 'Model configuration is unavailable' })
    }
  };
  return surface;
}
export function useSafetySurface(workspaceId: string, enabled: boolean): SafetySurface {
  const surface = useMemo(() => createSafetySurface(workspaceId), [workspaceId]);
  useEffect(() => enabled ? surface.attach() : undefined, [surface, enabled]);
  return surface;
}
