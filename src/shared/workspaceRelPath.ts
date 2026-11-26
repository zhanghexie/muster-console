export function normalizePathSlashes(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function tryRelativizeToRoot(root: string, absOrRel: string): string | null {
  const r = normalizePathSlashes(root.trim());
  let c = normalizePathSlashes(absOrRel.trim());
  if (!r || !c) return null;
  const isAbs = /^[A-Za-z]:\//.test(c) || c.startsWith('/') || c.startsWith('//');
  if (!isAbs) {
    return c.replace(/^\.\//, '');
  }
  const rKey = /^[A-Za-z]:\//.test(r) ? r.toLowerCase() : r;
  const cKey = /^[A-Za-z]:\//.test(c) ? c.toLowerCase() : c;
  const prefix = rKey.endsWith('/') ? rKey : rKey + '/';
  if (cKey === rKey) return '';
  if (!cKey.startsWith(prefix)) return null;
  // 用原 c 的切片保持文件名大小写
  const cut = c.slice(prefix.length);
  return cut;
}

/** 把工作区相对路径接到根上；分隔符跟 root 走（Windows `\` / POSIX `/`）。 */
export function joinUnderRoot(root: string, rel: string): string {
  const r = root.replace(/[/\\]+$/, '');
  const n = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const sep = root.includes('\\') ? '\\' : '/';
  return `${r}${sep}${n.split('/').join(sep)}`;
}

function normalizePosix(parts: string[]): string[] {
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out;
}

/**
 * 文档（md 预览等）里的相对链接按「当前文件所在目录」解析。
 * - currentPath 是工作区相对 posix 路径 → 返回工作区相对 posix 路径（`../` 越界按段保留，由 stat 兜底）
 * - currentPath 是绝对路径 → 返回同形态绝对路径（Windows 反斜杠）
 * - href 是 file:// URI → 转本地路径
 * - 非文件形态（http(s)/mailto 等 scheme、`#` 锚点、空）返回 null
 */
export function resolveDocLink(currentPath: string | null, href: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:\/\//i.test(raw)) return null;
  if (!currentPath) return null;

  let target = raw;
  if (/^file:\/\//i.test(target)) {
    target = target.replace(/^file:\/\/\/?/i, '');
    try {
      target = decodeURIComponent(target);
    } catch {
      /* 保留原样 */
    }
    target = target.replace(/\//g, currentPath.includes('\\') ? '\\' : '/');
    return target;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    /* 保留原样 */
  }
  target = target.replace(/\\/g, '/');

  const dir = currentPath.replace(/\\/g, '/');
  const isAbsCurrent = /^[A-Za-z]:\//.test(dir) || dir.startsWith('/');
  const dirParts = dir.split('/').slice(0, -1); // 去掉文件名
  const joined = normalizePosix([...dirParts, ...target.replace(/^\/+/, '').split('/')]);

  if (!isAbsCurrent) {
    return joined.join('/');
  }
  const posix = joined.join('/');
  if (/^[A-Za-z]:\//.test(dir)) {
    // Windows 盘符形态：段首是 `E:`；`..` 越过盘符会被 normalizePosix 保留为前导 ..，交 stat 兜底
    return posix.split('/').join('\\');
  }
  return `/${posix.replace(/^\/+/, '')}`;
}
