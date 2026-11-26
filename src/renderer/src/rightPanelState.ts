import type { PanelBrowserPresentation, RightPanelLayoutChange, RightPanelSnapshot } from '../../shared/panelState';
import { rightPanelLayoutTabIds, sameRightPanelLayout, type RightPanelLayout } from '../../shared/rightPanelLayout';
import type { RightContent } from '../../shared/rightWorkspace';
import { isWorkspaceFileClosePending } from './workspaceFileClose';
function assertWorkspaceNotClosing(workspaceId: string): void {
  if (isWorkspaceFileClosePending(workspaceId)) throw new Error('Workspace close is pending');
}
const readers = new Set<() => RightPanelSnapshot | null>();

export function registerRightPanelState(read: () => RightPanelSnapshot | null): () => void {
  readers.add(read);
  return () => { readers.delete(read); };
}

/** No guessing when multiple live workbench surfaces claim the same workspace. */
export function readRightPanelState(workspaceId: string): RightPanelSnapshot {
  const matches = [...readers].map(read => read()).filter((item): item is RightPanelSnapshot => !!item && item.workspaceId === workspaceId);
  if (matches.length !== 1) throw new Error('Right panel is unavailable or ambiguous for this workspace');
  return matches[0];
}

export type AgentRightContent = PanelBrowserPresentation | Extract<RightContent, { kind: 'file' | 'image' | 'git' | 'diff' | 'session' | 'utility' | 'review' }>;
export interface AgentRightOpenResult { tabId: string; existing: boolean; selected: boolean }
type OpenHandler = (workspaceId: string, content: AgentRightContent, focus: boolean) => Promise<AgentRightOpenResult>;
const openHandlers = new Set<OpenHandler>();

export function registerAgentRightOpen(handler: OpenHandler): () => void {
  openHandlers.add(handler);
  return () => { openHandlers.delete(handler); };
}

export function openAgentRightContent(workspaceId: string, content: AgentRightContent, focus = false): Promise<AgentRightOpenResult> {
  assertWorkspaceNotClosing(workspaceId);
  if (openHandlers.size !== 1) throw new Error('Right panel is unavailable or ambiguous');
  return [...openHandlers][0]!(workspaceId, content, focus);
}

export type AgentCenterFile = Extract<RightContent, { kind: 'file' | 'image' }>;
export interface AgentCenterFileResult { tabId: string; existing: boolean; centerOnly: boolean }
export interface AgentCenterFileState { tabId: string; centerOnly: boolean; pinned: boolean; content: AgentCenterFile }
type CenterFileHandler = (workspaceId: string, content: AgentCenterFile) => AgentCenterFileResult;
const centerFileHandlers = new Set<CenterFileHandler>();
export function registerAgentCenterFile(handler: CenterFileHandler): () => void {
  centerFileHandlers.add(handler);
  return () => { centerFileHandlers.delete(handler); };
}
export function prepareAgentCenterFile(workspaceId: string, content: AgentCenterFile): AgentCenterFileResult {
  assertWorkspaceNotClosing(workspaceId);
  if (centerFileHandlers.size !== 1) throw new Error('File surface is unavailable or ambiguous');
  return [...centerFileHandlers][0]!(workspaceId, content);
}
type CenterFileReader = (workspaceId: string, tabId: string) => AgentCenterFileState | null;
const centerFileReaders = new Set<CenterFileReader>();
const centerFileListeners = new Set<() => void>();
let centerFileVersion = 0;
export function registerAgentCenterFileRead(reader: CenterFileReader): () => void {
  centerFileReaders.add(reader);
  return () => { centerFileReaders.delete(reader); publishAgentCenterFiles(); };
}
export function publishAgentCenterFiles(): void {
  centerFileVersion++;
  centerFileListeners.forEach(listener => listener());
}
export function subscribeAgentCenterFiles(listener: () => void): () => void {
  centerFileListeners.add(listener);
  return () => { centerFileListeners.delete(listener); };
}
export function agentCenterFilesVersion(): number { return centerFileVersion; }
export function readAgentCenterFile(workspaceId: string, tabId: string): AgentCenterFileState | null {
  if (centerFileReaders.size !== 1) throw new Error('File surface is unavailable or ambiguous');
  return [...centerFileReaders][0]!(workspaceId, tabId);
}
type ReleaseCenterFileHandler = (workspaceId: string, tabId: string, expectedContent: string) => { released: boolean };
const releaseCenterFileHandlers = new Set<ReleaseCenterFileHandler>();
export function registerAgentCenterFileRelease(handler: ReleaseCenterFileHandler): () => void {
  releaseCenterFileHandlers.add(handler);
  return () => { releaseCenterFileHandlers.delete(handler); };
}
export function releaseAgentCenterFile(workspaceId: string, tabId: string, expectedContent: string): { released: boolean } {
  assertWorkspaceNotClosing(workspaceId);
  if (releaseCenterFileHandlers.size !== 1) throw new Error('File surface is unavailable or ambiguous');
  return [...releaseCenterFileHandlers][0]!(workspaceId, tabId, expectedContent);
}

type CloseHandler = (workspaceId: string, tabId: string, expectedContent?: string) => { tabId: string; closed: true };
const closeHandlers = new Set<CloseHandler>();
export function registerAgentRightClose(handler: CloseHandler): () => void {
  closeHandlers.add(handler);
  return () => { closeHandlers.delete(handler); };
}
export function closeAgentRightTab(workspaceId: string, tabId: string, expectedContent?: string): { tabId: string; closed: true } {
  assertWorkspaceNotClosing(workspaceId);
  if (closeHandlers.size !== 1) throw new Error('Right panel is unavailable or ambiguous');
  return [...closeHandlers][0]!(workspaceId, tabId, expectedContent);
}

type FocusHandler = (workspaceId: string, tabId: string, expectedContent?: string) => { tabId: string; selected: true };
const focusHandlers = new Set<FocusHandler>();
export function registerAgentRightFocus(handler: FocusHandler): () => void {
  focusHandlers.add(handler);
  return () => { focusHandlers.delete(handler); };
}
export function focusAgentRightTab(workspaceId: string, tabId: string, expectedContent?: string): { tabId: string; selected: true } {
  assertWorkspaceNotClosing(workspaceId);
  if (focusHandlers.size !== 1) throw new Error('Right panel is unavailable or ambiguous');
  return [...focusHandlers][0]!(workspaceId, tabId, expectedContent);
}

type RightLayoutHandler = (workspaceId: string, change: RightPanelLayoutChange) => void;
const layoutHandlers = new Set<RightLayoutHandler>();
export function registerAgentRightLayout(handler: RightLayoutHandler): () => void {
  layoutHandlers.add(handler);
  return () => { layoutHandlers.delete(handler); };
}
export function applyAgentRightLayout(workspaceId: string, change: RightPanelLayoutChange): void {
  assertWorkspaceNotClosing(workspaceId);
  if (layoutHandlers.size !== 1) throw new Error('Right panel is unavailable or ambiguous');
  [...layoutHandlers][0]!(workspaceId, change);
}
export function rightLayoutMatches(snapshot: RightPanelSnapshot, change: RightPanelLayoutChange, layout: RightPanelLayout): boolean {
  if (snapshot.sessionId !== change.sessionId || snapshot.split === undefined ||
      !sameRightPanelLayout({ selectedTabId: snapshot.selectedTabId, split: snapshot.split }, layout)) return false;
  const ids = new Set([...rightPanelLayoutTabIds(change.expected), ...rightPanelLayoutTabIds(change.next)]);
  return change.tabs.length === ids.size && change.tabs.every(({ id, content }) => ids.delete(id) &&
    snapshot.tabs.some(tab => tab.id === id && !tab.deferredDock && JSON.stringify(tab.content) === content));
}
