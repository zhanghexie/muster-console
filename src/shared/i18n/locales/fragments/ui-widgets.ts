/**
 * ma-ui 智能部件卡（UiWidgetCard / ui.render 产物呈现层）词条。
 * key = 中文原文，与代码里 t('…') 字面量逐字一致。
 */
export const frag: Record<string, string> = {
  '交互页面未连接宿主': 'The interactive page is not connected to the host.',
  '网页区未就绪': 'The browser is not ready.',
  '消息未发送': 'The message was not sent.',
  '所属会话已关闭': 'The owning session has closed.',
  '会话窗口已关闭': 'The session window has closed.',
  '交互动作无效': 'Invalid interactive action',
  '链接只支持 http 或 https': 'Links must use HTTP or HTTPS',
  '交互动作文本为空或超过长度限制': 'Interactive action text is empty or exceeds the length limit',
  '交互状态必须是 JSON 对象': 'Interactive state must be a JSON object',
  '交互增量必须是有效 JSON 对象': 'Interactive changes must be a valid JSON object',
  '交互值增量须包含 value/private': 'Interactive value changes must include value and private',
  '交互展示状态 collapsed 必须是布尔值': 'The interactive presentation state collapsed must be a boolean',
  '部件不属于当前应用的会话目录': 'The widget is not in this app’s session directory',
  '部件实际路径越界': 'The widget resolves outside its allowed directory',
  '部件实际路径越界（跨会话或文件别名）': 'The widget resolves outside its allowed path or through another session or alias',
  '部件文件不存在': 'The widget file does not exist',
  '部件回执数据无效': 'Invalid widget receipt data',
  '会话 id 无效': 'Invalid session ID',
  '部件回执无效': 'Invalid widget receipt',
  '交互状态超出 256 KiB：已用 {{used}} 字节，上限 {{max}} 字节；请只保存选择 ID 和界面参数': 'Interactive state exceeds 256 KiB: {{used}} bytes used, limit {{max}} bytes. Save only selection IDs and interface parameters.',
  '交互状态 {{field}} 必须是有效 JSON': 'Interactive state {{field}} must be valid JSON',
  '继续提问': 'Continue the conversation',
  '交互 UI': 'Interactive UI',
  // ── 部件卡（inline iframe / browser 链接卡 / 加载失败卡）──
  '部件加载失败（文件可能已随会话清理）': 'Widget failed to load (file may have been cleaned up with the session)',
  '在网页区打开': 'Open in browser pane',

  // ── ma-ui 家族既有缺词补齐（M1/M4 遗留，补上后对账 0 缺失）──
  '部件较多，仅打开前 {{n}} 个': 'Too many widgets; opening the first {{n}} only',
  '在网页区打开失败': 'Failed to open in the browser pane',
  '交互内容的宿主会话身份缺失或无效':
    'The host session identity for interactive content is missing or invalid.'
};
