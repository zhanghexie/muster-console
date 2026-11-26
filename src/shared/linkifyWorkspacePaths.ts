/**
 * 把助手 Markdown 里的工作区路径变成可点击链接（muster-file: 协议）。
 * 纯函数：不做磁盘探测、不做 cwd 解析（点击时由渲染层相对 session.cwd 解析并打开）。
 * 识别全部复用 terminalSelectionText（唯一正则源），此处只做 Markdown 结构保护与包装。
 * 二次校验：语法像路径 ≠ 真实文件（`PDF/DOCX/PPTX`、`Marker/pdftotext` 这类斜杠组合词
 * 也能过语法），调用方可传 exists（渲染前批量 stat 的结果）把不存在的候选拦下——
 * 聊天区的把关方是 ChatMarkdownBody；不传 exists 时保持纯语法通道（向后兼容）。
 */
import {
  URL_RE,
  detectLocEntities,
  detectPathEntities
} from './terminalSelectionText';

export const WORKSPACE_FILE_LINK_SCHEME = 'muster-file:';

/** 存在性过滤（调用方 stat 把关）：返回 false 的候选不包装成链接 */
export interface PathLinkFilter {
  exists?: (path: string) => boolean;
}

export interface WorkspacePathLink {
  raw: string;
  path: string;
  line?: number;
  col?: number;
  /** 候选在输入段中的起始下标（包装定位用；过滤后位置不变，勿用 indexOf 重找） */
  at: number;
}

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
/** 已存在的 markdown 链接 `[label](href)` 整段：标签与 href 内的候选都不再包装（幂等） */
const MD_LINK_RE = /\[[^\]]*\]\([^)]*\)/g;

/**
 * 候选起点前是否存在未闭合的 `[`（即候选落在某个 markdown 链接的 label 区间内）：
 * 向左扫描，`]` 计入闭合深度、`[` 消耗深度，深度 0 时遇 `[` 即未闭合。
 * href 是 http(s) URL 的链接 `[label](url)` 会被顶层 URL 保护段切断，MD_LINK_RE
 * 整段保护失效、label 暴露成可包装文本——再包一层会产出 `[[label](…)](url)`
 * 损坏嵌套（2026-09-11 评审 F-01，2026-10-26 吸收排修），故此类候选跳过包裹。
 * 成对方括号（`arr[0]`）不误伤：`[` 消耗了 `]` 的深度，不构成未闭合。
 */
function insideUnclosedBracket(segment: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = segment[i]!;
    if (c === ']') depth++;
    else if (c === '[') {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

/**
 * 在一段（无代码块/URL 的）纯文本里找可链接路径：path:line[:col] 优先，其次普通候选；
 * 返回互不重叠、按出现顺序排列。filter.exists 为 false 的候选（磁盘不存在）被丢弃。
 */
export function findWorkspacePathLinks(
  segment: string,
  filter?: PathLinkFilter
): WorkspacePathLink[] {
  const taken: Array<{ start: number; end: number }> = [];
  const links: Array<WorkspacePathLink> = [];
  const overlaps = (s: number, e: number): boolean =>
    taken.some((t) => s < t.end && e > t.start);

  // 已有 markdown 链接整段保护（label + href）：模型手写的 [x](src/a.ts) 保持原样由
  // 点击路由处理，自己生成的链接也由此保证幂等
  const mdLinkSpans: Array<{ start: number; end: number }> = [];
  for (const m of segment.matchAll(MD_LINK_RE)) {
    mdLinkSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  const inMdLink = (s: number, e: number): boolean =>
    mdLinkSpans.some((t) => s < t.end && t.start < e);

  for (const l of detectLocEntities(segment)) {
    if (filter?.exists && !filter.exists(l.pathText)) continue;
    if (inMdLink(l.start, l.end)) continue;
    if (insideUnclosedBracket(segment, l.start)) continue;
    if (overlaps(l.start, l.end)) continue;
    taken.push({ start: l.start, end: l.end });
    links.push({
      raw: segment.slice(l.start, l.end),
      path: l.pathText,
      line: l.line,
      col: l.col,
      at: l.start
    });
  }

  // 反引号不在路径候选的前缀类里；行内码里的路径（`src/foo.ts`）必须可点，
  // 用等长掩码（` → 空格）探测，索引与原文一一对应。
  // 命中两侧紧贴反引号时：把替换范围扩到含反引号并去之——否则链接落进 code span，
  // react-markdown 不解析其中的 markdown，会显示字面 `[x](href)` 源码（不可点）。
  const masked = segment.replaceAll('`', ' ');
  for (const p of detectPathEntities(masked)) {
    if (p.text.includes('%') || p.text.startsWith('muster-file')) continue; // 已链接化痕迹，勿重复包
    if (filter?.exists && !filter.exists(p.text)) continue;
    if (inMdLink(p.start, p.end)) continue;
    // label 区间内的候选跳过（反引号扩展分支同样覆盖：extStart 前邻是反引号，
    // 非括号字符，不影响下方以 p.start 为起点的深度扫描判定）
    if (insideUnclosedBracket(segment, p.start)) continue;
    if (overlaps(p.start, p.end)) continue;
    const tickBefore = p.start > 0 && segment[p.start - 1] === '`';
    const tickAfter = segment[p.end] === '`';
    // 成对反引号才算行内码包裹（单侧贴合的是别处的闭合反引号，如 href 尾部）
    if (tickBefore && tickAfter) {
      const extStart = p.start - 1;
      const extEnd = p.end + 1;
      if (overlaps(extStart, extEnd)) continue;
      taken.push({ start: extStart, end: extEnd });
      // raw 含反引号：包成 [`x`](href) —— code 样式保留在链接标签里，可点且幂等判断有据
      links.push({ raw: segment.slice(extStart, extEnd), path: p.text, at: extStart });
      continue;
    }
    taken.push({ start: p.start, end: p.end });
    links.push({ raw: segment.slice(p.start, p.end), path: p.text, at: p.start });
  }

  return links.sort((a, b) => a.at - b.at);
}

/** 构建 href：muster-file:<encodeURIComponent(path)>?line=N&col=M */
export function buildWorkspaceFileHref(path: string, line?: number, col?: number): string {
  const q = line ? `?line=${line}${col ? `&col=${col}` : ''}` : '';
  return `${WORKSPACE_FILE_LINK_SCHEME}${encodeURIComponent(path)}${q}`;
}

export function parseWorkspaceFileHref(
  href: string
): { path: string; line?: number; col?: number } | null {
  if (!href.startsWith(WORKSPACE_FILE_LINK_SCHEME)) return null;
  try {
    const rest = href.slice(WORKSPACE_FILE_LINK_SCHEME.length);
    const qi = rest.indexOf('?');
    const path = decodeURIComponent(qi === -1 ? rest : rest.slice(0, qi));
    let line: number | undefined;
    let col: number | undefined;
    if (qi !== -1) {
      for (const pair of rest.slice(qi + 1).split('&')) {
        const [k, v] = pair.split('=');
        if (k === 'line') line = Number(v) || undefined;
        if (k === 'col') col = Number(v) || undefined;
      }
    }
    return { path, line, col };
  } catch {
    return null;
  }
}

function collectProtectedSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const re of [FENCE_RE, URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Markdown 安全的路径链接化：代码块/行内代码/URL 原样保留，其余按 findWorkspacePathLinks
 * 包成 [`raw`](muster-file:...)。filter.exists 传 stat 结果可拦掉不存在的候选。
 * 重复调用幂等（已包链接的文本前缀是 `](`，会被跳过）；定位一律用候选自带下标——
 * 曾用 indexOf(raw) 找首个出现，同段重复词会把多个链接双包到第一处，产出
 * `[[x](a)](a)` 嵌套损坏（渲染成裸链接语法）。
 */
export function linkifyWorkspacePaths(text: string, filter?: PathLinkFilter): string {
  if (!text) return text;
  const spans = collectProtectedSpans(text);

  const links: Array<{ start: number; end: number; href: string }> = [];
  const pushSegment = (seg: string, base: number) => {
    for (const link of findWorkspacePathLinks(seg, filter)) {
      // 幂等护栏：候选紧贴 `](` 说明是已有链接的 href（上轮产物/模型手写），跳过
      if (seg.slice(Math.max(0, link.at - 2), link.at) === '](') continue;
      links.push({
        start: base + link.at,
        end: base + link.at + link.raw.length,
        href: buildWorkspaceFileHref(link.path, link.line, link.col)
      });
    }
  };
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) pushSegment(text.slice(cursor, span.start), cursor);
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < text.length) pushSegment(text.slice(cursor), cursor);
  if (!links.length) return text;

  links.sort((a, b) => b.start - a.start);
  let out = text;
  for (const l of links) {
    const raw = out.slice(l.start, l.end);
    out = `${out.slice(0, l.start)}[${raw}](${l.href})${out.slice(l.end)}`;
  }
  return out;
}
