/** hunk 键序列化（渲染层勾选状态与主进程 filterPatchByHunks 必须同格式） */
import type { GitAdoptHunkKey } from './types';

export function adoptHunkKeyId(k: GitAdoptHunkKey): string {
  return `${k.file}|${k.oldStart},${k.oldLines},${k.newStart},${k.newLines}`;
}
