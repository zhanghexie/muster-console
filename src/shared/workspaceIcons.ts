/** Stable workspace icon IDs. Config stores this token, never a renderer build URL. */
export const WORKSPACE_ICONS = [
  { id: 'news', label: '新闻' }, { id: 'social', label: '社交' },
  { id: 'messaging', label: '即时通讯' }, { id: 'development', label: '开发' },
  { id: 'video', label: '视频' }, { id: 'music', label: '音乐' },
  { id: 'live', label: '直播' }, { id: 'photography', label: '摄影' },
  { id: 'design', label: '设计' }, { id: 'writing', label: '写作' },
  { id: 'reading', label: '阅读' }, { id: 'education', label: '教育' },
  { id: 'calendar', label: '日程' }, { id: 'tasks', label: '任务' },
  { id: 'notes', label: '笔记' }, { id: 'mail', label: '邮件' },
  { id: 'cloud', label: '云盘' }, { id: 'security', label: '安全' },
  { id: 'data', label: '数据' }, { id: 'finance', label: '财务' },
  { id: 'shopping', label: '购物' }, { id: 'travel', label: '旅行' },
  { id: 'maps', label: '地图' }, { id: 'health', label: '健康' },
  { id: 'gamepad', label: '通用游戏' }, { id: 'action', label: '动作游戏' },
  { id: 'shooter', label: '射击游戏' }, { id: 'rpg', label: '角色扮演' },
  { id: 'strategy', label: '策略游戏' }, { id: 'racing', label: '竞速游戏' },
  { id: 'sports', label: '体育游戏' }, { id: 'puzzle', label: '解谜游戏' },
  { id: 'simulation', label: '模拟经营' }, { id: 'sandbox', label: '沙盒游戏' },
  { id: 'rhythm', label: '节奏游戏' }, { id: 'cards', label: '卡牌游戏' }
] as const;
export type WorkspaceIconId = typeof WORKSPACE_ICONS[number]['id'];
export const WORKSPACE_ICON_PREFIX = 'builtin-workspace:';
export const DEFAULT_WORKSPACE_ICON = `${WORKSPACE_ICON_PREFIX}development`;
export function workspaceIconId(value: unknown): WorkspaceIconId | undefined {
  if (typeof value !== 'string' || !value.trim().startsWith(WORKSPACE_ICON_PREFIX)) return undefined;
  const id = value.trim().slice(WORKSPACE_ICON_PREFIX.length);
  return WORKSPACE_ICONS.find(icon => icon.id === id)?.id;
}
export function workspaceIconValue(id: string): string {
  if (!WORKSPACE_ICONS.some(icon => icon.id === id)) throw new Error(`Unknown workspace icon: ${id}`);
  return `${WORKSPACE_ICON_PREFIX}${id}`;
}
