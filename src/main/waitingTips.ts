import { userDataStorage } from './runtimeKernel/storageRootResolver';
import fs from 'node:fs';

import { parseWaitingTips, type WaitingTipsResult } from '../shared/waitingTips';

/** The editable userData file is the single runtime source. Seed once, never overwrite edits. */
export function readWaitingTips(userData: string, seedFile: string): WaitingTipsResult {
  const file = userDataStorage(userData).file('waiting-tips');
  try {
    fs.mkdirSync(userData, { recursive: true });
    if (!fs.existsSync(file)) {
      try { fs.copyFileSync(seedFile, file, fs.constants.COPYFILE_EXCL); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (fs.statSync(file).size > 256 * 1024) throw new Error('File exceeds 256 KiB');
    const tips = parseWaitingTips(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    return { ok: true, path: file, tips };
  } catch (error) {
    return { ok: false, path: file, error: error instanceof Error ? error.message : String(error) };
  }
}
