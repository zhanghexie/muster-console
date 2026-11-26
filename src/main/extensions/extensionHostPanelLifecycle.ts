/**
 * Per-panel lifetime state shared by the panel bridge and long-running calls.
 *
 * Keeping the parent signal and stream cancellation here prevents individual
 * bridge branches from owning a second, detached lifetime.
 */
export class ExtensionHostPanelLifecycle {
  private readonly signals = new Map<string, AbortController>();
  private readonly streams = new Map<string, Map<string, AbortController>>();

  open(token: string): void {
    this.signals.set(token, new AbortController());
  }

  childSignal(token: string): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
    const parent = this.signals.get(token);
    if (!parent) throw new Error('Extension panel is closed');
    const controller = new AbortController();
    const abort = (): void => controller.abort(parent.signal.reason);
    if (parent.signal.aborted) abort();
    else parent.signal.addEventListener('abort', abort, { once: true });
    return {
      controller,
      signal: controller.signal,
      dispose: () => parent.signal.removeEventListener('abort', abort),
    };
  }

  parentSignal(token: string): AbortSignal {
    const signal = this.signals.get(token)?.signal;
    if (!signal) throw new Error('Extension panel is closed');
    return signal;
  }

  setStream(token: string, requestId: string, controller: AbortController): void {
    const streams = this.streams.get(token) ?? new Map<string, AbortController>();
    streams.set(requestId, controller);
    this.streams.set(token, streams);
  }

  stream(token: string, requestId: string): AbortController | undefined {
    return this.streams.get(token)?.get(requestId);
  }

  finishStream(token: string, requestId: string): void {
    const streams = this.streams.get(token);
    if (!streams) return;
    streams.delete(requestId);
    if (!streams.size) this.streams.delete(token);
  }

  reset(token: string): void {
    this.abort(token);
    this.open(token);
  }

  close(token: string): void {
    this.abort(token);
    this.signals.delete(token);
    this.streams.delete(token);
  }

  abort(token: string): void {
    this.signals.get(token)?.abort();
    for (const controller of this.streams.get(token)?.values() ?? []) controller.abort();
  }
}
