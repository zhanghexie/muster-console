import { randomUuid } from '../../../shared/randomUuid';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WorkspaceFileRef } from '../../../shared/types';
import { getWebGatewayStatus, subscribeWebGatewayStatus } from '../webGatewayStatus';

/** Mounted previews keep their source registered even when the desktop panel is hidden. */
export function useFileRootUse(ref: WorkspaceFileRef | null) {
  const connected = useSyncExternalStore(subscribeWebGatewayStatus, getWebGatewayStatus).connected;
  const key = ref ? JSON.stringify([ref.workspaceId, ref.rootId, ref.relativePath]) : '';
  const [state, setState] = useState({ key: '', ready: false, error: '' });
  useEffect(() => {
    if (!ref || !connected) return;
    // One identity per effect protects a new view from late close/open responses.
    const viewId = randomUuid();
    let cancelled = false;
    setState({ key, ready: false, error: '' });
    void window.api.fs.openFile(ref, viewId).then(result => {
      if (!cancelled) setState({ key, ready: result.ok, error: result.error ?? '' });
    }).catch(error => {
      if (!cancelled) setState({ key, ready: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
      // The server also releases views when the owning transport disappears.
      void window.api.fs.closeFile(viewId).catch(() => {});
    };
  }, [key, connected]);
  return { ready: !ref || (connected && state.key === key && state.ready),
    error: state.key === key ? state.error : '' };
}
