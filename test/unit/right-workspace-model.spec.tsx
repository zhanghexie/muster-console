import { describe, expect, it } from 'vitest';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace as reduce, rightContentKey, rightResources, saveRightWorkspace, validateRightWorkspaceSaved, visibleRightTabs, type RightContent } from '../../src/shared/rightWorkspace';
import { readArchivedRightTabs, serializeArchivedRightTabs, writeArchivedRightTabs } from '../../src/renderer/src/archivedRightTabs';
const file = (path: string, rootId = 'a'): RightContent => ({ kind: 'file', path, fileRef: { workspaceId: 'ws', rootId, relativePath: path } });
const web: RightContent = { kind: 'web', browserId: 'bt1', title: 'Prototype', url: 'https://prototype.test/' };
const repo: RightContent = { kind: 'git', repoPath: 'E:/ws' };
describe('production unified right workspace', () => {
  it('keeps browser export playback available until restart and saves ordinary browser tabs', () => {
    let model = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: web, origin: 'user' });
    model = reduce(model, { type: 'open', content: { kind: 'web', browserId: 'bt2', title: 'PPT', url: 'muster-export://id/slides.html' }, origin: 'user' });
    expect(activeRightTab(model)?.content).toMatchObject({ title: 'PPT' });
    expect(saveRightWorkspace(model).tabs.map(tab => tab.content.kind === 'web' && tab.content.url)).toEqual(['https://prototype.test/']);
  });
  it('undoes and redoes a preview navigation in the original tab', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts'), source: 'preview' });
    const id = activeRightTab(s)!.id;
    s = reduce(s, { type: 'open', content: file('b.ts'), source: 'preview' });
    s = reduce(s, { type: 'history', dir: -1 });
    expect(visibleRightTabs(s).map(tab => [tab.id, tab.content, tab.preview])).toEqual([[id, file('a.ts'), true]]);
    s = reduce(s, { type: 'history', dir: 1 });
    expect(visibleRightTabs(s).map(tab => [tab.id, tab.content])).toEqual([[id, file('b.ts')]]);
  });
  it('drops only closed workspace file instances and allows later hydration', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'hydrate', workspaceId: 'ws' });
    s = reduce(s, { type: 'open', content: file('visible.ts'), origin: 'user' });
    s = reduce(s, { type: 'openCenterOwned', workspaceId: 'ws', sessionId: 's1', content: file('center.ts') });
    s = reduce(s, { type: 'open', content: repo, origin: 'user' });
    const saved = saveRightWorkspace(s);
    s = reduce(s, { type: 'forgetWorkspaceFiles', workspaceId: 'ws' });
    expect(s.tabs.filter(tab => tab.content.kind === 'file')).toHaveLength(0);
    expect(s.tabs.some(tab => tab.content.kind === 'git')).toBe(true);
    expect(s.hydrated).not.toContain('ws');
    s = reduce(s, { type: 'hydrate', workspaceId: 'ws', saved });
    expect(s.tabs.filter(tab => tab.content.kind === 'file')).toHaveLength(1);
    expect(s.tabs.filter(tab => tab.content.kind === 'git')).toHaveLength(1);
  });
  it('keeps a center-owned file backing view out of right tabs and persistence, reuses it, and lets a user open it on the right', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('visible.ts'), origin: 'user' });
    const selected = activeRightTab(s)!.id;
    s = reduce(s, { type: 'openCenterOwned', workspaceId: 'ws', sessionId: 's1', content: file('center.ts') });
    const backing = s.tabs.find(tab => tab.centerOnly)!;
    expect(backing.content).toEqual(file('center.ts'));
    expect(activeRightTab(s)?.id).toBe(selected);
    expect(visibleRightTabs(s).map(tab => tab.id)).not.toContain(backing.id);
    expect(saveRightWorkspace(s).tabs.map(tab => tab.id)).not.toContain(backing.id);
    expect(serializeArchivedRightTabs(reduce(s, { type: 'suspend', id: backing.id }))).not.toContain('center.ts');
    s = reduce(s, { type: 'openCenterOwned', workspaceId: 'ws', sessionId: 's1', content: file('center.ts') });
    expect(s.tabs.filter(tab => rightContentKey(tab.content) === rightContentKey(file('center.ts')))).toHaveLength(1);
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: file('center.ts'), focus: false, origin: 'agent' });
    expect(s.tabs.find(tab => tab.id === backing.id)?.centerOnly).toBe(true);
    expect(activeRightTab(s)?.id).toBe(selected);
    expect(reduce(s, { type: 'releaseCenterOwned', workspaceId: 'ws', id: backing.id, expectedContent: '{}' }).tabs).toContainEqual(backing);
    expect(reduce(s, { type: 'releaseCenterOwned', workspaceId: 'ws', id: backing.id, expectedContent: JSON.stringify(backing.content) }).tabs).not.toContainEqual(backing);
    s = reduce(s, { type: 'open', content: file('center.ts'), origin: 'user' });
    expect(activeRightTab(s)?.id).toBe(backing.id);
    expect(activeRightTab(s)?.centerOnly).toBeUndefined();
    expect(s.tabs.filter(tab => rightContentKey(tab.content) === rightContentKey(file('center.ts')))).toHaveLength(1);
  });
  it('reuses a visible owner without changing it and rejects cross-workspace or external center files', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('visible.ts'), origin: 'user' });
    const original = s.tabs[0];
    s = reduce(s, { type: 'openCenterOwned', workspaceId: 'ws', sessionId: 's1', content: file('visible.ts') });
    expect(s.tabs).toEqual([original]);
    s = reduce(s, { type: 'openCenterOwned', workspaceId: 'other', sessionId: 's1', content: file('bad.ts') });
    s = reduce(s, { type: 'openCenterOwned', workspaceId: 'ws', sessionId: 's1', content: { kind: 'file', path: 'external', external: true } });
    expect(s.tabs).toEqual([original]);
  });
  it('defers an agent dock target until explicit selection, including restore and replacement', () => {
    const utility: RightContent = { kind: 'utility', sel: 'tasks', title: '定时任务' };
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: utility, focus: false, origin: 'agent' });
    const id = s.tabs[0].id;
    expect(s.tabs[0].deferredDock).toBe(true);
    expect(activeRightTab(s)).toBeUndefined();
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: utility, focus: false, origin: 'agent' });
    expect(s.tabs).toHaveLength(1); expect(s.tabs[0].deferredDock).toBe(true);
    const restored = validateRightWorkspaceSaved(saveRightWorkspace(s), 'ws')!;
    expect(restored.tabs[0].deferredDock).toBe(true);
    s = reduce(s, { type: 'open', content: file('visible.ts'), origin: 'user' });
    const fileId = activeRightTab(s)!.id;
    s = reduce(s, { type: 'close', ids: [fileId] });
    expect(activeRightTab(s)).toBeUndefined();
    expect(s.tabs[0].deferredDock).toBe(true);
    s = reduce(s, { type: 'select', id });
    expect(activeRightTab(s)?.id).toBe(id);
    expect(s.tabs[0].deferredDock).toBeUndefined();
  });
  it('keeps Linux and macOS repository case distinct while normalizing Windows paths', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      for (const os of ['linux', 'darwin']) {
        Object.defineProperty(process, 'platform', { ...platform, value: os });
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: os === 'linux' ? 'Linux' : 'MacIntel' } });
        expect(rightContentKey({ kind: 'git', repoPath: '/work/Foo' })).not.toBe(rightContentKey({ kind: 'git', repoPath: '/work/foo' }));
        expect(rightContentKey({ kind: 'diff', repoPath: '/work/Foo', filePath: 'a', staged: false })).not.toBe(rightContentKey({ kind: 'diff', repoPath: '/work/foo', filePath: 'a', staged: false }));
      }
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(rightContentKey({ kind: 'git', repoPath: 'C:\\Work\\Repo' })).toBe(rightContentKey({ kind: 'git', repoPath: 'c:/work/repo/' }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (nav) Object.defineProperty(globalThis, 'navigator', nav);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
  it('tracks tab origin without relabeling an existing user tab and preserves it across restore', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('user.ts'), origin: 'user' });
    const userId = activeRightTab(s)!.id;
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: file('user.ts'), focus: false, origin: 'agent' });
    expect(s.tabs.find(tab => tab.id === userId)?.origin).toBe('user');
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: file('agent.ts'), focus: false, origin: 'agent' });
    expect(activeRightTab(s)?.id).toBe(userId);
    expect(s.tabs.find(tab => tab.content.kind === 'file' && tab.content.path === 'agent.ts')?.origin).toBe('agent');
    const restored = validateRightWorkspaceSaved(saveRightWorkspace(s), 'ws')!;
    expect(restored.tabs.map(tab => tab.origin).sort()).toEqual(['agent', 'user']);
    const untrusted = { ...restored, tabs: restored.tabs.map(tab => ({ ...tab, origin: 'invented' })) };
    expect(validateRightWorkspaceSaved(untrusted, 'ws')!.tabs.every(tab => tab.origin === 'unknown')).toBe(true);
  });
  it('keeps sidebar previews shared while replacing only the matching scope preview', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts'), source: 'preview', scope: 'workspace' });
    const sharedId = activeRightTab(s)!.id;
    expect(activeRightTab(s)).toMatchObject({ scope: 'workspace', pinned: false, preview: true });
    s = reduce(s, { type: 'open', content: file('chat.ts'), source: 'preview', scope: 'session' });
    expect(s.tabs).toHaveLength(2);
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's2' });
    expect(visibleRightTabs(s).map(tab => tab.id)).toEqual([sharedId]);
    s = reduce(s, { type: 'open', content: file('b.ts'), source: 'preview', scope: 'workspace' });
    expect(activeRightTab(s)).toMatchObject({ id: sharedId, scope: 'workspace', pinned: false, preview: true, content: { path: 'b.ts' } });
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's1' });
    expect(s.tabs.some(tab => tab.content.kind === 'file' && tab.content.path === 'chat.ts')).toBe(true);
  });
  it('keeps a session open separate from the same workspace-shared file', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('same.ts'), scope: 'workspace' });
    s = reduce(s, { type: 'open', content: file('same.ts'), scope: 'session' });
    expect(s.tabs.map(tab => [tab.scope, tab.pinned])).toEqual([['workspace', false], ['session', false]]);
  });
  it('persists suspended session tabs and restores their selection after native closure', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: web });
    const id = activeRightTab(s)!.id;
    s = reduce(s, { type: 'suspend', id });
    expect(visibleRightTabs(s)).toHaveLength(0);
    s = reduce(s, { type: 'nativeClosed', browserIds: ['bt1'] });
    expect(s.tabs[0]).toMatchObject({ suspended: true, content: { browserId: '', url: web.url } });
    const saved = saveRightWorkspace(s);
    let restored = reduce(initialRightWorkspace('ws', 's1'), { type: 'hydrate', workspaceId: 'ws', saved });
    expect(visibleRightTabs(restored)).toHaveLength(0);
    const restoredId = restored.tabs[0].id;
    restored = reduce(restored, { type: 'resume', id: restoredId });
    expect(activeRightTab(restored)).toMatchObject({ id: restoredId, content: { browserId: '', url: web.url } });
  });
  it('recovers archived tabs from another workspace after a restart and merges its later preferences', () => {
    localStorage.removeItem('muster.right-workspace.archived-tabs.v1');
    let s = reduce(initialRightWorkspace('other', 'chat-a'), { type: 'open', content: { ...web, browserId: 'other-web' } });
    const id = activeRightTab(s)!.id;
    s = reduce(s, { type: 'suspend', id });
    const workspaceSaved = saveRightWorkspace(s);
    writeArchivedRightTabs(serializeArchivedRightTabs(s));
    const loaded = readArchivedRightTabs();
    expect(loaded.error).toBeUndefined(); expect(loaded.tabs).toHaveLength(1);
    let restarted = reduce(initialRightWorkspace('ws', 's2'), { type: 'restoreArchived', tabs: loaded.tabs });
    restarted = reduce(restarted, { type: 'scope', workspaceId: 'other', sessionId: 'chat-a' });
    restarted = reduce(restarted, { type: 'hydrate', workspaceId: 'other', saved: workspaceSaved });
    expect(restarted.tabs).toHaveLength(1); expect(visibleRightTabs(restarted)).toHaveLength(0);
    restarted = reduce(restarted, { type: 'resume', id: restarted.tabs[0].id });
    expect(activeRightTab(restarted)?.content).toMatchObject({ browserId: '', url: web.url });
    localStorage.removeItem('muster.right-workspace.archived-tabs.v1');
  });
  it('pinned sessions and utilities are project-wide, keep the resource panel, persist and close only when their session is gone', () => {
    const term: RightContent = { kind: 'session', sessionId: 'sh1', title: 'PowerShell 1' };
    const tasks: RightContent = { kind: 'utility', sel: 'tasks', title: '定时任务' };
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts') });
    s = reduce(s, { type: 'open', content: term });
    s = reduce(s, { type: 'open', content: term });
    s = reduce(s, { type: 'open', content: tasks });
    expect(s.tabs).toHaveLength(3); expect(rightResources(s).panel).toBe('files');
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's2' });
    expect(visibleRightTabs(s).map(tab => tab.content.kind)).toEqual(['session', 'utility']);
    const restored = reduce(initialRightWorkspace('ws', 's9'), { type: 'hydrate', workspaceId: 'ws', saved: saveRightWorkspace(s) });
    expect(visibleRightTabs(restored).map(tab => tab.content)).toEqual([term, tasks]);
    expect(validateRightWorkspaceSaved({ ...saveRightWorkspace(s), panel: 'terminal' }, 'ws')?.panel).toBe('files');
    expect(validateRightWorkspaceSaved({ ...saveRightWorkspace(s), tabs: [{ ...s.tabs[2], content: { kind: 'utility', sel: 'nope', title: 'x' } }] }, 'ws')?.tabs).toEqual([]);
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's1' });
    s = reduce(s, { type: 'select', id: s.tabs[1].id });
    // 会话表尚未包含 sh1（未加载）时不清理，只改名存活会话
    s = reduce(s, { type: 'sessions', titles: [{ id: 'sh1', title: '构建' }], removed: [] });
    expect(activeRightTab(s)?.content).toEqual({ ...term, title: '构建' });
    expect(reduce(s, { type: 'sessions', titles: [], removed: [] })).toBe(s);
    s = reduce(s, { type: 'sessions', titles: [], removed: ['sh1'] });
    expect(s.tabs.map(tab => tab.content.kind)).toEqual(['file', 'utility']);
    expect(activeRightTab(s)?.content.kind).toBe('utility');
    expect(s.histories[JSON.stringify(['ws', 's1'])].entries.some(command => command.changes.some(change =>
      change.before?.tab.content.kind === 'session' || change.after?.tab.content.kind === 'session'))).toBe(false);
  });
  it('keeps a review per owner, follows Git resources and restores its selected turn and file', () => {
    let s = initialRightWorkspace('ws', 's1');
    const content: RightContent = { kind: 'review', owner: { kind: 'gui', id: 's1' }, messageId: 'a', filePath: 'a.ts' };
    s = reduce(s, { type: 'open', content });
    s = reduce(s, { type: 'open', content: { ...content, messageId: 'b', filePath: 'b.ts' } });
    expect(s.tabs).toHaveLength(1); expect(rightResources(s).panel).toBe('git');
    const restored = validateRightWorkspaceSaved(saveRightWorkspace(s), 'ws');
    expect(restored?.tabs[0].content).toEqual({ ...content, messageId: 'b', filePath: 'b.ts' });
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's2' });
    expect(visibleRightTabs(s)).toHaveLength(0);
    s = reduce(s, { type: 'open', content: { kind: 'review', owner: { kind: 'gui', id: 's2' } } });
    expect(s.tabs).toHaveLength(2);
  });
  it('single clicks reuse one preview; editing or double clicking makes it permanent', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts'), source: 'preview' });
    const id = activeRightTab(s)!.id;
    s = reduce(s, { type: 'open', content: file('b.ts'), source: 'preview' });
    expect(s.tabs).toHaveLength(1); expect(activeRightTab(s)!.id).toBe(id);
    s = reduce(s, { type: 'keep', id });
    s = reduce(s, { type: 'open', content: file('c.ts'), source: 'preview' });
    expect(s.tabs).toHaveLength(2); expect(s.tabs.filter(tab => tab.preview)).toHaveLength(1);
  });
  it('chat files deduplicate by root identity and keep the review tab', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: repo });
    s = reduce(s, { type: 'open', content: file('same.ts', 'a') });
    s = reduce(s, { type: 'open', content: file('same.ts', 'b') });
    s = reduce(s, { type: 'open', content: file('same.ts', 'a') });
    expect(s.tabs).toHaveLength(3); expect(activeRightTab(s)!.content).toEqual(file('same.ts', 'a'));
  });
  it('persists scope and pin independently and deduplicates a pinned tab in its own scope', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts'), scope: 'workspace' });
    s = reduce(s, { type: 'open', content: file('a.ts'), scope: 'session' });
    const sessionTab = activeRightTab(s)!;
    s = reduce(s, { type: 'pin', id: sessionTab.id });
    s = reduce(s, { type: 'open', content: sessionTab.content, scope: 'session' });
    expect(s.tabs).toHaveLength(2);
    expect(activeRightTab(s)).toMatchObject({ id: sessionTab.id, scope: 'session', pinned: true, sessionId: 's1' });
    const saved = saveRightWorkspace(s);
    s = reduce(initialRightWorkspace('ws', 's1'), { type: 'hydrate', workspaceId: 'ws', saved });
    expect(activeRightTab(s)).toMatchObject({ scope: 'session', pinned: true });
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's2' });
    expect(visibleRightTabs(s).map(tab => [tab.scope, tab.pinned])).toEqual([['workspace', false]]);
    s = reduce(s, { type: 'scope', workspaceId: 'other', sessionId: 's2' }); expect(visibleRightTabs(s)).toHaveLength(0);
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's1' });
    expect(activeRightTab(s)).toMatchObject({ scope: 'session', pinned: true });
  });
  it('infers the legacy scope and lets a saved project pin be unpinned without hiding it', () => {
    const legacy = { ...saveRightWorkspace(initialRightWorkspace('ws', 's1')), tabs: [
      { id: 'legacy-pin', workspaceId: 'ws', sessionId: 's1', pinned: true, preview: false, content: file('legacy.ts') },
      { id: 'legacy-session', workspaceId: 'ws', sessionId: 's1', pinned: false, preview: false, content: file('session.ts') }
    ] };
    const saved = validateRightWorkspaceSaved(legacy, 'ws')!;
    expect(saved.tabs.map(tab => [tab.scope, tab.pinned])).toEqual([['workspace', true], ['session', false]]);
    let s = reduce(initialRightWorkspace('ws', 's2'), { type: 'hydrate', workspaceId: 'ws', saved });
    s = reduce(s, { type: 'pin', id: activeRightTab(s)!.id });
    expect(visibleRightTabs(s)).toEqual([expect.objectContaining({ scope: 'workspace', pinned: false, sessionId: 's1' })]);
  });
  it('manual resource selection does not navigate; content selection follows while retaining collapse', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts') });
    const id = activeRightTab(s)!.id;
    s = reduce(s, { type: 'resources', panel: 'browser' }); expect(activeRightTab(s)!.id).toBe(id);
    s = reduce(s, { type: 'resources', collapsed: true });
    s = reduce(s, { type: 'select', id }); expect(rightResources(s)).toEqual({ panel: 'files', collapsed: true });
  });
  it('undo and redo open commands cross Git, image and web, with isolated chat histories', () => {
    let s = initialRightWorkspace('ws', 's1');
    for (const content of [repo, { ...file('preview.png'), kind: 'image' } as RightContent, web]) s = reduce(s, { type: 'open', content });
    s = reduce(s, { type: 'history', dir: -1 }); expect(visibleRightTabs(s).map(tab => tab.content.kind)).toEqual(['git', 'image']);
    s = reduce(s, { type: 'history', dir: -1 }); expect(visibleRightTabs(s).map(tab => tab.content.kind)).toEqual(['git']);
    s = reduce(s, { type: 'history', dir: 1 }); expect(visibleRightTabs(s).map(tab => tab.content.kind)).toEqual(['git', 'image']);
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's2' }); s = reduce(s, { type: 'history', dir: -1 }); expect(activeRightTab(s)).toBeUndefined();
  });
  it('preview history restores an older workspace file without pinning it or overwriting an edited preview', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts'), source: 'preview', scope: 'workspace' });
    s = reduce(s, { type: 'open', content: file('b.ts'), source: 'preview', scope: 'workspace' });
    s = reduce(s, { type: 'keep', id: activeRightTab(s)!.id });
    s = reduce(s, { type: 'history', dir: -1 }); expect(s.tabs).toHaveLength(2); expect(s.tabs.some(tab => tab.content.kind === 'file' && tab.content.path === 'b.ts')).toBe(true);
    expect(activeRightTab(s)).toMatchObject({ scope: 'workspace', pinned: false, content: file('a.ts') });
  });
  it('web commands refer to distinct committed positions even at the same URL', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: web, webHistoryKey: 'home' });
    s = reduce(s, { type: 'web', browserId: 'bt1', url: web.url, title: 'Next', historyKey: 'next', record: true });
    s = reduce(s, { type: 'history', dir: -1 }); expect(activeRightTab(s)!.content).toEqual(web); expect(s.tabs).toHaveLength(1);
    expect(activeRightTab(s)?.webHistoryKey).toBe('home');
    s = reduce(s, { type: 'history', dir: 1 }); expect(activeRightTab(s)?.webHistoryKey).toBe('next');
  });
  it('returning to a loaded page keeps its current title instead of its initial empty title', () => {
    let state = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: { ...web, title: '' } });
    state = reduce(state, { type: 'web', browserId: 'bt1', url: web.url, title: 'Prototype' });
    state = reduce(state, { type: 'open', content: file('review.ts') });
    state = reduce(state, { type: 'history', dir: -1 });
    expect(activeRightTab(state)!.content).toMatchObject({ title: 'Prototype', url: web.url });
  });
  it('async browser opens retain the original project and chat after navigation', () => {
    let s = initialRightWorkspace('other', 's2');
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: web });
    expect(visibleRightTabs(s)).toHaveLength(0); expect(s.workspaceId).toBe('other');
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's1' }); expect(activeRightTab(s)!.content).toEqual(web);
  });
  it('restoring native shells does not steal an existing file selection', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts') });
    const id = activeRightTab(s)!.id;
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: web, focus: false }); expect(activeRightTab(s)!.id).toBe(id);
  });
  it('independent diffs distinguish staged and unstaged views', () => {
    let s = initialRightWorkspace('ws', 's1');
    for (const staged of [false, true]) s = reduce(s, { type: 'open', content: { kind: 'diff', repoPath: 'E:/ws', filePath: 'a.ts', staged } });
    expect(s.tabs).toHaveLength(2);
  });
  it('close selects the adjacent tab and undo restores its scope and pin in the initiating chat', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: repo });
    const repoId = activeRightTab(s)!.id;
    s = reduce(s, { type: 'open', content: web, scope: 'workspace' }); const webId = activeRightTab(s)!.id;
    s = reduce(s, { type: 'pin', id: webId });
    s = reduce(s, { type: 'close', ids: [webId] }); expect(activeRightTab(s)!.id).toBe(repoId);
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's2' });
    expect(reduce(s, { type: 'history', dir: -1 })).toBe(s);
    s = reduce(s, { type: 'scope', workspaceId: 'ws', sessionId: 's1' });
    s = reduce(s, { type: 'history', dir: -1 }); expect(activeRightTab(s)).toMatchObject({ id: webId, scope: 'workspace', pinned: true });
    s = reduce(s, { type: 'history', dir: 1 }); expect(activeRightTab(s)?.id).toBe(repoId);
  });
  it('undoes a bulk close in one step, preserving order, independent background tabs and the selected tab', () => {
    let s = initialRightWorkspace('ws', 's1');
    for (const path of ['a.ts', 'b.ts', 'c.ts']) s = reduce(s, { type: 'open', content: file(path) });
    const [a, b, c] = s.tabs;
    const scope = JSON.stringify(['ws', 's1']);
    s = reduce(s, { type: 'select', id: b.id });
    expect(s.histories[scope].index).toBe(3);
    s = reduce(s, { type: 'close', ids: [a.id, b.id] });
    expect(activeRightTab(s)?.id).toBe(c.id);
    s = reduce(s, { type: 'openOwned', workspaceId: 'ws', sessionId: 's1', content: web, focus: false });
    const background = s.tabs.at(-1)!;
    s = reduce(s, { type: 'history', dir: -1 });
    expect(s.tabs.map(tab => tab.id)).toEqual([a.id, b.id, c.id, background.id]);
    expect(activeRightTab(s)?.id).toBe(b.id);
    s = reduce(s, { type: 'history', dir: 1 });
    expect(s.tabs.map(tab => tab.id)).toEqual([c.id, background.id]);
    expect(s.histories[scope].index).toBe(4);
  });
  it('saved layout excludes temporary previews and bookmarks and remaps tab IDs', () => {
    let s = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: web });
    s = reduce(s, { type: 'open', content: file('a.ts'), source: 'preview' });
    s = reduce(s, { type: 'bookmarkSnapshot', workspaceId: 'ws', saved: { version: 1, bookmarkDefaultsVersion: 1,
      bookmarks: [{ id: 'folder', label: 'Design', children: [{ id: 'site', label: 'Prototype', url: 'https://prototype.test/' }] }] } });
    const saved = saveRightWorkspace(s); expect(saved.tabs).toHaveLength(1); expect((saved.tabs[0].content as typeof web).browserId).toBe('');
    expect(saved).not.toHaveProperty('bookmarks');
    expect(saved).not.toHaveProperty('bookmarkDefaultsVersion');
    const restored = reduce(initialRightWorkspace('ws', 's1'), { type: 'hydrate', workspaceId: 'ws', saved });
    expect(restored.bookmarks.ws).toBeUndefined();
    expect(reduce(restored, { type: 'hydrate', workspaceId: 'ws', saved }).tabs).toHaveLength(1);
  });
  it('late preference hydration does not duplicate a newly opened tab or replace its selection', () => {
    let savedState = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts') });
    const saved = saveRightWorkspace(savedState);
    let state = reduce(initialRightWorkspace('ws', 's1'), { type: 'open', content: file('a.ts') });
    state = reduce(state, { type: 'open', content: repo }); const id = activeRightTab(state)!.id;
    state = reduce(state, { type: 'hydrate', workspaceId: 'ws', saved });
    expect(state.tabs).toHaveLength(2); expect(activeRightTab(state)!.id).toBe(id);
  });
  it('persisted workspace files require explicit source root identity', () => {
    const saved = { ...saveRightWorkspace(initialRightWorkspace('ws', 's1')), tabs: [{ id: 'old', workspaceId: 'ws', sessionId: 's1', content: { kind: 'file', path: 'a.ts' } }] };
    expect(validateRightWorkspaceSaved(saved, 'ws')!.tabs).toHaveLength(0);
  });
  it('discards cross-project FileRefs and leaves legacy bookmarks to the host', () => {
    const saved = { ...saveRightWorkspace(initialRightWorkspace('ws', 's1')), tabs: [{ id: 'old', workspaceId: 'ws', sessionId: 's1', content: { ...file('a.ts'), fileRef: { workspaceId: 'other', rootId: 'a', relativePath: 'a.ts' } } }], bookmarks: [{ id: 'bad', label: 'bad', url: 'javascript:alert(1)' }] };
    expect(validateRightWorkspaceSaved(saved, 'ws')!.tabs).toHaveLength(0);
    expect(validateRightWorkspaceSaved(saved, 'ws')).not.toHaveProperty('bookmarks');
  });
});


it('projects extension tabs from navigation across sessions and purges recalled history', () => {
  let model = initialRightWorkspace('ws', 'a');
  model = reduce(model, { type: 'extensions', contents: [{ kind: 'extension', nodeId: 'board', title: '工具' }] });
  const id = activeRightTab(model)!.id;
  model = reduce(model, { type: 'scope', workspaceId: 'ws', sessionId: 'b' });
  expect(visibleRightTabs(model).map(tab => tab.id)).toEqual([id]);
  expect(saveRightWorkspace(model).tabs).toEqual([]);
  model = reduce(model, { type: 'extensions', contents: [{ kind: 'extension', nodeId: 'board', title: '新名字' }] });
  expect(activeRightTab(model)!.content).toMatchObject({ title: '新名字' });
  model = reduce(model, { type: 'extensions', contents: [] });
  model = reduce(model, { type: 'scope', workspaceId: 'ws', sessionId: 'a' });
  model = reduce(model, { type: 'history', dir: -1 });
  expect(visibleRightTabs(model)).toEqual([]);
});

it('promotes only the matching owned hidden browser surface and keeps its instance', () => {
  let model = reduce(initialRightWorkspace('ws','visible-chat'), {type:'openOwned',workspaceId:'ws',sessionId:'extension-agent',scope:'session',focus:false,content:web});
  const id = model.tabs[0].id;
  expect(visibleRightTabs(model)).toHaveLength(0);
  const request = {type:'presentWeb' as const,browserId:'bt1',url:web.url,ownerSessionId:'extension-agent'};
  expect(reduce(model,{...request,ownerSessionId:'peer'})).toBe(model);
  expect(reduce(model,{...request,url:'https://changed.test/'})).toBe(model);
  const ownerView = reduce(model, {type:'scope', workspaceId:'ws', sessionId:'extension-agent'});
  expect(activeRightTab(reduce(ownerView,request))?.scope).toBe('session');
  model = reduce(model,request);
  expect(model.tabs).toHaveLength(1);
  expect(activeRightTab(model)).toMatchObject({id,sessionId:'extension-agent',scope:'workspace',content:web});
});
