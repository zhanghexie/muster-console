export const MAX_BANG_TOKENS = 500;

/**
 * 唯一的 URL 识别正则（终端扫描 / 划词 / 会话链接化共用，勿在别处复制）。
 * - 左边界：前一字符不能是单词/scheme 组成字符（防 `xhttps://` 半截匹配）；
 *   CJK、全角标点都是合法边界（`详见https://…` 无空格也能匹配）。
 * - 主体：排除空白、引号、尖括号、方/花括号与全角标点；半角圆括号允许进入
 *   （wiki 风格 `函数_(数学)`），由 trimUrlNoise 做尾部配平修剪。
 */
export const URL_RE =
  /(?<=^|[^\w+.-])https?:\/\/[^\s<>"'`{}\[\]，。；：？！、“”‘’《》〈〉「」『』【】（）]+/gi;

/** URL 尾部修剪：去尾标点；闭括号多于开括号时退掉多余的 `)` */
export function trimUrlNoise(u: string): string {
  let s = u.replace(/[.,;:!?]+$/, '');
  for (;;) {
    if (!/\)$/.test(s)) break;
    const opens = (s.match(/\(/g) ?? []).length;
    const closes = (s.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    s = s.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return s;
}

export interface UrlEntity {
  text: string;
  start: number;
  end: number;
}

export function detectUrlEntities(text: string): UrlEntity[] {
  const out: UrlEntity[] = [];
  URL_RE.lastIndex = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index == null) continue;
    const trimmed = trimUrlNoise(m[0]);
    if (!/^https?:\/\//i.test(trimmed)) continue;
    out.push({ text: trimmed, start: m.index, end: m.index + trimmed.length });
  }
  return out;
}

/** 路径主体的硬停字符（含空白、半角/全角括号、引号、全角标点） */
/** 路径主体的硬停字符（含空白、半角/全角括号、引号、全角标点；半角 `:` 停——path:line 归 loc） */
const STOP_CHARS = /[\s<>"'`(){}\[\]:，。；：？！、“”‘’《》〈〉「」『』【】（）]/;
/** UNC 停字符集：`:` 放行（`\\?\C:\…` 盘符冒号） */
const STOP_CHARS_UNC = /[\s<>"'`{}\[\]，。；：？！、“”‘’《》〈〉「」』【】（）]/;

function scanToStop(text: string, from: number, stopRe: RegExp = STOP_CHARS): number {
  let i = from;
  while (i < text.length && !stopRe.test(text[i]!)) i++;
  return i;
}
/** 非 ASCII 且非全角标点（CJK 字符可进「宽松段」）；箭头/数学符号区排除——
 *  `zip→slideN.xml`、`a≥b` 这类符号连接的词不是路径（2026-09-11 会话误识别修复） */
const NON_ASCII_OK =
  '[^\\x00-\\x7f\\u2190-\\u21ff\\u2200-\\u22ff，。；：？！、“”‘’《》〈〉「」』【】（）]';
/** 左边界：任何非路径组成字符（CJK、`：:|*` 等都是合法边界） */
const BOUND = String.raw`(?<=^|[^A-Za-z0-9_.\-/\\@~+])`;
/** ASCII 路径段（含点开头的隐藏段；@/~/+ 允许出现在段内） */
const SEG = '[\\w.@~+-]+';
/** 宽松段：ASCII 段字符 + CJK 等非 ASCII（须配合「末段带扩展名/尾分隔符」约束） */
const SEG_LOOSE = `(?:[\\w.@~+-]|${NON_ASCII_OK})+`;

/** Unix 根路径 */
const UNIX_PATH_RE = new RegExp(`${BOUND}\\/${SEG}(?:\\/${SEG})*`, 'g');
/** 相对路径（ASCII 段，保守主通道）：./x、../x、src/foo.ts、docs/、logs\a.log */
const REL_PATH_RE = new RegExp(
  BOUND +
    String.raw`(?![A-Za-z]:)(?!\/)(?:(?:\.{1,2}[\\/])+(?:${SEG}(?:[\\/]${SEG})*[\\/]?)|${SEG}(?:[\\/]${SEG})+[\\/]?|${SEG}[\\/])`,
  'g'
);
/** 含 CJK 段的相对路径（仅当末段带扩展名或候选尾分隔符时采纳，防 `他/她都行` 散文误报） */
const REL_PATH_CJK_RE = new RegExp(
  BOUND + String.raw`(?![A-Za-z]:)(?!\/)(?:\.{1,2}[\\/])?${SEG_LOOSE}(?:[\\/]${SEG_LOOSE})+`,
  'gu'
);
/** 裸文件名（须带字母开头的扩展名）+ 无扩展名常用构建文件白名单；排除纯数字版本号 */
const BARE_NAMES =
  'Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Jenkinsfile|Vagrantfile|Justfile|Taskfile|LICENSE|CHANGELOG|README|NOTICE|CONTRIBUTING|AUTHORS';
const FILE_NAME_RE = new RegExp(
  BOUND +
    String.raw`(?!\d+(?:\.\d+)+\b)((?:\.[A-Za-z][\w-]{0,30}|[\w.-][\w.@~+-]*\.[A-Za-z][\w-]{0,24})\b|${BARE_NAMES})`,
  'g'
);
/** 含 CJK 的裸文件名（如 `会议纪要.md`；扩展名仍须 ASCII 字母开头） */
const FILE_NAME_CJK_RE = new RegExp(
  BOUND + String.raw`(?![A-Za-z]:)(?:[\w.@~+-]|${NON_ASCII_OK})+\.[A-Za-z][\w-]{0,24}`,
  'gu'
);

/** 常见 TLD：裸域名护栏用（`registry.npmjs.org/@scope/pkg` 不当路径） */
const TLD_SET = new Set(
  'com|org|net|io|dev|cn|ai|app|co|me|info|xyz|top|site|online|tech|cc|tv|pro|biz|edu|gov|sh|so|im|fm|gg|cloud|live|news|wiki|team|code|run|link|zip|mov|pub|us|uk|jp|de|fr|ru|kr|hk|tw|sg|in|au|ca|br|es|it|nl|se|ch'.split(
    '|'
  )
);

export function trimPathNoise(p: string): string {
  let s = p
    .replace(/[（(][^）)]*$/u, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/[，。；：？！、“”‘’《》〈〉「」』【】）]+$/u, '');
  // 尾部 CJK 连续段：前面是 ASCII 字母数字时视为粘连正文，退掉（`…b.md里修改` → `…b.md`）；
  // 跟在分隔符后的 CJK 目录名（`E:\项目`）不受影响
  const cjk = /[^\x00-\x7f]+$/.exec(s);
  if (cjk && cjk.index > 0 && /[A-Za-z0-9]$/.test(s.slice(0, cjk.index))) {
    s = s.slice(0, cjk.index).replace(/[._-]+$/, '');
  }
  return s;
}

/** 仅 ./、../、.../ 等，不算有效路径 */
export function isTrivialRelPath(p: string): boolean {
  return /^(?:\.{1,2}[\\/]*)+$/.test(p.trim());
}

/** 裸文件名启发式（带扩展名） */
export function looksLikeFileName(text: string): boolean {
  const t = text.trim();
  if (!t || /[\\/]/.test(t) || /^[A-Za-z]:/.test(t)) return false;
  if (/^\d+(?:\.\d+)+$/.test(t)) return false;
  return /^(?:\.[A-Za-z][\w-]{0,30}|[\w-][\w.-]*\.[A-Za-z][\w-]{0,24})$/.test(t);
}

export function buildSearchUrl(text: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

export function detectFirstUrl(text: string): string | null {
  const m = detectUrlEntities(text)[0];
  return m ? m.text : null;
}

export type PathEntityKind = 'file' | 'dir';

export interface PathEntity {
  kind: PathEntityKind;
  text: string;
  start: number;
  end: number;
}

function classifyKind(text: string): PathEntityKind {
  return /[\\/]$/.test(text) ? 'dir' : 'file';
}

function pushEntity(out: PathEntity[], text: string, start: number): void {
  out.push({ kind: classifyKind(text), text, start, end: start + text.length });
}

function matchPathRe(re: RegExp, text: string, guard?: (p: string) => boolean): PathEntity[] {
  const out: PathEntity[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m.index == null) continue;
    const cand = trimPathNoise(m[0]);
    if (cand && (!guard || guard(cand))) pushEntity(out, cand, m.index);
  }
  return out;
}

/** Unix 候选末段约束：单段无扩展名的 `/word` 多为散文斜杠组合（`本仓/pi`、`页数/token`、
 *  `文本/Markdown`），不产候选；放行多段（`/etc/hosts`）、尾分隔符（`/var/log/`）、
 *  末段带扩展名与点开头（`/.bashrc`）。相对路径通道不设此约束——`src/utils` 这类
 *  无扩展名真实目录靠消费方 stat 把关，语法层收紧会误杀。 */
function unixTailOk(p: string): boolean {
  if (p.endsWith('/')) return true;
  const segs = p.split('/').filter(Boolean);
  if (segs.length >= 2) return true;
  const last = segs[segs.length - 1] ?? '';
  return last.startsWith('.') || /^[^.]+\.[A-Za-z][\w-]{0,24}$/.test(last);
}

/** Windows 盘符路径与 UNC：程序化扫描——引号感知（成对引号内整段捕获，支持空格）+ 全角标点截断 */
function scanWindowsUncPaths(text: string): PathEntity[] {
  const out: PathEntity[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const inSpan = (i: number): boolean => spans.some((s) => i >= s.start && i < s.end);
  // UNC：\\server\share、\\wsl$\…、\\?\C:\…（前贴路径字符的不是独立 UNC）
  for (const m of text.matchAll(/\\\\/g)) {
    const start = m.index;
    if (inSpan(start)) continue;
    if (start > 0 && /[A-Za-z0-9_.\-/\\@~+]/.test(text[start - 1]!)) continue;
    const end = scanToStop(text, start, STOP_CHARS_UNC);
    const cand = trimPathNoise(text.slice(start, end));
    if (cand.length > 2) {
      pushEntity(out, cand, start);
      spans.push({ start, end: start + cand.length });
    }
  }
  // 盘符（扫描跳过 `E:\` 前缀——前缀里的 `:` 本身是停字符）
  for (const m of text.matchAll(/[A-Za-z]:[\\/]/g)) {
    const start = m.index;
    if (inSpan(start)) continue;
    const quote =
      start > 0 && (text[start - 1] === "'" || text[start - 1] === '"')
        ? text[start - 1]!
        : null;
    let end: number;
    if (quote != null) {
      const close = text.indexOf(quote, start);
      end = close === -1 ? scanToStop(text, start + m[0].length) : close;
    } else {
      end = scanToStop(text, start + m[0].length);
    }
    const cand = trimPathNoise(text.slice(start, end));
    if (cand.length > 3) {
      pushEntity(out, cand, start);
      spans.push({ start, end: start + cand.length });
    }
  }
  return out;
}

function looksLikeDomainFirstSeg(seg: string): boolean {
  const labels = seg.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[A-Za-z0-9-]+$/.test(l))) return false;
  return TLD_SET.has((labels[labels.length - 1] ?? '').toLowerCase());
}

/** 裸域名护栏：`registry.npmjs.org/@scope/pkg`、`registry.npmjs.org` 不当路径/文件 */
function domainGuard(e: PathEntity): boolean {
  if (e.text.includes('\\')) return true;
  if (!e.text.includes('/')) {
    return !looksLikeDomainFirstSeg(e.text);
  }
  const segs = e.text.split('/');
  if (segs.length < 2) return true;
  const first = segs[0]!;
  const last = segs[segs.length - 1] ?? '';
  if (!looksLikeDomainFirstSeg(first)) return true;
  if (last === '' || last.includes('.')) return true;
  return false;
}

/** 宽松（含 CJK）候选的末段约束：带扩展名，或候选以分隔符结尾 */
function hasFileTail(p: string): boolean {
  if (/[\\/]$/.test(p)) return true;
  const segs = p.split(/[\\/]/);
  const last = segs[segs.length - 1] ?? '';
  return last !== '' && /^.+\.[A-Za-z][\w-]{0,24}$/.test(last);
}

/**
 * 含 CJK 的相对路径：剥离前置 CJK 散文段（`已修改src/…` → `src/…`、`看文档/src/app.ts`
 * → `src/app.ts`）。剥后余下仍须有分隔符结构，否则视作真 CJK 目录段（`文档/会议纪要.md`）。
 */
function matchCjkRel(text: string): PathEntity[] {
  const out: PathEntity[] = [];
  REL_PATH_CJK_RE.lastIndex = 0;
  for (const m of text.matchAll(REL_PATH_CJK_RE)) {
    if (m.index == null) continue;
    let cand = trimPathNoise(m[0]);
    let cut = 0; // 前置散文段长度（含紧跟的分隔符）
    for (;;) {
      const run = /^[^\x00-\x7f]+/.exec(cand);
      if (!run) break;
      const rest = cand.slice(run[0].length);
      const restSep = /^[\\/]+/.exec(rest)?.[0] ?? '';
      const restNorm = rest.slice(restSep.length);
      if (!restNorm || !/[\\/]/.test(restNorm)) break;
      cand = restNorm;
      cut += run[0].length + restSep.length;
    }
    if (!cand || !hasFileTail(cand)) continue;
    pushEntity(out, cand, m.index + cut);
  }
  return out;
}

/** 含 CJK 的裸文件名：剥离前置 CJK 散文段（`已修改App.tsx` → `App.tsx`，剥后纯 ASCII 则跳过） */
function matchCjkFileName(text: string): PathEntity[] {
  const out: PathEntity[] = [];
  FILE_NAME_CJK_RE.lastIndex = 0;
  for (const m of text.matchAll(FILE_NAME_CJK_RE)) {
    if (m.index == null) continue;
    let cand = trimPathNoise(m[0]);
    let cut = 0;
    const run = /^[^\x00-\x7f]+/.exec(cand);
    if (run) {
      const rest = cand.slice(run[0].length);
      if (rest && /^[A-Za-z0-9_]/.test(rest)) {
        cand = rest;
        cut = run[0].length;
      }
    }
    if (!cand || !/[^\x00-\x7f]/.test(cand)) continue;
    pushEntity(out, cand, m.index + cut);
  }
  return out;
}

/**
 * 文本中的路径实体（保守：空白处截断，引号包裹时空格整段捕获）。含空格的未引号
 * 路径由调用方用 greedyPathTextAt + pathStatVariants 做 stat 回退。URL 区间内的
 * 路径候选自动丢弃（选中 URL 不再出「资源管理器/预览」假按钮）。
 */
export function detectPathEntities(text: string): PathEntity[] {
  const urlSpans = detectUrlEntities(text).map((u) => ({ start: u.start, end: u.end }));
  const overlapsUrl = (e: PathEntity): boolean =>
    urlSpans.some((s) => e.start < s.end && s.start < e.end);

  const raw: PathEntity[] = [
    ...scanWindowsUncPaths(text),
    ...matchPathRe(UNIX_PATH_RE, text, unixTailOk),
    ...matchPathRe(REL_PATH_RE, text),
    ...matchCjkRel(text),
    ...matchPathRe(FILE_NAME_RE, text),
    ...matchCjkFileName(text)
  ];

  const kept = raw.filter((e) => !overlapsUrl(e) && !isTrivialRelPath(e.text) && domainGuard(e));
  kept.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: PathEntity[] = [];
  let cover = -1;
  for (const e of kept) {
    if (e.start < cover) continue;
    out.push(e);
    cover = e.end;
  }
  return out;
}

export function detectPathCandidates(text: string): string[] {
  return [...new Set(detectPathEntities(text).map((e) => e.text))];
}

/** 多候选时取最长（避免 `.cursor/skills/.../SKILL.md` 被截成 `.cursor`） */
export function primaryPathCandidate(text: string): string | null {
  const cands = detectPathCandidates(text);
  if (cands.length === 0) return null;
  return cands.reduce((best, p) => (p.length > best.length ? p : best));
}

export interface LocEntity {
  text: string;
  pathText: string;
  line: number;
  col?: number;
  start: number;
  end: number;
}

/** path:line[:col]：路径实体 + 行号后缀探测（URL 区间内不产 loc） */
export function detectLocEntities(text: string): LocEntity[] {
  const out: LocEntity[] = [];
  for (const p of detectPathEntities(text)) {
    const rest = /^:(\d+)(?::(\d+))?/.exec(text.slice(p.end));
    if (!rest) continue;
    const line = Number(rest[1]);
    if (!Number.isFinite(line) || line < 1) continue;
    const colRaw = rest[2] != null ? Number(rest[2]) : undefined;
    const col = colRaw != null && Number.isFinite(colRaw) && colRaw >= 1 ? colRaw : undefined;
    out.push({
      text: text.slice(p.start, p.end + rest[0].length),
      pathText: p.text,
      line,
      col,
      start: p.start,
      end: p.end + rest[0].length
    });
  }
  return out;
}

/** 绝对路径（盘符/UNC）才值得跨空格贪心扩展；相对路径贪心吞句子风险大 */
export function isGreedyEligible(text: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\');
}

/** 从保守候选起向右跨空格贪心扩展（引号/括号/全角标点停），尾部经 trimPathNoise 自清理 */
export function greedyPathTextAt(
  text: string,
  start: number,
  end: number
): { text: string; end: number } {
  let i = end;
  for (;;) {
    const rest = text.slice(i);
    const m = /^[ \t]+[^\s<>"'`(){}\[\]，。；：？！、“”‘’《》〈〉「」』【】（）]+/.exec(rest);
    if (!m) break;
    i += m[0].length;
  }
  const cand = trimPathNoise(text.slice(start, i));
  return { text: cand, end: start + cand.length };
}

/** 含空格路径的 stat 变体链（最长优先）：逐空格截断前缀，回填时取最长存在者 */
export function pathStatVariants(p: string): string[] {
  if (!p.includes(' ')) return [p];
  const parts = p.split(' ');
  const out: string[] = [];
  for (let i = parts.length; i >= 1; i--) {
    const v = trimPathNoise(parts.slice(0, i).join(' '));
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : [p];
}

const LOCALHOST_URL_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/(.*))?$/i;

/** 是否 localhost 家族的 http(s) URL（聊天链接路由用） */
export function isLocalhostHttpUrl(url: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(url);
}

/** dev/预览服务器 URL → 本地文件候选：`http://localhost:5188/docs/a.md` → `<cwd>\docs\a.md` */
export function localFileFromUrl(url: string, cwd?: string): string | null {
  const m = LOCALHOST_URL_RE.exec(url.split(/[?#]/)[0] ?? '');
  if (!m) return null;
  const raw = m[1];
  if (!raw) return null;
  let pathText: string;
  try {
    pathText = decodeURIComponent(raw);
  } catch {
    pathText = raw;
  }
  return resolvePathCandidate(pathText, cwd);
}

/** 选区/词块拼出的路径若可预览（非目录尾斜杠），返回绝对路径与可选行列 */
export function firstPreviewablePath(
  text: string,
  cwd?: string
): { absPath: string; line?: number; col?: number } | null {
  const t = text.trim();
  if (!t) return null;
  const loc = /^(.+?):(\d+)(?::(\d+))?$/.exec(t);
  if (loc) {
    const pathText = loc[1]!;
    const hasSep = /[\\/]/.test(pathText) || /^[A-Za-z]:/.test(pathText);
    if (hasSep || looksLikeFileName(pathText)) {
      const line = Number(loc[2]);
      const colRaw = loc[3] != null ? Number(loc[3]) : undefined;
      if (Number.isFinite(line) && line >= 1) {
        const abs = resolvePathCandidate(pathText, cwd);
        if (abs) {
          const col =
            colRaw != null && Number.isFinite(colRaw) && colRaw >= 1 ? colRaw : undefined;
          return { absPath: abs, line, col };
        }
      }
    }
  }
  // localhost 家族 URL：映射为本地文件（点击时 stat，失败提示改用「打开链接」）
  const url = detectFirstUrl(t);
  if (url) {
    const local = localFileFromUrl(url, cwd);
    if (local && !/[\\/]$/.test(local)) return { absPath: local };
  }
  const raw = primaryPathCandidate(t);
  if (!raw || /[\\/]$/.test(raw)) return null;
  const abs = resolvePathCandidate(raw, cwd);
  if (!abs) return null;
  return { absPath: abs };
}

/** 单段文本是否像路径（含相对），用于词块样式等 */
export function looksLikePath(text: string): boolean {
  return detectPathCandidates(text.trim()).length > 0;
}

/** 相对路径用 cwd 拼接；已是绝对路径则原样（主进程再 path.normalize） */
export function resolvePathCandidate(raw: string, cwd?: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  // 模型偶尔把 Unix 根斜杠加在 Windows 绝对盘符前；只修正明确盘符形态。
  if (/^\/[A-Za-z]:[\\/]/.test(t)) return t.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\')) return t;
  // Git Bash：/e/Projects/x → E:\Projects\x（单字母盘符）
  const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(t.replace(/\\/g, '/'));
  if (msys) {
    const rest = (msys[2] ?? '').replace(/\//g, '\\');
    return rest ? `${msys[1]!.toUpperCase()}:\\${rest}` : `${msys[1]!.toUpperCase()}:\\`;
  }
  if (t.startsWith('/')) return t;
  if (!cwd) return null;
  const sep = cwd.includes('\\') || /^[A-Za-z]:/.test(cwd) ? '\\' : '/';
  const base = cwd.replace(/[\\/]+$/, '');
  const trail = /[\\/]$/.test(t) ? sep : '';
  const body = t.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  return `${base}${sep}${body.replace(/\//g, sep)}${trail}`;
}

function fallbackTokenize(s: string): string[] {
  return s.match(/[\u4e00-\u9fff]+|[A-Za-z0-9_./-]+|[^\s]/g) ?? [];
}

function segmentWords(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Seg !== 'function') return fallbackTokenize(s);
  try {
    const seg = new Seg(undefined, { granularity: 'word' });
    const out: string[] = [];
    for (const part of seg.segment(s)) {
      if (part.isWordLike || /[^\s]/.test(part.segment)) {
        const t = part.segment;
        if (t.trim()) out.push(t);
      }
    }
    return out.length ? out : fallbackTokenize(s);
  } catch {
    return fallbackTokenize(s);
  }
}

/** 先挖出 URL/路径占位，再对其余分段，最后按原文顺序还原 */
export function tokenizeForBang(text: string): string[] {
  type Hole = { start: number; end: number; value: string };
  const holes: Hole[] = [
    ...detectUrlEntities(text).map((u) => ({ start: u.start, end: u.end, value: u.text })),
    ...detectPathEntities(text).map((p) => ({ start: p.start, end: p.end, value: p.text }))
  ];
  holes.sort((a, b) => a.start - b.start);
  const merged: Hole[] = [];
  for (const h of holes) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) continue;
    merged.push(h);
  }
  const tokens: string[] = [];
  let cursor = 0;
  for (const h of merged) {
    if (h.start > cursor) tokens.push(...segmentWords(text.slice(cursor, h.start)));
    tokens.push(h.value);
    cursor = h.end;
  }
  if (cursor < text.length) tokens.push(...segmentWords(text.slice(cursor)));
  return tokens.filter((t) => t.length > 0);
}

/** 英文词边界回填空格：仅两侧都是 ASCII 字母/数字时补（CJK 相邻、路径/URL/标点边界不动） */
function needsSpaceBetween(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

export function joinTokens(tokens: string[], pickedIndices: number[]): string {
  const picked = [...pickedIndices]
    .filter((i) => i >= 0 && i < tokens.length)
    .sort((a, b) => a - b)
    .map((i) => tokens[i]!);
  let out = '';
  for (const t of picked) {
    if (out && needsSpaceBetween(out, t)) out += ' ';
    out += t;
  }
  return out;
}

/** 爆炸用分词，超限时截断并标记 */
export function tokenizeForBangLimited(
  text: string,
  max = MAX_BANG_TOKENS
): { tokens: string[]; truncated: boolean; total: number } {
  const all = tokenizeForBang(text);
  if (all.length <= max) return { tokens: all, truncated: false, total: all.length };
  return { tokens: all.slice(0, max), truncated: true, total: all.length };
}
