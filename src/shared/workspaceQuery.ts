import { scoreFuzzyPath } from './fuzzyPathMatch';
import type { WorkspaceFileEntry } from './types';

/** 各根内部按匹配度排序，再交错取候选；同名路径保留各自身份。 */
export function rankWorkspaceFiles<T extends WorkspaceFileEntry>(files: readonly T[], query: string, limit: number): T[] {
  const groups = new Map<string, Array<{ file: T; score: number }>>();
  for (const file of files) {
    const key = file.fileRef?.rootId ?? '';
    const group = groups.get(key) ?? [];
    groups.set(key, group);
    const score = scoreFuzzyPath(file.path, query);
    if (score >= 0) group.push({ file, score });
  }
  for (const values of groups.values()) values.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const result: T[] = [];
  for (let row = 0; result.length < limit && [...groups.values()].some(values => row < values.length); row++) {
    for (const values of groups.values()) if (row < values.length && result.length < limit) result.push(values[row].file);
  }
  return result;
}
