import type { WorkspaceFileRef } from './types';
import type { TurnChangeOwner } from './turnChanges';
import { applyBookmarkChange, type BookmarkChange, type BookmarkNode, type WorkspaceBookmarks } from './bookmarks';
export type { BookmarkNode } from './bookmarks';
import { pathKey } from './pathKey';
import { MUSTER_EXPORT_SCHEME } from './protocolSchemes';

export type ResourcePanel = 'files' | 'git' | 'browser';
export type RightOpenScope = 'workspace' | 'session';
export const RESOURCE_PANELS: readonly ResourcePanel[] = ['files', 'git', 'browser'];
/** 可固定到右侧的内置实用功能（与左栏 UtilityPanelId 同值） */
export type RightUtilityId = 'tasks' | 'usage' | 'memory' | 'ext-manager' | 'settings';
export const RIGHT_UTILITY_IDS: readonly RightUtilityId[] = ['tasks', 'usage', 'memory', 'ext-manager', 'settings'];
/** Translation keys, not model-provided titles. */
export const RIGHT_UTILITY_TITLES: Record<RightUtilityId, string> = { tasks: '定时任务', usage: '使用统计', memory: '记忆整理', 'ext-manager': '扩展管理', settings: '设置' };
export type RightContent =
  | { kind: 'extension'; nodeId: string; title: string }
  | { kind: 'session'; sessionId: string; title: string; chat?: boolean }
  | { kind: 'utility'; sel: RightUtilityId; title: string }
  | { kind: 'file' | 'image'; path: string; fileRef?: WorkspaceFileRef; external?: boolean; directory?: boolean; line?: number; revealNonce?: number }
  | { kind: 'git'; repoPath: string }
  | { kind: 'diff'; repoPath: string; filePath: string; staged: boolean; untracked?: boolean }
  | { kind: 'review'; owner: TurnChangeOwner; messageId?: string; filePath?: string; repoPath?: string }
  | { kind: 'web'; browserId: string; url: string; title: string };
export interface RightTab {
  id: string;
  workspaceId: string;
  sessionId: string;
  scope: RightOpenScope;
  pinned: boolean;
  preview: boolean;
  /** Who opened this tab; older entries may have no reliable provenance. */
  origin?: 'user' | 'agent' | 'unknown';
  /** An agent-created dock target is not moved from the center until explicitly selected. */
  deferredDock?: boolean;
  /** Ephemeral backing instance for a center view; never persisted as a right tab. */
  centerOnly?: boolean;
  /** 会话归档后的可恢复标签记录；内容实例必须卸载。 */
  suspended?: boolean;
  /** 归档记录另存本机，覆盖尚未访问的工作区和跨重启恢复。 */
  archiveBacked?: boolean;
  /** Main-process checkpoint for the committed page in a web tab. */
  webHistoryKey?: string;
  /** Temporary preview used when the original preview was kept after navigation. */
  replayOf?: string;
  content: RightContent;
}
interface TabPosition { tab: RightTab; index: number }
interface RightTabChange { before?: TabPosition; after?: TabPosition }
export interface RightCommand { changes: RightTabChange[]; beforeSelected?: string; afterSelected?: string }
/** index is the number of applied commands. */
export interface RightHistory { entries: RightCommand[]; index: number }
export interface RightWebReplay { tabId: string; browserId: string; url: string; title: string; historyKey?: string }
export interface RightWorkspaceSaved {
  version: 1;
  tabs: RightTab[];
  selected: Record<string, string>;
  panel: ResourcePanel;
  collapsed: boolean;
  /** Legacy fields read by the host migration. */
  bookmarks?: BookmarkNode[];
  bookmarkDefaultsVersion?: number;
}
export interface RightWorkspaceModel {
  workspaceId: string;
  sessionId: string;
  tabs: RightTab[];
  selected: Record<string, string>;
  histories: Record<string, RightHistory>;
  resources: Record<string, { panel: ResourcePanel; collapsed: boolean }>;
  bookmarks: Record<string, BookmarkNode[]>;
  bookmarkDefaultsVersion: Record<string, number>;
  hydrated: string[];
  /** 已确认关闭的原生壳，防止迟到的浏览器快照将其重新绑定。 */
  retiredBrowserIds: string[];
  nextId: number;
}
export type RightAction =
  | { type: 'extensions'; contents: Extract<RightContent, { kind: 'extension' }>[]; available?: string[]; held?: string[]; record?: boolean }
  /** titles：存活会话的当前标题；removed：曾经存在、现已删除或归档的会话（未加载过的会话不在此列） */
  | { type: 'sessions'; titles: Array<{ id: string; title: string }>; removed: string[] }
  | { type: 'scope'; workspaceId: string; sessionId: string }
  | { type: 'hydrate'; workspaceId: string; saved?: RightWorkspaceSaved }
  | { type: 'restoreArchived'; tabs: RightTab[] }
  | { type: 'open'; content: RightContent; source?: 'preview' | 'keep'; scope?: RightOpenScope; record?: boolean; replacePreview?: boolean; origin?: RightTab['origin'] }
  | { type: 'openOwned'; workspaceId: string; sessionId: string; content: RightContent; scope?: RightOpenScope; focus?: boolean; record?: boolean; origin?: RightTab['origin']; webHistoryKey?: string }
  | { type: 'openCenterOwned'; workspaceId: string; sessionId: string; content: RightContent }
  | { type: 'releaseCenterOwned'; workspaceId: string; id: string; expectedContent: string }
  | { type: 'forgetWorkspaceFiles'; workspaceId: string }
  | { type: 'select'; id: string }
  | { type: 'presentWeb'; browserId: string; url: string; ownerSessionId: string }
  | { type: 'keep' | 'pin'; id: string }
  | { type: 'suspend' | 'resume'; id: string }
  | { type: 'releaseWeb'; id: string; browserId: string }
  | { type: 'close'; ids: string[]; scope?: string; record?: boolean }
  | { type: 'nativeClosed'; browserIds: string[] }
  | { type: 'history'; dir: -1 | 1; scope?: string; command?: RightCommand; web?: RightWebReplay[] }
  | { type: 'resources'; panel?: ResourcePanel; collapsed?: boolean }
  | { type: 'move'; id: string; before: string }
  | { type: 'web'; browserId: string; url: string; title: string; historyKey?: string; record?: boolean }
  | { type: 'bindWeb'; id: string; browserId: string }
  | { type: 'bookmarkSnapshot'; workspaceId: string; saved?: WorkspaceBookmarks }
  | { type: 'bookmarkChange'; workspaceId: string; change: BookmarkChange };

export const rightScope = (s: Pick<RightWorkspaceModel, 'workspaceId' | 'sessionId'>): string => JSON.stringify([s.workspaceId, s.sessionId]);
export type DockedRightContent = Extract<RightContent, { kind: 'extension' | 'session' | 'utility' }>;
/** 从左栏/中栏固定到右侧的内容：项目内所有会话作用域共享，不跟随资源胶囊 */
export const isDockedRightContent = (content: RightContent): content is DockedRightContent =>
  content.kind === 'extension' || content.kind === 'session' || content.kind === 'utility';
export const resourceForContent = (content?: RightContent): ResourcePanel => content?.kind === 'web' ? 'browser' : content?.kind === 'git' || content?.kind === 'diff' || content?.kind === 'review' ? 'git' : 'files';
export function rightContentKey(content: RightContent): string {
  if (content.kind === 'extension') return JSON.stringify(['extension', content.nodeId]);
  if (content.kind === 'session') return JSON.stringify(['session', content.sessionId]);
  if (content.kind === 'utility') return JSON.stringify(['utility', content.sel]);
  if (content.kind === 'review') return JSON.stringify(['review', content.owner.kind, content.owner.id]);
  if (content.kind === 'git') return JSON.stringify(['git', pathKey(content.repoPath)]);
  if (content.kind === 'diff') return JSON.stringify(['diff', pathKey(content.repoPath), content.filePath, content.staged]);
  if (content.kind === 'web') return JSON.stringify(['web', content.browserId || content.url]);
  return JSON.stringify(['file', content.fileRef?.workspaceId, content.fileRef?.rootId, content.path, !!content.external, !!content.directory]);
}
export function rightContentTitle(content: RightContent): string {
  if (isDockedRightContent(content)) return content.title;
  if (content.kind === 'review') return '审阅';
  if (content.kind === 'web') return content.title || content.url || 'about:blank';
  const path = content.kind === 'git' ? content.repoPath : content.kind === 'diff' ? content.filePath : content.path;
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path;
}
export function rightContentLocation(content: RightContent): string {
  if (isDockedRightContent(content)) return content.title;
  if (content.kind === 'review') return content.filePath || content.repoPath || '审阅';
  return content.kind === 'web' ? content.url : content.kind === 'git' ? content.repoPath : content.kind === 'diff' ? `${content.repoPath} / ${content.filePath}` : content.path;
}
export function initialRightWorkspace(workspaceId = '', sessionId = ''): RightWorkspaceModel {
  return { workspaceId, sessionId, tabs: [], selected: {}, histories: {}, resources: {}, bookmarks: {}, bookmarkDefaultsVersion: {}, hydrated: [], retiredBrowserIds: [], nextId: 1 };
}
export const projectRightTabs = (s: RightWorkspaceModel): RightTab[] => s.tabs.filter(tab => tab.workspaceId === s.workspaceId);
export function rightTabAppliesToSession(tab: RightTab, sessionId: string): boolean {
  return tab.scope === 'workspace' || tab.sessionId === sessionId;
}
function sameTabScope(a: RightTab, b: RightTab): boolean {
  return a.scope === b.scope && rightTabAppliesToSession(a, b.sessionId);
}
export const visibleRightTabs = (s: RightWorkspaceModel): RightTab[] => projectRightTabs(s).filter(tab => !tab.centerOnly && !tab.suspended && rightTabAppliesToSession(tab, s.sessionId)).sort((a, b) => Number(b.pinned) - Number(a.pinned));
export function rightPreviewFor(s: RightWorkspaceModel, scope: RightOpenScope): RightTab | undefined {
  return visibleRightTabs(s).find(tab => tab.preview && tab.scope === scope);
}
export function activeRightTab(s: RightWorkspaceModel): RightTab | undefined {
  const tabs = visibleRightTabs(s).filter(tab => !tab.deferredDock);
  return tabs.find(tab => tab.id === s.selected[rightScope(s)]) ?? tabs.find(tab => tab.scope === 'session' || isDockedRightContent(tab.content)) ?? tabs[0];
}
export const rightResources = (s: RightWorkspaceModel): { panel: ResourcePanel; collapsed: boolean } => s.resources[s.workspaceId] ?? { panel: resourceForContent(activeRightTab(s)?.content), collapsed: false };
function follow(s: RightWorkspaceModel, content = activeRightTab(s)?.content): RightWorkspaceModel {
  if (!content || isDockedRightContent(content)) return s;
  const ui = rightResources(s), panel = resourceForContent(content);
  return { ...s, resources: { ...s.resources, [s.workspaceId]: { ...ui, panel } } };
}
function snapshotRightContent(content: RightContent): RightContent {
  return content.kind === 'web' ? { ...content, browserId: '' } : { ...content };
}
function focus(s: RightWorkspaceModel, tab: RightTab): RightWorkspaceModel {
  const scope = rightScope(s);
  if (tab.deferredDock) {
    tab = { ...tab, deferredDock: undefined };
    s = { ...s, tabs: s.tabs.map(item => item.id === tab.id ? tab : item) };
  }
  return follow({ ...s, selected: { ...s.selected, [scope]: tab.id } }, tab.content);
}
function clearSelection(s: RightWorkspaceModel): RightWorkspaceModel {
  const selected = { ...s.selected };
  delete selected[rightScope(s)];
  return { ...s, selected };
}
function tabPosition(s: RightWorkspaceModel, tab: RightTab): TabPosition {
  return { tab: { ...tab, content: snapshotRightContent(tab.content) }, index: s.tabs.indexOf(tab) };
}
function sameTarget(a: RightTab, b: RightTab): boolean {
  const left = a.content, right = b.content;
  if (left.kind === 'web' && right.kind === 'web') {
    return left.url === right.url && (!a.webHistoryKey || !b.webHistoryKey || a.webHistoryKey === b.webHistoryKey);
  }
  if (rightContentKey(left) !== rightContentKey(right)) return false;
  if ((left.kind === 'file' || left.kind === 'image') && (right.kind === 'file' || right.kind === 'image')) return left.line === right.line;
  if (left.kind === 'review' && right.kind === 'review') return left.messageId === right.messageId && left.filePath === right.filePath && left.repoPath === right.repoPath;
  return true;
}
function commandTabs(command: RightCommand): RightTab[] {
  return command.changes.flatMap(({ before, after }) => [before?.tab, after?.tab].filter((tab): tab is RightTab => !!tab));
}
export function rightWebHistoryKeys(s: RightWorkspaceModel): string[] {
  const keys = new Set<string>();
  for (const history of Object.values(s.histories)) {
    for (const command of history.entries) {
      for (const tab of commandTabs(command)) if (tab.webHistoryKey) keys.add(tab.webHistoryKey);
    }
  }
  return [...keys];
}
function pruneCommands(s: RightWorkspaceModel, valid: (tab: RightTab) => boolean, exceptScope?: string): RightWorkspaceModel {
  let histories = s.histories;
  for (const [scope, history] of Object.entries(histories)) {
    if (scope === exceptScope) continue;
    const entries = history.entries.map(command => {
      const changes = command.changes.filter(({ before, after }) => (!before || valid(before.tab)) && (!after || valid(after.tab)));
      return changes.length === command.changes.length ? command : { ...command, changes };
    });
    if (entries.every((command, index) => command === history.entries[index])) continue;
    histories = { ...histories, [scope]: { entries: entries.filter(command => command.changes.length),
      index: entries.slice(0, history.index).filter(command => command.changes.length).length } };
  }
  return histories === s.histories ? s : { ...s, histories };
}
function recordCommand(s: RightWorkspaceModel, next: RightWorkspaceModel, changes: RightTabChange[]): RightWorkspaceModel {
  if (!changes.length) return next;
  const scope = rightScope(s);
  const touched = new Set(changes.map(change => (change.after ?? change.before)!.tab.id));
  next = pruneCommands(next, tab => !touched.has(tab.id), scope);
  const history = next.histories[scope] ?? { entries: [], index: 0 };
  const entries = [...history.entries.slice(0, history.index), { changes, beforeSelected: activeRightTab(s)?.id, afterSelected: activeRightTab(next)?.id }].slice(-60);
  return { ...next, histories: { ...next.histories, [scope]: { entries, index: entries.length } } };
}
export function findRightTabForOpen(s: RightWorkspaceModel, content: RightContent, scope: RightOpenScope): RightTab | undefined {
  const key = rightContentKey(content);
  return visibleRightTabs(s).find(tab => tab.scope === scope && rightContentKey(tab.content) === key) ??
    projectRightTabs(s).find(tab => tab.centerOnly && !tab.suspended && tab.sessionId === s.sessionId && rightContentKey(tab.content) === key);
}
function open(s: RightWorkspaceModel, content: RightContent, source: 'preview' | 'keep', record = true, replacePreview = false, requestedScope: RightOpenScope = 'session', origin: RightTab['origin'] = 'unknown', webHistoryKey?: string): RightWorkspaceModel {
  const scope = isDockedRightContent(content) ? 'workspace' : requestedScope;
  const existing = findRightTabForOpen(s, content, scope);
  const preview = source === 'preview' || replacePreview ? rightPreviewFor(s, scope) : undefined;
  const previous = existing ?? preview;
  const tab: RightTab = existing ? { ...existing, content, ...(existing.centerOnly ? { centerOnly: undefined, scope, origin } : {}), preview: source === 'keep' ? false : existing.preview } : {
    id: preview?.id ?? `right-${s.nextId}`, workspaceId: s.workspaceId, sessionId: s.sessionId,
    scope, pinned: false, preview: source === 'preview', content, origin,
    ...(preview?.replayOf ? { replayOf: preview.replayOf } : {}), ...(webHistoryKey ? { webHistoryKey } : {})
  };
  const next = focus({ ...s, tabs: previous ? s.tabs.map(old => old === previous ? tab : old) : [...s.tabs, tab], nextId: previous ? s.nextId : s.nextId + 1 }, tab);
  const before = previous && !previous.centerOnly ? tabPosition(s, previous) : undefined;
  if (!record || (before && sameTarget(before.tab, tab))) return next;
  return recordCommand(s, next, [{ before, after: tabPosition(next, next.tabs.find(item => item.id === tab.id)!) }]);
}
function closeRightTabs(s: RightWorkspaceModel, closing: RightTab[], record: boolean): RightWorkspaceModel {
  if (!closing.length) return s;
  const visible = visibleRightTabs(s), current = activeRightTab(s);
  const ids = new Set(closing.map(tab => tab.id));
  const retired = new Set(s.retiredBrowserIds);
  for (const tab of closing) if (tab.content.kind === 'web' && tab.content.browserId) retired.add(tab.content.browserId);
  let next = { ...s, tabs: s.tabs.filter(tab => !ids.has(tab.id)), retiredBrowserIds: [...retired] };
  if (current && ids.has(current.id)) {
    const index = visible.indexOf(current);
    const replacement = [...visible.slice(index + 1), ...visible.slice(0, index).reverse()].find(tab => !ids.has(tab.id) && !tab.deferredDock);
    next = replacement ? focus(next, replacement) : clearSelection(next);
  }
  return record ? recordCommand(s, next, closing.map(tab => ({ before: tabPosition(s, tab) }))) : pruneCommands(next, tab => !ids.has(tab.id));
}

/** Resolve just the affected tabs. Tabs opened independently since the command stay in place. */
export function planRightHistory(s: RightWorkspaceModel, dir: -1 | 1, scope = rightScope(s), expected?: RightCommand) {
  const history = s.histories[scope];
  const index = (history?.index ?? 0) + (dir === -1 ? -1 : 0);
  const command = history?.entries[index];
  if (!command || (expected && command !== expected)) return;
  const [workspaceId, sessionId] = JSON.parse(scope) as [string, string];
  let nextId = s.nextId;
  let selected = dir === -1 ? command.beforeSelected : command.afterSelected;
  const remove: RightTab[] = [];
  const insert: TabPosition[] = [];
  for (const change of command.changes) {
    const source = dir === -1 ? change.after : change.before;
    const target = dir === -1 ? change.before : change.after;
    const id = (source ?? target)!.tab.id;
    const primary = s.tabs.find(tab => tab.id === id && !tab.centerOnly);
    if (primary && (primary.suspended || primary.workspaceId !== workspaceId || !rightTabAppliesToSession(primary, sessionId))) return;
    const alternate = s.tabs.find(tab => tab.replayOf === id && tab.preview && !tab.suspended);
    const kept = primary && !primary.preview && ((source?.tab.preview ?? target?.tab.preview) || alternate);
    const live = kept ? alternate : primary;
    if (live) remove.push(live);
    if (!target) continue;
    if (kept && sameTarget(primary, target.tab)) {
      if (selected === id) selected = primary.id;
      continue;
    }
    const restored: RightTab = kept ? {
      ...target.tab, id: live?.id ?? `right-${nextId++}`, replayOf: id, preview: true, pinned: false
    } : {
      ...target.tab,
      ...(live ? { pinned: live.pinned, preview: live.preview === source?.tab.preview ? target.tab.preview : live.preview, origin: live.origin } : {})
    };
    if (live?.content.kind === 'web' && restored.content.kind === 'web') {
      restored.content = { ...restored.content, browserId: live.content.browserId, title: sameTarget(live, restored) ? live.content.title : restored.content.title };
    } else if (live && isDockedRightContent(live.content) && isDockedRightContent(restored.content)) {
      restored.content = { ...restored.content, title: live.content.title };
    }
    if (selected === id) selected = restored.id;
    insert.push({ tab: restored, index: live ? s.tabs.indexOf(live) : target.index });
  }
  return { scope, command, history, index: dir === -1 ? index : index + 1, selected, remove, insert, nextId };
}

function inScope(s: RightWorkspaceModel, scope: string): RightWorkspaceModel {
  if (rightScope(s) === scope) return s;
  const [workspaceId, sessionId] = JSON.parse(scope) as [string, string];
  return { ...s, workspaceId, sessionId };
}
export function reduceRightWorkspace(s: RightWorkspaceModel, action: RightAction): RightWorkspaceModel {
  switch (action.type) {
    case 'extensions': {
      const live = new Set(action.contents.map(content => content.nodeId));
      const held = new Set(action.held), available = new Set(action.available ?? live);
      const valid = (tab: RightTab): boolean => tab.workspaceId !== s.workspaceId || tab.content.kind !== 'extension' ||
        held.has(tab.content.nodeId) || available.has(tab.content.nodeId);
      let next = pruneCommands(closeRightTabs(s, s.tabs.filter(tab => !valid(tab)), false), valid);
      const moved = projectRightTabs(next).filter(tab => tab.content.kind === 'extension' && !held.has(tab.content.nodeId) && !live.has(tab.content.nodeId));
      next = closeRightTabs(next, moved, action.record === true);
      for (const content of action.contents) {
        if (held.has(content.nodeId)) continue;
        const existing = projectRightTabs(next).find(tab => tab.content.kind === 'extension' && tab.content.nodeId === content.nodeId);
        if (!existing) next = open(next, content, 'keep', action.record === true);
        else if (existing.content.kind === 'extension' && existing.content.title !== content.title)
          next = { ...next, tabs: next.tabs.map(tab => tab.id === existing.id ? { ...tab, content } : tab) };
      }
      return next;
    }
    case 'sessions': {
      const titles = new Map(action.titles.map(session => [session.id, session.title]));
      const removedIds = new Set(action.removed);
      const valid = (tab: Pick<RightTab, 'content'>): boolean => tab.content.kind !== 'session' || !removedIds.has(tab.content.sessionId);
      const retitle = <T extends Pick<RightTab, 'content'>>(tab: T): T => tab.content.kind === 'session' && titles.has(tab.content.sessionId) && titles.get(tab.content.sessionId) !== tab.content.title
        ? { ...tab, content: { ...tab.content, title: titles.get(tab.content.sessionId)! } } : tab;
      const pruned = pruneCommands(s, tab => valid(tab) && (tab.scope !== 'session' || !removedIds.has(tab.sessionId)));
      if (s.tabs.every(tab => valid(tab) && retitle(tab) === tab)) return pruned;
      const tabs = s.tabs.filter(valid).map(retitle);
      const next = { ...pruned, tabs };
      const removed = s.tabs.filter(tab => !valid(tab)).map(tab => tab.id);
      const current = activeRightTab(s);
      if (!current || !removed.includes(current.id)) return next;
      const visible = visibleRightTabs(s), index = visible.findIndex(tab => tab.id === current.id);
      const replacement = [...visible.slice(index + 1), ...visible.slice(0, index).reverse()].find(tab => !removed.includes(tab.id));
      return replacement ? focus(next, next.tabs.find(tab => tab.id === replacement.id)!) : clearSelection(next);
    }
    case 'scope': return follow({ ...s, workspaceId: action.workspaceId, sessionId: action.sessionId });
    case 'restoreArchived': {
      let nextId = s.nextId;
      const tabs = [...s.tabs];
      const seen = new Set<string>();
      for (const tab of action.tabs) {
        const key = JSON.stringify([tab.workspaceId, tab.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        tabs.push({ ...tab, id: `right-${nextId++}`, archiveBacked: true });
      }
      return { ...s, tabs, nextId };
    }
    case 'hydrate': {
      if (s.hydrated.includes(action.workspaceId)) return s;
      const saved = validateRightWorkspaceSaved(action.saved, action.workspaceId);
      const tabs = [...s.tabs];
      let nextId = s.nextId;
      const remap = new Map<string, string>();
      const matched = new Set<string>();
      for (const tab of saved?.tabs ?? []) {
        const existing = tabs.find(current => !matched.has(current.id) && current.workspaceId === tab.workspaceId &&
          sameTabScope(current, tab) &&
          (rightContentKey(current.content) === rightContentKey(tab.content) ||
            current.content.kind === 'web' && tab.content.kind === 'web' && current.content.url === tab.content.url));
        if (existing) { matched.add(existing.id); remap.set(tab.id, existing.id); continue; }
        const id = `right-${nextId++}`;
        tabs.push({ ...tab, id }); remap.set(tab.id, id);
      }
      const selected = { ...s.selected };
      for (const [sessionId, id] of Object.entries(saved?.selected ?? {})) {
        const scope = JSON.stringify([action.workspaceId, sessionId]);
        if (remap.has(id) && !selected[scope]) selected[scope] = remap.get(id)!;
      }
      return follow({ ...s, tabs, nextId, selected, hydrated: [...s.hydrated, action.workspaceId],
        resources: { ...s.resources, [action.workspaceId]: s.resources[action.workspaceId] ?? { panel: saved?.panel ?? 'files', collapsed: saved?.collapsed ?? false } } });
    }
    case 'open': return open(s, action.content, action.source ?? 'keep', action.record !== false && action.origin !== 'agent', action.replacePreview, action.scope, action.origin);
    case 'openCenterOwned': {
      const content = action.content;
      if ((content.kind !== 'file' && content.kind !== 'image') || !content.fileRef || content.fileRef.workspaceId !== action.workspaceId ||
          content.fileRef.relativePath !== content.path || content.external || content.directory) return s;
      const existing = s.tabs.find(tab => tab.workspaceId === action.workspaceId && !tab.suspended &&
        rightTabAppliesToSession(tab, action.sessionId) && rightContentKey(tab.content) === rightContentKey(content));
      if (existing) return s;
      return { ...s, tabs: [...s.tabs, { id: `right-${s.nextId}`, workspaceId: action.workspaceId, sessionId: action.sessionId,
        scope: 'session', pinned: false, preview: false, origin: 'agent', centerOnly: true, content }], nextId: s.nextId + 1 };
    }
    case 'releaseCenterOwned': return { ...s, tabs: s.tabs.filter(tab => !(tab.centerOnly && tab.workspaceId === action.workspaceId &&
      tab.id === action.id && JSON.stringify(tab.content) === action.expectedContent)) };
    case 'forgetWorkspaceFiles': {
      const removed = new Set(s.tabs.filter(tab => tab.workspaceId === action.workspaceId && (tab.content.kind === 'file' || tab.content.kind === 'image')).map(tab => tab.id));
      return pruneCommands({ ...s, tabs: s.tabs.filter(tab => !removed.has(tab.id)),
        selected: Object.fromEntries(Object.entries(s.selected).filter(([, id]) => !removed.has(id))),
        hydrated: s.hydrated.filter(id => id !== action.workspaceId) }, tab => tab.workspaceId !== action.workspaceId || (tab.content.kind !== 'file' && tab.content.kind !== 'image'));
    }
    case 'openOwned': {
      if (action.focus === false && s.tabs.some(tab => tab.centerOnly && !tab.suspended && tab.workspaceId === action.workspaceId &&
          tab.sessionId === action.sessionId && rightContentKey(tab.content) === rightContentKey(action.content))) return s;
      const record = action.record ?? (action.focus !== false && action.origin !== 'agent');
      if (s.workspaceId === action.workspaceId && action.scope === 'workspace' && action.focus !== false) return open(s, action.content, 'keep', record, false, 'workspace', action.origin, action.webHistoryKey);
      if (s.workspaceId === action.workspaceId && s.sessionId === action.sessionId && action.focus !== false) return open(s, action.content, 'keep', record, false, action.scope, action.origin, action.webHistoryKey);
      const before = new Set(s.tabs.map(tab => tab.id));
      const deferred = new Set(s.tabs.filter(tab => tab.deferredDock).map(tab => tab.id));
      const ownerSession = s.workspaceId === action.workspaceId && action.scope === 'workspace' ? s.sessionId : action.sessionId;
      const owner = { ...s, workspaceId: action.workspaceId, sessionId: ownerSession };
      let next = open(owner, action.content, 'keep', record && action.focus !== false, false, action.scope, action.origin, action.webHistoryKey);
      const defer = action.focus === false && action.origin === 'agent' && (action.content.kind === 'session' || action.content.kind === 'utility');
      if (action.focus === false) {
        next = { ...next, selected: s.selected, resources: s.resources };
        const opened = next.tabs.find(tab => !before.has(tab.id));
        if (record && opened) next = recordCommand(owner, next, [{ after: tabPosition(next, opened) }]);
      }
      return { ...next, workspaceId: s.workspaceId, sessionId: s.sessionId,
        ...(defer ? { tabs: next.tabs.map(tab => !before.has(tab.id) || deferred.has(tab.id) ? { ...tab, deferredDock: true } : tab) } : {}) };
    }
    case 'select': {
      const tab = visibleRightTabs(s).find(tab => tab.id === action.id);
      return tab ? focus(s, tab) : s;
    }
    case 'keep': return { ...s, tabs: s.tabs.map(tab => tab.id === action.id ? { ...tab, preview: false } : tab) };
    case 'presentWeb': {
      const matches = s.tabs.filter(tab => tab.workspaceId === s.workspaceId && !tab.suspended && tab.sessionId === action.ownerSessionId &&
        tab.content.kind === 'web' && tab.content.browserId === action.browserId && tab.content.url === action.url);
      if (matches.length !== 1) return s;
      const match = matches[0];
      const tab = rightTabAppliesToSession(match, s.sessionId) ? match : { ...match, scope: 'workspace' as const };
      return focus({ ...s, tabs: s.tabs.map(item => item.id === tab.id ? tab : item) }, tab);
    }
    case 'pin': return { ...s, tabs: s.tabs.map(tab => tab.id === action.id && tab.workspaceId === s.workspaceId ? { ...tab, pinned: !tab.pinned, preview: false } : tab) };
    case 'suspend': return { ...s, tabs: s.tabs.filter(tab => tab.id !== action.id || !tab.centerOnly).map(tab => tab.id === action.id && tab.scope === 'session' ? { ...tab, suspended: true, archiveBacked: true } : tab) };
    case 'resume': return { ...s, tabs: s.tabs.map(tab => tab.id === action.id && tab.suspended ? { ...tab, suspended: undefined } : tab) };
    case 'releaseWeb': return { ...s, retiredBrowserIds: [...new Set([...s.retiredBrowserIds, action.browserId])],
      tabs: s.tabs.map(tab => tab.id === action.id && tab.content.kind === 'web' && tab.content.browserId === action.browserId
        ? { ...tab, webHistoryKey: undefined, content: { ...tab.content, browserId: '' } } : tab) };
    case 'close': {
      const scoped = inScope(s, action.scope ?? rightScope(s));
      const next = closeRightTabs(scoped, visibleRightTabs(scoped).filter(tab => action.ids.includes(tab.id)), action.record !== false);
      return scoped === s ? next : { ...next, workspaceId: s.workspaceId, sessionId: s.sessionId, resources: s.resources };
    }
    case 'nativeClosed': {
      const ids = new Set(action.browserIds);
      const matches = (tab: RightTab): boolean => tab.content.kind === 'web' && ids.has(tab.content.browserId);
      const next = closeRightTabs(s, s.tabs.filter(tab => !tab.suspended && matches(tab)), false);
      const retired = new Set([...next.retiredBrowserIds, ...ids]);
      const tabs = next.tabs.map(tab => matches(tab) ? { ...tab, webHistoryKey: undefined, content: snapshotRightContent(tab.content) } : tab);
      return { ...next, tabs, retiredBrowserIds: [...retired] };
    }
    case 'history': {
      const plan = planRightHistory(s, action.dir, action.scope, action.command);
      if (!plan) return s;
      const tabs = s.tabs.filter(tab => !plan.remove.includes(tab));
      const retired = new Set(s.retiredBrowserIds);
      const rebound = new Set<string>();
      for (const { tab, index } of plan.insert.sort((a, b) => a.index - b.index)) {
        const web = action.web?.find(item => item.tabId === tab.id);
        const restored = web && tab.content.kind === 'web' ? { ...tab, webHistoryKey: web.historyKey,
          content: { ...tab.content, browserId: web.browserId, url: web.url, title: web.title } } : tab;
        if (restored.content.kind === 'web') rebound.add(restored.content.browserId);
        tabs.splice(index, 0, restored);
      }
      for (const tab of plan.remove) if (tab.content.kind === 'web' && tab.content.browserId && !rebound.has(tab.content.browserId)) retired.add(tab.content.browserId);
      const next = inScope({ ...s, tabs, nextId: plan.nextId, retiredBrowserIds: [...retired],
        histories: { ...s.histories, [plan.scope]: { ...plan.history, index: plan.index } } }, plan.scope);
      const selected = visibleRightTabs(next).find(tab => tab.id === plan.selected);
      const focused = selected ? focus(next, selected) : follow(clearSelection(next));
      return plan.scope === rightScope(s) ? focused : { ...focused, workspaceId: s.workspaceId, sessionId: s.sessionId, resources: s.resources };
    }
    case 'resources': return { ...s, resources: { ...s.resources, [s.workspaceId]: { panel: action.panel ?? rightResources(s).panel, collapsed: action.collapsed ?? (action.panel ? false : rightResources(s).collapsed) } } };
    case 'move': {
      const tab = visibleRightTabs(s).find(tab => tab.id === action.id), target = visibleRightTabs(s).find(tab => tab.id === action.before);
      if (!tab || !target || tab.pinned !== target.pinned) return s;
      const tabs = s.tabs.filter(old => old.id !== tab.id); tabs.splice(tabs.indexOf(target), 0, tab);
      return { ...s, tabs };
    }
    case 'web': {
      const previous = s.tabs.find(tab => tab.content.kind === 'web' && tab.content.browserId === action.browserId);
      if (!previous || previous.content.kind !== 'web' || previous.suspended) return s;
      const { url, title, historyKey } = action;
      // navigate() can publish the requested address before Chromium commits it.
      if (previous.webHistoryKey && !historyKey) return s;
      if (previous.content.url === url && previous.content.title === title && previous.webHistoryKey === historyKey) return s;
      const tab = { ...previous, webHistoryKey: historyKey, content: { ...previous.content, url, title } };
      const next = { ...s, tabs: s.tabs.map(item => item === previous ? tab : item) };
      if (action.record && previous.webHistoryKey && historyKey !== previous.webHistoryKey &&
          previous.workspaceId === s.workspaceId && rightTabAppliesToSession(previous, s.sessionId)) {
        return recordCommand(s, next, [{ before: tabPosition(s, previous), after: tabPosition(next, tab) }]);
      }
      if (!previous.webHistoryKey && historyKey) {
        const bind = (pos?: TabPosition): TabPosition | undefined => pos?.tab.id === tab.id && !pos.tab.webHistoryKey
          ? { ...pos, tab: { ...pos.tab, webHistoryKey: historyKey, content: snapshotRightContent(tab.content) } } : pos;
        const histories = Object.fromEntries(Object.entries(next.histories).map(([scope, history]) => [scope, {
          ...history, entries: history.entries.map(command => {
            const changes = command.changes.map(change => ({ before: bind(change.before), after: bind(change.after) }));
            return changes.some((change, i) => change.before !== command.changes[i].before || change.after !== command.changes[i].after)
              ? { ...command, changes } : command;
          })
        }]));
        return { ...next, histories };
      }
      return next;
    }
    case 'bindWeb': {
      if (!action.browserId || s.retiredBrowserIds.includes(action.browserId) || s.tabs.some(tab => tab.content.kind === 'web' && tab.content.browserId === action.browserId)) return s;
      const target = s.tabs.find(tab => tab.id === action.id);
      if (!target || target.suspended || target.content.kind !== 'web' || target.content.browserId) return s;
      const bound = { ...target, content: { ...target.content, browserId: action.browserId } };
      return { ...s, tabs: s.tabs.map(tab => tab.id === action.id ? bound : tab) };
    }
    case 'bookmarkSnapshot': {
      const bookmarks = { ...s.bookmarks }, bookmarkDefaultsVersion = { ...s.bookmarkDefaultsVersion };
      if (action.saved) {
        bookmarks[action.workspaceId] = action.saved.bookmarks;
        bookmarkDefaultsVersion[action.workspaceId] = action.saved.bookmarkDefaultsVersion;
      } else {
        delete bookmarks[action.workspaceId];
        delete bookmarkDefaultsVersion[action.workspaceId];
      }
      return { ...s, bookmarks, bookmarkDefaultsVersion };
    }
    case 'bookmarkChange': {
      if (action.workspaceId !== s.workspaceId || s.bookmarkDefaultsVersion[action.workspaceId] === undefined) return s;
      const current = s.bookmarks[action.workspaceId] ?? [];
      const result = applyBookmarkChange(current, action.change);
      return result.error ? s : { ...s, bookmarks: { ...s.bookmarks, [action.workspaceId]: result.nodes } };
    }
  }
}
export function saveRightWorkspace(s: RightWorkspaceModel): RightWorkspaceSaved {
  const selected: Record<string, string> = {};
  const tabs = projectRightTabs(s).filter(tab => !tab.centerOnly && (!tab.preview || tab.suspended) && tab.content.kind !== 'extension' &&
    !(tab.content.kind === 'web' && tab.content.url.startsWith(MUSTER_EXPORT_SCHEME + ':')))
    .map(({ webHistoryKey: _key, replayOf: _preview, ...tab }) => ({ ...tab, content: snapshotRightContent(tab.content) }));
  for (const [key, id] of Object.entries(s.selected)) {
    const [workspaceId, sessionId] = JSON.parse(key) as string[];
    if (workspaceId === s.workspaceId && tabs.some(tab => tab.id === id)) selected[sessionId!] = id;
  }
  return { version: 1, tabs, selected, ...rightResources(s) };
}
/** Workspace preferences are untrusted data. Ignore malformed or cross-project identities. */
export function validateRightWorkspaceSaved(value: unknown, workspaceId: string): RightWorkspaceSaved | undefined {
  if (!value || typeof value !== 'object' || (value as RightWorkspaceSaved).version !== 1) return undefined;
  const v = value as RightWorkspaceSaved;
  const tabs = Array.isArray(v.tabs) ? v.tabs.filter(tab => {
    if (!tab || typeof tab.id !== 'string' || tab.workspaceId !== workspaceId || typeof tab.sessionId !== 'string' || !tab.content) return false;
    const c = tab.content;
    if (c.kind === 'web') return typeof c.url === 'string' && typeof c.title === 'string';
    if (c.kind === 'session') return typeof c.sessionId === 'string' && !!c.sessionId && typeof c.title === 'string' && (c.chat === undefined || typeof c.chat === 'boolean');
    if (c.kind === 'utility') return RIGHT_UTILITY_IDS.includes(c.sel) && typeof c.title === 'string';
    if (c.kind === 'git') return typeof c.repoPath === 'string';
    if (c.kind === 'diff') return typeof c.repoPath === 'string' && typeof c.filePath === 'string' && typeof c.staged === 'boolean';
    if (c.kind === 'review') return !!c.owner && (c.owner.kind === 'gui' || c.owner.kind === 'dispatch') && typeof c.owner.id === 'string' && (c.messageId === undefined || typeof c.messageId === 'string') && (c.filePath === undefined || typeof c.filePath === 'string') && (c.repoPath === undefined || typeof c.repoPath === 'string') && (c.owner.kind !== 'dispatch' || c.owner.id === workspaceId);
    if (c.kind !== 'file' && c.kind !== 'image' || typeof c.path !== 'string') return false;
    return c.external === true || !!c.fileRef && c.fileRef.workspaceId === workspaceId && typeof c.fileRef.rootId === 'string' && typeof c.fileRef.relativePath === 'string' && c.fileRef.relativePath === c.path;
  }).slice(0, 200).map((tab): RightTab => {
    const pinned = tab.pinned === true;
    // Legacy tabs used the pin bit for both workspace sharing and explicit pins.
    const scope = isDockedRightContent(tab.content) ? 'workspace' :
      tab.scope === 'workspace' || tab.scope === 'session' ? tab.scope : pinned ? 'workspace' : 'session';
    return { ...tab, scope, pinned, preview: (tab.suspended === true || tab.archiveBacked === true) && tab.preview === true,
      centerOnly: undefined,
      origin: tab.origin === 'agent' || tab.origin === 'user' ? tab.origin : 'unknown',
      deferredDock: tab.deferredDock === true && tab.origin === 'agent' && (tab.content.kind === 'session' || tab.content.kind === 'utility') ? true : undefined,
      archiveBacked: tab.archiveBacked === true ? true : undefined,
      suspended: tab.suspended === true && scope === 'session' ? true : undefined };
  }) : [];
  return { version: 1, tabs, selected: v.selected && typeof v.selected === 'object' ? v.selected : {},
    panel: RESOURCE_PANELS.includes(v.panel) ? v.panel : 'files', collapsed: v.collapsed === true };
}
