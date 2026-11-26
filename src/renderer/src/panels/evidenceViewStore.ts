/**
 * 证据页打开状态（模块级小 store，同 needsReadStore 模式）。
 * 左栏右键 / 看板卡片右键「查看证据」→ openEvidenceView；App 根层级挂唯一的
 * EvidencePanel 宿主（presence 进出场由面板自理）。纯渲染层内存态。
 */
import { useSyncExternalStore } from 'react';

export interface EvidenceViewTarget {
  sessionId: string;
  sessionName: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let target: EvidenceViewTarget | null = null;

function emit(): void {
  for (const l of listeners) l();
}

export function openEvidenceView(t: EvidenceViewTarget): void {
  if (target?.sessionId === t.sessionId && target.sessionName === t.sessionName) return;
  target = t;
  emit();
}

export function closeEvidenceView(): void {
  if (!target) return;
  target = null;
  emit();
}

/** 订阅当前打开目标（null = 关闭；快照按引用比较） */
export function useEvidenceView(): EvidenceViewTarget | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => target
  );
}
