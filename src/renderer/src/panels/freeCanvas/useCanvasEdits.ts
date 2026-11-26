/**
 * 自由视图画布 · 编辑态：卡片备注 / 思路便签 / 连线标签 / 组名重命名。
 * 只存画布 layout（notes / stickies / edges[].label / groups[].label），不进会话元数据。
 * 从 FreeCanvas.tsx 原样拆出；提交/取消/变更的时序与持久化行为不变。
 */
import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { updateFreeViewLayout } from '../freeViewStore';

export interface CanvasEditValue {
  id: string;
  value: string;
}

export type EditStateSetter = Dispatch<SetStateAction<CanvasEditValue | null>>;
export type SelListSetter = Dispatch<SetStateAction<string[]>>;

export interface CanvasEditsOptions {
  /** 布局里的卡片备注（layout.notes ?? {}） */
  notes: Record<string, string>;
  setSelNodes: SelListSetter;
  setSelEdges: SelListSetter;
  setSelGroups: SelListSetter;
}

export function useCanvasEdits(options: CanvasEditsOptions): {
  noteEdit: CanvasEditValue | null;
  stickyEdit: CanvasEditValue | null;
  edgeLabelEdit: CanvasEditValue | null;
  groupRename: CanvasEditValue | null;
  setStickyEdit: EditStateSetter;
  setEdgeLabelEdit: EditStateSetter;
  setGroupRename: EditStateSetter;
  persistNote: (id: string, value: string) => void;
  commitNoteEdit: () => void;
  cancelNoteEdit: () => void;
  changeNoteEdit: (id: string, value: string) => void;
  startNoteEdit: (id: string) => void;
  clearNote: (id: string) => void;
  commitStickyEdit: () => void;
  cancelStickyEdit: () => void;
  changeStickyEdit: (id: string, value: string) => void;
  commitEdgeLabel: () => void;
  commitGroupRename: () => void;
} {
  const { notes, setSelNodes, setSelEdges, setSelGroups } = options;
  const [noteEdit, setNoteEdit] = useState<CanvasEditValue | null>(null);
  const [stickyEdit, setStickyEdit] = useState<CanvasEditValue | null>(null);
  const [edgeLabelEdit, setEdgeLabelEdit] = useState<CanvasEditValue | null>(null);
  const [groupRename, setGroupRename] = useState<CanvasEditValue | null>(null);

  const persistNote = useCallback((id: string, value: string): void => {
    const text = value.replace(/\s+$/g, '');
    updateFreeViewLayout((l) => {
      const next = { ...(l.notes ?? {}) };
      if (text) next[id] = text;
      else delete next[id];
      return { ...l, notes: next };
    });
  }, []);

  const persistStickyText = useCallback((id: string, value: string): void => {
    updateFreeViewLayout((l) => ({
      ...l,
      stickies: (l.stickies ?? []).map((s) => (s.id === id ? { ...s, text: value } : s))
    }));
  }, []);

  const commitStickyEdit = useCallback((): void => {
    setStickyEdit((r) => {
      if (r) persistStickyText(r.id, r.value);
      return null;
    });
  }, [persistStickyText]);

  const cancelStickyEdit = useCallback((): void => {
    setStickyEdit((r) => {
      if (r) persistStickyText(r.id, r.value);
      return null;
    });
  }, [persistStickyText]);

  const changeStickyEdit = useCallback((id: string, value: string): void => {
    setStickyEdit((r) => (r?.id === id ? { ...r, value } : { id, value }));
  }, []);

  const commitEdgeLabel = useCallback((): void => {
    setEdgeLabelEdit((r) => {
      if (r) {
        const label = r.value.trim();
        updateFreeViewLayout((l) => ({
          ...l,
          edges: l.edges.map((e) => {
            if (e.id !== r.id) return e;
            const next = { ...e };
            if (label) next.label = label;
            else delete next.label;
            return next;
          })
        }));
      }
      return null;
    });
  }, []);

  const commitNoteEdit = useCallback((): void => {
    setNoteEdit((r) => {
      if (r) persistNote(r.id, r.value);
      return null;
    });
  }, [persistNote]);

  const cancelNoteEdit = useCallback((): void => setNoteEdit(null), []);
  const changeNoteEdit = useCallback((id: string, value: string): void => {
    setNoteEdit((r) => {
      if (r?.id === id) return { ...r, value };
      if (r) persistNote(r.id, r.value);
      return { id, value };
    });
  }, [persistNote]);

  const startNoteEdit = useCallback(
    (id: string): void => {
      setNoteEdit((r) => {
        if (r && r.id !== id) persistNote(r.id, r.value);
        if (r?.id === id) return r;
        return { id, value: notes[id] ?? '' };
      });
      setSelNodes([id]);
      setSelEdges([]);
      setSelGroups([]);
    },
    [persistNote, notes, setSelNodes, setSelEdges, setSelGroups]
  );

  const clearNote = useCallback((id: string): void => {
    updateFreeViewLayout((l) => {
      const next = { ...(l.notes ?? {}) };
      delete next[id];
      return { ...l, notes: next };
    });
    setNoteEdit((r) => (r?.id === id ? null : r));
  }, []);

  const commitGroupRename = useCallback((): void => {
    setGroupRename((r) => {
      if (r) {
        const name = r.value.trim();
        if (name) {
          updateFreeViewLayout((l) => ({
            ...l,
            groups: l.groups.map((g) => (g.id === r.id ? { ...g, label: name } : g))
          }));
        }
      }
      return null;
    });
  }, []);

  return {
    noteEdit,
    stickyEdit,
    edgeLabelEdit,
    groupRename,
    setStickyEdit,
    setEdgeLabelEdit,
    setGroupRename,
    persistNote,
    commitNoteEdit,
    cancelNoteEdit,
    changeNoteEdit,
    startNoteEdit,
    clearNote,
    commitStickyEdit,
    cancelStickyEdit,
    changeStickyEdit,
    commitEdgeLabel,
    commitGroupRename
  };
}
