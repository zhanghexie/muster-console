import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuntimeAvailabilitySnapshot } from '../../../shared/runtimeAvailability';
import type { AgentRuntimeEntry } from '../../../shared/types';

type AvailabilityState = { snapshot: RuntimeAvailabilitySnapshot | null; loading: boolean; error: string };

/** Creation surfaces use probed availability; a failed probe never turns registry entries into executable choices. */
export function useRuntimeAvailability(active: boolean): AvailabilityState & { ready: boolean; refresh: (force?: boolean) => Promise<RuntimeAvailabilitySnapshot | null> } {
  const { t } = useTranslation();
  const [state, setState] = useState<AvailabilityState>({ snapshot: null, loading: active, error: '' });
  const wasActive = useRef(active);
  const request = useRef(0);
  const live = useRef(false);
  const forcedRequests = useRef(0);
  const deferredBroadcast = useRef(false);
  if (wasActive.current !== active) {
    wasActive.current = active;
    request.current++;
    // Presence keeps the closing form visible; a new opening starts with no executable choices.
    setState(previous => active ? { snapshot: null, loading: true, error: '' } : { ...previous, loading: false });
  }
  const reload = useCallback(async (force = false): Promise<RuntimeAvailabilitySnapshot | null> => {
    if (!live.current) return null;
    const generation = ++request.current;
    if (force) forcedRequests.current++;
    setState(previous => ({ ...previous, loading: true, error: '' }));
    try {
      const snapshot = await window.api.runtimes.availability(force);
      if (!snapshot || !Array.isArray(snapshot.runtimes) || !Array.isArray(snapshot.acpAgents) || !Number.isFinite(snapshot.checkedAt)) {
        throw new Error(t('运行工具检测返回无效数据'));
      }
      if (live.current && request.current === generation) {
        setState({ snapshot, loading: false, error: '' });
        return snapshot;
      }
    } catch (error) {
      if (live.current && request.current === generation) setState({ snapshot: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (force && --forcedRequests.current === 0 && deferredBroadcast.current) {
        deferredBroadcast.current = false;
        // Let the caller consume its forced result before rereading a broadcast snapshot.
        setTimeout(() => {
          if (!live.current) return;
          if (forcedRequests.current) deferredBroadcast.current = true;
          else void reload();
        }, 0);
      }
    }
    return null;
  }, [t]);
  useEffect(() => {
    if (!active) return;
    live.current = true;
    // These events only reread the main-process snapshot, never run a new probe.
    const onSnapshotChanged = (): void => { void reload(); };
    const onAvailabilityChanged = (): void => {
      if (forcedRequests.current) deferredBroadcast.current = true;
      else void reload();
    };
    const offs = [window.api.on('runtimes:changed', onSnapshotChanged), window.api.on('runtimes:availabilityChanged', onAvailabilityChanged)];
    void reload();
    return () => {
      live.current = false; request.current++;
      offs.forEach(off => off());
    };
  }, [active, reload]);
  return { ...state, ready: active && !state.loading && !state.error && state.snapshot !== null, refresh: reload };
}

/** Keep the current registry's labels and enabled flags, without treating registration as availability. */
export function availableRuntimeEntries(snapshot: RuntimeAvailabilitySnapshot | null, registered: AgentRuntimeEntry[]): AgentRuntimeEntry[] {
  const ids = new Set(snapshot?.runtimes.filter(runtime => runtime.enabled).map(runtime => runtime.id));
  return registered.filter(runtime => runtime.enabled && ids.has(runtime.id) && (runtime.id !== 'acp' || !!snapshot?.acpAgents.length));
}

export function runtimeSelectionAvailable(snapshot: RuntimeAvailabilitySnapshot | null, registered: AgentRuntimeEntry[], runtime: string, acpAgent?: string): boolean {
  return availableRuntimeEntries(snapshot, registered).some(entry => entry.id === runtime)
    && (runtime !== 'acp' || !!acpAgent && !!snapshot?.acpAgents.some(agent => agent.id === acpAgent));
}
