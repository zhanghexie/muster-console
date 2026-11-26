export type TreeNavRow = {
  id: string;
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
};

export function moveListIndex(
  index: number,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
  length: number
): number {
  if (length === 0) {
    return -1;
  }

  const last = length - 1;

  if (index < 0 || index >= length) {
    return key === 'ArrowDown' || key === 'Home' ? 0 : last;
  }

  switch (key) {
    case 'ArrowUp':
      return Math.max(0, index - 1);
    case 'ArrowDown':
      return Math.min(last, index + 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
  }
}

export function nextTreeIndexOnArrow(
  rows: TreeNavRow[],
  index: number,
  key: 'ArrowLeft' | 'ArrowRight'
): { index: number; toggleId?: string } {
  const row = rows[index];
  if (!row) {
    return { index };
  }

  if (key === 'ArrowRight') {
    if (row.expandable && !row.expanded) {
      return { index, toggleId: row.id };
    }

    const next = rows[index + 1];
    if (next?.parentId === row.id) {
      return { index: index + 1 };
    }

    return { index };
  }

  if (row.expandable && row.expanded) {
    return { index, toggleId: row.id };
  }

  if (row.parentId == null) {
    return { index };
  }

  const parentIndex = rows.findIndex((r) => r.id === row.parentId);
  if (parentIndex === -1) {
    return { index };
  }

  return { index: parentIndex };
}
