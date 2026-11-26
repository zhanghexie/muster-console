import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore, useUiStore } from '../store';
import { useExtensionWorkbenchNavigation, setExtensionPlacement } from '../extensionWorkbench';
import { navigationChildren } from '../../../shared/extensionNavigation';
import { extensionSurfaceKey } from '../components/ExtensionSurface';
import { showInCenter } from '../rightDock';
import { DomainExtensionPanel } from './DomainExtensionPanel';
import { NavigationIcon } from '../components/ExtensionNavigationTree';
import type { UtilitySelection } from './LeftPanel';

export function WorkbenchNavigationPanel({ nodeId, active, centerOnly, onClose, onSelect }: { nodeId: string; active: boolean; /** 分屏 pane 内隐藏文件夹返回按钮 */ centerOnly?: boolean; onClose?: () => void; onSelect?: (selection: UtilitySelection) => void }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { activeWorkspaceId } = useWorkspaceStore();
  const { requestShowWorkspace, flashTip } = useUiStore();
  const placementRequest = useRef(0);
  const snapshot = useExtensionWorkbenchNavigation(activeWorkspaceId ?? '');
  const node = snapshot.nodes.find(node => node.id === nodeId);
  if (!node) return <div className="ui-empty"><p>{t('入口已移除或尚未加载')}</p><button className="ui-btn" onClick={onClose}>{t('返回会话')}</button></div>;
  if (node.kind === 'extension') return <DomainExtensionPanel workspaceId={snapshot.workspaceId} extensionId={node.extensionId} scope={node.extensionScope ?? 'global'} sourceRootId={node.extensionSourceRootId} active={active}
    surfaceKey={extensionSurfaceKey(snapshot.workspaceId, node.id)}
    placement={!centerOnly && (node.placement === 'tab' || node.placement === 'window') ? node.placement : 'center'}
    onPlacement={centerOnly ? undefined : (placement, onFailure) => {
      const request = ++placementRequest.current;
      void setExtensionPlacement(snapshot.workspaceId, node.id, placement).then(() => {
        if (request !== placementRequest.current) return;
        if (placement === 'tab') requestShowWorkspace();
        else if (placement === 'center') void showInCenter({ kind: 'utility', sel: `nav:${node.id}` });
      }).catch(error => {
        if (request !== placementRequest.current) return;
        const message = error instanceof Error ? error.message : String(error);
        onFailure?.(message);
        flashTip(message);
      });
    }}
    onClose={() => onClose?.()} />;
  if (node.kind === 'web') return null;
  return <section className="ext-panel"><header className="workbench-page-header"><NavigationIcon node={{ kind: 'folder', id: '', parentId: null, title: '', expanded: false }} /><strong>{node.title}</strong><span className="ext-panel-meta-spacer" />{!centerOnly && <button className="ui-btn ghost tiny" onClick={onClose}>{t('返回会话')}</button>}</header>
    <div className="workbench-folder-grid">{navigationChildren(snapshot.nodes, node.id).map(child => <button className="workbench-folder-card ui-btn" key={child.id} onClick={() => onSelect?.(`nav:${child.id}`)}><NavigationIcon node={child} /><span>{child.title}</span></button>)}{!navigationChildren(snapshot.nodes, node.id).length && <p className="ui-empty">{t('在侧栏将扩展移入这个文件夹')}</p>}</div></section>;
}
