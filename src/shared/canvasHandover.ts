/** A prepared history snapshot, held until the new task is submitted or cancelled. */
export interface CanvasHandoverDraft {
  id: string;
  sourceId: string;
  workspaceId: string;
  sourceRoot: { rootId: string; path: string };
  name: string;
  documentPath: string;
  lockedTask: string;
}

export interface HandoverLineRange { start: number; end: number }

export interface HandoverOverview {
  sourceId: string;
  sourceName: string;
  documentPath: string;
  rounds: number;
  userMessages: number;
  queuedUserMessages: number;
  assistantMessages: number;
  otherMessages: number;
  toolCalls: number;
  toolOutputsTruncated?: boolean;
  conversation: HandoverLineRange;
  tools?: HandoverLineRange;
  native?: HandoverLineRange;
}

/** Generated only from the host's own snapshot metadata. */
export function canvasHandoverBackground(info: HandoverOverview): string {
  const pending = info.queuedUserMessages ? `（其中 ${info.queuedUserMessages} 条排队未发送，不计入轮次）` : '';
  const other = info.otherMessages ? `另有 ${info.otherMessages} 条宿主、调度或代理消息。` : '';
  const tools = info.tools ? `工具调用附录：第 ${info.tools.start}–${info.tools.end} 行` : '工具调用附录：无';
  const native = info.native ? `\n原生记录附录：第 ${info.native.start}–${info.native.end} 行` : '';
  const truncated = info.toolOutputsTruncated ? '\n部分超长工具输出已截断，仅保留首尾，原始大小和省略量见工具记录。' : '';
  return `【交接背景】\n原会话：${info.sourceName}\n原会话 ID：${info.sourceId}\n会话记录：${info.documentPath}\n\n原会话共 ${info.rounds} 轮，包含 ${info.userMessages} 条用户消息${pending}、${info.assistantMessages} 条助手消息和 ${info.toolCalls} 次工具调用。${other}\n轮次按已发送的用户消息划分。\n沟通正文：第 ${info.conversation.start}–${info.conversation.end} 行\n${tools}${native}${truncated}\n\n记录按对话顺序排列。搜索行首“## [用户 #”可以找到用户消息，搜索行首“## [助手 #”可以找到助手回复；消息标有所属轮次。正文中的“[工具 #0001]”只显示工具名称，搜索“[工具详情 #0001]”可在附录找到对应的调用详情。此前用户的消息可以帮助你了解原任务和后续要求。`;
}

/** The background is taken from the host's pending draft, never from renderer input. */
export function canvasHandoverTask(background: string, task = ''): string {
  return task.trim() ? `${background}\n\n【本次任务】\n${task.trim()}` : background;
}
