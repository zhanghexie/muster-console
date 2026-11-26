import path from 'node:path';
import type { SessionEntry, SessionManager, SessionProjection } from '@earendil-works/pi-coding-agent';
import { checkpoint, rangeData, sourceText } from '../../../agent/coreContext';
import { compressionFields, type RequestCompression } from '../../../../shared/modelRequest';

export interface CompressionTrace {
  file: string;
  nativeId: string;
  items: RequestCompression[];
}

/** Resolve only active native edits whose replacement actually occurs in a sent field. */
export function traceRequestCompression(body: Buffer, leaf: string, manager: SessionManager, directory: string,
  project: (entries: SessionEntry[]) => SessionProjection): CompressionTrace {
  const sessionFile = manager.getSessionFile();
  const trace: CompressionTrace = { file: sessionFile ? path.relative(directory, sessionFile) : '', nativeId: manager.getSessionId(), items: [] };
  if (!body.includes('[Core ') && !body.includes('The conversation history before this point was compacted')) return trace;
  let payload: unknown;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return trace; }
  const fields = compressionFields(payload);
  if (!fields.size) return trace;
  const branch = manager.getBranch(leaf);
  if (branch.at(-1)?.id !== leaf) throw new Error('Recorded compression branch is unavailable');
  const byId = new Map(branch.map(entry => [entry.id, entry]));
  const rows = project(branch).entries;
  const visibleRanges = new Map<string, SessionEntry>();
  for (const entry of rows.map(row => row.sourceEntry)) {
    const data = rangeData(entry);
    if (data) visibleRanges.set(data.sources[0], entry);
    if (entry.type === 'custom' && entry.customType === 'muster.range.undo.v1') {
      const undone = byId.get((entry.data as { id: string }).id);
      const original = undone && rangeData(undone);
      if (original && visibleRanges.get(original.sources[0])?.id === undone!.id) visibleRanges.delete(original.sources[0]);
    }
  }
  const edits = new Set(rows.flatMap(row => row.sourceEntry.type === 'context_edit' ? [row.sourceEntry.targetId] : []));
  for (const { sourceEntry: entry, messages } of rows) {
    const projected = messages.find(m => m.role === 'compactionSummary');
    const range = visibleRanges.get(entry.id);
    const owner = range ?? entry;
    const block = checkpoint(owner);
    if (projected && (range || entry.type === 'compaction')) {
      for (const [field, text] of fields) {
        if (!text.endsWith('<summary>\n' + projected.summary + '\n</summary>')) continue;
        const expanded = !block && projected.summary === 'Earlier Core fold expanded; original messages follow.';
        let ids: string[] = [];
        if (block) ids = [...(block.previous ? [block.previous] : []), ...block.sources];
        else if (!expanded && entry.type === 'compaction') {
          // Resolve the visible prefix just before native compaction, including its prior summary.
          const before = project(branch.slice(0, branch.indexOf(entry))).entries;
          for (const row of before) {
            if (row.sourceEntry.id === entry.firstKeptEntryId) break;
            if (row.messages.length) ids.push(row.sourceEntry.id);
          }
        }
        const sources = ids.flatMap(id => {
          const original = byId.get(id);
          const value = original && sourceText(original);
          if (!original || value === undefined) return [];
          return [{ id, role: original.type === 'message' ? original.message.role : original.type, chars: value.length }];
        });
        trace.items.push({ kind: block ? 'checkpoint' : expanded ? 'expanded' : 'native', id: owner.id, level: block?.level, previous: block?.previous, path: field, sources });
        fields.delete(field);
        break;
      }
    } else if (edits.has(entry.id) && entry.type === 'message' && entry.message.role === 'toolResult') {
      const msg = messages[0];
      const part = msg?.role === 'toolResult' && msg.content[0];
      if (!part || part.type !== 'text') continue;
      const kind = part.text.startsWith('[Core excerpt · source ' + entry.id + ' ·') ? 'excerpt'
        : part.text.startsWith('[Core summary · source ' + entry.id + ' ·') ? 'summary' : null;
      if (!kind) continue;
      for (const [field, text] of fields) {
        if (text !== part.text) continue;
        trace.items.push({ kind, path: field, id: entry.id, tool: entry.message.toolName,
          sources: [{ id: entry.id, role: 'toolResult', chars: sourceText(entry)?.length ?? 0 }] });
        fields.delete(field);
        break;
      }
    }
  }
  return trace;
}
