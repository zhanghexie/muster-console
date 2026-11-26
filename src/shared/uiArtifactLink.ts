/**
 * ma-ui 部件链接识别（共享纯逻辑）：
 * GUI 聊天链接化（MarkdownBody/ChatMarkdownBody）与 CLI 终端划词扫描共用。
 * 契约：链接 = ui.render 返回的绝对路径，文件名 <n>-<slug>.<inline|browser>.html，
 * 位于 agent-sessions/<sessionId>/ui/ 下。
 */

export interface UiArtifactLinkMatch {
  /** 规一化后的绝对路径（正斜杠） */
  path: string;
  mode: 'inline' | 'browser';
}

const SUFFIX_RE = /[\\/]agent-sessions[\\/][^\\/]+[\\/]ui[\\/].+?\.(inline|browser)\.html$/i;

/** 判断单个链接目标是否 ma-ui 部件；兼容 file:// 前缀、URL 编码与反斜杠 */
export function matchUiArtifactLink(href: string): UiArtifactLinkMatch | null {
  if (typeof href !== 'string' || href.length === 0 || href.length > 1024) return null;
  let p = href.trim();
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')); } catch { return null; }
  }
  p = p.replace(/\\/g, '/');
  const m = p.match(SUFFIX_RE);
  if (!m) return null;
  if (p.split('/').includes('..')) return null; // 防穿越：部件路径不允许相对段
  return { path: p, mode: m[1]!.toLowerCase() as 'inline' | 'browser' };
}

/** 从终端划词/任意文本中提取全部部件链接（markdown 链接目标与裸路径都能识别） */
export function extractUiArtifactLinks(text: string): UiArtifactLinkMatch[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: UiArtifactLinkMatch[] = [];
  const seen = new Set<string>();
  // Generated angle-bracket destinations may contain spaces or parentheses.
  for (const m of text.matchAll(/\]\(\s*<([^>]+)>\s*\)|\]\(\s*([^\s)]+)\s*\)/g)) {
    const hit = matchUiArtifactLink(m[1] ?? m[2] ?? '');
    if (hit && !seen.has(hit.path)) { seen.add(hit.path); out.push(hit); }
  }
  const RE = /(?:[A-Za-z]:[\\/]|\/)[^\s()<>[\]'"`]*?\.(?:inline|browser)\.html\b/gi;
  for (const m of text.matchAll(RE)) {
    const hit = matchUiArtifactLink(m[0]);
    if (hit && !seen.has(hit.path)) {
      seen.add(hit.path);
      out.push(hit);
    }
  }
  return out;
}

/** ui.render 的各 runtime 工具名形态（pi 目录名 / MCP 名 / claude·acp 的 mcp__ 前缀名） */
export function isUiRenderToolName(name: string): boolean {
  const n = String(name).toLowerCase();
  return n === 'ui.render' || n.endsWith('ui_render') || n.endsWith('ui.render');
}

/**
 * 从工具名及真实工具结果封装反查产物。呈现层将部件绑定到工具调用位置并置于折叠体外；
 * 失败/无链接/解析错误返回 null，工具卡保持普通形态。
 */
export function uiRenderWidgetFromToolCall(name: string, resultJson: string | null | undefined): UiArtifactLinkMatch | null {
  if (!isUiRenderToolName(name) || typeof resultJson !== 'string' || !resultJson) return null;
  try {
    let result = JSON.parse(resultJson) as unknown;
    for (let depth = 0; depth < 5; depth++) {
      if (!result || typeof result !== 'object') return null;
      const record = result as Record<string, unknown>;
      if (record.ok === false) return null;
      if (typeof record.link === 'string') return matchUiArtifactLink(record.link);
      const structured = record.structuredContent as Record<string, unknown> | undefined;
      if (structured && typeof structured.link === 'string') return matchUiArtifactLink(structured.link);
      if (record.result && typeof record.result === 'object') { result = record.result; continue; }
      const content = record.content;
      if (!Array.isArray(content)) return null;
      const text = content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text;
      if (!text) return null;
      result = JSON.parse(text);
    }
    return null;
  } catch {
    return null;
  }
}
