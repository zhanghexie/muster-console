import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-startup-recovery-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { recoverDesktopInitializationFailure } = await import(pathToFileURL(compile('main/desktop/desktopStartupRecovery.ts')).href);

  const clean = [];
  const noHost = await recoverDesktopInitializationFailure(undefined, {
    cleanRun: () => clean.push('clean'), close: () => clean.push('close')
  }, () => {});
  assert.deepEqual(clean, ['clean', 'close'], 'a host that was never constructed must clear its dirty run marker');
  assert.deepEqual(noHost, { resumeStateClosed: true });

  const uncertain = [];
  const failedHost = await recoverDesktopInitializationFailure({ close: async () => { throw new Error('driver still running'); } }, {
    cleanRun: () => uncertain.push('clean'), close: () => uncertain.push('close')
  }, () => {});
  assert.deepEqual(uncertain, [], 'uncertain host cleanup must leave the resume ledger open and dirty');
  assert.deepEqual(failedHost, { resumeStateClosed: false });
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('desktop-startup-recovery: ok');
