import type { ExtensionAPI, ExtensionContext, ProjectedSessionEntry, SessionBoundaryDraft, SessionEntry } from '@earendil-works/pi-coding-agent';
import { normalizeAutoCompactConfig, type AutoCompactConfig } from '../../shared/autoCompact';
import { CORE_CONTEXT_SKILL_PATH } from '../metaAgent/hostSkillPaths';

export const CORE_CONTEXT_TOOL = 'core_context';
const MARK = 'muster.context.v1';
const RANGE = 'muster.range.v1';
const UNDO = 'muster.range.undo.v1';
const PAGE = 6000;
const MIN_RESULT = 6000;
const MAX_SUMMARY = 12000;
const READ_RESULTS = new Set(['read', 'ls', 'grep', 'find', 'bash', 'powershell',
  'host_sessions_observe', 'sessions_observe', 'host_memory_list', 'memory_list']);
const DIAGNOSTIC = /\b(error|fatal|fail(?:ed|ure)?|exception|panic|warning|exit[ _-]?code|assertion|traceback)\b|错误|失败|异常/i;
const IMPORTANT = /必须|不要|禁止|口令|方案|部署区域|\b(?:must\b|never\b|required\b|region\s*(?:is\b|=)|pinned to\b)/i;

type MessageEntry = Extract<SessionEntry, { type: 'message' }>;
type AssistantContent = Extract<MessageEntry['message'], { role: 'assistant' }>['content'][number];
function publicPart(part: AssistantContent | { type: 'image' }): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'toolCall') return JSON.stringify({ name: part.name, id: part.id, arguments: part.arguments });
  return part.type === 'image' ? '[image]' : '';
}

/** Only material actually exposed in conversation. Never return tool details, private
 * extension entries, system messages, reasoning signatures, or sibling-branch data. */
export function sourceText(entry: SessionEntry): string | undefined {
  if (entry.type === 'custom') return rangeData(entry)?.summary;
  if (entry.type === 'compaction') return entry.summary;
  if (entry.type !== 'message') return;
  const msg = entry.message;
  if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'toolResult') return;
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return;
  return msg.content.map(publicPart).filter(Boolean).join('\n');
}

function evidenceOffset(entry: SessionEntry, value: string, needle: RegExp): number {
  if (entry.type !== 'message' || entry.message.role !== 'assistant' ||
      !entry.message.content.some(p => p.type === 'toolCall' && p.name === CORE_CONTEXT_TOOL)) return value.search(needle);
  // Keep offsets in the original read() text, including skipped calls in a mixed group.
  let offset = 0;
  for (const part of entry.message.content) {
    const text = publicPart(part);
    if (!text) continue;
    if (part.type !== 'toolCall' || part.name !== CORE_CONTEXT_TOOL) {
      const at = text.search(needle);
      if (at >= 0) return offset + at;
    }
    offset += text.length + 1;
  }
  return -1;
}

function excerpt(text: string, id: string, toolName: string): string | undefined {
  if (text.length < MIN_RESULT) return;
  const header = `[Core excerpt · source ${id} · ${text.length} chars · core_context read]\n`;
  // Prefer preserving every distinct line, its order and repeat count. This
  // retains one-off facts even when they look like ordinary successful output.
  const runs: string[] = [];
  let previous = '', count = 0, length = 0;
  const flush = () => {
    const run = count > 1 ? `${previous}\n[previous line × ${count} total]` : previous;
    runs.push(run);
    length += run.length + 1;
  };
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/\r?\n$/, '');
    if (count && line === previous) { count++; continue; }
    if (count) flush();
    if (length > 2800) break;
    previous = line;
    count = 1;
  }
  if (length <= 2800 && count) {
    flush();
    const card = header + runs.join('\n');
    if (card.length <= 3000 && card.length < text.length / 2) return card;
  }
  // Source files and search results commonly contain a unique fact on every
  // line. Let the model choose what to distill after seeing those results.
  if (['read', 'grep', 'find', 'ls'].includes(toolName)) return;
  const diagnostics = new Set<string>();
  let size = 0;
  // A diagnostic in the middle of a long result must survive, including its line.
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    const line = match[0];
    if ((!DIAGNOSTIC.test(line) && !IMPORTANT.test(line)) || diagnostics.has(line)) continue;
    size += line.length + 1;
    if (size > 2600) return;
    diagnostics.add(line);
  }
  const head = text.split('\n', 1)[0].slice(0, 200);
  const tail = text.slice(-720).trimEnd().split('\n').slice(-3).join('\n');
  const middle = [...diagnostics].filter(line => !head.includes(line) && !tail.includes(line));
  const card = header + [head, '…', ...middle, tail].join('\n');
  return card.length < text.length / 2 ? card : undefined;
}

type Manager = ExtensionContext['sessionManager'];
type Checkpoint = { owner: string; level: number; previous?: string; sources: string[] };
export function rangeData(entry: SessionEntry) {
  if (entry.type !== 'custom' || entry.customType !== RANGE) return;
  const data = entry.data as (Checkpoint & {summary: string}) | undefined;
  if (data?.owner === MARK && typeof data.summary === 'string' && Array.isArray(data.sources)) return data;
}

export function checkpoint(entry: SessionEntry): Checkpoint | undefined {
  if (entry.type === 'custom') return rangeData(entry);
  if (entry.type !== 'compaction') return;
  const data = entry.details as Partial<Checkpoint> | undefined;
  if (data?.owner === MARK && Number.isInteger(data.level) && Array.isArray(data.sources)) return data as Checkpoint;
}

/** Preserve the latest assistant/tool group. Older tool rounds in a single
 * long user turn may fold; pinnedEvidence carries that user's exact request. */
function foldable(rows: ProjectedSessionEntry[]) {
  let hasHistory = false;
  const boundaries: ProjectedSessionEntry[] = [];
  for (const row of rows) {
    const msg = row.messages[0];
    if (!msg || row.sourceEntry.type !== 'message') continue;
    if (hasHistory && (msg.role === 'user' || msg.role === 'assistant')) boundaries.push(row);
    if (msg.role === 'toolResult' || msg.role === 'assistant') hasHistory = true;
  }
  return boundaries;
}

function measureFoldRow(row: ProjectedSessionEntry, pending: Set<string>): number {
  let visibleSize = 0;
  const msg = row.messages[0];
  if (msg.role !== 'user' && msg.role !== 'toolResult' && msg.role !== 'assistant') throw new Error('Protected message in range.');
  if (msg.role !== 'toolResult' && pending.size) throw new Error('Incomplete tool group in range.');
  if (msg.role === 'toolResult') {
    if (!pending.delete(msg.toolCallId)) throw new Error('Unpaired tool result in range.');
  }
  if (msg.role === 'assistant' && (msg.stopReason === 'error' || msg.stopReason === 'aborted')) throw new Error('Preserve interrupted assistant response.');
  if (typeof msg.content === 'string') visibleSize += msg.content.length;
  else for (const part of msg.content) {
    if (part.type === 'toolCall') {
      if (pending.has(part.id)) throw new Error('Duplicate tool call in range.');
      pending.add(part.id);
      visibleSize += JSON.stringify(part.arguments).length;
    } else if (part.type === 'text') visibleSize += part.text.length;
    else if (part.type !== 'thinking') throw new Error('Preserve media in this range.');
  }
  return visibleSize;
}

function planFold(rows: ProjectedSessionEntry[], keep: string, summary: string, start?: string) {
  if (!summary.trim() || summary.length > MAX_SUMMARY) throw new Error('Supply a non-empty summary of at most 12000 characters.');
  if (!foldable(rows).some(row => row.sourceEntry.id === keep)) throw new Error('Boundary is stale. Use status to select a retained entry.');
  if (start) {
    const from = rows.findIndex(row => row.sourceEntry.id === start);
    if (from < 0 || from >= rows.findIndex(row => row.sourceEntry.id === keep) ||
        !['user','assistant'].includes(rows[from].messages[0]?.role)) throw new Error('Range start is stale or splits a tool group.');
    rows = rows.slice(from);
  }
  const sources: string[] = [];
  const pending = new Set<string>();
  let previous: string | undefined;
  let level = 1;
  let visibleSize = 0;
  for (const row of rows) {
    const entry = row.sourceEntry;
    if (entry.id === keep) break;
    if (!row.messages.length) continue;
    if (entry.type === 'compaction') {
      previous = entry.id;
      level = (checkpoint(entry)?.level ?? 0) + 1;
      visibleSize += entry.summary.length;
      continue;
    }
    // Pi carries the active system message on native checkpoints. Range
    // projection replaces only the explicitly collected conversational IDs.
    if (entry.type === 'message' && entry.message.role === 'system') continue;
    if (entry.type === 'custom_message' && entry.customType === MARK) continue;
    if (entry.type !== 'message') throw new Error('This range contains a protected host message.');
    visibleSize += measureFoldRow(row, pending);
    sources.push(entry.id);
  }
  if (pending.size) throw new Error('Incomplete tool group at boundary.');
  return { sources, previous, level, visibleSize, summary: summary.trim() };
}

function evidenceQuote(source?: SessionEntry): string | undefined {
  if (source?.type !== 'message') return;
  const id = source.id;
  const msg = source.message;
  if (msg.role === 'user' || (msg.role === 'toolResult' && msg.isError)) {
    return JSON.stringify({ role: msg.role, source: id, text: sourceText(source) ?? '' });
  } else if (msg.role === 'toolResult' && READ_RESULTS.has(msg.toolName)) {
    const lines = new Set<string>();
    for (const [line] of (sourceText(source) ?? '').matchAll(/[^\r\n]+/g)) {
      if (DIAGNOSTIC.test(line) || IMPORTANT.test(line)) lines.add(line);
    }
    if (lines.size) return JSON.stringify({ role: msg.role, source: id, text: [...lines].join('\n') });
  }
}

const evidenceSizes = new WeakMap<SessionEntry, number>();
function evidenceSize(entry: SessionEntry) {
  const cached = evidenceSizes.get(entry);
  if (cached !== undefined) return cached;
  const size = evidenceQuote(entry)?.length ?? 0;
  evidenceSizes.set(entry, size);
  return size;
}

interface FoldCandidate { start?: string; first: string; keep: string; count: number; net: number }

/** Inspect complete groups in model order. A protected group ends the current
 * span; later text groups can form a separately reversible range. */
export function recommendCoreFold(rows: ProjectedSessionEntry[], highPressure: boolean) {
  const boundaries = foldable(rows);
  const lastKeep = boundaries.at(-2)?.sourceEntry.id;
  if (!lastKeep) return;
  const previous = new Map<string, number>();
  for (const { sourceEntry } of rows) {
    if (sourceEntry.type !== 'custom_message' || sourceEntry.customType !== MARK) continue;
    const details = sourceEntry.details as Partial<FoldCandidate> | undefined;
    if (details?.first && typeof details.net === 'number') previous.set(details.first, details.net);
  }
  // UTF-16 characters, never provider tokens. Reserve room for a useful
  // summary and its envelope in addition to the exact protected quotations.
  const threshold = highPressure ? 4096 : 32000;
  let best: FoldCandidate | undefined;
  let first: string | undefined;
  let prefix = true, net = 0, count = 0;
  const pending = new Set<string>();
  for (const row of rows) {
    const entry = row.sourceEntry, msg = row.messages[0];
    if (!msg || (entry.type === 'message' && msg.role === 'system') ||
        (entry.type === 'custom_message' && entry.customType === MARK)) continue;
    // A Core prefix checkpoint carries forward its pinned evidence. Give its
    // summary no credit in the estimate, but permit the next generation.
    if (!first && prefix && entry.type === 'compaction' && checkpoint(entry)) continue;
    const boundary = msg.role === 'user' || msg.role === 'assistant';
    if (boundary && first && !pending.size && net - 2048 >= threshold) {
      const saved = net - 2048;
      const last = previous.get(first);
      if ((last === undefined || saved - last >= Math.max(threshold / 2, last / 4)) && (!best || saved > best.net))
        best = { first, start: prefix ? undefined : first, keep: entry.id, count, net: saved };
    }
    if (entry.id === lastKeep) break;
    if (!first && !boundary) { prefix = false; continue; }
    try {
      if (entry.type !== 'message' || (boundary && pending.size)) throw new Error('Protected group');
      const size = measureFoldRow(row, pending);
      first ??= entry.id;
      net += size - evidenceSize(entry);
      count++;
    } catch {
      first = undefined; prefix = false; net = 0; count = 0; pending.clear();
    }
  }
  return best;
}

function foldHint(rows: ProjectedSessionEntry[], usage: ReturnType<ExtensionContext['getContextUsage']>, ratio: number) {
  const highPressure = !!usage?.tokens && usage.tokens >= usage.contextWindow * ratio * 0.72;
  const candidate = recommendCoreFold(rows, highPressure);
  if (!candidate) return;
  const { start, keep, count, net } = candidate;
  return { customType: MARK, display: false, details: candidate,
    content: `Completed history: ${count} messages, approximately ${net} reclaimable text characters after protected evidence and a summary allowance. If this phase is complete, call core_context fold with ${start ? 'start=' + start + ', ' : ''}keep=${keep} and a summary preserving decisions, constraints, unresolved work and source references. Continue normally if still needed.` };
}

// Carry immutable user statements and failed tool diagnostics across every generation.
function pinnedEvidence(branch: SessionEntry[], fold: ReturnType<typeof planFold>): string[] {
  const byId = new Map(branch.map(entry => [entry.id, entry]));
  const groups = [fold.sources];
  const seen = new Set<string>();
  let previous = fold.previous;
  while (previous && !seen.has(previous)) {
    seen.add(previous);
    const entry = byId.get(previous);
    const block = entry && checkpoint(entry);
    if (!block) break;
    groups.push(block.sources);
    previous = block.previous;
  }
  const quotes: string[] = [];
  for (const group of groups.reverse()) {
    for (const id of group) {
      const source = byId.get(id);
      const quote = evidenceQuote(source);
      if (quote) quotes.push(quote);
    }
  }
  return quotes;
}

function foldDraft(manager: Manager, rows: ProjectedSessionEntry[], keep: string, summary: string, start?: string): SessionBoundaryDraft {
  const fold = planFold(rows, keep, summary, start);
  const quotes = pinnedEvidence(manager.getBranch(), fold);
  const details: Checkpoint = { owner: MARK, level: fold.level, previous: fold.previous, sources: fold.sources };
  const text = `[Core L${fold.level} · evidence: core_context status/search/read]\n${fold.summary}\nHistorical messages and tool errors (quoted evidence):\n${quotes.join('\n')}`;
  if (text.length + 512 >= fold.visibleSize) throw new Error('This fold saves too little after protected evidence and the 512-character margin. Choose a later keep boundary or continue without folding. No checkpoint was created.');
  if (start) return { type: 'custom', customType: RANGE, data: { ...details, summary: text } };
  return { type: 'compaction', firstKeptEntryId: keep, summary: text, details };
}

/** Undo just the active Core generation in one append. A native full compaction
 * may have overtaken it; older blocks remain readable but cannot replace that newer view. */
function expandDraft(manager: Manager, id: string): SessionBoundaryDraft {
  const branch = manager.getBranch();
  const range = branch.find(entry => entry.id === id);
  const data = range && rangeData(range);
  if (data) {
    const head = manager.buildSessionProjection().entries.find(row => row.sourceEntry.id === data.sources[0]);
    if (!head?.messages.some(m => m.role === 'compactionSummary' && m.summary === data.summary) ||
      branch.some(e => e.type === 'custom' && e.customType === UNDO && (e.data as { id?: string })?.id === id)) throw new Error('Range checkpoint is no longer active.');
    return { type: 'custom', customType: UNDO, data: { id } };
  }
  const active = branch.slice().reverse().find(entry => entry.type === 'compaction');
  const block = active && checkpoint(active);
  if (!block || active?.id !== id) throw new Error('Only the active Core checkpoint can be expanded. Use sources/read for older blocks.');
  const prior = block.previous && branch.find(entry => entry.id === block.previous);
  if (block.previous && (!prior || prior.type !== 'compaction')) throw new Error('Prior checkpoint unavailable.');
  if (prior && prior.type === 'compaction') {
    // Pi encodes "keep none" by pointing a checkpoint at itself. Reusing that
    // ID for a later checkpoint starts the retained suffix at the old marker.
    return { type: 'compaction', firstKeptEntryId: prior.firstKeptEntryId, summary: prior.summary, details: prior.details };
  }
  return { type: 'compaction', firstKeptEntryId: block.sources[0], summary: 'Earlier Core fold expanded; original messages follow.' };
}

function cutConsumed(rows: ProjectedSessionEntry[], current: Set<string>, assistantId?: string): SessionBoundaryDraft[] {
  const edits: SessionBoundaryDraft[] = [];
  const changed = new Set<string>();
  // Only visit the newest work; prior edits and user messages are prefix fences.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i], entry = row.sourceEntry;
    if (entry.type === 'context_edit') { changed.add(entry.targetId); continue; }
    if (entry.type === 'compaction' || changed.has(entry.id)) break;
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') break;
    if (current.has(entry.id) || assistantId === entry.id || entry.message.role !== 'toolResult') continue;
    const msg = entry.message;
    if (msg.isError || !READ_RESULTS.has(msg.toolName) || msg.content?.length !== 1 || msg.content[0]?.type !== 'text') continue;
    if (/^\s*\[stderr\]|(?:exit[ _]code[":=\s]+|command finished with exit code\s+)[1-9]\d*\b/i.test(msg.content[0].text)) continue;
    const projected = row.messages[0];
    if (projected?.role !== 'toolResult' || projected.content?.length !== 1 || projected.content[0]?.type !== 'text' ||
      projected.content[0].text !== msg.content[0].text) continue;
    const card = excerpt(msg.content[0].text, entry.id, msg.toolName);
    if (card) edits.push({ type: 'context_edit', targetId: entry.id, replacement: { content: card } });
  }
  return edits.reverse();
}

/** A single historical tool result can also be distilled in place. Retain the
 * same source handle as its mechanical excerpt and keep the entire left prefix. */
function semanticEdit(rows: ProjectedSessionEntry[], id: string, summary: string): SessionBoundaryDraft {
  const row = rows.find(item => item.sourceEntry.id === id);
  const entry = row?.sourceEntry;
  const shown = row?.messages[0];
  if (!entry || entry.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.isError ||
      !READ_RESULTS.has(entry.message.toolName) || shown?.role !== 'toolResult' || shown.content.length !== 1 ||
      shown.content[0].type !== 'text' || entry.message.content.length !== 1 || entry.message.content[0].type !== 'text') {
    throw new Error('Choose an active, successful text result from a supported tool.');
  }
  if (!summary.trim() || summary.length > MAX_SUMMARY) throw new Error('Supply a bounded non-empty summary.');
  const original = entry.message.content[0].text;
  const facts = new Set<string>();
  for (const [line] of original.matchAll(/[^\r\n]+/g)) {
    if (DIAGNOSTIC.test(line) || IMPORTANT.test(line)) facts.add(line);
  }
  const text = `[Core summary · source ${id} · core_context read]\n${summary.trim()}\n${[...facts].join('\n')}`.trimEnd();
  if (text.length + 128 >= shown.content[0].text.length) throw new Error('Summary would not reduce this result. Use fold(keep,summary) for a larger phase.');
  return { type: 'context_edit', targetId: id, replacement: { content: text } };
}

function page(value: string, offset: number, maxResultChars?: number) {
  const slice = (length: number) => ({
    offset, total: value.length, text: value.slice(offset, offset + length),
    next: offset + length < value.length ? offset + length : null
  });
  let length = PAGE;
  let result = slice(length);
  // The mode trims the serialized tool response. Account for JSON escaping
  // as well as the envelope so a recovery page always keeps its next cursor.
  while (maxResultChars && JSON.stringify(result).length > maxResultChars && length > 1) {
    length = Math.max(1, Math.floor(length / 2));
    result = slice(length);
  }
  return result;
}

export function createCoreContextExtension(config: () => AutoCompactConfig | undefined, maxResultChars?: number) {
  return (api: ExtensionAPI) => {
    api.registerTool({
      name: CORE_CONTEXT_TOOL, label: 'Core context',
      description: `Manage this branch's context. Use status and fold to summarize completed work, search and read to recover original evidence, sources and expand to inspect or restore checkpoints. See ${CORE_CONTEXT_SKILL_PATH} for arguments and examples.`,
      parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
        action: { type: 'string', enum: ['status', 'search', 'read', 'sources', 'fold', 'expand'] },
        id: { type: 'string' }, start: { type: 'string' }, keep: { type: 'string' }, summary: { type: 'string', maxLength: MAX_SUMMARY },
        query: { type: 'string', maxLength: 512 }, offset: { type: 'integer', minimum: 0 } } } as const,
      executionMode: 'sequential',
      async execute(_call, args, signal, _update, ctx) {
        signal?.throwIfAborted();
        const sm = ctx.sessionManager;
        const branch = sm.getBranch();
        if (args.action === 'fold' || args.action === 'expand') {
          const invocation = branch.slice().reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
          if (invocation?.type === 'message' && invocation.message.role === 'assistant' &&
              invocation.message.content.filter(part => part.type === 'toolCall' && part.name === CORE_CONTEXT_TOOL &&
                (part.arguments.action === 'fold' || part.arguments.action === 'expand')).length > 1) {
            throw new Error('Submit one history change per tool group.');
          }
        }
        const offset = args.offset ?? 0;
        const budget = maxResultChars ?? Infinity;
        const fits = (value: unknown) => JSON.stringify(value).length <= budget;
        let result: unknown;
        switch (args.action) {
          case 'read':
          case 'sources': {
            const source = branch.find(entry => entry.id === args.id);
            if (!source) throw new Error('Unknown source on this branch.');
            if (args.action === 'read') {
              const value = sourceText(source);
              if (value === undefined) throw new Error('Entry has no public conversation text.');
              result = page(value, offset, maxResultChars);
            } else {
              const block = checkpoint(source);
              if (!block) throw new Error('Not a Core checkpoint.');
              const sources = block.sources.slice(offset, offset + 64);
              const response = { level: block.level, previous: block.previous, sources, next: null as number | null };
              while (sources.length > 1 && !fits({ ...response, next: offset + sources.length })) sources.pop();
              if (offset + sources.length < block.sources.length) response.next = offset + sources.length;
              result = response;
            }
            break;
          }
          case 'search': {
            if (!args.query?.trim()) throw new Error('Supply a literal query.');
            const needle = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
            const hits = [];
            let i = offset;
            for (; i < branch.length && hits.length < 12; i++) {
              const entry = branch[i];
              // Retrieval calls can contain copies of old evidence. Prefer originals.
              if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === CORE_CONTEXT_TOOL) continue;
              const value = sourceText(entry);
              const at = value === undefined ? -1 : evidenceOffset(entry, value, needle);
              if (value === undefined || at < 0) continue;
              const hit = { id: entry.id, offset: at, text: value.slice(Math.max(0, at - 80), at + 240) };
              if (hits.length && !fits({ hits: [...hits, hit], next: i + 1 })) break;
              while (hit.text && !fits({ hits: [...hits, hit], next: i + 1 })) {
                hit.text = value.slice(at, at + Math.floor(hit.text.length / 2));
              }
              hits.push(hit);
            }
            result = { hits, next: i < branch.length ? i : null };
            break;
          }
          case 'status': {
            const rows = sm.buildSessionProjection().entries;
            // Most recent choices generally free the most space. Include a
            // role so the model can distinguish a tool-call entry from a user
            // handoff even when their text previews mention the same task.
            const positions = new Map(branch.map((entry, index) => [entry.id, index + 1]));
            const available = foldable(rows).reverse();
            const boundaries: Array<{ keep: string; role: string; preview?: string }> = [];
            const response = { usage: ctx.getContextUsage(), checkpoints: branch.filter(entry => checkpoint(entry)).slice(-12).map(entry => entry.id),
              boundaries, next: null as number | null };
            for (const { sourceEntry, messages } of available) {
              const position = positions.get(sourceEntry.id)!;
              // Positive cursors point into the append-only branch, not into a
              // reversed array that grows with each status invocation.
              if (offset && position > offset) continue;
              const item = { keep: sourceEntry.id, role: messages[0].role, preview: sourceText(sourceEntry)?.slice(0, 120) };
              response.next = position;
              if (boundaries.length >= 24) break;
              boundaries.push(item);
              if (!fits(response)) {
                if (boundaries.length > 1) { boundaries.pop(); break; }
                while (response.checkpoints.length > 1 && !fits(response)) response.checkpoints.shift();
                while (item.preview && !fits(response)) item.preview = item.preview.slice(0, Math.floor(item.preview.length / 2));
                if (!item.preview) delete item.preview;
              }
              response.next = null;
            }
            result = response;
            break;
          }
          case 'fold': {
            if (!!args.keep === !!args.id || (args.start && !args.keep)) throw new Error('Specify keep (optionally with start), or id.');
            const rows = sm.buildSessionProjection().entries;
            if (args.id) semanticEdit(rows, args.id, args.summary ?? '');
            else foldDraft(sm, rows, args.keep!, args.summary ?? '', args.start);
            // The completed, persisted tool invocation is the proposal. At turn_end
            // revalidate it against the current projection before one checkpoint append.
            result = { proposed: true, start: args.start, keep: args.keep, id: args.id, effective: 'Check status after the tool group settles.' };
            break;
          }
          case 'expand': {
            expandDraft(sm, args.id ?? '');
            result = { proposed: true, expand: args.id };
            break;
          }
          default: throw new Error('Unknown context action.');
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
      }
    });
    api.on('before_agent_start', (event, ctx) => {
      if (event.messageType !== 'user' || !api.getActiveTools().includes(CORE_CONTEXT_TOOL)) return;
      const settings = normalizeAutoCompactConfig(config());
      if (!settings.enabled) return;
      const message = foldHint(ctx.sessionManager.buildSessionProjection().entries, ctx.getContextUsage(), settings.ratio);
      if (message) return { message };
    });
    api.on('turn_end', (event, ctx) => {
      if (event.outcome !== 'completed' || !api.getActiveTools().includes(CORE_CONTEXT_TOOL) || ctx.hasPendingMessages()) return;
      const rows = event.context.contextEntries;
      if (event.message.role !== 'assistant') return;
      for (const part of event.message.content) {
        if (part.type !== 'toolCall' || part.name !== CORE_CONTEXT_TOOL || !['fold', 'expand'].includes(String(part.arguments.action))) continue;
        if (!event.toolResults.some(r => r.toolCallId === part.id && r.toolName === CORE_CONTEXT_TOOL && !r.isError)) continue;
        let draft: SessionBoundaryDraft;
        if (part.arguments.action === 'expand') draft = expandDraft(ctx.sessionManager, String(part.arguments.id));
        else if (part.arguments.id) draft = semanticEdit(rows, String(part.arguments.id), String(part.arguments.summary));
        else draft = foldDraft(ctx.sessionManager, rows, String(part.arguments.keep), String(part.arguments.summary),
          typeof part.arguments.start === 'string' ? part.arguments.start : undefined);
        return { entries: [...event.entries, draft] };
      }
      const settings = config();
      if (settings?.enabled === false) return;
      const drafts = settings?.micro?.enabled === false ? [] : cutConsumed(rows, new Set(event.toolResultEntryIds), event.messageEntryId);
      if (event.toolResults.length) {
        // Score the text that will actually remain after this boundary's excerpts.
        const excerpts = new Map<string, string>();
        for (const draft of drafts) {
          if (draft.type === 'context_edit' && typeof draft.replacement?.content === 'string')
            excerpts.set(draft.targetId, draft.replacement.content);
        }
        const projected = excerpts.size ? rows.map(row => {
          const text = excerpts.get(row.sourceEntry.id);
          const msg = row.messages[0];
          if (text === undefined || msg?.role !== 'toolResult') return row;
          return { ...row, messages: [{ ...msg, content: [{ type: 'text' as const, text }] }] };
        }) : rows;
        const message = foldHint(projected, ctx.getContextUsage(), normalizeAutoCompactConfig(settings).ratio);
        if (message) drafts.push({ type: 'custom_message', ...message });
      }
      if (drafts.length) return { entries: [...event.entries, ...drafts] };
    });
  };
}
