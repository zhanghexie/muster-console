import { t } from '../../shared/i18n';
import { jsonEqual, type GuiChatMessage, type GuiToolCallView } from '../../shared/guiWorker';
import { replayMessage, type SessionReplayMaterial, type SessionReplayStep } from '../../shared/sessionReplay';
import type { EventEnvelope, SessionRangeQuery } from './contracts';

interface Track {
  message: GuiChatMessage;
  steps: SessionReplayStep[];
  /** Length consumed for text, zero for a tool that has appeared. */
  lengths: number[];
  tools: Map<string, { index: number; latest: GuiToolCallView }>;
}
type StreamEvent =
  | { kind: 'delta'; messageId: string; deltaKind: 'text' | 'thinking'; delta: string }
  | { kind: 'tool'; messageId: string; part: { kind: 'tool'; tool: GuiToolCallView } };

function addStep(track: Track, at: number, event: StreamEvent): boolean {
  const { parts } = track.message;
  let index = track.lengths.length;
  if (event.kind === 'tool') {
    const tool = event.part.tool;
    index = track.tools.get(tool.id)?.index ?? index;
    const part = parts[index];
    if (part?.kind !== 'tool' || part.tool.id !== tool.id || part.tool.name !== tool.name) return false;
    track.tools.set(tool.id, { index, latest: tool });
    track.lengths[index] = 0;
    track.steps.push({ at, partIndex: index, tool });
  } else {
    const last = parts[index - 1];
    if (last?.kind === event.deltaKind && track.lengths[index - 1] < last.text.length) index--;
    const part = parts[index];
    const offset = track.lengths[index] ?? 0;
    if (part?.kind !== event.deltaKind || !part.text.startsWith(event.delta, offset)) return false;
    track.lengths[index] = offset + event.delta.length;
    track.steps.push({ at, partIndex: index, end: track.lengths[index] });
  }
  return true;
}

/** Freeze the visible messages and journal revision together before the first asynchronous read. */
export async function guiReplayMaterial(source: GuiChatMessage[], lastSeq: number,
  read: (query: SessionRangeQuery) => Promise<EventEnvelope[]>, beforeMessageIds?: readonly string[]): Promise<SessionReplayMaterial> {
  if (beforeMessageIds !== undefined) {
    if (!Array.isArray(beforeMessageIds) || !beforeMessageIds.every(id => typeof id === 'string' && id.length > 0)) {
      throw new Error(t('回放片段的消息编号无效'));
    }
    const selected = new Set(beforeMessageIds);
    const first = source.findIndex(message => selected.has(message.id));
    // A clip from another conversation follows the target's existing transcript.
    const history = first < 0 ? source : source.slice(0, first);
    return { version: 1, messages: history.map(replayMessage) };
  }
  const messages = source.map(replayMessage);
  const candidates = new Map<string, Track>();
  for (const message of messages) {
    if (message.role === 'assistant') candidates.set(message.id, { message, steps: [], lengths: [], tools: new Map() });
  }
  for (let fromSeq = 1; fromSeq <= lastSeq && candidates.size;) {
    const page = await read({ fromSeq, toSeq: lastSeq, limit: 256 });
    const last = page.at(-1);
    if (!last || last.seq < fromSeq) throw new Error(t('读取会话回放期间事件记录发生变化，请重试'));
    for (const entry of page) {
      if (entry.type !== 'gui-session.delta' && entry.type !== 'gui-session.tool') continue;
      const event = entry.payload as StreamEvent;
      const track = candidates.get(event.messageId);
      if (track && !addStep(track, entry.createdAt, event)) candidates.delete(event.messageId);
    }
    fromSeq = last.seq + 1;
  }
  // A fork, edit or legacy checkpoint can contain final text with no corresponding stream.
  const tracks = Array.from(candidates.values()).filter(partsComplete)
    .map(({ message, steps }) => ({ messageId: message.id, steps }));
  return { version: 1, messages, tracks };
}

function partsComplete({ message, lengths, steps, tools }: Track): boolean {
  return steps.length > 0 && message.parts.length === lengths.length && message.parts.every((part, i) => {
    if (part.kind !== 'tool') return part.text.length === lengths[i];
    const last = tools.get(part.tool.id)?.latest;
    return last?.status === part.tool.status && last.output === part.tool.output && last.patch === part.tool.patch
      && jsonEqual(last.input, part.tool.input);
  });
}
