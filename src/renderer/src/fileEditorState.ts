import type { FileEditorSnapshot } from '../../shared/panelState';

// Snapshot readers use live refs: autosave can become dirty without a React re-render.
const readers = new Set<() => FileEditorSnapshot | null>();

export function registerFileEditorState(read: () => FileEditorSnapshot | null): () => void {
  readers.add(read);
  return () => { readers.delete(read); };
}

export function readFileEditorStates(workspaceId: string): FileEditorSnapshot[] {
  return [...readers].flatMap(read => {
    const snapshot = read();
    return snapshot?.workspaceId === workspaceId ? [snapshot] : [];
  });
}
