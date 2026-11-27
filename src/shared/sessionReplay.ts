import { t } from './i18n';
import type { GuiChatMessage, GuiMessagePart, GuiToolCallView } from './guiWorker';

/** Offsets refer to the final text in UTF-16 units. Tool updates include the output visible at that instant. */
export type SessionReplayStep = { at: number; partIndex: number } & (
  { end: number } | { tool: GuiToolCallView }
);
export interface SessionReplayMaterial {
  version: 1;
  messages: GuiChatMessage[];
  tracks?: { messageId: string; steps: SessionReplayStep[] }[];
}
export type SessionReplaySource = string | SessionReplayMaterial | GuiChatMessage[];
export interface SessionReplayHandle {
  finished: Promise<'finished' | 'stopped'>;
  /** Restore the live view, including after the last frame. */
  stop(): void;
}
export type ReplaySession = (source?: SessionReplaySource, targetSessionId?: string,
  options?: { speed?: number }) => Promise<SessionReplayHandle>;

/** Only display data crosses the replay boundary. Live approvals and execution handles belong to the source. */
export function replayMessage(m: GuiChatMessage): GuiChatMessage {
  const { id, role, ts, parts, images, source, sourceAgent, host, steering, error, aborted, finishedAt, displayItems } = m;
  if (!id || (role !== 'user' && role !== 'assistant') || !Number.isFinite(ts) || !Array.isArray(parts) ||
      !parts.every(p => p && (p.kind === 'tool' ? !!p.tool?.id && typeof p.tool.name === 'string' :
        (p.kind === 'text' || p.kind === 'thinking') && typeof p.text === 'string'))) {
    throw new Error(t('会话回放素材包含无效的消息'));
  }
  return structuredClone({ id, role, ts, parts, images, source, sourceAgent, host, steering, error, aborted, finishedAt, displayItems });
}

function* syntheticSteps(message: GuiChatMessage): Generator<SessionReplayStep> {
  let at = message.ts;
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.kind === 'tool') {
      const { id, name, input, status } = part.tool;
      yield { at: at += 160, partIndex, tool: { id, name, input, status: 'running' } };
      if (status !== 'running') yield { at: at += 440, partIndex, tool: part.tool };
    } else {
      let end = 0;
      if (!part.text.length) yield { at, partIndex, end };
      for (const [chunk] of part.text.matchAll(/[\s\S]{1,5}/gu)) {
        end += chunk.length;
        yield { at: at += 55, partIndex, end };
      }
    }
  }
}

export interface SessionReplayFrame {
  delay: number;
  message: GuiChatMessage;
  /** First frame appends the message. Following frames replace just that row. */
  append: boolean;
  busy: boolean;
}

/** Pull-based fake response source. No UI, clock, network or tool executor is required. */
export function* sessionReplayFrames(material: SessionReplayMaterial): Generator<SessionReplayFrame> {
  const tracks = new Map(material.tracks?.map(track => [track.messageId, track.steps]));
  for (const [index, message] of material.messages.entries()) {
    if (message.role === 'user') {
      yield { delay: index ? 600 : 0, message, append: true, busy: true };
      continue;
    }
    const { id, role, ts } = message;
    let parts: GuiMessagePart[] = [];
    yield { delay: index ? 100 : 0, message: { id, role, ts, parts }, append: true, busy: true };
    let previous = ts;
    for (const step of tracks.get(id) ?? syntheticSteps(message)) {
      const finalPart = message.parts[step.partIndex];
      if (!Number.isFinite(step.at) || !Number.isInteger(step.partIndex) || step.partIndex < 0 ||
          step.partIndex > parts.length || !finalPart) throw new Error(t('会话回放片段与消息不匹配'));
      let part: GuiMessagePart;
      if ('tool' in step) {
        if (finalPart.kind !== 'tool' || step.tool?.id !== finalPart.tool.id || step.tool.name !== finalPart.tool.name)
          throw new Error(t('回放工具与消息不匹配'));
        part = { kind: 'tool', tool: step.tool };
      } else {
        if (finalPart.kind === 'tool' || !Number.isInteger(step.end) || step.end < 0 || step.end > finalPart.text.length)
          throw new Error(t('回放文字位置无效'));
        part = { kind: finalPart.kind, text: finalPart.text.slice(0, step.end) };
      }
      parts = parts.slice();
      parts[step.partIndex] = part;
      const at = Math.max(previous, step.at);
      yield { delay: at - previous, message: { id, role, ts, parts }, append: false, busy: true };
      previous = at;
    }
    yield { delay: 0, message, append: false, busy: false };
  }
}
