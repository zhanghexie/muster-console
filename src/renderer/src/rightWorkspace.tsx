import { createContext, useContext, type CSSProperties } from 'react';
import type { RightAction, RightContent, RightOpenScope, RightTab, RightWorkspaceModel, ResourcePanel } from '../../shared/rightWorkspace';

export interface RightContentToolbarHosts {
  toolbar: HTMLElement | null;
  location: HTMLElement | null;
}

export interface RightWorkspaceBridge {
  model: RightWorkspaceModel;
  current: RightTab | undefined;
  splitPanes?: ReadonlyMap<string, CSSProperties>;
  splitToolbars?: ReadonlyMap<string, RightContentToolbarHosts>;
  toolbar: HTMLElement | null;
  location?: HTMLElement | null;
  resourceHosts: Record<ResourcePanel, HTMLElement | null>;
  open: (content: RightContent, source?: 'preview' | 'keep', scope?: RightOpenScope) => void;
  dispatch: (action: RightAction) => void;
  browserTransaction?: { busy: boolean; manages: (browserId: string, requestId?: string) => boolean };
  registerFile: (id: string, flush: (() => Promise<void>) | null) => void;
}
export const RightWorkspaceContext = createContext<RightWorkspaceBridge | null>(null);
export const useRightWorkspace = (): RightWorkspaceBridge | null => useContext(RightWorkspaceContext);

export function rightToolbarHosts(bridge: RightWorkspaceBridge | null, id: string | undefined): RightContentToolbarHosts | undefined {
  if (!bridge || !id) return;
  if (bridge.splitPanes) return bridge.splitToolbars?.get(id);
  if (bridge.current?.id === id) return { toolbar: bridge.toolbar, location: bridge.location ?? null };
}
