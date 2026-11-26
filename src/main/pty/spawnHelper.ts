import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { toUnpackedAsarPath } from '../asarPaths';

interface InstalledHelper { file: string; packaged: boolean }
let installed: InstalledHelper | undefined;

function activeHelper(): InstalledHelper {
  if (installed) return installed;
  const req = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  // Match the loaded binding itself: a later install can change which candidate a new lookup would find.
  const { native } = req('node-pty') as { native: object };
  const binding = Object.values(req.cache).find(mod => mod && mod.exports === native && path.basename(mod.filename) === 'pty.node');
  if (!binding) throw new Error('Cannot locate the loaded node-pty binding');
  const file = toUnpackedAsarPath(path.join(path.dirname(binding.filename), 'spawn-helper'));
  installed = { file, packaged: req('electron').app.isPackaged };
  return installed;
}

/** Check before entering native PtyFork: its failure can terminate the entire Electron process. */
export function preparePtySpawnHelper(
  platform = process.platform,
  inElectronMain = process.type === 'browser',
  resolveHelper = activeHelper
): void {
  if (platform !== 'darwin' || !inElectronMain) return;
  let helper: InstalledHelper | undefined;
  try {
    helper = resolveHelper();
    const stat = fs.lstatSync(helper.file);
    if (!stat.isFile()) throw new Error('spawn-helper must be a regular file');
    // npm's macOS prebuild can ship with mode 0644. Never change a packaged application.
    if (!helper.packaged && !(stat.mode & 0o111)) fs.chmodSync(helper.file, (stat.mode & 0o777) | 0o111);
    fs.accessSync(helper.file, fs.constants.X_OK);
  } catch (cause) {
    const repair = helper?.packaged ? '请重新安装集序。' : '请检查工作台依赖并重新安装或构建 node-pty。';
    throw new Error(`无法启动 macOS 终端，辅助程序不可用${helper ? '（' + helper.file + '）' : ''}。${repair}`, { cause });
  }
}
