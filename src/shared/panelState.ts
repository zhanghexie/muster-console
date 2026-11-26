import type { WorkspaceFileRef } from './types';
import type { RightContent } from './rightWorkspace';
import type { RightPanelLayout, RightPanelSplit } from './rightPanelLayout';
import type { SplitPaneRef, CenterSnapLayoutId, CenterPaneSlot } from './centerSplit';

/** A center file target is bound to the current instance and ownership, not a caller-supplied path. */
export interface CenterFileBinding { sel: string; tabId: string; content: string; centerOnly: boolean; pinned: boolean }

export interface FileEditorSnapshot {
  workspaceId: string;
  path: string;
  fileRef?: WorkspaceFileRef;
  active: boolean;
  editing: boolean;
  unsaved: boolean;
}

export interface RightPanelSnapshot {
  workspaceId: string;
  sessionId: string;
  selectedTabId: string | null;
  split?: RightPanelSplit | null;
  tabs: Array<{ id: string; pinned: boolean; content: RightContent; origin: 'user' | 'agent' | 'unknown'; deferredDock?: boolean }>;
  editors: FileEditorSnapshot[];
}

export interface PanelSnapshot {
  workspaceId: string;
  axis: { page: 'terminal' | 'git'; virtualScreen: boolean; focusMode: boolean };
  center: { panes: SplitPaneRef[]; focused: CenterPaneSlot; layoutId?: CenterSnapLayoutId; order?: number[];
    fileViews?: CenterFileBinding[];
    background?: Array<{ id: string; target: Exclude<SplitPaneRef, { kind: 'empty' }>; navigation?: CenterNavigationIdentity }> };
  settings?: { prepared: boolean; visible: boolean; dirty: boolean };
  right: Omit<RightPanelSnapshot, 'tabs'> & {
    tabs: Array<Omit<RightPanelSnapshot['tabs'][number], 'content'> & {
      content: RightContent | { kind: 'redacted' };
    }>;
  };
}

export type PanelSnapshotResponse = { ok: true; snapshot: PanelSnapshot } | { ok: false; error: string };
export type PanelBrowserPresentation = Extract<RightContent, { kind: 'web' }> & { ownerSessionId: string };
export type PanelOpenContent = PanelBrowserPresentation | (Extract<RightContent, { kind: 'file' | 'image' | 'git' | 'diff' | 'session' | 'utility' | 'review' }> & { placement?: 'center' | 'right' }) |
  (Extract<RightContent, { kind: 'extension' }> & { placement: 'center'; navigation: CenterNavigationIdentity }) | { kind: 'settings'; placement?: 'center' | 'right' };
export type PanelOpenResponse =
  | { ok: true; tabId: string; existing: boolean; selected: boolean }
  | { ok: false; error: string; outcome?: 'unknown' };
export type PanelCloseResponse =
  | { ok: true; tabId: string; closed: true }
  | { ok: false; error: string; outcome?: 'unknown' };
export type PanelFocusResponse =
  | { ok: true; tabId: string; selected: true }
  | { ok: false; error: string; outcome?: 'unknown' };
export type PanelAxisFocusResponse =
  | { ok: true; page: 'terminal' | 'git' }
  | { ok: false; error: string; outcome?: 'unknown' };
/** Host-bound navigation snapshot required before acting on a central nav reference. */
export interface CenterNavigationIdentity { sourceRootId: string; selectionRevision: number; revision: number; node: string }
export type CenterNavigationBinding = CenterNavigationIdentity & { sel: string };
export type PanelCenterFocusResponse =
  | { ok: true; target: Exclude<SplitPaneRef, { kind: 'empty' }>; slot: CenterPaneSlot }
  | { ok: false; error: string; outcome?: 'unknown' };
export type PanelCenterCloseResponse =
  | { ok: true; target: Exclude<SplitPaneRef, { kind: 'empty' }>; closed: true }
  | { ok: false; error: string; outcome?: 'unknown' };
export type PanelSplitResponse =
  | { ok: true; panes: Exclude<SplitPaneRef, { kind: 'empty' }>[]; layoutId: CenterSnapLayoutId }
  | { ok: false; error: string; outcome?: 'unknown' };

export interface RightPanelLayoutChange {
  sessionId: string;
  expected: RightPanelLayout;
  next: RightPanelLayout;
  tabs: Array<{ id: string; content: string }>;
  navigation?: CenterNavigationBinding[];
}

export type PanelRightLayoutResponse =
  | ({ ok: true; placement: 'right' } & RightPanelLayout)
  | { ok: false; error: string; outcome?: 'unknown' };
