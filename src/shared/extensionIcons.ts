/**
 * Built-in extension icon identifiers.
 *
 * The manifest stores the stable identifier, never the bundled asset URL. This
 * keeps global packages portable across workspaces and platforms.
 */
export const EXTENSION_ICON_PREFIX = 'builtin-extension:';

/** The approved hand-authored SVG catalog. */
export const EXTENSION_ICONS = [
  { id: 'accessibility', label: '无障碍' }, { id: 'analytics', label: '分析' }, { id: 'audio-player', label: '音频播放' }, { id: 'automation', label: '自动化' },
  { id: 'backup-restore', label: '备份恢复' }, { id: 'backup', label: '备份' }, { id: 'bank', label: '银行' }, { id: 'barcode', label: '条形码' },
  { id: 'billing', label: '账单' }, { id: 'board', label: '棋盘' }, { id: 'book', label: '书籍' }, { id: 'bookmarks', label: '书签组' },
  { id: 'browser', label: '浏览器' }, { id: 'bug-tracker', label: '缺陷追踪' }, { id: 'calendar-plus', label: '日程' }, { id: 'calendar', label: '日历' },
  { id: 'camera-video', label: '摄像视频' }, { id: 'card', label: '卡券支付' }, { id: 'career', label: '职业' }, { id: 'charity', label: '公益' },
  { id: 'chart', label: '图表' }, { id: 'chat', label: '聊天' }, { id: 'checklist', label: '清单' }, { id: 'cloud-drive', label: '云盘' },
  { id: 'cloud-sync', label: '云同步' }, { id: 'code-review', label: '代码审查' }, { id: 'code', label: '代码' }, { id: 'coffee', label: '咖啡生活' },
  { id: 'command-line', label: '命令行' }, { id: 'community', label: '社区' }, { id: 'crypto', label: '数字资产' }, { id: 'database', label: '数据库' },
  { id: 'delivery', label: '配送' }, { id: 'design-tools', label: '设计工具' }, { id: 'developer-tools', label: '开发工具' }, { id: 'education', label: '教育' },
  { id: 'energy', label: '能源' }, { id: 'environment', label: '环境' }, { id: 'events', label: '活动' }, { id: 'export', label: '导出' },
  { id: 'feedback', label: '反馈' }, { id: 'files', label: '文件' }, { id: 'finance', label: '财务' }, { id: 'firewall', label: '防火墙' },
  { id: 'fitness', label: '健身' }, { id: 'flight', label: '航空' }, { id: 'focus', label: '专注' }, { id: 'folder', label: '文件夹' },
  { id: 'food', label: '餐饮' }, { id: 'forms', label: '表单' }, { id: 'games', label: '游戏' }, { id: 'globe', label: '网络' },
  { id: 'grocery', label: '生鲜购物' }, { id: 'habit', label: '习惯' }, { id: 'health', label: '医疗健康' }, { id: 'home-life', label: '家庭生活' },
  { id: 'hotel', label: '酒店' }, { id: 'image-editor', label: '图片编辑' }, { id: 'import', label: '导入' }, { id: 'inventory', label: '库存' },
  { id: 'invoices', label: '发票' }, { id: 'iot', label: '物联网' }, { id: 'jobs', label: '招聘求职' }, { id: 'language-learning', label: '语言学习' },
  { id: 'legal', label: '法律' }, { id: 'login', label: '登录' }, { id: 'meditation', label: '冥想' }, { id: 'mental-health', label: '心理健康' },
  { id: 'messages', label: '消息' }, { id: 'music-player', label: '音乐播放' }, { id: 'navigation', label: '导航' }, { id: 'news', label: '新闻' },
  { id: 'notes', label: '笔记' }, { id: 'package-tracking', label: '包裹追踪' }, { id: 'palette', label: '设计创意' }, { id: 'parenting', label: '育儿' },
  { id: 'parking', label: '停车' }, { id: 'password-manager', label: '密码管理' }, { id: 'pdf-reader', label: 'PDF 阅读' }, { id: 'pets', label: '宠物' },
  { id: 'photography', label: '摄影' }, { id: 'podcast', label: '播客' }, { id: 'presentation-editor', label: '演示编辑' }, { id: 'print', label: '打印' },
  { id: 'productivity', label: '效率' }, { id: 'profile', label: '个人资料' }, { id: 'qr-code', label: '二维码' }, { id: 'real-estate', label: '房产' },
  { id: 'receipts', label: '收据' }, { id: 'recipes', label: '菜谱' }, { id: 'recruiting', label: '人才招聘' }, { id: 'recycling', label: '回收' },
  { id: 'remote-desktop', label: '远程桌面' }, { id: 'robot', label: '智能体' }, { id: 'rocket', label: '发布启动' }, { id: 'route-map', label: '路线地图' },
  { id: 'scanner', label: '扫描' }, { id: 'search-tool', label: '搜索工具' }, { id: 'security', label: '安全' }, { id: 'settings', label: '设置' },
  { id: 'shield', label: '防护' }, { id: 'shopping-list', label: '购物清单' }, { id: 'shopping', label: '购物' }, { id: 'sleep', label: '睡眠' },
  { id: 'social', label: '社交' }, { id: 'sports', label: '体育' }, { id: 'spreadsheet-editor', label: '表格编辑' }, { id: 'subscriptions', label: '订阅' },
  { id: 'support', label: '客服支持' }, { id: 'sync', label: '同步' }, { id: 'table-grid', label: '表格网格' }, { id: 'task-board', label: '任务管理' },
  { id: 'team', label: '团队' }, { id: 'terminal', label: '终端' }, { id: 'tickets', label: '票务' }, { id: 'translate', label: '翻译' },
  { id: 'transport', label: '交通' }, { id: 'travel', label: '旅行' }, { id: 'video-player', label: '视频播放' }, { id: 'volunteer', label: '志愿服务' },
  { id: 'vpn', label: 'VPN' }, { id: 'warehouse', label: '仓储' }, { id: 'water', label: '水资源' }, { id: 'weather-alert', label: '天气预警' },
  { id: 'weather', label: '天气' }, { id: 'wifi', label: '无线网络' }, { id: 'workflow-builder', label: '流程编排' }, { id: 'workspace', label: '工作空间' },
  // 内置样例的品牌图标（与样例面板 header 的自绘形状同源）
  { id: 'daily-report', label: '工作日报' }, { id: 'gomoku', label: '五子棋' }, { id: 'rubiks-cube', label: '魔方' }, { id: 'library', label: '图书馆' },
] as const;

export type ExtensionIconId = typeof EXTENSION_ICONS[number]['id'];
export const DEFAULT_EXTENSION_ICON: ExtensionIconId = 'workspace';

/** Older manifest values resolve to the closest hand-authored SVG. */
const LEGACY_EXTENSION_ICON_ALIASES: Record<string, ExtensionIconId> = {
  command: 'command-line', bug: 'bug-tracker', tests: 'checklist', package: 'package-tracking', git: 'code-review', branch: 'route-map',
  merge: 'workflow-builder', commit: 'code-review', repository: 'cloud-drive', cloud: 'cloud-drive', server: 'remote-desktop', table: 'table-grid',
  api: 'developer-tools', braces: 'code', function: 'developer-tools', variable: 'analytics', binary: 'developer-tools', cpu: 'developer-tools',
  memory: 'database', monitor: 'workspace', mobile: 'transport', keyboard: 'developer-tools', mouse: 'scanner', printer: 'print', microchip: 'developer-tools',
  link: 'browser', webhook: 'automation', workflow: 'workflow-builder', deploy: 'rocket', 'folder-open': 'folder', file: 'files', document: 'files',
  note: 'notes', edit: 'design-tools', copy: 'files', paste: 'files', save: 'backup', archive: 'cloud-drive', trash: 'recycling', download: 'import',
  upload: 'export', attachment: 'files', image: 'image-editor', video: 'video-player', audio: 'audio-player', pdf: 'pdf-reader', spreadsheet: 'spreadsheet-editor',
  presentation: 'presentation-editor', clock: 'productivity', alarm: 'calendar-plus', timer: 'focus', task: 'task-board', bookmark: 'bookmarks', tag: 'shopping',
  search: 'search-tool', filter: 'analytics', sort: 'analytics', dashboard: 'analytics', mail: 'messages', message: 'messages', comment: 'feedback',
  send: 'messages', inbox: 'messages', phone: 'support', contacts: 'team', user: 'profile', users: 'team', notification: 'messages', bell: 'messages',
  megaphone: 'news', map: 'route-map', location: 'navigation', compass: 'navigation', home: 'home-life', lock: 'password-manager', key: 'password-manager',
  eye: 'profile', 'hidden-eye': 'password-manager', sliders: 'settings', help: 'support', info: 'feedback', warning: 'weather-alert', error: 'support',
  check: 'checklist', close: 'feedback', spark: 'automation', magic: 'design-tools', brain: 'mental-health', airplane: 'flight', car: 'transport', train: 'transport',
  bicycle: 'fitness', gamepad: 'games', puzzle: 'workflow-builder', dice: 'games', music: 'music-player', microphone: 'podcast', camera: 'photography',
  brush: 'design-tools', pen: 'design-tools', graduation: 'education', flask: 'education', atom: 'education', leaf: 'environment', fire: 'energy', sun: 'weather',
  moon: 'sleep', star: 'events', heart: 'health', trophy: 'sports', 'bar-chart': 'chart', 'pie-chart': 'analytics', bolt: 'energy',
};

const ids = new Set<string>(EXTENSION_ICONS.map(icon => icon.id));

export function extensionIconValue(id: ExtensionIconId): string {
  return `${EXTENSION_ICON_PREFIX}${id}`;
}

export function extensionIconId(value: unknown): ExtensionIconId | undefined {
  if (typeof value !== 'string' || !value.startsWith(EXTENSION_ICON_PREFIX)) return undefined;
  const id = value.slice(EXTENSION_ICON_PREFIX.length);
  if (ids.has(id)) return id as ExtensionIconId;
  return LEGACY_EXTENSION_ICON_ALIASES[id];
}

export function isBuiltinExtensionIcon(value: unknown): value is string {
  return extensionIconId(value) !== undefined;
}

/** Manifest icon validation: built-ins are stable IDs; legacy glyphs remain compatible. */
export function isValidExtensionIcon(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && (isBuiltinExtensionIcon(value) || [...value].length <= 4);
}
