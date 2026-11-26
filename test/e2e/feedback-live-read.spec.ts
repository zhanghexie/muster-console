/** Opt-in: real GitLab read, real OS credential store, temporary Electron userData, no Issue creation. */
import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

test.skip(process.env.MUSTER_FEEDBACK_LIVE_READONLY !== '1', 'Requires a locally configured GitLab test credential and network.');
test('reads real GitLab after importing the existing credential into isolated system-encrypted storage', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-feedback-live-read-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const main = path.join(temp, 'main.cjs'), profile = path.join(temp, 'profile');
    fs.mkdirSync(profile);
    await build({ entryPoints: [path.join(root, 'test/fixtures/feedback-electron-live-read.ts')], outfile: main,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    const env: NodeJS.ProcessEnv = { ...process.env, MUSTER_FEEDBACK_LIVE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: createRequire(__filename)('electron') as string, args: [main], env: env as Record<string, string>, timeout: 30_000 });
    await application.firstWindow();
    const result = await application.evaluate(async () => (globalThis as any).__feedbackLive.check());
    expect(result.configured).toBe(true);
    expect(result.nativeEncryption).toBe(true);
    expect(result.remoteAvailable).toBe(true);
    expect(result.historyCount).toBeGreaterThanOrEqual(0);
    expect(result.matches).toBeGreaterThanOrEqual(0);
    expect(fs.readFileSync(path.join(profile, 'feedback', 'credential.json'), 'utf8')).not.toContain('glpat-');
  } finally {
    await application?.close();
    if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('ma-feedback-live-read-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
