/**
 * ACP session/update → GuiDriverStreamEvent（T5.2）。
 *
 * 五事件合同（对齐 refs/wmux AcpBrainAdapter 头注释）：
 *   agent_message_chunk → text-delta
 *   tool_call           → tool-start
 *   tool_call_update → tool-update（工具元数据）/ tool-result（终态）
 *   session/prompt 响应 → turn-end（driver 发 turn-complete；此处只映射流）
 *   错误                → error
 *
 * 另映射（AionUi platforms/acp）：
 *   agent_thought_chunk → thinking-delta
 *   available_commands_update → available-commands（斜杠菜单）
 *   current_mode_update → current-mode（模式 chip）
 */
import type { GuiDriverStreamEvent } from '../../types';
import unidiff from 'unidiff';
import { TURN_FILE_LIMIT, type ReportedFileChange } from '../../../../shared/turnChanges';

type ReportedDiff = ReportedFileChange & { bytes: number };

type AcpToolCall = {
  name?: string;
  title?: string;
  kind?: string;
  input?: Record<string, unknown>;
  locations?: unknown[];
};

export interface AcpStreamState {
  agentId?: string;
  toolCalls: Map<string, AcpToolCall>;
  endedTools: Set<string>;
  toolDiffs: Map<string, Map<string, ReportedDiff>>;
  diffBytes: number;
  diffWarnings: Set<string>;
}

export function createAcpStreamState(agentId?: string): AcpStreamState {
  return { agentId, toolCalls: new Map(), endedTools: new Set(),
    toolDiffs: new Map(), diffBytes: 0, diffWarnings: new Set() };
}

export function resetAcpStreamTurn(state: AcpStreamState): void {
  state.toolCalls.clear();
  state.endedTools.clear();
  state.toolDiffs.clear();
  state.diffBytes = 0;
  state.diffWarnings.clear();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function contentText(block: unknown): string {
  if (typeof block === 'string') return block;
  const b = asRecord(block);
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  if (typeof b.text === 'string') return b.text;
  return '';
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('');
  if (content && typeof content === 'object') return contentText(content);
  return '';
}

function toolContentText(block: unknown): string {
  const record = asRecord(block);
  return contentText(record.type === 'content' ? record.content : block);
}

function toolOutputText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const t = raw.map(toolContentText).filter(Boolean).join('\n');
    if (t) return t;
  }
  const rec = asRecord(raw);
  if (typeof rec.text === 'string') return rec.text;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function resultText(update: Record<string, unknown>, preferContent: boolean): string {
  const content = update.content;
  if (preferContent && Array.isArray(content)) {
    const text = content.map(toolContentText).filter(Boolean).join('\n');
    if (text) return text;
  }
  const raw = toolOutputText(update.rawOutput ?? update.raw_output);
  return raw || (Array.isArray(content) && content.length === 0 ? '' : toolOutputText(content));
}

function toolCallId(update: Record<string, unknown>): string {
  const id = update.toolCallId ?? update.tool_call_id ?? update.id;
  return typeof id === 'string' && id.trim() ? id : `acp-tool-${Date.now()}`;
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function toolNameOf(tool: AcpToolCall, id: string): string {
  return tool.name ?? tool.title ?? tool.kind ?? id;
}

function inputOf(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = update.rawInput ?? update.raw_input ?? update.input;
  if (raw == null) return undefined;
  return typeof raw === 'object' && !Array.isArray(raw) ? asRecord(raw) : { input: raw };
}

/** ACP may send full old/new file contents before its terminal update. */
function rememberDiffs(state: AcpStreamState, id: string, content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let warned = content.length > 201;
  for (const raw of content.slice(0, 201)) {
    const block = asRecord(raw);
    if (block.type !== 'diff' || typeof block.path !== 'string' || block.path.length > 4096 ||
        !(typeof block.oldText === 'string' || block.oldText === null) || typeof block.newText !== 'string') continue;
    const current = state.toolDiffs.get(id);
    const previous = current?.get(block.path);
    const withoutOld = state.diffBytes - (previous?.bytes ?? 0);
    if ((!current && state.toolDiffs.size >= 512) || (!previous && current && current.size >= 201)) {
      warned = true; continue;
    }
    if (block.oldText === block.newText) {
      if (previous) { current!.delete(block.path); state.diffBytes = withoutOld; }
      continue;
    }
    const oversized = Buffer.byteLength(block.oldText ?? '') > TURN_FILE_LIMIT || Buffer.byteLength(block.newText) > TURN_FILE_LIMIT;
    const diff = oversized ? '' : unidiff.createTwoFilesPatch('a/file', 'b/file', block.oldText ?? '', block.newText);
    const size = Buffer.byteLength(diff);
    const omit = oversized || size > TURN_FILE_LIMIT || withoutOld + size > 2 * 1024 * 1024;
    const bytes = omit ? 0 : size;
    const files = current ?? new Map<string, ReportedDiff>();
    files.set(block.path, { path: block.path, kind: block.oldText === null ? 'add' : 'update', diff: omit ? '' : diff, ...(omit ? { diffOmitted: true } : {}), bytes });
    state.toolDiffs.set(id, files); state.diffBytes = withoutOld + bytes;
  }
  if (!warned || state.diffWarnings.has(id)) return false;
  state.diffWarnings.add(id);
  return true;
}

function takeDiffs(state: AcpStreamState, id: string): ReportedFileChange[] {
  const files = [...(state.toolDiffs.get(id)?.values() ?? [])];
  state.toolDiffs.delete(id);
  for (const file of files) state.diffBytes -= file.bytes;
  return files.map(({ bytes, ...change }) => change);
}

function isTerminalStatus(status: unknown): { done: boolean; ok: boolean } {
  const s = typeof status === 'string' ? status.toLowerCase() : '';
  if (s === 'completed' || s === 'done' || s === 'success') return { done: true, ok: true };
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') {
    return { done: true, ok: false };
  }
  return { done: false, ok: true };
}

/**
 * 解析 session/update 通知的 update 对象（sessionUpdate / session_update / 顶层 sessionUpdate）。
 */
export function mapAcpSessionUpdate(
  state: AcpStreamState,
  update: unknown
): GuiDriverStreamEvent[] {
  const u = asRecord(update);
  const kind = String(u.sessionUpdate ?? u.session_update ?? u.type ?? '');
  switch (kind) {
    case 'agent_message_chunk': {
      const delta = contentText(u.content) || blocksText(u.content);
      return delta ? [{ type: 'text-delta', delta }] : [];
    }
    case 'agent_thought_chunk': {
      const delta = contentText(u.content) || blocksText(u.content);
      return delta ? [{ type: 'thinking-delta', delta }] : [];
    }
    case 'user_message_chunk':
      return [];
    case 'tool_call':
    case 'tool_call_update': {
      const id = toolCallId(u);
      if (state.endedTools.has(id)) return [];
      const previous = state.toolCalls.get(id);
      const qwen = state.agentId === 'qwen';
      const tool: AcpToolCall = {
        name: label(u.name) ?? (qwen ? label(asRecord(u._meta).toolName) : undefined) ?? previous?.name,
        title: label(u.title) ?? previous?.title,
        kind: label(u.kind) ?? previous?.kind,
        input: inputOf(u) ?? previous?.input,
        locations: Array.isArray(u.locations) ? u.locations : previous?.locations
      };
      state.toolCalls.set(id, tool);
      const name = toolNameOf(tool, id);
      const term = isTerminalStatus(u.status);
      const events: GuiDriverStreamEvent[] = [];
      if (!previous || name !== toolNameOf(previous, id) || tool.kind !== previous.kind ||
          tool.input !== previous.input || tool.locations !== previous.locations) {
        const locations = tool.locations?.length ? tool.locations : undefined;
        events.push({
          type: previous ? 'tool-update' : 'tool-start',
          toolCallId: id,
          toolName: name,
          // Review also consumes protocol locations. The chat card uses the
          // actual arguments when the agent supplied them.
          input: locations ? { ...tool.input, locations } : tool.input ?? {},
          ...(locations && tool.input ? { displayInput: tool.input } : {}),
          ...(tool.kind ? { toolKind: tool.kind } : {}),
          ...(term.done ? { reviewLate: true } : {})
        });
      }
      if (rememberDiffs(state, id, u.content)) events.push({ type: 'review-warning', message: '引擎差异达到大小上限，部分改动未记录' });
      if (term.done) {
        state.toolCalls.delete(id);
        state.endedTools.add(id);
        const reviewChanges = takeDiffs(state, id);
        events.push({
          type: 'tool-result',
          toolCallId: id,
          toolName: name,
          ok: term.ok,
          // Qwen's raw read/search output can be empty or a short status summary.
          output: resultText(u, qwen && (!term.ok || tool.kind === 'read' || tool.kind === 'search')),
          ...(term.ok && reviewChanges.length ? { reviewChanges } : {})
        });
      }
      return events;
    }
    case 'available_commands_update': {
      const raw = Array.isArray(u.availableCommands)
        ? u.availableCommands
        : Array.isArray(u.available_commands)
          ? u.available_commands
          : [];
      const commands = raw
        .map((c) => asRecord(c))
        .map((c) => ({
          name: String(c.name ?? c.command ?? '').trim(),
          ...(typeof c.description === 'string' ? { description: c.description } : {}),
          ...(typeof c.input === 'string'
            ? { inputHint: c.input }
            : typeof (c.input as { hint?: string } | undefined)?.hint === 'string'
              ? { inputHint: (c.input as { hint: string }).hint }
              : {})
        }))
        .filter((c) => c.name);
      return [{ type: 'available-commands', commands }];
    }
    case 'current_mode_update': {
      const modeId = String(u.currentModeId ?? u.current_mode_id ?? u.modeId ?? '').trim();
      if (!modeId) return [];
      return [
        {
          type: 'current-mode',
          modeId,
          ...(typeof u.name === 'string' ? { name: u.name } : {})
        }
      ];
    }
    default:
      return [];
  }
}
