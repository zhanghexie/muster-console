/** shared 数据标签词条（commandPalette / keybindings / theme / workbenchStatus / uiDialog / sessionTitle / gitRepoTree / mcpConfig） */
export const frag: Record<string, string> = {
  // ── commandPalette.ts：PALETTE_FILTERS（会话/工作区/设置已在 en.ts）──

  // ── keybindings.ts：KEYBINDING_ACTIONS 分组（实用功能已在 en.ts）──
  '弹层': 'Overlays',
  '应用': 'App',
  '侧栏': 'Sidebar',
  '导航': 'Navigation',

  // ── keybindings.ts：KEYBINDING_ACTIONS 动作名 ──
  '关闭当前弹出层': 'Close current overlay',
  '打开设置': 'Open Settings',
  '退出终端焦点': 'Release terminal focus',
  '打开命令面板': 'Open command palette',
  '跳转会话或工作区': 'Go to session or workspace',
  '实用功能：定时任务': 'Utilities: Scheduled tasks',
  '实用功能：记忆整理': 'Utilities: Memory',
  '实用功能：扩展管理': 'Utilities: Extensions',
  '实用功能：使用统计': 'Utilities: Usage stats',
  '开关全局看板': 'Toggle global board',
  '快速打开文件': 'Quick open file',
  '当前文件查找': 'Find in current file',
  '会话内查找': 'Find in chat',
  '侧栏切到文件': 'Sidebar: files',
  '侧栏切到 Git': 'Sidebar: Git',
  '虚拟屏切 Git / 终端': 'Virtual screen: Git / terminal',
  '面板后退': 'Panel back',
  '面板前进': 'Panel forward',

  // ── theme.ts：内置主题名（浅色/深色已在 en.ts）──
  '深色（默认）': 'Dark (default)',
  '{{name}} 副本': '{{name}} copy',

  // ── theme.ts：parseTheme 校验错误 ──
  '主题必须是 JSON 对象': 'Theme must be a JSON object',
  '缺少主题 id': 'Missing theme id',
  'id "{{id}}" 不合法（只允许小写字母/数字/连字符，≤64 字符）':
    'Invalid id "{{id}}" (only lowercase letters, digits and hyphens allowed, ≤64 chars)',
  'name 必须是非空字符串（主题显示名）': 'name must be a non-empty string (theme display name)',
  'appearance 只能是 "dark" 或 "light"，当前为 {{value}}':
    'appearance must be "dark" or "light", got {{value}}',
  '{{section}} 必须是对象': '{{section}} must be an object',
  '{{section}} 存在未知字段 "{{key}}"（拼写错误或已废弃）':
    '{{section}} has unknown field "{{key}}" (typo or deprecated)',
  '{{section}}."{{key}}" 的值 {{value}} 不合法（支持 #hex / rgb() / rgba()；阴影 token 支持多段 box-shadow）':
    '{{section}}."{{key}}" has an invalid value {{value}} (#hex / rgb() / rgba() supported; shadow tokens accept multi-segment box-shadow)',

  // ── workbenchStatus.ts：/status 快照显示输出 ──
  '调度：忙碌': 'Dispatch: busy',
  '调度：空闲': 'Dispatch: idle',
  '（未知）': '(unknown)',
  '工作区：{{name}}': 'Workspace: {{name}}',
  '绑定会话：{{name}}': 'Bound session: {{name}}',
  '终端（{{n}}）：': 'Terminals ({{n}}):',
  ' ←当前': ' ←current',
  'lifecycle：{{value}}': 'lifecycle: {{value}}',
  '工作区数：{{n}}': 'Workspaces: {{n}}',
  '调度模式：{{mode}}': 'Dispatch mode: {{mode}}',
  '最近：{{text}}': 'Recent: {{text}}',

  // ── uiDialog.ts：宿主对话框校验错误 ──
  'title 必须是非空字符串': 'title must be a non-empty string',
  'message 必须是字符串': 'message must be a string',
  'items 必须是非空数组': 'items must be a non-empty array',
  'items 至多 {{n}} 项': 'items allows at most {{n}} entries',
  'items 项必须是对象': 'each item must be an object',
  '本对话框不支持 separator': 'separator is not supported in this dialog',
  'item.id 必须是 1-{{n}} 字符': 'item.id must be 1-{{n}} characters',
  'item.label 必须是 1-{{n}} 字符': 'item.label must be 1-{{n}} characters',
  'item.id 重复：{{id}}': 'duplicate item.id: {{id}}',
  'item.detail 必须是字符串': 'item.detail must be a string',
  'items 至少需要一项可选条目': 'items must contain at least one selectable entry',
  'args 必须是对象': 'args must be an object',
  'defaultValue 必须是字符串': 'defaultValue must be a string',
  'placeholder 必须是字符串': 'placeholder must be a string',
  'selectedIds 必须是数组': 'selectedIds must be an array',
  'selectedIds 含未知 id: {{id}}': 'selectedIds contains unknown id: {{id}}',
  'title 必须是字符串': 'title must be a string',

  // ── sessionTitle.ts：历史会话兜底标题 ──
  '定时任务运行': 'Scheduled task run',
  '（无消息）': '(no messages)',

  // ── gitRepoTree.ts：外部仓库根徽标（消费点 t(node.label)）──
  '外部': 'External',

  // ── mcpConfig.ts：MCP JSON 提示与解析错误（提示常量保持原文，消费点 t()）──
  '支持直接粘贴 {"server-name": {...}} 或 {"mcpServers": {"server-name": {...}}}。':
    'Paste {"server-name": {...}} or {"mcpServers": {"server-name": {...}}} directly.',
  'JSON 为空': 'JSON is empty',
  'JSON 无效：{{msg}}': 'Invalid JSON: {{msg}}',
  '未识别到 MCP 服务器（需要 {"name": {...}} 或 {"mcpServers": {...}}）':
    'No MCP servers recognized (need {"name": {...}} or {"mcpServers": {...}})',
  '「{{name}}」未配置 baseUrl/apiKey（设置 → 模型服务商）': 'Provider {{name}} has no baseUrl/apiKey configured (Settings → Model Providers)',
  'LLM 流返回错误：{{message}}': 'LLM stream error: {{message}}'
};
