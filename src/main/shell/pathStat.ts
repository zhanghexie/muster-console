import fs from 'node:fs/promises';
import path from 'node:path';

export type PathStatResult = {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
};

/** Git Bash / MSYS：/e/Projects/x → E:\Projects\x（仅 Windows） */
export function normalizeShellPath(absPath: string): string {
  const t = String(absPath ?? '').trim();
  if (!t) return t;
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(t.replace(/\\/g, '/'));
    if (m) {
      const rest = (m[2] ?? '').replace(/\//g, '\\');
      const win = rest ? `${m[1]!.toUpperCase()}:\\${rest}` : `${m[1]!.toUpperCase()}:\\`;
      return path.normalize(win);
    }
  }
  return path.normalize(t);
}

export async function statPath(absPath: string): Promise<PathStatResult> {
  const normalized = normalizeShellPath(absPath);
  if (!normalized) return { exists: false, isFile: false, isDirectory: false };
  try {
    const st = await fs.stat(normalized);
    return {
      exists: true,
      isFile: st.isFile(),
      isDirectory: st.isDirectory()
    };
  } catch {
    return { exists: false, isFile: false, isDirectory: false };
  }
}

/** 批量 stat；key 为调用方传入的原始路径字符串 */
export async function statPaths(
  absPaths: string[]
): Promise<Record<string, PathStatResult>> {
  const uniq = [...new Set(absPaths.map((p) => String(p ?? '').trim()).filter(Boolean))];
  const out: Record<string, PathStatResult> = {};
  await Promise.all(
    uniq.map(async (p) => {
      out[p] = await statPath(p);
    })
  );
  return out;
}
