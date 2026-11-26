/**
 * 手机端页面栈模型（mobile-remote-interaction-plan）：
 * L1 工作区列表 → L2 工作区详情 → L3 对话页，一屏一层、点击下钻、返回上浮。
 * 栈内容持久化到 localStorage，刷新/断线重连后回原位（数据失效时截断到有效前缀）。
 */

/** L3 对话目标：调度 Agent（按工作区桶）或 GUI Worker 会话 */
export type MobileChatTarget =
  | { kind: 'dispatch' }
  | { kind: 'session'; sessionId: string };

export type MobilePage =
  | { kind: 'workspaces' }
  | { kind: 'workspace'; wsId: string }
  | { kind: 'chat'; wsId: string; target: MobileChatTarget };

const NAV_KEY = 'muster.mobile.nav.v1';

export function pageKeyOf(p: MobilePage): string {
  switch (p.kind) {
    case 'workspaces':
      return 'ws-list';
    case 'workspace':
      return `ws:${p.wsId}`;
    case 'chat':
      return `chat:${p.wsId}:${p.target.kind === 'dispatch' ? 'dispatch' : p.target.sessionId}`;
  }
}

export function readPersistedNav(): MobilePage[] | null {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const pages: MobilePage[] = [];
    for (const p of parsed) {
      if (p && p.kind === 'workspaces') pages.push({ kind: 'workspaces' });
      else if (p && p.kind === 'workspace' && typeof p.wsId === 'string')
        pages.push({ kind: 'workspace', wsId: p.wsId });
      else if (
        p &&
        p.kind === 'chat' &&
        typeof p.wsId === 'string' &&
        p.target &&
        (p.target.kind === 'dispatch' ||
          (p.target.kind === 'session' && typeof p.target.sessionId === 'string'))
      )
        pages.push(p as Extract<MobilePage, { kind: 'chat' }>);
      else return null; // 结构不符：整份丢弃，宁可不恢复也不错位
    }
    // 首页必须是工作区列表，深度封顶三级
    if (pages[0]?.kind !== 'workspaces' || pages.length > 3) return null;
    return pages;
  } catch {
    return null;
  }
}

export function persistNav(pages: MobilePage[]): void {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify(pages));
  } catch {
    /* localStorage 不可用时静默（无痕模式等） */
  }
}
