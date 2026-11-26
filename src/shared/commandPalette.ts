/**
 * 命令面板 / Quick Open 统一浮层：查询前缀、分组、回车语义、跳转条目。
 * 纯函数，禁止碰 process。
 */

import { t, getResolvedLocale } from './i18n';

export type PaletteMode = 'goto' | 'file' | 'command' | 'content';

export type PaletteConfirm =
  | { kind: 'switch-mode'; mode: PaletteMode }
  | { kind: 'close' }
  | { kind: 'run' };

export type GotoHit = {
  kind: 'workspace' | 'session';
  id: string;
  title: string;
  detail: string;
  current: boolean;
};

export type GotoWorkspaceInput = { id: string; name: string; path: string };
export type GotoSessionInput = {
  id: string;
  name: string;
  type: string;
  launchKind?: string;
  workspaceId?: string;
  archived?: boolean;
  cwd?: string;
  pinned?: boolean;
  pinnedAt?: number;
  lastUsedAt?: number;
  createdAt?: number;
};

const GOTO_SESSION_LIMIT = 60;

export const PALETTE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'sessions', label: '会话' },
  { id: 'workspaces', label: '工作区' },
  { id: 'files', label: '文件' },
  { id: 'content', label: '内容' },
  { id: 'commands', label: '命令' },
  { id: 'settings', label: '设置' }
] as const;

export type PaletteFilter = (typeof PALETTE_FILTERS)[number]['id'];

/** 行首 `>` 切命令；只认开头，`foo>bar` 仍是跳转/文件搜索。 */
export function parsePaletteQuery(raw: string): { command: boolean; search: string } {
  if (raw.startsWith('>')) return { command: true, search: raw.slice(1) };
  return { command: false, search: raw };
}

export function modeToFilter(mode: PaletteMode): PaletteFilter {
  if (mode === 'file') return 'files';
  if (mode === 'content') return 'content';
  if (mode === 'command') return 'commands';
  return 'all';
}

export function cyclePaletteFilter(cur: PaletteFilter, dir: 1 | -1): PaletteFilter {
  const ids = PALETTE_FILTERS.map((f) => f.id);
  const i = Math.max(0, ids.indexOf(cur));
  return ids[(i + dir + ids.length) % ids.length]!;
}

/** 行首 `>` 时强制命令档；否则用页签。 */
export function effectivePaletteFilter(query: string, filter: PaletteFilter): PaletteFilter {
  if (query.startsWith('>')) return 'commands';
  return filter;
}

/** 全部档空查询不搜文件；文件档或全部档有字才枚举。内容档走 ripgrep，不枚举路径。 */
export function paletteNeedsFiles(filter: PaletteFilter, search: string): boolean {
  if (filter === 'content') return false;
  if (filter === 'files') return true;
  return filter === 'all' && search.trim().length > 0;
}

/** 只在「内容」档搜正文；不混进「全部」（贵且和路径命中抢位置）。 */
export function paletteNeedsContent(filter: PaletteFilter): boolean {
  return filter === 'content';
}

export const CONTENT_SEARCH_DEBOUNCE_MS = 280;
export const CONTENT_SEARCH_MAX_RESULTS = 200;
export const PREVIEW_MAX_MARKS = 20;

/** 预览行里把匹配片段标出来（大小写可选，上限防超长行爆节点）。 */
export function markPreviewHits(
  preview: string,
  rawQuery: string,
  caseSensitive: boolean
): { text: string; mark: boolean }[] {
  const query = rawQuery.trim();
  if (!query) return [{ text: preview, mark: false }];
  const needle = caseSensitive ? query : query.toLowerCase();
  const parts: { text: string; mark: boolean }[] = [];
  let rest = preview;
  let restCmp = caseSensitive ? rest : rest.toLowerCase();
  let marks = 0;
  while (rest && marks < PREVIEW_MAX_MARKS) {
    const idx = restCmp.indexOf(needle);
    if (idx < 0) break;
    if (idx > 0) parts.push({ text: rest.slice(0, idx), mark: false });
    parts.push({ text: rest.slice(idx, idx + query.length), mark: true });
    rest = rest.slice(idx + query.length);
    restCmp = caseSensitive ? rest : rest.toLowerCase();
    marks += 1;
  }
  if (rest) parts.push({ text: rest, mark: false });
  return parts.length ? parts : [{ text: preview, mark: false }];
}

export function initialPaletteQuery(_mode?: PaletteMode): string {
  return '';
}

/** 切换入口时去掉 `>`，页签自己决定列表。 */
export function setPaletteMode(raw: string, _mode: PaletteMode): string {
  return parsePaletteQuery(raw).search;
}

/** 设置档：id 属于 settings.*。i18n 后标题随语言变，不再按标题猜（生产无标题用法） */
export function isSettingsCommand(id: string, _title?: string): boolean {
  return id === 'settings.open' || id.startsWith('settings.');
}

/** 设置导航分组（顺序即导航顺序） */
export const SETTINGS_GROUPS = [
  { id: 'common', label: '常用' },
  { id: 'ai', label: 'AI' },
  { id: 'connect', label: '连接' },
  { id: 'other', label: '其他' }
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];

/**
 * 设置页签：id 是 focusItem / 命令面板跳转契约（改名只改 label，勿改 id）；
 * desc 进搜索索引与命令面板副标题，lead 是页顶一句话说明。
 */
export const SETTINGS_TABS = [
  { id: 'general', group: 'common', label: '通用', desc: '语言 · 字体 · 交互 · 电脑行为', lead: '语言、字体、滚动动效和电脑行为。' },
  { id: 'appearance', group: 'common', label: '外观', desc: '主题 · 配色 · 头像', lead: '调整主题、工作区配色和头像。' },
  { id: 'worker', group: 'ai', label: 'Harness 接入', desc: '引擎接入 · 聊天与原生终端 · 模型' },
  { id: 'agent', group: 'ai', label: '模型与输入', desc: '模型服务商 · 输入能力 · 文件处理', lead: '配置模型 API 与原生输入能力，以及所有模型共用的文件预处理、自动预览和本机转换工具。' },
  { id: 'capabilityManagement', group: 'ai', label: '能力管理', desc: 'Skills · MCP · 应用能力', lead: '集中管理技能、MCP 与应用能力目录，含宿主与 CLI 的互联配置。' },
  { id: 'capabilities', group: 'ai', label: '调度 Agent', desc: '调度提示词 · 规矩', lead: '负责分派任务、盯进度的那个 AI。这里决定它怎么说话、守什么规矩。' },
  { id: 'memory', group: 'ai', label: '记忆', desc: '知识处理 LLM · 检索嵌入模型', lead: '分别配置用于抽取与审查知识的 LLM，以及用于按意思搜索的嵌入模型。' },
  { id: 'textTools', group: 'ai', label: '文本工具', desc: '划词 AI 功能 · 翻译 · 自定义提示词', lead: '选中任意文字后弹出的 AI 小工具：翻译、解释、润色，也能加你自己的。' },
  { id: 'notify', group: 'connect', label: '通知', desc: '推送开关 · 免打扰', lead: '会话状态变化时怎么提醒你：桌面气泡、手机。同类提醒 45 秒内只发一次。' },
  { id: 'channels', group: 'connect', label: 'Channels', desc: '消息源 · 连接账号 · 收件与回复', lead: '全局管理 Channel 和消息来源。各工作区在手机 Channel App 中选择绑定。' },
  { id: 'remoteAccess', group: 'connect', label: '远程访问', desc: '远程输入 · 网址 · 二维码', lead: '从授权的消息对话输入，或用浏览器打开工作台。' },
  { id: 'keybindings', group: 'other', label: '快捷键', desc: '查看 · 搜索 · 自定义绑定', lead: '点快捷键格子，然后按下新组合键。' },
  { id: 'localStorage', group: 'other', label: '本机存储', desc: '存储占用 · 查看与清理', lead: '查看和管理工作台本机数据。' },
  { id: 'about', group: 'other', label: '关于', desc: '版本 · 检查更新', lead: '版本和更新。' }
] as const satisfies readonly { id: string; group: SettingsGroupId; label: string; desc: string; lead?: string }[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/** 已删除页签的旧 id → 现页签。外部调用（deep link / 旧配置）仍传旧 id 时兜底。 */
export const SETTINGS_TAB_ALIASES: Record<string, SettingsTabId> = {
  integrations: 'capabilityManagement',
  feedback: 'about'
};

/** 把任意外部传入的页签 id 归一为现役页签；未知值回「通用」。 */
export function normalizeSettingsTab(tab: string | undefined | null): SettingsTabId {
  if (tab === 'feishu') return 'remoteAccess'; // Old deep links open the unified remote settings.
  if (!tab) return 'general';
  if (SETTINGS_TABS.some(t => t.id === tab)) return tab as SettingsTabId;
  return SETTINGS_TAB_ALIASES[tab] ?? 'general';
}

export type SettingsCatalogItem = {
  id: string;
  tab: SettingsTabId;
  title: string;
  detail: string;
  keywords?: string;
};

export type SettingsHit = {
  id: string;
  tab: SettingsTabId;
  title: string;
  detail: string;
};

const SETTINGS_FIELDS: SettingsCatalogItem[] = [
  { id: 'appearance-language', tab: 'general', title: '界面语言', detail: '通用', keywords: '语言 language english 中文 locale' },
  { id: 'appearance-font', tab: 'general', title: '字体', detail: '通用', keywords: '字体族 字号 font OPPO MiSans 紧凑 宽松' },
  { id: 'interaction-scroll-feel', tab: 'general', title: '滚动手感', detail: '通用', keywords: '滚轮 原生 利落 柔和 平滑 scroll wheel native crisp soft' },
  { id: 'interaction-scroll-distance', tab: 'general', title: '每格滚动距离', detail: '通用', keywords: '滚动 距离 速度 倍数 scroll distance speed' },
  { id: 'interaction-motion', tab: 'general', title: '界面动效', detail: '通用', keywords: '动画 减少动态 跟随系统 轻微 motion animation reduced subtle' },
  { id: 'worktree-storage', tab: 'general', title: 'worktree 存储目录', detail: '通用', keywords: '隔离 worktree 磁盘 存储 目录 storage' },
  { id: 'waiting-tips', tab: 'general', title: '等待时显示功能提示', detail: '通用', keywords: 'tips 提示 等待 功能' },
  { id: 'live-thinking-only', tab: 'general', title: '只显示当前思考', detail: '通用', keywords: '思考 thinking reasoning 会话展示' },
  { id: 'worker-keep-awake', tab: 'general', title: '阻止系统休眠', detail: '通用', keywords: '休眠 睡眠 sleep keep awake 定时任务' },
  { id: 'worker-journal-exit-summary', tab: 'general', title: '会话结束自动写日志', detail: '通用', keywords: 'journal 日志 总结' },
  { id: 'general-shell', tab: 'general', title: '命令行环境', detail: '通用', keywords: '终端环境 Shell 手动指定 Git Bash 路径 Specify Git Bash manually' },
  { id: 'bg-shell-mode', tab: 'general', title: '后台命令 Shell', detail: '通用 · 命令行环境', keywords: 'bash powershell 自动 shell' },
  { id: 'appearance-message-avatar', tab: 'appearance', title: '你的头像', detail: '外观', keywords: '头像 avatar 显示名 内置 符号 symbol 上传' },
  { id: 'appearance-workspace-theme', tab: 'appearance', title: '当前工作区主题', detail: '外观', keywords: '工作区 主题 独立' },
  { id: 'agent-provider', tab: 'agent', title: '模型服务商', detail: '模型与输入', keywords: 'LLM 供应商 服务商 provider 模型' },
  { id: 'agent-input-processing', tab: 'agent', title: '文件预处理与自动预览', detail: '模型与输入', keywords: '附件 视频 抽帧 大小 限制 页数 预算' },
  { id: 'agent-input-tools', tab: 'agent', title: '本机文件转换工具', detail: '模型与输入', keywords: 'FFmpeg LibreOffice 转换 路径' },
  { id: 'agent-base-url', tab: 'agent', title: 'Base URL', detail: '模型服务商', keywords: '接口 地址 endpoint' },
  { id: 'agent-api-format', tab: 'agent', title: 'API 格式', detail: '模型服务商', keywords: 'openai completions protocol' },
  { id: 'agent-api-key', tab: 'agent', title: 'API Key', detail: '模型服务商', keywords: '密钥 token 凭证' },
  { id: 'agent-models', tab: 'agent', title: '模型列表', detail: '模型服务商', keywords: '添加模型 上下文 token' },
  { id: 'appearance-name', tab: 'appearance', title: '主题名', detail: '外观', keywords: '名称 自定义主题' },
  { id: 'appearance-mode', tab: 'appearance', title: '外观', detail: '外观', keywords: '深色 浅色 dark light' },
  { id: 'appearance-new', tab: 'appearance', title: '新建主题', detail: '外观', keywords: '复制 自定义 JSON' },
  { id: 'appearance-folder', tab: 'appearance', title: '打开主题文件夹', detail: '外观', keywords: 'JSON 文件 themes' },
  { id: 'appearance-accent', tab: 'appearance', title: '主题色', detail: '外观', keywords: '颜色 全局默认 当前工作区 头像 accent color' },
  { id: 'kb-list', tab: 'keybindings', title: '键盘快捷方式', detail: '快捷键', keywords: '改绑 绑定 热键 chord' },
  { id: 'kb-find', tab: 'keybindings', title: '按下查找', detail: '快捷键', keywords: '反查 按键 搜索快捷键' },
  { id: 'worker-default', tab: 'worker', title: '默认 runtime', detail: 'Worker', keywords: 'CLI cursor claude opencode' },
  { id: 'worker-routing', tab: 'worker', title: '自动派活', detail: 'Harness 接入', keywords: '档位 候选 模型 routing model failover' },
  { id: 'cap-init', tab: 'capabilities', title: 'Pi 初始化', detail: '调度 Agent', keywords: '调度 初始化' },
  { id: 'cap-prompt', tab: 'capabilities', title: '调度提示词', detail: '调度 Agent', keywords: 'appendSystemPrompt 系统提示 正文' },
  { id: 'cap-catalog', tab: 'capabilities', title: 'App Catalog', detail: '调度 Agent', keywords: '工具 catalog 能力' },
  { id: 'cap-allowlist', tab: 'capabilities', title: 'Worker 白名单', detail: '调度 Agent', keywords: 'allowlist 权限' },
  { id: 'notify-phases', tab: 'notify', title: '推送开关', detail: '通知', keywords: '推送 通知 状态 phase needs_you done error 开关' },
  { id: 'notify-dnd', tab: 'notify', title: '免打扰时段', detail: '通知', keywords: '免打扰 dnd 夜间 时段 静音' },
  { id: 'skills-manager', tab: 'capabilityManagement', title: '技能管理', detail: '能力管理', keywords: 'skill SKILL.md 技能 全局 项目 目录 关联 Claude Codex Cursor Pi' },
  { id: 'mcp-enabled', tab: 'capabilityManagement', title: '启用 MCP', detail: '能力管理', keywords: 'mcp 开关' },
  { id: 'mcp-servers', tab: 'capabilityManagement', title: 'MCP 服务器', detail: '能力管理', keywords: 'stdio HTTP JSON Cursor 导入 工作区 用户 headers' },
  { id: 'inbound-mcp', tab: 'capabilityManagement', title: 'CLI 使用工作台工具', detail: 'MCP · 自动配置', keywords: 'stdio MCP claude.json 自动配置 重试 警告' },
  { id: 'webaccess-url', tab: 'remoteAccess', title: '网址连接（网页访问）', detail: '远程访问', keywords: '远程 网址 二维码 token 浏览器 局域网 手机' },
  { id: 'channels-main', tab: 'channels', title: '管理 Channels', detail: 'Channels', keywords: '消息源 连接账号 飞书 微信 邮箱 channel IM 收件 回复' },
  { id: 'remote-messaging', tab: 'remoteAccess', title: '远程输入', detail: '远程访问', keywords: 'Channel 会话 绑定 授权操作人 远程输入 遥控' },
  { id: 'feedback', tab: 'about', title: '反馈', detail: '关于', keywords: '反馈 提交 github issue' },
  { id: 'textTools-default-model', tab: 'textTools', title: '功能默认模型', detail: '文本工具', keywords: '翻译 划词 模型 默认' },
  { id: 'about-update', tab: 'about', title: '检查更新', detail: '关于', keywords: '版本 更新 升级 重启 about version update' }
];

export const SETTINGS_ITEMS: SettingsCatalogItem[] = [
  ...SETTINGS_TABS.map((t) => ({
    id: t.id,
    tab: t.id,
    title: t.label,
    detail: t.desc,
    keywords: '设置'
  })),
  ...SETTINGS_FIELDS
];

export function themeGroupsToSettingsItems(
  groups: readonly { id: string; label: string; keys: readonly { key: string; label: string }[] }[]
): SettingsCatalogItem[] {
  const items: SettingsCatalogItem[] = [];
  for (const g of groups) {
    // 组合串在组装时就地翻译（collectSettingsHits 对整体 t() 是恒等，不会二次翻译）
    items.push({
      id: `theme-group:${g.id}`,
      tab: 'appearance',
      title: t(g.label),
      detail: `${t('外观')} · ${t(g.label)}`,
      keywords: g.keys.map((k) => `${k.label} ${k.key}`).join(' ')
    });
    for (const k of g.keys) {
      items.push({
        id: `theme-color:${k.key}`,
        tab: 'appearance',
        title: t(k.label),
        detail: `${t('外观')} · ${t(g.label)}`,
        keywords: k.key
      });
    }
  }
  return items;
}

export function collectSettingsHits(
  query: string,
  extra: readonly SettingsCatalogItem[] = []
): SettingsHit[] {
  const q = query.trim();
  const scored: (SettingsHit & { score: number })[] = [];
  for (const item of [...SETTINGS_ITEMS, ...extra]) {
    // 检索用原文（中文 + 关键词），展示用当前语言翻译；双向入 hay 让两种语言都能搜到
    const hay = `${item.title} ${item.detail} ${item.keywords ?? ''} ${t(item.title)} ${t(item.detail)}`;
    const score = q ? scoreGotoText(hay, q) : 0;
    if (q && score < 0) continue;
    scored.push({ id: item.id, tab: item.tab, title: t(item.title), detail: t(item.detail), score });
  }
  if (q) scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, getResolvedLocale()));
  return scored.map(({ id, tab, title, detail }) => ({ id, tab, title, detail }));
}

export function splitHighlight(
  text: string,
  query: string
): { text: string; mark: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, mark: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const i = lower.indexOf(needle);
  if (i < 0) return [{ text, mark: false }];
  const parts: { text: string; mark: boolean }[] = [];
  if (i > 0) parts.push({ text: text.slice(0, i), mark: false });
  parts.push({ text: text.slice(i, i + q.length), mark: true });
  if (i + q.length < text.length) parts.push({ text: text.slice(i + q.length), mark: false });
  return parts;
}

/** 无 `>` 时：从文件/内容入口进来仍停在该档，其余（含从命令删掉 `>`）回到跳转。 */
export function resolveListMode(query: string, requested: PaletteMode): PaletteMode {
  if (query.startsWith('>')) return 'command';
  if (requested === 'file') return 'file';
  if (requested === 'content') return 'content';
  return 'goto';
}

export function groupByPreservingOrder<T>(
  items: readonly T[],
  groupOf: (item: T) => string
): { group: string; items: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const item of items) {
    const g = groupOf(item);
    if (!map.has(g)) {
      order.push(g);
      map.set(g, []);
    }
    map.get(g)!.push(item);
  }
  return order.map((group) => ({ group, items: map.get(group)! }));
}

/** overlay.close 无 useKeybinding，但面板自己就是一层 overlay。 */
export function isPaletteRowEnabled(id: string, registered: boolean): boolean {
  if (id === 'overlay.close') return true;
  return registered;
}

export function paletteConfirmAction(id: string): PaletteConfirm {
  if (id === 'palette.goto') return { kind: 'switch-mode', mode: 'goto' };
  if (id === 'files.quickOpen') return { kind: 'switch-mode', mode: 'file' };
  if (id === 'files.findInFiles') return { kind: 'switch-mode', mode: 'content' };
  if (id === 'palette.commands') return { kind: 'switch-mode', mode: 'command' };
  if (id === 'overlay.close') return { kind: 'close' };
  return { kind: 'run' };
}

export function sessionKindLabel(s: { type: string; launchKind?: string }): string {
  if (s.type === 'scheduled') return t('定时');
  if (s.launchKind === 'shell') return 'Shell';
  return 'Agent';
}

export function scoreGotoText(haystack: string, query: string): number {
  const q = query.trim().toLowerCase();
  const h = haystack.toLowerCase();
  if (!q) return 0;
  if (h === q) return 1000;
  if (h.startsWith(q)) return 800 - h.length;
  if (h.includes(q)) return 600 - h.length;
  let i = 0;
  for (const ch of h) {
    if (ch === q[i]) i++;
    if (i >= q.length) return 200 - h.length;
  }
  return -1;
}

function workspaceNameOf(
  workspaces: readonly GotoWorkspaceInput[],
  wsId: string | undefined
): string {
  if (!wsId) return t('未归属');
  return workspaces.find((w) => w.id === wsId)?.name ?? t('已关闭工作区');
}

function sessionSortKey(s: GotoSessionInput): number {
  if (s.pinned) return 2e15 + (s.pinnedAt ?? 0);
  return s.lastUsedAt ?? s.createdAt ?? 0;
}

export function collectGotoHits(
  workspaces: readonly GotoWorkspaceInput[],
  sessions: readonly GotoSessionInput[],
  query: string,
  activeWorkspaceId: string | null,
  activeSessionId: string | null
): { workspaces: GotoHit[]; sessions: GotoHit[] } {
  const q = query.trim();

  const wsScored: (GotoHit & { score: number })[] = [];
  for (const w of workspaces) {
    const hay = `${w.name} ${w.path}`;
    const score = q ? scoreGotoText(hay, q) : w.id === activeWorkspaceId ? 1 : 0;
    if (q && score < 0) continue;
    wsScored.push({
      kind: 'workspace',
      id: w.id,
      title: w.name || w.path,
      detail: w.path,
      current: w.id === activeWorkspaceId,
      score
    });
  }
  if (q) wsScored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, getResolvedLocale()));
  else {
    wsScored.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.title.localeCompare(b.title, getResolvedLocale());
    });
  }

  const sessScored: (GotoHit & { score: number; recency: number; sameWs: boolean })[] = [];
  for (const s of sessions) {
    const wsName = workspaceNameOf(workspaces, s.workspaceId);
    const kind = sessionKindLabel(s);
    const title = s.type === 'scheduled' && !s.name.trim() ? t('定时任务') : s.name;
    const bits = [wsName, kind];
    if (s.archived) bits.push(t('已归档'));
    const detail = bits.join(' · ');
    const hay = `${title} ${detail} ${s.cwd ?? ''} ${s.id}`;
    const score = q ? scoreGotoText(hay, q) : 0;
    if (q && score < 0) continue;
    sessScored.push({
      kind: 'session',
      id: s.id,
      title,
      detail,
      current: s.id === activeSessionId,
      score,
      recency: sessionSortKey(s),
      sameWs: !!activeWorkspaceId && s.workspaceId === activeWorkspaceId
    });
  }
  if (q) {
    sessScored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, getResolvedLocale()));
  } else {
    sessScored.sort((a, b) => {
      if (a.sameWs !== b.sameWs) return a.sameWs ? -1 : 1;
      return b.recency - a.recency;
    });
  }

  const strip = <T extends GotoHit>(rows: T[]): GotoHit[] =>
    rows.map(({ kind, id, title, detail, current }) => ({ kind, id, title, detail, current }));

  return {
    workspaces: strip(wsScored),
    sessions: strip(sessScored).slice(0, GOTO_SESSION_LIMIT)
  };
}
