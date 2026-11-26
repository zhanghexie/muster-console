/** 应用壳/对话框/划词区词条 */
export const frag: Record<string, string> = {
  '继续按住以排序': 'Keep holding to reorder',
  '位置 {{position}}/{{total}} · Esc 取消': '{{position}}/{{total}} · Esc to cancel',
  // ── App 壳（App.tsx：终端截屏回执 / 焦点提示 / 左栏宽 / 页指示）──
  '终端视图未挂载': 'Terminal view not mounted',
  '画布为空': 'Canvas is empty',
  '已退出终端焦点，应用快捷键可用': 'Exited terminal focus; app shortcuts are active again',
  '终端未在输入，快捷键可用': 'Terminal was not taking input; app shortcuts are active',
  '调节左栏宽度': 'Adjust left column width',

  // ── store（气泡缺省文案 / 提示 / 转发失败 / hook 错误）──
  '待命': 'Standby',
  '转发失败：{{error}}': 'Forwarding failed: {{error}}',
  '{{name}} 必须在 StoreProvider 内使用': '{{name}} must be used inside StoreProvider',

  // ── hook / 启动错误（panelHistory / KeybindingHost / main / ErrorBoundary）──
  'usePanelHistory 必须在 PanelHistoryProvider 内使用':
    'usePanelHistory must be used inside PanelHistoryProvider',
  'useKeybindings 需在 KeybindingProvider 内': 'useKeybindings must be used inside KeybindingProvider',
  '工作台': 'Workbench',
  '{{label}}崩溃：': '{{label}} crashed: ',

  // ── 启动失败页（BootFailure）──
  '工作台启动失败': 'Workbench failed to start',
  '后台初始化链中断，界面功能不可用。重启通常可以恢复；若反复失败，请把下面的错误信息连同日志一起反馈。':
    'The background initialization chain was interrupted and the UI is unavailable. A restart usually fixes it; if it keeps failing, please report the error below together with the logs.',
  '日志目录：{{dir}}': 'Log folder: {{dir}}',
  '重启应用': 'Restart app',
  '复制错误信息': 'Copy error message',

  // ── 确认框 / 扩展 UI 弹窗 / 下拉缺省 ──
  '批准运行': 'Approve run',
  '确认执行': 'Confirm & run',
  '操作区域截图': 'Action area screenshot',
  '正在加载截图': 'Loading screenshot',
  '截图无法显示，无法批准': 'Screenshot unavailable; approval is disabled',
  '模型向说明与原始参数': 'Model-facing description and raw arguments',
  '请选择': 'Please select',

  // ── 分割面板 / 虚拟屏切换钮（SplitPane / SplitExpandControl）──
  '拖动调整面板大小': 'Drag to resize panels',
  '拖动调整大小（方向键微调）': 'Drag to resize (arrow keys to fine-tune)',
  '虚拟屏操作': 'Virtual screen controls',
  '长按选择切屏方式，左右拖动调宽': 'Hold to choose a switch mode. Drag sideways to resize.',
  '鼠标悬浮切屏': 'Hover to switch',
  '鼠标点击切屏': 'Click to switch',
  '关闭虚拟屏': 'Close virtual screen',
  '切屏位置无法保存，请检查本地存储空间或浏览器设置': 'Could not save the active virtual screen. Check local storage space or browser settings.',

  // ── 调宽指示卡（被调侧方位标注）──
  '左侧区域': 'Left area',
  '右侧区域': 'Right area',

  // ── 会话栏折叠/展开（右上角开关，与专注解耦）──
  '折叠会话栏': 'Collapse sessions panel',
  '展开会话栏': 'Expand sessions panel',
  '折叠右侧栏': 'Collapse right panel',
  '展开右侧栏': 'Expand right panel',

  // ── 侧栏工具页签（SideToolsSwitcher / SideToolsPanel）──
  '侧栏工具': 'Side tools',
  '文件 (F) · 可拖入路径': 'Files (F) · drop paths here',
  'Git (G) · 可拖入路径': 'Git (G) · drop paths here',
  '不在当前工作区': 'Not in the current workspace',

  // ── 划词浮条 / 大爆炸浮层 / 菜单项数据（SelectionBar / SelectionBangOverlay / selectionMenuAreas）──
  '选区操作': 'Selection actions',
  '拖到文件区、Git、Agent 或终端': 'Drag to Files, Git, Agent or terminal',
  '选区较大（{{total}} 词），已显示前 {{n}} 个': 'Selection is large ({{total}} words); showing the first {{n}}',
  '大爆炸': 'Big Bang',
  '爆炸': 'Big Bang',
  '连续点选或滑动选词，多次选择累加；选中后可拖到文件区 / Git / Agent':
    'Click or slide to pick words — selections keep adding up; drag them to Files / Git / Agent',
  '单击逐词加选，按住滑动连选一段；再点已选词可移除；选中后可拖出':
    'Click words to add them one by one, or press and slide to select a run; click a picked word again to remove it; drag the selection out afterwards',
  '选中词操作': 'Selected-word actions',
  '复制': 'Copy',
  '发给 Agent': 'Send to Agent',
  '打开链接': 'Open link',
  '资源管理器': 'File Explorer',
  '在文件区预览': 'Preview in Files',
  '粘贴': 'Paste',

  // ── 工具卡 Diff / 文本工具结果卡（ToolVisuals / TextToolResultCard）──
  '…diff 过长已截断': '…diff truncated (too long)',
  '文本工具：{{name}}': 'Text tool: {{name}}',
  '模型思考中…': 'Model thinking…',
  '正在调用模型…': 'Calling the model…',
  '模型在输出思考内容，正文马上就来…': 'The model is outputting its thinking; the answer is coming right up…',
  '正在调用模型，请稍候…': 'Calling the model, please wait…',
  '重新生成': 'Regenerate',
};
