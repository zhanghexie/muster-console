import React from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../store';
import { ExtensionsManagerContainer } from './ExtensionsManagerContainer';
import type { ExtensionManagementApi } from './ExtensionsManagerContainer';
import { isWebGateway } from '../webGatewayEnvironment';

const api: ExtensionManagementApi = {
  snapshot: workspaceId => window.api.extensions.snapshot(workspaceId),
  installLocal: () => window.api.extensionCatalog.installLocal(),
  preserveTransaction: async (workspaceId, id) => {
    const result = await window.api.extensions.preserveTransaction({ workspaceId, id });
    if (!result.ok) throw new Error(result.error);
    return result.preservedPath;
  },
  selectProject: (workspaceId, sourceRootId) => window.api.extensions.selectProject({ workspaceId, sourceRootId }),
  setEnabled: (workspaceId, sourceRootId, scope, extensionId, enabled, selectionRevision) => window.api.extensions.setEnabled({ workspaceId, sourceRootId, scope, extensionId, enabled, selectionRevision }),
  setEnabledAll: (workspaceId, extensionId, enabled) => window.api.extensions.setEnabledAll({ workspaceId, extensionId, enabled }).then(() => undefined),
  uninstallGlobal: (workspaceId, extensionId, fingerprint) => window.api.extensions.uninstallGlobal({ workspaceId, extensionId, fingerprint }),
  onChanged: listener => window.api.on('extensions:changed', () => listener()),
  centerList: (force?: boolean) => window.api.extensionCenter.list(force),
  centerInstall: packageKey => window.api.extensionCenter.install(packageKey),
  centerUninstall: packageKey => window.api.extensionCenter.uninstall(packageKey)
};

export function ExtensionsManagerPage(): React.JSX.Element {
  const { t } = useTranslation(), { activeWorkspaceId } = useWorkspaceStore();
  return activeWorkspaceId ? <ExtensionsManagerContainer key={activeWorkspaceId} workspaceId={activeWorkspaceId} api={api}
    publishingApi={isWebGateway() ? undefined : window.api.extensionPublishing}/>
    : <main className="prompt-task-panel ext-manager-panel"><div className="ui-empty"><p>{t('请先打开工作区')}</p></div></main>;
}
