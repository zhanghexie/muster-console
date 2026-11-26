/**
 * 嵌套仓发现的 .gitignore 过滤（gitignoreFilter）：
 * 主仓 .gitignore（含各级父目录 .gitignore 级联）命中的嵌套独立仓不入发现结果——
 * 参考项目克隆 / 开发沙箱（refs/、.dev-sandbox/ 等被主仓忽略的目录）曾被当嵌套仓
 * 收进隔离组与 UI 仓库列表，导致建树慢、仓库列表膨胀（2026-10-06 用户报）。
 *
 * 只按 .gitignore 文件匹配（仓根 + 各级父目录级联），**刻意不读**：
 * - `.git/info/exclude`：宿主建隔离组时会把各嵌套仓相对路径写进主仓
 *   `.git/info/exclude`（ensureNestedReposExclude，防容器 worktree 恒脏）——
 *   若过滤算上它，建过一次组之后所有正常嵌套仓会从发现结果里自我消失；
 * - 全局 excludesFile（core.excludesFile）：机器本地配置，与仓库语义无关。
 *
 * 等价实现而非 `git check-ignore`：check-ignore 无法排除 info/exclude 来源，
 * 且逐仓起 git 进程开销大（check-ignore --stdin 可批，但来源不可裁剪）。
 * gitignore(5) 语义子集：注释/转义/取反(!)/目录尾斜杠/锚定(**、含 / 模式)，
 * 「父目录被排除时子路径不可再取反救回」按 git 文档口径实现（父级命中即忽略）。
 *
 * 本模块无 electron 依赖；发现过滤层级见 GitRepoDiscoveryCache.scan 与
 * discoverNestedReposDetailed（两处共用 filterGitignoreExcludedRepos）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathKey } from '../pathKey';
import { isPathInsideWorkspace } from './scan';

export interface GitignoreRule {
  negated: boolean;
  /** 尾 `/` 模式只匹配目录；本过滤器只检查目录路径（仓与祖先目录），恒可命中 */
  dirOnly: boolean;
  /** 含 `/`（尾斜杠除外）→ 锚定到 .gitignore 所在目录；否则匹配任意深度的 basename */
  anchored: boolean;
  /** 全匹配正则（含 ^$）：anchored 对相对路径、非 anchored 对单段 basename */
  regex: RegExp;
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** 单段 glob → 正则源（* ? 字符类；`**` 由分段逻辑单独处理，进到这里的都是普通星） */
function segmentToRegExpSource(segment: string): string | null {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '\\') {
      const next = segment[i + 1];
      if (next === undefined) return null;
      out += escapeRegExp(next);
      i++;
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let classSrc = '';
      if (segment[j] === '!' || segment[j] === '^') {
        classSrc += '^';
        j++;
      }
      let closed = false;
      for (; j < segment.length; j++) {
        const cc = segment[j]!;
        if (cc === '\\') {
          if (j + 1 >= segment.length) break;
          classSrc += escapeRegExp(segment[j + 1]!);
          j++;
          continue;
        }
        if (cc === ']') {
          closed = true;
          break;
        }
        classSrc += cc;
      }
      if (!closed || !classSrc) {
        out += '\\[';
        continue;
      }
      out += `[${classSrc}]`;
      i = j;
      continue;
    }
    out += escapeRegExp(c);
  }
  return out || null;
}

/**
 * 多段模式 → 正则源。段级 `**` 的三种特型（gitignore(5)）：
 * - 首段 `**` 后随分隔符 → 任意深度（等价不锚定 basename）；
 * - 尾段 `**` 前有分隔符 → 目录内全部（不匹配目录自身）；
 * - 中段 `**` 前后都有分隔符 → 零或多层目录。
 * 其余连续星按普通星处理（gitignore 口径）。
 */
function patternToRegExpSource(pattern: string): string | null {
  const segments = pattern.split('/');
  let source = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    if (seg === '**') {
      if (isLast) source += i === 0 ? '.*' : '.+';
      else source += '(?:[^/]+/)*';
      continue;
    }
    const segSource = segmentToRegExpSource(seg);
    if (!segSource) return null;
    source += segSource;
    if (!isLast) source += '/';
  }
  return source || null;
}

/** 解析一段 .gitignore 文本（BOM 剥离；空行/注释跳过；尾随空白按未转义剥除） */
export function parseGitignoreRules(content: string, caseInsensitive = process.platform === 'win32'): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)[ \t]+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    if (!line) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.replace(/\/+$/, '');
    if (!line) continue;
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    if (!line) continue;
    const source = patternToRegExpSource(line);
    if (!source) continue;
    rules.push({ negated, dirOnly, anchored, regex: new RegExp(`^(?:${source})$`, caseInsensitive ? 'i' : '') });
  }
  return rules;
}

export interface GitignoreMatcher {
  /** repoRoot 内相对路径（posix 分隔）是否被 .gitignore 级联排除（目录语义） */
  excluded(repoRoot: string, relPath: string): Promise<boolean>;
}

/** 每次发现扫描一个实例：目录 → .gitignore 规则的读盘缓存（一次扫描内不重复读） */
export function createGitignoreMatcher(): GitignoreMatcher {
  const cache = new Map<string, GitignoreRule[] | null>();
  const loadRules = async (dir: string): Promise<GitignoreRule[] | null> => {
    const key = pathKey(dir);
    if (cache.has(key)) return cache.get(key)!;
    let rules: GitignoreRule[] | null = null;
    try {
      rules = parseGitignoreRules(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'));
    } catch {
      rules = null;
    }
    cache.set(key, rules);
    return rules;
  };
  return {
    async excluded(repoRoot, relPath) {
      const segments = relPath.split('/').filter(Boolean);
      if (!segments.length) return false;
      // 规则链：第 j 层 = repoRoot/seg[0..j-1] 目录下的 .gitignore（浅→深，后匹配胜）
      const ruleChains: GitignoreRule[][] = [];
      for (let j = 0; j < segments.length; j++) {
        const dir = j === 0 ? repoRoot : path.join(repoRoot, ...segments.slice(0, j));
        ruleChains.push((await loadRules(dir)) ?? []);
      }
      // 逐前缀层级判忽略：祖先目录被排除 → 整条路径忽略（git 取反救不回，文档口径）
      for (let k = 0; k < segments.length; k++) {
        const relFromRoot = segments.slice(0, k + 1);
        let matched: GitignoreRule | undefined;
        for (let j = 0; j <= k; j++) {
          const anchoredTarget = relFromRoot.slice(j).join('/');
          const basenameTarget = segments[k]!;
          for (const rule of ruleChains[j]!) {
            if (rule.regex.test(rule.anchored ? anchoredTarget : basenameTarget)) matched = rule;
          }
        }
        if (matched && !matched.negated) return true;
      }
      return false;
    }
  };
}

/**
 * 发现结果的 .gitignore 过滤层级（两条发现路径共用）：
 * 1. 扫描范围根自身永不过滤（源根/extras 是用户显式登记，登记即权威）；
 * 2. 嵌套仓只对「扫描范围内最近的包围仓」的 .gitignore 级联判定——包围仓在
 *    范围外（源根落在更外层仓的忽略目录里）时不判，用户登记优先于外仓忽略；
 * 3. 包围仓自身被过滤时其内部嵌套仓一并过滤（整个子树本就在忽略目录下）；
 * 4. 未命中的照常保留（正常嵌套仓隔离不受影响）。
 */
export async function filterGitignoreExcludedRepos(scopeRoot: string, repos: readonly string[]): Promise<string[]> {
  if (repos.length <= 1) return [...repos];
  const scope = path.resolve(scopeRoot);
  const ordered = [...new Map(repos.map(r => [pathKey(r), path.resolve(r)])).values()]
    .sort((a, b) => a.length - b.length);
  const dropped = new Set<string>();
  const matcher = createGitignoreMatcher();
  for (const repo of ordered) {
    const key = pathKey(repo);
    if (key === pathKey(scope)) continue;
    const nearest = ordered
      .filter(other => pathKey(other) !== key && isPathInsideWorkspace(repo, other))
      .sort((a, b) => b.length - a.length)[0];
    if (!nearest) continue;
    if (dropped.has(pathKey(nearest))) {
      dropped.add(key);
      continue;
    }
    const rel = path.relative(nearest, repo).replace(/\\/g, '/');
    if (await matcher.excluded(nearest, rel)) dropped.add(key);
  }
  return repos.filter(r => !dropped.has(pathKey(r)));
}
