/**
 * 手机表面订阅服务端 session-status 推送帧（T1.2，mobile-surface.md「服务端推送」）。
 *
 * 订阅源是 webApiShim 的 WS push 帧（桌面壳无 shim 时 no-op——桌面有自己的
 * toast 总线）。回调经 ref 取最新实现，订阅本身只建立一次（连接生命周期对齐）。
 * isViewingSession：用户正停在某个 L3 会话页时，该会话的推送由页面自身呈现，
 * 静默跳过（toast 只服务「没盯着」的会话）。
 */
import { useEffect, useRef } from 'react';
import type { SessionStatusPush } from '../../../shared/webPush';
import { subscribeSessionStatusPush } from '../webApiShim';

export interface UseSessionStatusPushOptions {
  /** 每个通过过滤的推送帧回调一次 */
  onPush(push: SessionStatusPush): void;
  /** 返回 true = 用户正在直接查看该会话，跳过本帧 */
  isViewingSession?(sessionId: string): boolean;
}

export function useSessionStatusPush(options: UseSessionStatusPushOptions): void {
  const ref = useRef(options);
  ref.current = options;
  useEffect(() => {
    const off = subscribeSessionStatusPush((push) => {
      if (ref.current.isViewingSession?.(push.sessionId)) return;
      ref.current.onPush(push);
    });
    return off;
  }, []);
}
