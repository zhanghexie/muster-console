import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { MOTION } from '../components/motion';
import { AppPresentationController } from './presentation';

export const PHONE_AUTO_KEY = 'muster.agentPhone.auto';
export function useAgentPhone(workspaceId: string) {
  const controllers = useRef(new Map<string, AppPresentationController>());
  const controller = useMemo(() => {
    let value = controllers.current.get(workspaceId);
    if (!value) { value = new AppPresentationController(workspaceId, localStorage.getItem(PHONE_AUTO_KEY) !== 'false'); controllers.current.set(workspaceId, value); }
    if (controllers.current.size > 30) controllers.current.delete(controllers.current.keys().next().value!);
    return value;
  }, [workspaceId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => window.api.on('agentApps:operation', event => {
    // Keep completion bookkeeping for visited workspaces without opening them off-screen.
    controllers.current.forEach(instance => instance.accept(event, instance === controller && document.visibilityState !== 'hidden'));
  }), [controller]);
  const hasPending = state.pending > 0;
  useEffect(() => {
    if (!hasPending || !state.following || !state.auto) return;
    // Arrivals must not debounce this pump. Each displayed page gets one short,
    // complete turnstile; the agent/IPC never waits for this renderer-only timer.
    const timer = window.setTimeout(() => controller.advance(), state.open ? MOTION.moveMs + MOTION.menuMs : MOTION.microMs);
    return () => window.clearTimeout(timer);
  }, [controller, hasPending, state.following, state.auto, state.open, state.operation]);
  useEffect(() => {
    if (!state.open || state.openedBy !== 'agent' || !state.following || hasPending || state.active) return;
    // Reading time for the final result, not animation duration. New work or human
    // ownership cancels it; dismissal itself uses AgentPhone's existing presence.
    const timer = window.setTimeout(() => controller.closeIfIdle(), 1500);
    return () => window.clearTimeout(timer);
  }, [controller, state.open, state.openedBy, state.following, hasPending, state.active, state.operation]);
  return { controller, state, setAuto: (value: boolean) => { localStorage.setItem(PHONE_AUTO_KEY, String(value)); controllers.current.forEach(instance => instance.setAuto(value)); } };
}
