/**
 * 会话视图保活 LRU（2026-10-14）纯逻辑契约：
 * 1) touch 新面孔入池（尾部最新），容量 CAP、超容逐出最旧；
 * 2) 池内 touch 只移位不通知（version 不变——切会话不产生无谓重渲）；
 * 3) retainSessionViews 清死会话并通知；
 * 4) keptSessionViews：显示中（active/分屏）恒保 + 池内存活。
 * 还原即红：去掉逐出（容量不裁）时「最旧被逐出」转红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_VIEW_LRU_CAP,
  getSessionViewsDebug,
  getSessionViewsVersion,
  isSessionViewAlive,
  keptSessionViews,
  resetSessionViewsForTest,
  retainSessionViews,
  subscribeSessionViews,
  touchSessionView
} from '../../src/renderer/src/sessionViewLru';

describe('会话视图保活 LRU', () => {
  beforeEach(() => resetSessionViewsForTest());

  it('touch 入池、容量封顶、逐出最旧', () => {
    for (let i = 0; i < SESSION_VIEW_LRU_CAP + 3; i++) touchSessionView(`s${i}`);
    const alive = getSessionViewsDebug();
    expect(alive).toHaveLength(SESSION_VIEW_LRU_CAP);
    expect(isSessionViewAlive('s0')).toBe(false); // 最旧的三个被逐出
    expect(isSessionViewAlive('s1')).toBe(false);
    expect(isSessionViewAlive('s2')).toBe(false);
    expect(isSessionViewAlive(`s${SESSION_VIEW_LRU_CAP + 2}`)).toBe(true); // 最新在
    expect(alive[alive.length - 1]).toBe(`s${SESSION_VIEW_LRU_CAP + 2}`); // 尾部=最近
  });

  it('池内 touch 移位但不通知（存活集合未变）', () => {
    touchSessionView('a');
    touchSessionView('b');
    const v1 = getSessionViewsVersion();
    touchSessionView('a'); // 移到尾部
    expect(getSessionViewsVersion()).toBe(v1); // 不通知
    expect(getSessionViewsDebug()[1]).toBe('a'); // 顺序确实更新
    touchSessionView('c'); // 新面孔
    expect(getSessionViewsVersion()).toBe(v1 + 1); // 通知
  });

  it('retain 清死会话并通知', () => {
    touchSessionView('a');
    touchSessionView('b');
    const v1 = getSessionViewsVersion();
    retainSessionViews(new Set(['b', 'x']));
    expect(getSessionViewsVersion()).toBe(v1 + 1);
    expect(isSessionViewAlive('a')).toBe(false);
    expect(isSessionViewAlive('b')).toBe(true);
  });

  it('订阅在集合变化时收到通知', () => {
    const fn = vi.fn();
    const stop = subscribeSessionViews(fn);
    touchSessionView('a');
    expect(fn).toHaveBeenCalledTimes(1);
    touchSessionView('a'); // 移位不通知
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    touchSessionView('b');
    expect(fn).toHaveBeenCalledTimes(1); // 退订后不再收
  });

  it('keptSessionViews：显示中恒保 + 池内存活，其余过滤', () => {
    const views = [{ id: 'active' }, { id: 'split' }, { id: 'pooled' }, { id: 'cold' }, { id: 'gone' }];
    touchSessionView('pooled');
    touchSessionView('gone');
    // 会话仍全部在 store，但只有 pooled/gone 进过池
    const kept = keptSessionViews(views, 'active', new Set(['split']));
    expect(kept.map((v) => v.id)).toEqual(['active', 'split', 'pooled', 'gone']);
  });
});
