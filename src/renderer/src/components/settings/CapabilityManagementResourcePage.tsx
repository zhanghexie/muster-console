import React, { type Ref, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig } from '../../../../shared/types';
import type { ManagedSkill, SkillManagementSnapshot } from '../../../../shared/capabilityManagement';
import type { ManagedMcpEntry, McpManagementInventory } from '../../../../shared/mcpManagement';
import { AnimatedDetails } from '../AnimatedDetails';
import { CustomSelect } from '../CustomSelect';
import { SearchBar } from '../SearchBar';
import { Chevron, Segmented } from './shared';
import type { Presence } from '../motion';

type ResourcePage = 'skills' | 'mcp' | 'review';
type ScopeKind = 'global' | 'project';

export interface CapabilityManagementResourcePageProps {
  page: ResourcePage;
  busy: boolean;
  loading: boolean;
  actualKind: ScopeKind;
  scopeKind: ScopeKind;
  workspaces: NonNullable<AppConfig['workspaces']>;
  workspaceId: string;
  skills: SkillManagementSnapshot | null;
  mcp: McpManagementInventory | null;
  query: string;
  setQuery: (value: string) => void;
  setScopeKind: (value: ScopeKind) => void;
  setWorkspaceId: (value: string) => void;
  reviewCount: number;
  projectSkills: ManagedSkill[];
  inheritedSkills: ManagedSkill[];
  projectMcp: ManagedMcpEntry[];
  inheritedMcp: ManagedMcpEntry[];
  inheritedCount: number;
  inheritedConflictCount: number;
  showInherited: boolean;
  globalExpanded: boolean;
  setGlobalExpanded: (value: boolean) => void;
  hasResults: boolean;
  pendingMcpEnabled: boolean | null;
  setPendingMcpEnabled: (value: boolean | null) => void;
  onReview: () => void;
  onNewSkill: () => void;
  onNewMcp: () => void;
  onImportMcp: () => void;
  onMcpEnabledChange: (value: boolean) => void;
  onOpenUsage: () => void;
  renderSkill: (skill: ManagedSkill) => ReactNode;
  renderMcp: (entry: ManagedMcpEntry) => ReactNode;
  narrow: boolean;
  detail: Presence;
  detailRef: Ref<HTMLElement>;
  inventoryRef: Ref<HTMLDivElement>;
  onCloseDetail: () => void;
  renderDetail: () => ReactNode;
  icon: (name: string, size?: number) => ReactNode;
  detailVisible: boolean;
  dialogOpen: boolean;
}

/** Resource browser surface for Skills and MCP. It owns only presentation and user intent callbacks. */
export function CapabilityManagementResourcePage({
  page, busy, loading, actualKind, scopeKind, workspaces, workspaceId, skills, mcp, query, setQuery,
  setScopeKind, setWorkspaceId, reviewCount, projectSkills, inheritedSkills, projectMcp, inheritedMcp,
  inheritedCount, inheritedConflictCount, showInherited, globalExpanded, setGlobalExpanded, hasResults,
  pendingMcpEnabled, setPendingMcpEnabled, onReview, onNewSkill, onNewMcp, onImportMcp,
  onMcpEnabledChange, onOpenUsage, renderSkill, renderMcp, narrow, detail, detailRef, inventoryRef,
  onCloseDetail, renderDetail, icon, detailVisible, dialogOpen
}: CapabilityManagementResourcePageProps): React.JSX.Element {
  const { t } = useTranslation();
  const isMcp = page === 'mcp';
  return <div className="cm-manager-grid settings-split cm-resource-grid settings-resource-layout">
    <div className="cm-workspace-toolbar settings-resource-toolbar">
      <div className="cm-workspace-scope">
        <Segmented label={t('作用范围')} value={actualKind} disabled={busy} onChange={value => { if (value === 'project' && !workspaces.length) return; setScopeKind(value); setQuery(''); }} options={[{ value: 'global', label: t('全局') }, ...(workspaces.length ? [{ value: 'project' as const, label: t('当前项目') }] : [])]}/>
        {actualKind === 'project' && <CustomSelect ariaLabel={t('选择项目')} value={workspaceId} disabled={busy} className="cm-select cm-project-select" onChange={value => { setWorkspaceId(value); setQuery(''); }} options={workspaces.map(item => ({ value: item.id, label: item.name }))}/>} 
        {reviewCount > 0 && <button className={`cm-review-pill${page === 'review' ? ' is-on' : ''}`} disabled={busy} onClick={onReview} title={t('只看有差异的条目；同名来源会显示在这里')}>{icon('alert', 14)}{t('待处理差异')}<span>{reviewCount}</span></button>}
      </div>
      <div className="cm-resource-actions">
        {page === 'skills' && <button className="btn tiny cm-button" disabled={busy || !skills} onClick={onNewSkill}>{icon('plus', 15)}{t('新建技能')}</button>}
        {isMcp && <><button className="btn tiny cm-button" disabled={busy || !mcp} onClick={onNewMcp}>{icon('plus', 15)}<span>{t('新增服务器')}</span></button><button className="cm-text-button" disabled={busy || !mcp} onClick={onImportMcp}>{t('导入 JSON')}</button></>}
      </div>
    </div>
    <div className="cm-inventory settings-resource-nav" ref={inventoryRef} data-settings-item="mcp-servers">
      <div className="cm-list-tools"><SearchBar aria-label={t('搜索能力')} value={query} onChange={setQuery} placeholder={t('搜索名称、用途或来源…')} className="cm-search-bar"/></div>
      <div className="cm-list-scroll" tabIndex={0}>
        {loading && <p className="cm-loading" role="status">{t('正在读取技能与 MCP 配置…')}</p>}
        {!loading && !hasResults && <div className="cm-empty">{icon(query ? 'search' : page === 'mcp' ? 'mcp' : 'skill', 28)}<h3>{query ? t('没有匹配的内容') : page === 'review' ? t('没有待处理差异') : t('这里还没有内容')}</h3><p>{query ? t('换个关键词。') : page === 'skills' ? t('创建技能，或在两个通用 .agents/skills 目录中放入已有技能。') : page === 'mcp' ? t('添加服务器或导入现有 JSON 配置。') : t('同名来源会显示在这里。')}</p></div>}
        {hasResults && <>{actualKind === 'project' && (isMcp ? projectMcp.length : projectSkills.length) > 0 && <section className="cm-list-group" aria-label={t('项目能力')}><div className="cm-list-heading">{t('仅当前项目')}</div>{isMcp ? projectMcp.map(renderMcp) : projectSkills.map(renderSkill)}</section>}
          {inheritedCount > 0 && (actualKind === 'global' ? <section className="cm-list-group" aria-label={t('全局能力')}><div className="cm-list-heading">{t('全局能力')}</div>{isMcp ? inheritedMcp.map(renderMcp) : inheritedSkills.map(renderSkill)}</section> : <AnimatedDetails className="cm-list-group cm-inherited-group" open={showInherited} onToggle={setGlobalExpanded} summary={<><Chevron/><span>{t('来自全局')}</span><span className="cm-list-count">{inheritedCount}</span>{inheritedConflictCount > 0 && <span className="cm-list-conflicts">{isMcp ? t('项目已覆盖') : t('待处理差异')} {inheritedConflictCount}</span>}</>}><div className="cm-inherited-items">{isMcp ? inheritedMcp.map(renderMcp) : inheritedSkills.map(renderSkill)}</div></AnimatedDetails>)}
        </>}
      </div>
      <div className="cm-inventory-footer">{isMcp ? <label className="cm-relay-toggle" data-settings-item="mcp-enabled" title={t('总开关控制宿主中转对第三方 MCP 服务器的可达性。')}><span>{t('启用 MCP')}</span><input type="checkbox" aria-label={t('启用 MCP')} checked={pendingMcpEnabled ?? !!mcp?.enabled} disabled={busy || loading || !mcp} onChange={e => { const enabled = e.target.checked; setPendingMcpEnabled(enabled); onMcpEnabledChange(enabled); }}/></label> : <span className="cm-fine">{t('Skills 只管理全局和项目的 .agents/skills；宿主内置技能由工作台私有加载。')}</span>}<button type="button" className="cm-footer-button" disabled={busy} onClick={onOpenUsage}>{icon('plug', 15)}{t('使用开关与范围')}</button></div>
    </div>
    {detail.mounted && detailVisible && <><div className="cm-detail-backdrop mp-scrim" {...detail.spread} aria-hidden="true" onMouseDown={() => { if (!busy && !dialogOpen) onCloseDetail(); }}/><aside className="cm-detail settings-resource-detail mp-panel" ref={detailRef} {...detail.spread} aria-label={t('能力详情')} data-overlay-root={narrow ? '' : undefined} tabIndex={-1}>{narrow && <button type="button" className="cm-text-button cm-detail-back" aria-label={t('关闭详情')} disabled={busy || dialogOpen} onClick={onCloseDetail}>← {t('返回列表')}</button>}{renderDetail()}</aside></>}
    {(!detail.mounted || !detailVisible) && <aside className="cm-detail-empty settings-resource-detail"><h3>{t('选一项查看详情')}</h3></aside>}
  </div>;
}

