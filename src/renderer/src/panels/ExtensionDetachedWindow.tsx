import React from 'react';
import { useTranslation } from 'react-i18next';
import { DomainExtensionPanel } from './DomainExtensionPanel';

/**
 * 扩展独立窗口（主进程 panelViews 以 `#extension-window?...` 打开的完整应用窗口）：
 * 整个扩展面板——扩展 iframe 与 AI 侧栏——作为一个整体在此渲染；会话流事件经主进程
 * aux 广播送达，AI 与主窗口共用同一 Agent 会话。
 */
export function ExtensionDetachedWindow(): React.JSX.Element {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.hash.slice('#extension-window?'.length));
  const workspaceId = params.get('workspaceId') ?? '';
  const extensionId = params.get('extensionId') ?? '';
  const sourceRootId = params.get('sourceRootId') ?? undefined;
  if (!workspaceId || !extensionId) {
    return <div className="ui-empty" role="alert"><p>{t('扩展窗口参数缺失，请从扩展面板重新打开独立窗口。')}</p></div>;
  }
  return (
    <div className="detached-extension-window">
      <DomainExtensionPanel workspaceId={workspaceId} extensionId={extensionId} sourceRootId={sourceRootId} active detachedWindow onClose={() => window.close()} />
    </div>
  );
}
