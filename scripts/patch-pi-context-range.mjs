import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A single native custom entry commits a whole range. Replaying the same
// branch (including SDK compaction and fork previews) must yield the same view.
function projectCoreRanges(rows) {
  const active = new Map();
  for (const { sourceEntry: entry } of rows) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === 'muster.range.undo.v1') active.delete(entry.data?.id);
    if (entry.customType === 'muster.range.v1') active.set(entry.id, entry);
  }
  if (!active.size) return;
  const positions = new Map(rows.map((row, i) => [row.sourceEntry.id, i]));
  for (const { data, timestamp } of active.values()) {
    if (data?.owner !== 'muster.context.v1' || !Array.isArray(data.sources) || !data.sources.length || typeof data.summary !== 'string') continue;
    const indices = data.sources.map(id => positions.get(id));
    if (indices.some((i, offset) => i === undefined || (offset && i <= indices[offset - 1]) || !rows[i].messages.length)) continue;
    rows[indices[0]].messages = [createCompactionSummaryMessage(data.summary, 0, timestamp)];
    for (const i of indices.slice(1)) rows[i].messages = [];
  }
}

const file = path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'core', 'session-manager.js');
const source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const anchor = '    return {\n        entries: projectedEntries,';
const original = source.replace(/function projectCoreRanges\(rows\) \{[\s\S]*?\n\}\n(?=export function buildSessionProjection\()/, '').replace('    projectCoreRanges(projectedEntries);\n', '');
if (original.split(anchor).length !== 2 || original.split('export function buildSessionProjection(').length !== 2 ||
    original.includes('projectCoreRanges')) throw new Error('Pi session projection changed. Review the Core range patch.');
const patched = original.replace('export function buildSessionProjection(', projectCoreRanges.toString() + '\nexport function buildSessionProjection(')
  .replace(anchor, '    projectCoreRanges(projectedEntries);\n' + anchor);
if (patched !== source) fs.writeFileSync(file, patched);
