import { useEffect } from 'react';
import { useUiStore } from '../store';

/** Reuse the existing AgentFloat request path and its presence/transition system. */
export function CliRunNavigation(): null {
  const { requestAgentPanel } = useUiStore();
  useEffect(() => window.api.on('cli:openRun', event => {
    if (event.workspaceId && event.runId) requestAgentPanel(event.workspaceId);
  }), [requestAgentPanel]);
  return null;
}
