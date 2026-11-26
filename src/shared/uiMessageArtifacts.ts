import type { ChatMessage, ToolCallRecord } from './types';
import { uiRenderWidgetFromToolCall, type UiArtifactLinkMatch } from './uiArtifactLink';
import { renderedUiArtifactLinks } from './uiArtifactMarkdown';
import { uiWidgetIdentity } from './uiWidgetProtocol';

const EMPTY_MESSAGE_ARTIFACTS: {
  all: UiArtifactLinkMatch[]; fallback: UiArtifactLinkMatch[];
} = { all: [], fallback: [] };

export function uiMessageArtifacts(message: ChatMessage): {
  all: UiArtifactLinkMatch[]; fallback: UiArtifactLinkMatch[];
} {
  const seen = new Set<string>(), all: UiArtifactLinkMatch[] = [];
  const collect = (tool: ToolCallRecord): void => {
    if (tool.status === 'running') return;
    const match = uiRenderWidgetFromToolCall(tool.name, tool.result);
    if (match && !seen.has(uiWidgetIdentity(match.path))) { seen.add(uiWidgetIdentity(match.path)); all.push(match); }
  };
  if (message.parts) {
    for (const part of message.parts) {
      if (part.kind === 'tool' && part.toolCall) collect(part.toolCall);
    }
  } else {
    for (const tool of message.toolCalls ?? []) collect(tool);
  }
  // 普通正文/流式消息没有工具产物时，隐藏表与兜底表必为空；不要为此扫描全文
  // （去代码围栏、解析链接及引用定义）。正文里的独立部件仍由 Markdown 插件处理。
  if (all.length === 0) return EMPTY_MESSAGE_ARTIFACTS;
  let finalText = message.content ?? '';
  if (message.parts) {
    finalText = '';
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]!;
      if (part.kind === 'text') {
        finalText = part.text ?? '';
        break;
      }
    }
  }
  const finalPaths = new Set(renderedUiArtifactLinks(finalText).map(match => uiWidgetIdentity(match.path)));
  return { all, fallback: all.filter(match => !finalPaths.has(uiWidgetIdentity(match.path))) };
}
