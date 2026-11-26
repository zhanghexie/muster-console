import { interleaveCompactionMarkers, type ChatCompactionMarker, type TranscriptStreamItem } from '../../../shared/chatCompaction';
import type { ChatSurfacePageState } from '../../../shared/chatSurface';

export type TranscriptRow<T> = (TranscriptStreamItem<T> & {
  decorations?: readonly ChatCompactionMarker[];
}) | { kind: 'gap'; index: number; hidden: boolean };

/** A sparse row source: neither allocation nor navigation scans the session's total. */
export function transcriptRows<T extends { id: string; createdAt: number }>(
  messages: readonly T[], markers: readonly ChatCompactionMarker[], page?: ChatSurfacePageState
) {
  const sparse = !!page?.slots;
  const rows = new Map<number, TranscriptRow<T>>();
  let length = 0;
  if (!sparse) {
    const dense = interleaveCompactionMarkers(messages, markers);
    dense.forEach((row, index) => rows.set(index, row));
    length = dense.length;
  } else {
    const positions = new Map(page!.slots!.map(slot => [slot.messageId, slot.index]));
    length = page!.total;
    for (const slot of page!.slots!) rows.set(slot.index, { kind: 'gap', index: slot.index, hidden: true });
    messages.forEach((message, srcIndex) => {
      const index = positions.get(message.id) ?? length++;
      rows.set(index, { kind: 'message', message, srcIndex });
    });
    // A marker shares its anchor's measured box. It never shifts absolute message
    // indexes when another page arrives. Unknown anchors wait for that page.
    const ordered = [...rows.entries()].filter((entry): entry is [number, Extract<TranscriptRow<T>, { kind: 'message' }>] => entry[1].kind === 'message');
    ordered.sort((a, b) => a[0] - b[0]);
    for (const marker of markers) {
      let anchor: typeof ordered[number] | undefined;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const entry = ordered[i]!;
        if (marker.status === 'running') {
          if (entry[0] === length - 1) anchor = entry;
          break;
        }
        const next = ordered[i + 1];
        if (entry[1].message.createdAt <= marker.createdAt &&
            (entry[0] === length - 1 || (next?.[0] === entry[0] + 1 && next[1].message.createdAt > marker.createdAt))) {
          anchor = entry;
          break;
        }
      }
      if (anchor) anchor[1].decorations = [...(anchor[1].decorations ?? []), marker];
    }
  }
  return {
    sparse, length,
    get(index: number): TranscriptRow<T> | undefined {
      if (index < 0 || index >= length) return undefined;
      return rows.get(index) ?? { kind: 'gap', index, hidden: false };
    },
    slice(start: number, end = length): TranscriptRow<T>[] {
      const result: TranscriptRow<T>[] = [];
      for (let index = Math.max(0, start); index < Math.min(end, length); index++) result.push(this.get(index)!);
      return result;
    },
    findIndex(predicate: (row: TranscriptRow<T>) => boolean): number {
      for (const [index, row] of rows) if (predicate(row)) return index;
      return -1;
    },
    some(predicate: (row: TranscriptRow<T>) => boolean): boolean { return this.findIndex(predicate) >= 0; }
  };
}
