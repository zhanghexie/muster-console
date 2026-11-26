import path from 'node:path';
import fs from 'node:fs/promises';
import { EXTENSION_ID_RE } from '../../shared/extensions';

export function extensionTrialRoot(): string | undefined {
  const target = process.env.MUSTER_EXTENSION_TRIAL_ROOT;
  if (process.env.MUSTER_SANDBOX === '1' && target && path.isAbsolute(target) && path.basename(target).startsWith('muster-extension-trial-')) return target;
  return undefined;
}

export function extensionTrialTarget(): string | null {
  const id = process.env.MUSTER_EXTENSION_TRIAL_ID;
  return extensionTrialRoot() && id && EXTENSION_ID_RE.test(id) ? id : null;
}

export async function signalExtensionTrialWindow(): Promise<string | null> {
  const id = extensionTrialTarget(), root = extensionTrialRoot();
  if (id && root) await fs.writeFile(path.join(root, 'window-ready'), id);
  return id;
}
