import { ErrorTip } from '../components/ErrorTip';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtensionManagementSnapshot } from '../../../shared/extension';
import type { ExtensionCenterInstallResult, ExtensionCenterInstallSnapshot, ExtensionCenterListing } from '../../../shared/extensionCenter';
import type { ExtensionPublishingApi } from '../../../shared/extensionPublishing';
import { BrandLoading } from '../components/BrandLoader';
import { ExtensionsManager, type ExtensionManagementTab } from './ExtensionsManager';
import { localizeExtensionReason } from './extensionReason';

export interface ExtensionManagementApi {
  snapshot: (workspaceId: string) => Promise<ExtensionManagementSnapshot>;
  installLocal?: () => Promise<{ canceled: true } | { extensionId: string }>;
  selectProject: (workspaceId: string, sourceRootId: string) => Promise<ExtensionManagementSnapshot>;
  setEnabled: (workspaceId: string, sourceRootId: string, scope: 'global' | 'project', extensionId: string, enabled: boolean, selectionRevision: number) => Promise<ExtensionManagementSnapshot>;
  setEnabledAll?: (workspaceId: string, extensionId: string, enabled: boolean) => Promise<void>;
  uninstallGlobal?: (workspaceId: string, extensionId: string, fingerprint: string) => Promise<void>;
  preserveTransaction?: (workspaceId: string, id: string) => Promise<string>;
  onChanged: (listener: (workspaceId?: string) => void) => () => void;
  centerList?: (force?: boolean) => Promise<ExtensionCenterListing>;
  centerInstall?: (packageKey: string) => Promise<ExtensionCenterInstallResult>;
  centerUninstall?: (packageKey: string) => Promise<unknown>;
  onCenterInstallProgress?: (listener: (snapshot: ExtensionCenterInstallSnapshot) => void) => () => void;
}

/** Keep asynchronous responses bound to the workspace and selected project. */
export function ExtensionsManagerContainer({ workspaceId, api, publishingApi }: { workspaceId: string; api: ExtensionManagementApi; publishingApi?: ExtensionPublishingApi }): React.JSX.Element {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ExtensionManagementSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState<ExtensionManagementTab>('global');
  const [centerCatalog, setCenterCatalog] = useState<ExtensionCenterListing | null>(null);
  const [centerLoading, setCenterLoading] = useState(false), [centerError, setCenterError] = useState('');
  const [centerInstallProgress, setCenterInstallProgress] = useState<ExtensionCenterInstallSnapshot>();
  const latestCenterProgress = useRef<ExtensionCenterInstallSnapshot | undefined>(undefined);
  const centerRequested = useRef(false), centerRead = useRef(0);
  const generation = useRef(0), selecting = useRef(false), changedWhileSelecting = useRef(false);
  const currentWorkspace = useRef(workspaceId); currentWorkspace.current = workspaceId;
  const refresh = useCallback(async (clear: boolean): Promise<void> => {
    const sequence = ++generation.current;
    if (clear) { setSnapshot(null); setLoading(true); }
    try {
      const next = await api.snapshot(workspaceId);
      if (sequence !== generation.current || currentWorkspace.current !== workspaceId) return;
      if (next.workspaceId !== workspaceId) throw new Error('Extension management returned a different workspace');
      setSnapshot(next); setError('');
    } catch (cause) { if (sequence === generation.current && currentWorkspace.current === workspaceId) setError(String(cause)); }
    finally { if (sequence === generation.current && currentWorkspace.current === workspaceId) setLoading(false); }
  }, [api, workspaceId]);
  useEffect(() => {
    selecting.current = false; changedWhileSelecting.current = false;
    const stop = api.onChanged(changedWorkspace => {
      if (changedWorkspace && changedWorkspace !== workspaceId) return;
      if (selecting.current) { changedWhileSelecting.current = true; return; }
      void refresh(false);
    });
    void refresh(true);
    return () => { generation.current++; selecting.current = false; stop(); };
  }, [api, workspaceId, refresh]);
  const applyCenterProgress = useCallback((next: ExtensionCenterInstallSnapshot): boolean => {
    if (latestCenterProgress.current && next.revision <= latestCenterProgress.current.revision) return false;
    latestCenterProgress.current = next;
    setCenterInstallProgress(next);
    return true;
  }, []);
  const refreshCenter = useCallback(async (force = false): Promise<void> => {
    if (!api.centerList) return;
    const request = ++centerRead.current;
    centerRequested.current = true;
    setCenterLoading(true); setCenterError('');
    try {
      const next = await api.centerList(force);
      if (next.installProgress) applyCenterProgress(next.installProgress);
      if (request === centerRead.current) setCenterCatalog(next);
    } catch (cause) { if (request === centerRead.current) setCenterError(String(cause)); }
    finally { if (request === centerRead.current) setCenterLoading(false); }
  }, [api, applyCenterProgress]);
  useEffect(() => api.onCenterInstallProgress?.(next => {
    const previous = latestCenterProgress.current;
    if (applyCenterProgress(next) && centerRequested.current && previous?.active.some(
      item => !next.active.some(active => active.packageKey === item.packageKey),
    )) void refreshCenter();
  }), [api, applyCenterProgress, refreshCenter]);
  const openCenter = useCallback((): void => {
    if (!centerRequested.current) void refreshCenter();
  }, [refreshCenter]);

  const selectProject = (sourceRootId: string): void => {
    const sequence = ++generation.current;
    selecting.current = true; changedWhileSelecting.current = false;
    setSnapshot(null); setError(''); setLoading(true);
    void api.selectProject(workspaceId, sourceRootId).then(next => {
      if (sequence !== generation.current || currentWorkspace.current !== workspaceId) return;
      if (next.workspaceId !== workspaceId || next.sourceRootId !== sourceRootId) throw new Error('Extension management returned a different project');
      setSnapshot(next);
    }).catch(cause => { if (sequence === generation.current && currentWorkspace.current === workspaceId) setError(String(cause)); })
      .finally(() => {
        if (sequence !== generation.current || currentWorkspace.current !== workspaceId) return;
        selecting.current = false; setLoading(false);
        if (changedWhileSelecting.current) { changedWhileSelecting.current = false; void refresh(false); }
      });
  };
  const setEnabled = async (scope: 'global' | 'project', id: string, enabled: boolean): Promise<void> => {
    if (!snapshot || snapshot.workspaceId !== workspaceId) throw new Error('Extension management is not ready');
    const root = snapshot.sourceRootId, sequence = ++generation.current;
    try {
      const next = await api.setEnabled(workspaceId, root, scope, id, enabled, snapshot.selectionRevision);
      if (next.workspaceId !== workspaceId || next.sourceRootId !== root || next.selectionRevision !== snapshot.selectionRevision) throw new Error('Extension management returned a different project');
      if (sequence === generation.current && currentWorkspace.current === workspaceId) { setSnapshot(next); setError(''); }
    } catch (cause) {
      if (sequence === generation.current && currentWorkspace.current === workspaceId) void refresh(false);
      throw cause;
    }
  };
  const setEnabledAll = api.setEnabledAll ? async (id: string, enabled: boolean): Promise<void> => {
    if (!snapshot || snapshot.workspaceId !== workspaceId) throw new Error('Extension management is not ready');
    const sequence = ++generation.current;
    try {
      await api.setEnabledAll!(workspaceId, id, enabled);
      if (sequence === generation.current && currentWorkspace.current === workspaceId) await refresh(false);
    } catch (cause) {
      if (sequence === generation.current && currentWorkspace.current === workspaceId) void refresh(false);
      throw cause;
    }
  } : undefined;
  if (!snapshot || snapshot.workspaceId !== workspaceId) return <main className="prompt-task-panel ext-manager-panel">
    {loading ? <div className="ui-empty" role="status"><BrandLoading>{t('加载中…')}</BrandLoading></div> : <div className="ui-empty" role="alert"><p>{localizeExtensionReason(error)}</p><button className="ui-btn" onClick={() => void refresh(true)}>{t('重试')}</button></div>}
  </main>;
  const selected = snapshot.projects.find(project => project.id === snapshot.sourceRootId);
  const preserveTransaction = api.preserveTransaction ? async (id: string): Promise<string> => {
    const result = await api.preserveTransaction!(workspaceId, id);
    if (currentWorkspace.current === workspaceId) void refresh(false);
    return result;
  } : undefined;
  const uninstallGlobal = api.uninstallGlobal ? async (id: string, fingerprint: string): Promise<void> => {
    await api.uninstallGlobal!(workspaceId, id, fingerprint);
    await Promise.all([refresh(false), centerRequested.current && refreshCenter()]);
  } : undefined;
  const installLocal = api.installLocal ? async (): Promise<{ canceled: true } | { extensionId: string }> => {
    const result = await api.installLocal!();
    if (!('canceled' in result)) await refresh(false);
    return result;
  } : undefined;
  const installCenter = api.centerInstall ? async (packageKey: string): Promise<void> => {
    const result = await api.centerInstall!(packageKey);
    if (!result.installed && !result.skipped) throw new Error(result.error || t('扩展安装失败'));
    await Promise.all([refresh(false), refreshCenter(true)]);
  } : undefined;
  const uninstallCenter = api.centerUninstall ? async (packageKey: string): Promise<void> => { await api.centerUninstall!(packageKey); await Promise.all([refresh(false), refreshCenter(true)]); } : undefined;
  return <><ExtensionsManager workspaceId={workspaceId} sourceRootId={snapshot.sourceRootId} projectLabel={selected?.label ?? t('选择当前项目')} projects={snapshot.projects} onProjectChange={selectProject} selectedTab={selectedTab} onTabChange={setSelectedTab} listing={snapshot.listing} setEnabled={setEnabled} setEnabledAll={setEnabledAll} preserveTransaction={preserveTransaction} uninstallGlobal={uninstallGlobal} installLocal={installLocal} onRefresh={() => void refresh(false)} centerCatalog={centerCatalog} centerLoading={centerLoading} centerError={centerError} centerInstallProgress={centerInstallProgress} installCenter={installCenter} uninstallCenter={uninstallCenter} onCenterOpen={openCenter} onCenterRefresh={() => void refreshCenter(true)} publishingApi={publishingApi}/>{error && <ErrorTip message={localizeExtensionReason(error)} />}</>;
}
