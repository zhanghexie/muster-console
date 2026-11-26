/** Result and resource ownership are independent. busy remains the send/queue safety gate. */
export interface ExecutionLifecycle {
  id: string;
  revision: number;
  at: number;
  result: 'pending' | 'completed' | 'failed' | 'aborted';
  process: 'starting' | 'running' | 'draining' | 'stopping' | 'reclaiming' | 'reclaim_failed' | 'released';
  pid?: number;
  terminalAt?: number;
  stdoutClosedAt?: number;
  exitedAt?: number;
  stopRequestedAt?: number;
  message?: string;
}

export function executionIsGenerating(state?: ExecutionLifecycle): boolean {
  return !state || state.result === 'pending' && (state.process === 'starting' || state.process === 'running');
}
