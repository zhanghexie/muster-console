/** User-facing handover errors; the generated handover document remains protocol data. */
export const frag: Record<string, string> = {
  '源会话附件包含链接或特殊文件，无法安全复制': 'Source session attachments contain links or special files and cannot be copied safely.',
  '源会话附件清单无效：{{name}}': 'Invalid source session attachment manifest: {{name}}',
  '第 {{n}} 条消息的图片数据不可用，无法完整生成交接文档': 'Image data for message {{n}} is unavailable; the handover document cannot be generated completely.',
  '第 {{n}} 条消息的图片数据无效': 'Image data for message {{n}} is invalid.',
  'Claude Code 会话缺少可读取的原生会话标识或目录': 'The Claude Code session lacks a readable native session ID or directory.',
  '源会话记录正在变化，请等待当前回合结束后重试': 'The source session history is changing. Wait for the current turn to finish and try again.',
  '无法读取 Claude Code 原生聊天记录：{{error}}': 'Could not read the native Claude Code chat history: {{error}}',
  'Claude Code 原生聊天记录为空': 'The native Claude Code chat history is empty.',
  'Claude Code 聊天记录第 {{n}} 行不完整或无法解析': 'Line {{n}} of the Claude Code chat history is incomplete or cannot be parsed.',
  'Claude Code 原生记录中没有可交接的聊天消息': 'The native Claude Code history has no chat messages to hand over.',
  '源会话没有可交接的聊天记录': 'The source session has no chat history to hand over.',
  '源会话正在回复，请等待当前回合结束后交接': 'The source session is responding. Wait for the current turn to finish before handing over.',
  '此终端类型尚不能读取完整聊天记录，无法交接': 'This terminal type cannot yet read the full chat history and cannot be handed over.',
  '交接文档根目录已指向其他位置': 'The handover document root points to a different location.',
  '准备交接期间源会话已变化，请重试': 'The source session changed while preparing the handover. Try again.',
  '生成交接文档失败：{{error}}；临时数据清理失败：{{cleanup}}': 'Handover document generation failed: {{error}}; temporary data cleanup failed: {{cleanup}}',
  '交接草稿已失效或不属于当前工作区': 'The handover draft has expired or does not belong to the current workspace.',
  '交接历史文档不存在': 'The handover history document does not exist.'
};
