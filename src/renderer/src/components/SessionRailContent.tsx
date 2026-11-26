import React from 'react';
import { StatusBadge } from './StatusBadge';

/** 单行名称与状态始终并列；完整内容统一由会话详情悬浮卡展示。 */
export function SessionRailContent({ name, status, statusClassName, editing = false, children }: {
  name: string;
  status: string;
  statusClassName: string;
  editing?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return <span className="session-main session-rail-content">
    <span className="session-rail-name" aria-label={editing ? undefined : name}>{children}</span>
    {status && !editing ? <StatusBadge className={`${statusClassName} session-rail-status`} aria-label={status}>
      <span className="session-capsule-label session-rail-status-label">{status}</span>
    </StatusBadge> : null}
  </span>;
}
