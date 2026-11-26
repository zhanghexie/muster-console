import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/renderer/src/i18n';
import {applyLocaleSetting} from '../../src/shared/i18n';
import {KnowledgePanel} from '../../src/renderer/src/components/KnowledgePanel';
import {applyTheme} from '../../src/renderer/src/theme';
import {builtinTheme} from '../../src/shared/theme';
import type {KnowledgeApi,KnowledgeRecord} from '../../src/shared/knowledge';
let record:KnowledgeRecord={schema:1,id:'fixture',namespace:'worker',revision:1,kind:'user_preference',status:'active',origin:'user',
 summary:'报告先写结论',applicability:[],evidence:[{id:'fixture-user',source:'截图夹具',eventTime:1,verification:'user_confirmed'}],createdAt:1,updatedAt:1,history:[],decisionReason:'用户偏好'};
const versions=new Map<number,KnowledgeRecord>();
const change=(next:Partial<KnowledgeRecord>)=>{
 versions.set(record.revision,structuredClone(record));
 record={...record,...next,userManaged:true,revision:record.revision+1,updatedAt:Date.now(),history:[...record.history,{revision:record.revision,summary:record.summary,status:record.status,at:record.updatedAt}]};
 return structuredClone(record);
};
const fail=async()=>{throw new Error('不在截图夹具范围内');};
const api:KnowledgeApi={list:async()=>({records:[structuredClone(record)],active:record.status==='active'?1:0,pending:0,history:0,startedAt:1}),
 revise:async input=>change({...input.draft,status:'active'}),decide:async input=>change({status:input.decision==='revalidate'?'needs_revalidation':'rejected'}),
 restore:async input=>{const old=versions.get(input.fromRevision);if(!old)throw new Error('版本不存在');return change({summary:old.summary,status:old.status});},
 search:async()=>[],evidence:async()=>({status:'unavailable',reason:'截图夹具没有真实来源'}),historySources:async()=>[],history:async()=>({messages:[],truncated:false}),
 process:fail,create:fail,supersede:fail,confirm:fail,promoteHost:fail,govern:fail,undoGovernance:fail};
applyLocaleSetting('zh-CN');
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme')==='light'?'light':'dark')!);
createRoot(document.getElementById('root')!).render(<main className="memory-correction-fixture" style={{height:'100vh',display:'flex',flexDirection:'column',minWidth:0,background:'var(--surface-canvas)'}}><KnowledgePanel api={api} workspaceKey="fixture"/></main>);
