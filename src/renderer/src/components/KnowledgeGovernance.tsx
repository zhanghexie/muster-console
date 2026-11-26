import {CustomSelect} from './CustomSelect';
import React,{useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {KnowledgeGovernanceInput,KnowledgeRecord} from '../../../shared/knowledge';

export function KnowledgeGovernance({record,targets,busy,onSubmit}:{record:KnowledgeRecord;targets:KnowledgeRecord[];busy:boolean;onSubmit:(input:KnowledgeGovernanceInput)=>void}):React.JSX.Element {
  const {t}=useTranslation();
  const [targetId,setTargetId]=useState(''),[reason,setReason]=useState('');
  const target=targets.find(r=>r.id===targetId);
  const submit=(action:KnowledgeGovernanceInput['action'])=>onSubmit({id:record.id,revision:record.revision,action,reason,targetId:target?.id,targetRevision:target?.revision});
  const delta=(before:string[],after:string[])=>after.filter(s=>!before.includes(s)).join(t('；'))||t('无新增');
  return <section aria-label={t('治理对照')} className="knowledge-governance">
    <h4>{t('核对新增信息')}</h4>
    <label>{t('对照知识')}<CustomSelect ariaLabel={t('对照知识')} value={targetId} disabled={busy} onChange={setTargetId} options={[{value:'',label:t('选择同范围知识')},...targets.map(r=>({value:r.id,label:r.summary}))]}/></label>
    {target?<div>
      <p><strong>{t('已有：')}</strong>{target.summary} · {target.action||t('未声明方法')}</p>
      <p><strong>{t('当前：')}</strong>{record.summary} · {record.action||t('未声明方法')}</p>
      <p>{t('新增条件：{{added}}；移除条件：{{removed}}',{added:delta(target.applicability,record.applicability),removed:delta(record.applicability,target.applicability)})}</p>
      <p>{t('新增例外：{{added}}；移除例外：{{removed}}',{added:delta(target.exceptions??[],record.exceptions??[]),removed:delta(record.exceptions??[],target.exceptions??[])})}</p>
      <p>{t('新增依据 {{added}} 条；对照依据 {{existing}} 条',{added:record.evidence.filter(e=>!target.evidence.some(item=>item.id===e.id)).length,existing:target.evidence.length})}</p>
    </div>:null}
    <p>{t('范围：')}{t(({worker:'工作区共享',scheduler:'调度专用',profile:'用户画像',host:'工作台通用'})[record.namespace])} · {record.repoKey||t('未限定仓库')} · {record.branch||t('未限定分支')}</p>
    <label>{t('治理理由')}<textarea className="ui-input" aria-label={t('治理理由')} value={reason} maxLength={500} disabled={busy} onChange={e=>setReason(e.target.value)} placeholder={t('说明是重复、仅本次有效，还是适用边界不同')}/></label>
    <p>{t('合并会让当前条目退场，只把依据加入对照条目；条件或例外不同会拒绝合并。保留差异会确认当前知识生效。仅留历史保留90天，不再作为长期经验召回。')}</p>
    <div className="knowledge-actions">
      {record.namespace!=='profile'?<button className="ui-btn compact" disabled={busy||!reason.trim()} onClick={()=>submit('history')}>{t('仅留历史')}</button>:null}
      <button className="ui-btn compact" disabled={busy||!reason.trim()||!target} onClick={()=>submit('merge')}>{t('合并证据')}</button>
      <button className="ui-btn compact" disabled={busy||!reason.trim()||!target} onClick={()=>submit('distinct')}>{t('保留差异')}</button>
    </div>
  </section>;
}
