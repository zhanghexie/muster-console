import path from 'node:path';
import { pathKey as normalizePathKey } from '../shared/pathKey';

/** 主进程：先 resolve 再做大小写/分隔符归一。 */
export function pathKey(p: string): string {
  return normalizePathKey(path.resolve(p));
}
