/**
 * Claude SDK 消息 → GuiDriverStreamEvent 映射（纯函数，假 SDK 回放测试锁行为）。
 *
 * 事件源形状（@anthropic-ai/claude-agent-sdk，0.3.x）：
 * - stream_event（includePartialMessages）：Anthropic 流式增量，只取
 *   content_block_delta 的 text_delta / thinking_delta（input_json_delta 等部分工具入参不映射）；
 * - assistant：定稿消息。一个 API 回合可能拆多条（每条一个内容块），stop_reason/usage
 *   只在最后一条/result 上；正文/思考已由 stream_event 流过——去重后只映射 tool_use；
 * - user：CLI 回放的 tool_result 载体（content 里 tool_result 块）——映射 tool-result；
 *   名字不在块上，用 tool-start 记下的 toolCallId → toolName 回查；
 * - system/init：回合开始元信息（session_id/model/权限档）——resume-token 由 driver 发；
 * - result：回合终点信号（driver 消费 usage/错误），这里提供错误描述纯函数。
 * 子代理（parent_tool_use_id 非空）不摊进主聊天流（forwardSubagentText=false）。
 */
import type { GuiDriverStreamEvent } from '../../types';
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/** 回放状态：跨消息的 toolCallId→toolName 与「已流式送达文本」账本（去重定稿块） */
export interface ClaudeStreamState {
  toolNames: Map<string, string>;
  /** 本回合累计流式送达的正文/思考（assistant 定稿块与之比对，未流过才补发） */
  streamedText: string;
  streamedThinking: string;
  /** 定稿块已对账消费到的偏移（顺序消费，见 matchStreamed；M-6） */
  confirmedTextLen: number;
  confirmedThinkingLen: number;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return {
    toolNames: new Map(),
    streamedText: '',
    streamedThinking: '',
    confirmedTextLen: 0,
    confirmedThinkingLen: 0
  };
}

/** 回合收口后重置文本账本（工具名表保留——tool_result 可能晚到一拍） */
export function resetClaudeStreamTurn(state: ClaudeStreamState): void {
  state.streamedText = '';
  state.streamedThinking = '';
  state.confirmedTextLen = 0;
  state.confirmedThinkingLen = 0;
}

type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function blocksOf(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content as ContentBlock[];
}

function toolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
    // Image-only tool results must not be stringified into the workbench
    // event/history stream as large base64 payloads.
    if (content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'image')) return '[Image omitted]';
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** stream_event → 增量事件（text/thinking），同时记账供定稿块去重 */
export function mapClaudeStreamEvent(
  state: ClaudeStreamState,
  msg: SDKMessage
): GuiDriverStreamEvent[] {
  if (msg.type !== 'stream_event') return [];
  const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } })
    .event;
  if (!ev || ev.type !== 'content_block_delta') return [];
  const delta = ev.delta;
  if (!delta) return [];
  if (delta.type === 'text_delta' && delta.text) {
    state.streamedText += delta.text;
    return [{ type: 'text-delta', delta: delta.text }];
  }
  if (delta.type === 'thinking_delta' && delta.thinking) {
    state.streamedThinking += delta.thinking;
    return [{ type: 'thinking-delta', delta: delta.thinking }];
  }
  return [];
}

/**
 * 顺序消费式对账（M-6）：定稿块与流式账本按偏移逐一匹配——旧实现用 includes 全文
 * 包含判定，同回合两个完全相同的 text/thinking 块（未流式/降级路径）第二个会被当
 * 「已流过」吞掉。按 confirmedLen 顺序推进后：流式送达的块按序跳过（不重复补发），
 * 未流过的重复块各自补发。
 */
function matchStreamed(account: string, confirmedLen: number, block: string): boolean {
  if (confirmedLen + block.length > account.length) return false;
  return account.startsWith(block, confirmedLen);
}

/** assistant 定稿消息 → tool-start（正文/思考已流式送达则去重；漏流时补发一次整块） */
export function mapClaudeAssistant(
  state: ClaudeStreamState,
  msg: SDKAssistantMessage
): GuiDriverStreamEvent[] {
  if (msg.parent_tool_use_id) return []; // 子代理内容不摊主聊天
  const out: GuiDriverStreamEvent[] = [];
  for (const block of blocksOf((msg.message as { content?: unknown } | undefined)?.content)) {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      state.toolNames.set(block.id, name);
      out.push({
        type: 'tool-start',
        toolCallId: block.id,
        toolName: name,
        input:
          block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {}
      });
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      // 防御：includePartialMessages 丢帧（老 CLI/降级路径）时不能整段吞正文
      if (!matchStreamed(state.streamedText, state.confirmedTextLen, block.text)) {
        state.streamedText += block.text;
        out.push({ type: 'text-delta', delta: block.text });
      }
      state.confirmedTextLen += block.text.length;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      if (!matchStreamed(state.streamedThinking, state.confirmedThinkingLen, block.thinking)) {
        state.streamedThinking += block.thinking;
        out.push({ type: 'thinking-delta', delta: block.thinking });
      }
      state.confirmedThinkingLen += block.thinking.length;
    }
  }
  return out;
}

/**
 * user 消息（tool_result 载体）→ tool-result；resume 回放（isReplay）的历史 user
 * 消息整体不映射（M-6：回放的 tool_result 会冒充本回合工具收口，重连后还会盖空
 * checkpoint）；无 tool_result 块的消息不映射。
 */
export function mapClaudeUser(state: ClaudeStreamState, msg: SDKMessage): GuiDriverStreamEvent[] {
  if (msg.type !== 'user') return [];
  if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) return [];
  if ((msg as unknown as { isReplay?: boolean }).isReplay === true) return [];
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  const out: GuiDriverStreamEvent[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    out.push({
      type: 'tool-result',
      toolCallId: block.tool_use_id,
      toolName: state.toolNames.get(block.tool_use_id) ?? '',
      ok: block.is_error !== true,
      output: toolResultOutput(block.content)
    });
  }
  return out;
}

/** result 的用户可读错误描述（非错误 result 返回 undefined） */
export function describeClaudeResultError(msg: SDKResultMessage): string | undefined {
  if (msg.subtype === 'success') {
    if (msg.is_error === true) {
      // is_error 挂在 success 子型上 = 回合终止于 API 错误，result 字段即错误文本
      return msg.result || 'Claude 回合因 API 错误中止';
    }
    return undefined;
  }
  const errors = Array.isArray(msg.errors) ? msg.errors.filter(Boolean).join('；') : '';
  if (msg.subtype === 'error_max_turns') {
    return `已达最大回合数上限（${errors || 'max turns'}），任务未完成`;
  }
  return errors || `Claude 回合异常中止（${msg.subtype}）`;
}
