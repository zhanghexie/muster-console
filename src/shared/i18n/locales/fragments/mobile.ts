/**
 * 手机端远程访问表面（mobile-remote-interaction-plan）的英文词条。
 * key 与 mobile/ 目录下组件里 t('…') 的字面量一一对应（全部带引号——
 * i18n-coverage 的词条行正则只认带引号的 key）；桌面共用文案
 * （取消/清空/工作中/待命等）在别的 fragment，这里不重复。
 */
export const frag: Record<string, string> = {
  '调度 Agent': 'Dispatcher Agent',
  '返回': 'Back',
  '更多操作': 'More actions',
  '清空会话': 'Clear conversation',
  '清空': 'Clear',
  '复制会话名': 'Copy session name',
  '清空后当前对话上下文将丢失（不影响 Worker 会话与文件）。确定清空？':
    'This clears the current conversation context (worker sessions and files are untouched). Clear now?',
  '会话不可用，请返回重试': 'Session unavailable, go back and retry',
  '我是调度 Agent。手机上可以直接对话；派活、看板等完整能力请在电脑端使用。':
    "I'm the dispatcher agent. Chat directly from your phone; full capabilities (delegation, board) are on desktop.",
  '飞书绑定请在电脑端使用 /{{cmd}}': 'Feishu binding via /{{cmd}} is desktop-only',
  '调度 Agent：{{state}}': 'Dispatcher agent: {{state}}',
  '还没有工作区，请先在电脑端打开': 'No workspaces yet — open one on desktop first',
  '暂无会话': 'No sessions',
  '需要你 {{n}}': 'Needs you {{n}}',
  '工作中 {{n}}': 'Working {{n}}',
  '正在处理…': 'Working…',
  '工作区管家：对话 / 状态 / 远程审批': 'Workspace steward: chat / status / remote approvals',
  '暂无会话，点右上角「＋」新建': 'No sessions yet — tap “＋” to create one',
  '终端会话请在电脑端操作': 'Terminal sessions are desktop-only',
  '终端会话请在电脑端看输出；这里可以回复 Worker（存信后等空闲读取）。审批请在电脑端操作。':
    'Watch terminal output on desktop; replies are stored in the Worker mailbox for reading when idle. Approvals stay on desktop.',
  '回复 Worker…': 'Reply to Worker…',
  '注入失败': 'Inject failed',
  '没有可用的聊天会话类型，请先在电脑端配置 runtime':
    'No chat runtimes available — configure one on desktop first',
  '需要你处理': 'Needs your attention',
  '当前没有需要你处理的会话': 'No sessions need you right now',
  'useMobileNav 必须在 MobileApp 内使用': 'useMobileNav must be used within MobileApp',
  '文件列表': 'File list',
  '文件': 'Files',
  '上一级': 'Up one level',
  '目录为空': 'Directory is empty',
  '此格式请在电脑端预览': 'Preview this format on desktop',
  '外部目录请在电脑端查看': 'External directories are desktop-only'
};
