/**
 * 自由视图画布 · 选集与分组：节点/连线/组三类选集 + Ctrl+G 打组 / Ctrl+Shift+D 解散 /
 * Delete 删除（仅连线、分组、便签——会话节点不参与 Delete）。
 * 从 FreeCanvas.tsx 原样拆出；分组写盘与选集联动时序不变。
 */
import { useCallback, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { getFreeViewLayout, updateFreeViewLayout } from '../freeViewStore';
import { uid } from '../freeViewGeom';
import type { FreeGroup } from '../freeViewGeom';

export interface CanvasSelectionOptions {
  /** 会话节点 id 集（打组只允许会话卡） */
  sessionIdSet: ReadonlySet<string>;
  /** 便签 id 列表（Delete 删便签） */
  stickyIds: string[];
  /** 布局里的分组列表 */
  groups: FreeGroup[];
  /** 选集三态（状态归主组件持有，与指针/键盘/交互 hook 共享同一份） */
  selNodes: string[];
  selEdges: string[];
  selGroups: string[];
  setSelNodes: Dispatch<SetStateAction<string[]>>;
  setSelEdges: Dispatch<SetStateAction<string[]>>;
  setSelGroups: Dispatch<SetStateAction<string[]>>;
}

export function useCanvasSelection(options: CanvasSelectionOptions): {
  selNodes: string[];
  selEdges: string[];
  selGroups: string[];
  setSelNodes: Dispatch<SetStateAction<string[]>>;
  setSelEdges: Dispatch<SetStateAction<string[]>>;
  setSelGroups: Dispatch<SetStateAction<string[]>>;
  selNodeSet: ReadonlySet<string>;
  selEdgeSet: ReadonlySet<string>;
  selGroupSet: ReadonlySet<string>;
  canGroup: boolean;
  inAnyGroup: boolean;
  groupSelection: () => void;
  ungroupSelection: () => void;
  deleteSelection: () => void;
} {
  const { sessionIdSet, stickyIds, groups, selNodes, selEdges, selGroups, setSelNodes, setSelEdges, setSelGroups } =
    options;
  const { t } = useTranslation();

  const selNodeSet = useMemo(() => new Set(selNodes), [selNodes]);
  const selEdgeSet = useMemo(() => new Set(selEdges), [selEdges]);
  const selGroupSet = useMemo(() => new Set(selGroups), [selGroups]);

  const groupSelection = useCallback((): void => {
    const l = getFreeViewLayout();
    const members = selNodes.filter((id) => sessionIdSet.has(id));
    if (members.length < 2) return;
    const groupId = uid('g');
    const label = t('组 {{n}}', { n: l.groups.length + 1 });
    updateFreeViewLayout((x) => ({
      ...x,
      groups: [
        ...x.groups.map((g) => ({ ...g, members: g.members.filter((m) => !members.includes(m)) })),
        { id: groupId, label, members }
      ].filter((g) => g.members.length > 0)
    }));
    setSelGroups([groupId]);
    setSelEdges([]);
  }, [selNodes, t, sessionIdSet]);

  const ungroupSelection = useCallback((): void => {
    const l = getFreeViewLayout();
    const nodeSet = new Set(selNodes);
    const groupSet = new Set(selGroups);
    const hit = l.groups.filter(
      (g) => groupSet.has(g.id) || g.members.some((m) => nodeSet.has(m))
    );
    if (hit.length === 0) return;
    const hitIds = new Set(hit.map((g) => g.id));
    updateFreeViewLayout((x) => ({ ...x, groups: x.groups.filter((g) => !hitIds.has(g.id)) }));
    setSelGroups([]);
  }, [selNodes, selGroups]);

  const deleteSelection = useCallback((): void => {
    if (selEdges.length === 0 && selGroups.length === 0 && selNodes.length === 0) return;
    const stickySet = new Set(stickyIds);
    const dropStickies = selNodes.filter((id) => stickySet.has(id));
    if (selEdges.length === 0 && selGroups.length === 0 && dropStickies.length === 0) return;
    const dropSet = new Set(dropStickies);
    updateFreeViewLayout((l) => ({
      ...l,
      edges: l.edges.filter(
        (e) => !selEdges.includes(e.id) && !dropSet.has(e.from) && !dropSet.has(e.to)
      ),
      groups: l.groups.filter((g) => !selGroups.includes(g.id)),
      stickies: (l.stickies ?? []).filter((s) => !dropSet.has(s.id))
    }));
    setSelEdges([]);
    setSelGroups([]);
    if (dropStickies.length) setSelNodes((sel) => sel.filter((id) => !dropSet.has(id)));
  }, [selEdges, selGroups, selNodes, stickyIds]);

  const canGroup = selNodes.filter((id) => sessionIdSet.has(id)).length >= 2;
  const inAnyGroup =
    selGroups.length > 0 ||
    groups.some((g) => selNodes.some((m) => g.members.includes(m)));

  return {
    selNodes,
    selEdges,
    selGroups,
    setSelNodes,
    setSelEdges,
    setSelGroups,
    selNodeSet,
    selEdgeSet,
    selGroupSet,
    canGroup,
    inAnyGroup,
    groupSelection,
    ungroupSelection,
    deleteSelection
  };
}
