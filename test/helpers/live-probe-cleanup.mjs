import { setTimeout as delay } from 'node:timers/promises';
import { removeWorkspaceFixture } from './workspace-fixture.mjs';

/** Retry only transient cleanup failures, retaining workspace-fixture path checks. */
export async function removeLiveProbeFixture(target, remove = removeWorkspaceFixture, wait = delay, prefix = 'codex-live-delivery-') {
  if (!['codex-live-delivery-', 'codex-live-image-'].includes(prefix)) throw new Error('Unexpected live probe fixture prefix');
  for (let attempt = 0; ; attempt++) {
    try {
      remove(target, prefix);
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await wait((attempt + 1) * 100);
    }
  }
}

/** A cleanup failure must never hide the original probe failure. */
export async function runWithProbeCleanup(run, cleanup, report = error => console.error('Probe cleanup failed:', error)) {
  let failed = false;
  try { return await run(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) {
      if (!failed) throw error;
      report(error);
    }
  }
}
