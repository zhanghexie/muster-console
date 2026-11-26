export interface CenterSplitSelectionContext {
  workspaceId: string | null;
  utilityRevision: number;
}

export interface CenterSplitSelectionRequest extends CenterSplitSelectionContext {
  id: number;
  sessionId: string;
  deferReveal?: boolean;
}

/** Only the latest selection may dismiss the tool that was present when it began. */
export function createCenterSplitSelectionGuard() {
  let revision = 0;
  const inFlight = new Map<number, CenterSplitSelectionRequest>();
  const isCurrent = (request: CenterSplitSelectionRequest, context: CenterSplitSelectionContext): boolean =>
    request.id === revision && request.workspaceId === context.workspaceId &&
    request.utilityRevision === context.utilityRevision;
  return {
    begin(sessionId: string, context: CenterSplitSelectionContext, deferReveal = false): CenterSplitSelectionRequest {
      const request = { ...context, sessionId, id: ++revision, deferReveal };
      inFlight.set(request.id, request);
      return request;
    },
    invalidate(): void { revision++; },
    isCurrent,
    finish(request: CenterSplitSelectionRequest): void { inFlight.delete(request.id); },
    shouldDeferReveal(sessionId: string, context: CenterSplitSelectionContext): boolean {
      const own = [...inFlight.values()].filter(request => request.sessionId === sessionId).at(-1);
      return !!own?.deferReveal && isCurrent(own, context);
    },
    shouldHandleReveal(sessionId: string, context: CenterSplitSelectionContext): boolean {
      // Main sends reveal before resolving sessions.select. Unrelated native/replay
      // selections retain the ordinary App reveal path.
      const own = [...inFlight.values()].filter(request => request.sessionId === sessionId).at(-1);
      return !own || isCurrent(own, context);
    }
  };
}
