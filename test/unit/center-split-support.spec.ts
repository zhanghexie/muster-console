import { describe, expect, it } from 'vitest';
import {
  isCenterSplitSession, resolveActualCenterSelection, resolveCenterSplitPrimary, supportsCenterSplitRef,
  type CenterSplitSources
} from '../../src/renderer/src/centerSplitSupport';

const sources: CenterSplitSources = {
  sessions: [{ id: 'chat', type: 'terminal' }, { id: 'service', type: 'scheduled' }],
  navigation: [
    { id: 'folder', kind: 'folder', parentId: null, title: '工具', expanded: true },
    { id: 'extension', kind: 'extension', parentId: 'folder', title: '面板', extensionId: 'active', viewId: 'panel' },
    { id: 'legacy-web', kind: 'web', parentId: null, title: '旧网页', url: 'https://example.com' }
  ]
};

describe('中央分屏显示支持与主选解析', () => {
  it('终端/GUI 会话可分屏，定时任务与失源会话不会成为空白主侧', () => {
    expect(isCenterSplitSession(sources.sessions[0])).toBe(true);
    expect(isCenterSplitSession(sources.sessions[1])).toBe(false);
    expect(resolveCenterSplitPrimary(null, 'chat', sources)).toEqual({ kind: 'session', sessionId: 'chat' });
    expect(resolveCenterSplitPrimary(null, 'service', sources)).toEqual({ kind: 'empty' });
    expect(resolveCenterSplitPrimary(null, 'missing', sources)).toEqual({ kind: 'empty' });
    expect(supportsCenterSplitRef({ kind: 'session', sessionId: 'service' }, sources)).toBe(false);
  });

  it('子代理（带 parentSessionId 的 terminal 会话）与普通会话同等可分屏', () => {
    // 子代理通用化契约：分屏按引用驱动、不看父子关系，子代理不得被排除出分屏。
    // 锁此用例防将来有人给 supportsCenterSplitRef 加「有父即禁」这类排除。
    const withChild = {
      sessions: [
        { id: 'parent', type: 'terminal' as const },
        { id: 'child', type: 'terminal' as const, parentSessionId: 'parent' },
        { id: 'grand', type: 'terminal' as const, parentSessionId: 'child' }
      ],
      navigation: []
    };
    expect(isCenterSplitSession(withChild.sessions[1])).toBe(true);
    expect(isCenterSplitSession(withChild.sessions[2])).toBe(true);
    expect(supportsCenterSplitRef({ kind: 'session', sessionId: 'child' }, withChild)).toBe(true);
    expect(supportsCenterSplitRef({ kind: 'session', sessionId: 'grand' }, withChild)).toBe(true);
    // 子代理可作为主侧被解析（点左栏子代理行 → 整页下钻）
    expect(resolveCenterSplitPrimary(null, 'child', withChild)).toEqual({
      kind: 'session',
      sessionId: 'child'
    });
  });

  it('桥保留真实 scheduled 导航供迟到选择竞争判定，快捷键仍过滤它', () => {
    expect(resolveActualCenterSelection(null, 'service', sources)).toEqual({ kind: 'session', sessionId: 'service' });
    expect(resolveCenterSplitPrimary(null, 'service', sources)).toEqual({ kind: 'empty' });
    expect(resolveActualCenterSelection(null, 'missing', sources)).toEqual({ kind: 'empty' });
    expect(resolveActualCenterSelection('tasks', 'service', sources)).toEqual({ kind: 'utility', sel: 'tasks' });
  });

  it('工具主侧优先于背后的 scheduled 会话，空选择器与文件夹保持可用', () => {
    expect(resolveCenterSplitPrimary('tasks', 'service', sources)).toEqual({ kind: 'utility', sel: 'tasks' });
    expect(supportsCenterSplitRef({ kind: 'empty' }, sources)).toBe(true);
    expect(resolveCenterSplitPrimary('nav:folder', null, sources)).toEqual({ kind: 'utility', sel: 'nav:folder' });
    expect(supportsCenterSplitRef({ kind: 'utility', sel: 'nav:extension' }, sources)).toBe(true);
  });

  it('删除的入口、旧网页和退役的直接扩展引用不能参与分屏', () => {
    for (const sel of ['nav:missing', 'nav:legacy-web', 'ext:active', 'ext:missing', 'ext:disabled', 'ext:action-only', 'unknown']) {
      expect(supportsCenterSplitRef({ kind: 'utility', sel }, sources)).toBe(false);
      expect(resolveCenterSplitPrimary(sel, 'chat', sources)).toEqual({ kind: 'empty' });
    }
  });
  it('only accepts center file references present in the current trusted source set', () => {
    const target = { kind: 'utility' as const, sel: 'center-file:right-7' };
    expect(supportsCenterSplitRef(target, sources)).toBe(false);
    expect(supportsCenterSplitRef(target, { ...sources, centerFileIds: ['right-7'] })).toBe(true);
    expect(supportsCenterSplitRef(target, { ...sources, centerFileIds: ['right-8'] })).toBe(false);
    expect(resolveCenterSplitPrimary(target.sel, 'chat', { ...sources, centerFileIds: ['right-7'] })).toEqual(target);
  });
});
