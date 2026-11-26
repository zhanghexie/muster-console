import React, { useSyncExternalStore } from 'react';
import { usePresence } from './motion';
import { ErrorTip } from './ErrorTip';
import {
  bootStatusSnapshot,
  subscribeBootStatus
} from '../bootStatus';
import { t } from '../../../shared/i18n';

/**
 * 启动降级横幅（X7-F01）：bootWait 兜底超时半挂载期间，顶部明示「仍在初始化」，
 * 不再让面板空置得像坏掉；主进程就绪后退场（数据重拉由 bootStatus 的
 * BOOT_REHYDRATE_EVENT 驱动，与本组件无关）。启动链最终失败（超时后才 resolve
 * ok:false）时用全局 tip 提示。进出场走 usePresence + mp-panel-top 骨架。
 */
export function BootStatusBanner(): React.JSX.Element {
  const status = useSyncExternalStore(subscribeBootStatus, bootStatusSnapshot, bootStatusSnapshot);
  const presence = usePresence(status.phase === 'degraded');
  return <>
    <ErrorTip message={status.phase === 'failed' ? t('初始化失败：{{error}}', { error: status.error ?? '' }) : null} />
    {presence.mounted && <div className="boot-status-banner mp-panel mp-panel-top is-degraded" role="status" {...presence.spread}>
      {t('仍在初始化，部分面板可能暂不可用')}
    </div>}
  </>;
}
