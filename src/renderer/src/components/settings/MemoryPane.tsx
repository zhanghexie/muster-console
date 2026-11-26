import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig } from '../../../../shared/types';
import { SettingRow, SettingsRows, SettingsSection, Switch } from './shared';

export function KnowledgeProcessingSetting():React.JSX.Element {
  const {t}=useTranslation();
  const [config,setConfig]=useState<AppConfig|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [savedNote,setSavedNote]=useState('');
  const read=(c:AppConfig)=>{setConfig(c);};
  useEffect(()=>{let alive=true;void window.api.config.get().then(c=>{if(alive)read(c);}).catch(e=>{if(alive)setError(String(e.message??e));});return()=>{alive=false;};},[]);
  const save=async(patch:Partial<NonNullable<AppConfig['memoryConsolidation']>>)=>{setBusy(true);setError('');setSavedNote('');try{
    const current=await window.api.config.get();
    read(await window.api.config.update({memoryConsolidation:{...current.memoryConsolidation,...patch}}));setSavedNote(t('已保存记忆处理配置'));
  }catch(e){setError(String((e as Error).message??e));}finally{setBusy(false);}};
  return <SettingsSection title={t('记忆子系统')} desc={t('所有工作区共用。工作 Agent 提交候选后，由独立会话整理记忆；会话模型在输入框中切换。')}>
    <SettingsRows>
      <SettingRow title={t('按需自动整理记忆')} desc={t('有候选才启动整理，无需人工审批。关闭后不处理新增候选，已有知识仍可查询。')}><Switch label={t('按需自动整理记忆')} checked={config?.memoryConsolidation?.enabled!==false&&config!==null} disabled={busy||!config} onChange={value=>void save({enabled:value})}/></SettingRow>
    </SettingsRows>
    <p className="settings-hint">{t('记忆对话沿用当前工作区调度模型；如需切换，请使用对话输入框左侧的模型按钮。')}</p>
    {savedNote?<p className="settings-hint" role="status">{savedNote}</p>:null}
    {error?<p className="settings-hint" role="alert">{error}</p>:null}
  </SettingsSection>;
}

export function MemoryPane(): React.JSX.Element {
  return <div className="settings-pane-body memory-settings" data-testid="memory-settings">
    <KnowledgeProcessingSetting />
  </div>;
}
