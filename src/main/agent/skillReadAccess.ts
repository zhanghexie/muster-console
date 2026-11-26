import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../pathKey';

/** The resource loader publishes this identity only after discovery and usage filtering. */
export interface ReadableSkill {
  filePath: string;
  baseDir: string;
  musterSkill?: { physicalFilePath?: string };
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Read only the discovered physical package, checking its published identity on every call. */
export function canReadDiscoveredSkill(candidate: string, skills: readonly ReadableSkill[]): boolean {
  let physical: string;
  try { physical = pathKey(fs.realpathSync.native(candidate)); }
  catch { return false; }
  return skills.some(skill => {
    try {
      const expected = skill.musterSkill?.physicalFilePath;
      if (!expected || pathKey(fs.realpathSync.native(skill.filePath)) !== pathKey(expected)) return false;
      const root = path.dirname(expected);
      if (pathKey(fs.realpathSync.native(skill.baseDir)) !== pathKey(root)) return false;
      // Discovery deduplicates physical packages. An equivalent path may therefore
      // have no published lexical alias; its resolved target defines the read scope.
      return inside(physical, root);
    } catch { return false; }
  });
}
