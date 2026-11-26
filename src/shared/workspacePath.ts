import path from 'node:path';

/**
 * 将 candidate 解析为绝对路径，并断言落在 root 内；否则 throw。
 */
export function resolveInsideRoot(root: string, candidate: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, candidate);
  const rel = path.relative(absRoot, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('path outside workspace root');
  }
  return abs;
}

/** 相对 root 的 POSIX 路径；若在根上返回 '' */
export function toPosixRel(root: string, abs: string): string {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(abs);
  const rel = path.relative(absRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('path outside workspace root');
  }
  return rel.split(path.sep).join('/');
}
