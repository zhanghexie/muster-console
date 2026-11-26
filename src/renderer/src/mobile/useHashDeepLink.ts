/**
 * 会话 hash 深链（#/session/<id>，飞书卡片「打开」/toast「查看」落点）→ 回调直落目标会话。
 *
 * 两个时序事实决定实现形态：
 * 1. hash 在页面加载前就已存在（冷启动直达），且之后几乎不会再变——只靠 hashchange
 *    事件会漏掉挂载前就带着 hash 打开的场景，挂载时必须主动 apply 一次；
 * 2. 会话表是异步拉取的（挂载时常为 []，resolveSessionFromHash 返回 null），数据到位后
 *    必须重试——apply 经 ref 读会话表、appliedHashRef 去重，重放幂等无害。
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { resolveSessionFromHash } from '../../../shared/sessionDeepLink';

export function useHashDeepLink(options: {
  /** 最新会话表（ref 形态，apply 不依赖其引用稳定性） */
  sessionsRef: RefObject<ReadonlyArray<{ id: string; workspaceId?: string }>>;
  /** 会话表引用，仅作「数据到位后重试一次」的触发依赖 */
  sessions: ReadonlyArray<{ id: string; workspaceId?: string }>;
  onHit: (workspaceId: string, sessionId: string) => void;
}): void {
  const { sessionsRef, sessions, onHit } = options;
  const appliedHashRef = useRef('');
  const onHitRef = useRef(onHit);
  onHitRef.current = onHit;

  const apply = useCallback((): void => {
    const hash = window.location.hash;
    const hit = resolveSessionFromHash(hash, sessionsRef.current ?? []);
    if (!hit) return;
    if (appliedHashRef.current === hash) return;
    appliedHashRef.current = hash;
    onHitRef.current(hit.workspaceId, hit.sessionId);
  }, [sessionsRef]);

  // 挂载即 apply（冷启动 hash 场景）+ 监听后续变化；apply 引用稳定，监听器只挂一次
  useEffect(() => {
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [apply]);

  // 冷启动重试：挂载时会话表常为空，到位后重放（appliedHashRef 去重，命中过即 no-op）
  useEffect(() => {
    apply();
  }, [apply, sessions]);
}
