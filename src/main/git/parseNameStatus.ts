import type { GitCommitFile } from '../../shared/types';

/** 解析 `git … --name-status -z` 输出（NUL 分隔） */
export function parseNameStatusZ(raw: string): GitCommitFile[] {
  const parts = String(raw || '')
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const statusRaw = parts[i++];
    if (!statusRaw) break;
    const code = statusRaw[0] ?? 'M';
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++] ?? '';
      const path = parts[i++] ?? '';
      if (path) {
        files.push({
          path: path.replace(/\\/g, '/'),
          status: code,
          oldPath: oldPath.replace(/\\/g, '/') || undefined
        });
      }
    } else {
      const path = parts[i++] ?? '';
      if (path) files.push({ path: path.replace(/\\/g, '/'), status: code });
    }
  }
  return files;
}
