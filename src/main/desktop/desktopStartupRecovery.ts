export interface DesktopInitializationHost {
  close(): Promise<void>;
}

export interface DesktopInitializationResumeState {
  cleanRun(): void;
  close(): void;
}

/**
 * Reclaim the desktop host after construction failed.
 *
 * A host that was never constructed cannot own any backend, so its durable
 * run marker is safe to clean. If host cleanup is not confirmed, keep the
 * marker dirty and let the next process recover it conservatively.
 */
export async function recoverDesktopInitializationFailure(
  host: DesktopInitializationHost | undefined,
  resumeState: DesktopInitializationResumeState | undefined,
  report: (stage: string, error: unknown) => void,
): Promise<{ resumeStateClosed: boolean }> {
  let cleanupConfirmed = !host;
  if (host) {
    try {
      await host.close();
      cleanupConfirmed = true;
    } catch (error) {
      report('initialization cleanup is unconfirmed', error);
    }
  }

  if (!cleanupConfirmed || !resumeState) return { resumeStateClosed: false };

  try {
    resumeState.cleanRun();
  } catch (error) {
    // The backend is already known to be closed, but a persistence failure
    // must leave the marker dirty for a later recovery attempt.
    report('initialization run cleanup failed', error);
  }
  try {
    resumeState.close();
    return { resumeStateClosed: true };
  } catch (error) {
    report('initialization ledger close failed', error);
    return { resumeStateClosed: false };
  }
}
