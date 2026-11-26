import { IconPuzzle } from '../icons';
import { SettingsResourceItem, SettingsResourceStatus, SettingsDetailSection } from './SettingsResource';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomSelect } from '../CustomSelect';
import { SearchBar } from '../SearchBar';
import { usePresenceValue } from '../motion';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { AdvancedDetails } from './shared';
import { SettingsDetailHeader } from './SettingsDetailHeader';
import { SettingsPathControl } from './SettingsPathField';
import type { CatalogToolInfo } from '../../../../shared/types';

type Audience = 'all' | 'scheduler' | 'worker' | 'extension';
type Exposure = 'all' | 'direct' | 'domain' | 'action' | 'internal';

/** Read-only projection; registration is distinct from a running session's permissions. */
export function CapabilityCatalog({ tools, version, narrow = false, active = true }: { tools: CatalogToolInfo[]; version?: string; narrow?: boolean; active?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const [audience, setAudience] = useState<Audience>('all');
  const [exposure, setExposure] = useState<Exposure>('all');
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const inventory = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null), pendingFocus = useRef(false);
  const labels = { direct: t('原生直接工具'), domain: t('直接域入口'), action: t('经域入口调用'), internal: t('内部定义') };
  const visible = useMemo(() => tools.filter(tool => {
    if (audience === 'scheduler' && !(tool.exposure?.scheduler ?? tool.schedulerVisible !== false)) return false;
    if (audience === 'worker' && !(tool.exposure ? tool.exposure.workerPresets.length : tool.workerVisible)) return false;
    if (audience === 'extension' && !tool.extensionVisible) return false;
    if (exposure !== 'all' && (tool.exposure?.kind ?? 'internal') !== exposure) return false;
    const search = query.trim().toLocaleLowerCase();
    return !search || [tool.name, tool.summary, tool.description, tool.exposure?.entry, tool.exposure?.action].join('\n').toLocaleLowerCase().includes(search);
  }), [tools, audience, exposure, query]);
  const selected = visible.find(tool => tool.name === selectedName) ?? null;
  const detail = usePresenceValue(selected);
  const close = (): void => { pendingFocus.current = true; setSelectedName(''); };
  useOverlayDismiss(active && !!selected, close);
  useEffect(() => {
    if (panel.current) panel.current.inert = !selected;
    if (inventory.current) inventory.current.inert = narrow && detail.presence.mounted;
    if (selected && narrow) panel.current?.querySelector('button')?.focus({ preventScroll: true });
    if (!detail.presence.mounted && pendingFocus.current) {
      pendingFocus.current = false;
      if (active && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    }
  }, [active, narrow, selected?.name, detail.presence.mounted, detail.presence.stage]);
  useEffect(() => { if (selected && panel.current) panel.current.scrollTop = 0; }, [selected?.name]);
  useEffect(() => {
    if (selectedName && !selected) { pendingFocus.current = true; setSelectedName(''); }
  }, [selectedName, selected]);
  const current = detail.value;
  const nativeCount = visible.filter(tool => tool.exposure && ['direct', 'domain'].includes(tool.exposure.kind)).length;
  return <>
    <p className="cm-fine">{version ? `v${version} · ` : ''}{t('{{n}} 个定义 · {{direct}} 个目录内原生入口', { n: visible.length, direct: nativeCount })}</p>
    <p className="cm-fine">{t('这里只包含宿主工具；各引擎自带的文件、Shell 等工具不计入。')}</p>
    <div className="cm-manager-grid settings-split settings-resource-layout" data-settings-item="cap-catalog">
      <div className="cm-inventory settings-resource-nav" ref={inventory}>
        <div className="cm-list-tools cm-catalog-search"><SearchBar aria-label={t('搜索能力')} value={query} onChange={setQuery} placeholder={t('搜索名称、用途或来源…')} className="cm-search-bar"/></div>
        <div className="cm-list-tools cm-catalog-filters">
          <CustomSelect ariaLabel={t('能力使用方')} value={audience} className="cm-select" onChange={value => setAudience(value as Audience)} options={[
            { value: 'all', label: t('全部使用方') }, { value: 'scheduler', label: t('调度可用') }, { value: 'worker', label: t('Worker 可用') }, { value: 'extension', label: t('扩展可用') }
          ]}/>
          <CustomSelect ariaLabel={t('暴露方式')} value={exposure} className="cm-select" onChange={value => setExposure(value as Exposure)} options={[{ value: 'all', label: t('全部暴露方式') }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]}/>
        </div>
        <div className="cm-list-scroll" tabIndex={0}>
          {!visible.length && <div className="cm-empty"><h3>{t('没有匹配的能力')}</h3><p>{t('换个关键词或入口筛选。')}</p></div>}
          {visible.map(tool => <SettingsResourceItem key={tool.name} name={tool.name} className="cm-asset-row" selected={selectedName === tool.name}
            aria-label={`${t('查看')} ${tool.name}`} icon={<IconPuzzle size={20}/>}
            meta={<SettingsResourceStatus>{labels[tool.exposure?.kind ?? 'internal']}</SettingsResourceStatus>}
            onClick={event => { trigger.current = event.currentTarget; pendingFocus.current = false; setSelectedName(tool.name); }}
            trailing={tool.dangerous && <span className="cm-row-alert" title={t('受确认策略约束')}>!</span>}/>)}

        </div>
      </div>
      {detail.presence.mounted && current ? <>
        <div className="cm-detail-backdrop mp-scrim" {...detail.presence.spread} aria-hidden="true" onMouseDown={close}/>
        <aside className="cm-detail settings-resource-detail mp-panel" ref={panel} {...detail.presence.spread} aria-hidden={!selected || undefined} aria-label={t('工具详情')} data-overlay-root={narrow ? '' : undefined} tabIndex={-1} onKeyDown={event => {
          if (!narrow || event.key !== 'Tab') return;
          const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')).filter(field => !field.closest('details:not([open])') || !!field.closest('summary'));
          const next = event.shiftKey ? fields[fields.length - 1] : fields[0];
          if (event.target === (event.shiftKey ? fields[0] : fields[fields.length - 1])) { event.preventDefault(); next?.focus(); }
        }}>
          {narrow && <button type="button" className="cm-text-button cm-detail-back" aria-label={t('关闭详情')} onClick={close}>← {t('返回列表')}</button>}
          <SettingsDetailHeader icon={<IconPuzzle size={24}/>} title={<span className="mono">{current.name}</span>} description={current.description}
            meta={<>{current.dangerous && <span className="cm-badge is-warn">{t('受确认策略约束')}</span>}<span className="cm-badge">{labels[current.exposure?.kind ?? 'internal']}</span>{current.source === 'dynamic' && <span className="cm-badge">{t('动态扩展')}</span>}</>}/>
          <SettingsDetailSection title={t('使用方条件')}><p className="cm-fine">{current.exposure?.scheduler ? t('调度可用') : t('调度隐藏')} · {current.exposure?.workerPresets.length ? current.exposure.workerPresets.join(' / ') : t('Worker 不可用')}</p><p className="cm-fine">{current.extensionVisible ? t('扩展可用') : t('扩展不可用')}</p></SettingsDetailSection>
          {current.exposure?.entry && <SettingsDetailSection title={t('调用方式')}><code>{current.exposure.entry}{current.exposure.action ? ` · action: ${current.exposure.action}` : ''}</code></SettingsDetailSection>}
          {current.exposure?.actions && <AdvancedDetails summary={t('域动作与内部目标')}><ul className="cm-action-map">{current.exposure.actions.map(action => <li key={action.action}><code>{action.action}</code><span> → </span><code>{action.target}</code></li>)}</ul></AdvancedDetails>}
          {current.exposure?.skillPath ? <SettingsDetailSection title={t('用法文档')}><SettingsPathControl label={t('用法文档')} path={current.exposure.resolvedSkillPath ?? current.exposure.skillPath}/></SettingsDetailSection> : current.exposure?.kind === 'domain' ? <p className="cm-fine">{t('完整参数随入口 schema 提供，无需额外技能文档。')}</p> : null}
          <p className="cm-fine">{t('目录不代表现有会话已加载。实际注册仍受角色、模式、preset 和授权限制。')}</p>
        </aside>
      </> : <aside className="cm-detail-empty settings-resource-detail"><h3>{t('选一项查看详情')}</h3></aside>}
    </div>
  </>;
}
