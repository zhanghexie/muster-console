/**
 * 后台子代理的消息装配（纯逻辑，零运行时依赖；test/*.mjs 即时转译导入）。
 * host.handleEvent 的任务级同构：不碰会话注册表/轨迹/持久化，只攒 GuiChatMessage。
 */
import type { GuiDriverStreamEvent } from '../types';
import type { GuiChatMessage, GuiMessagePart } from '../../../shared/guiWorker';

/** 末条非空 assistant 正文（完成摘要用） */
export function lastAssistantText(messages: readonly GuiChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.parts
      .filter((p): p is Extract<GuiMessagePart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

export class TranscriptAssembler {
  readonly messages: GuiChatMessage[] = [];
  private assistant: GuiChatMessage | null = null;

  /** seedPrompt：派发时的任务提示词，作为首条 user 气泡（面板里与主聊天同构） */
  constructor(seedPrompt?: string) {
    if (seedPrompt?.trim()) {
      this.messages.push({
        id: `bg-seed-${Date.now()}`,
        role: 'user',
        parts: [{ kind: 'text', text: seedPrompt }],
        ts: Date.now()
      });
    }
  }

  /** 返回 'none' | 'update' | 'end'（end = 本回合收口，subagent 单回合即任务结束） */
  handle(ev: GuiDriverStreamEvent): 'none' | 'update' | 'end' {
    switch (ev.type) {
      case 'text-delta':
      case 'thinking-delta': {
        const kind = ev.type === 'text-delta' ? 'text' : 'thinking';
        const a = this.assistant ?? this.newAssistant();
        const parts = a.parts;
        const last = parts[parts.length - 1];
        if (!last || last.kind !== kind) parts.push({ kind, text: ev.delta });
        else last.text += ev.delta;
        return 'update';
      }
      case 'tool-start': {
        const a = this.assistant ?? this.newAssistant();
        a.parts.push({
          kind: 'tool',
          tool: { id: ev.toolCallId, name: ev.toolName, input: ev.input, status: 'running' }
        });
        return 'update';
      }
      case 'tool-result': {
        if (!this.assistant) return 'none';
        const parts = this.assistant.parts;
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.kind === 'tool' && p.tool.id === ev.toolCallId) {
            p.tool.status = ev.ok ? 'ok' : 'error';
            if (ev.output || !p.tool.output) p.tool.output = ev.output;
            if (ev.patch) p.tool.patch = ev.patch;
            break;
          }
        }
        return 'update';
      }
      case 'tool-progress': {
        if (!this.assistant || !ev.delta) return 'none';
        const parts = this.assistant.parts;
        let hit = -1;
        if (ev.toolCallId) {
          for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.kind === 'tool' && p.tool.id === ev.toolCallId) {
              hit = i;
              break;
            }
          }
        }
        if (hit < 0) {
          for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.kind === 'tool' && p.tool.status === 'running') {
              hit = i;
              break;
            }
          }
        }
        if (hit < 0) return 'none';
        const part = parts[hit];
        if (part.kind !== 'tool') return 'none';
        part.tool.output = (part.tool.output ?? '') + ev.delta;
        return 'update';
      }
      case 'turn-complete':
        this.assistant = null;
        return 'end';
      case 'error': {
        const a = this.assistant ?? this.newAssistant();
        a.error = ev.message;
        this.assistant = null;
        return 'end';
      }
      default:
        return 'none';
    }
  }

  private newAssistant(): GuiChatMessage {
    const m: GuiChatMessage = {
      id: `sa-${this.messages.length}-${Date.now()}`,
      role: 'assistant',
      parts: [],
      ts: Date.now()
    };
    this.assistant = m;
    this.messages.push(m);
    return m;
  }
}
