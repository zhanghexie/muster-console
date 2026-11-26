import fs from 'node:fs';
import path from 'node:path';

/** Resolve the existing packaged guardian without depending on a driver module. */
export function resolveWindowsJobAsset(fromDir: string): string {
  const file = 'windows-job.ps1';
  const candidates = [
    path.join(fromDir, '..', 'drivers', 'codex', 'worker', file),
    path.join(fromDir, '..', 'codex', 'worker', file),
    path.join(fromDir, 'worker', file),
    path.join(fromDir, '..', 'agentSession', 'drivers', 'codex', 'worker', file),
    path.join(fromDir, 'agentSession', 'drivers', 'codex', 'worker', file)
  ].map(candidate => candidate.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'));
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Windows 进程守护文件，请重新构建或重新安装工作台');
  return found;
}
