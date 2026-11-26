/** Explicitly opted-in read-only check against the configured GitLab project. */
import { app, BrowserWindow, safeStorage } from 'electron';
import path from 'node:path';
import { createFeedbackService } from '../../src/main/feedback/wiring';
import type { AppContext } from '../../src/main/context';

const profile = process.env.MUSTER_FEEDBACK_LIVE_PROFILE!;
app.setPath('userData', profile);
void app.whenReady().then(async () => {
  let win: BrowserWindow;
  const ctx = { getWindow: () => win } as unknown as AppContext;
  const service = createFeedbackService(ctx);
  (globalThis as any).__feedbackLive = {
    check: async () => {
      const status = await ctx.feedbackCredentials!.status();
      let history = await service.history('live-test');
      const remoteAvailable = history.remoteAvailable;
      let historyCount = history.items.length;
      while (history.hasMore) { history = await service.history('live-test', history.checkId); historyCount += history.items.length; }
      const proposal = await service.proposeChecked([{ kind: 'bug', title: 'MetaAgent feedback read-only connectivity check', area: 'test',
        context: 'read-only verification', actual: 'test observation', expected: 'test expectation', steps: 'test step', impact: 'test impact', evidence: '', suggestion: '' }], 'test', 'live-test', history.checkId);
      const review = await service.prepare(proposal[0]!.id, 1);
      return { configured: status.configured, remoteAvailable, historyCount, matches: review.matches.length, nativeEncryption: safeStorage.isEncryptionAvailable() };
    }
  };
  win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await win.loadURL('data:text/html,feedback-live-check');
});
