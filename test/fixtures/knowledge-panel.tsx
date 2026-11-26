import React from 'react';
import {createRoot} from 'react-dom/client';
import {KnowledgePanel} from '../../src/renderer/src/components/KnowledgePanel';
import {applyTheme} from '../../src/renderer/src/theme';
import {builtinTheme} from '../../src/shared/theme';
import type {KnowledgeApi,KnowledgeRecord} from '../../src/shared/knowledge';
const theme=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark';
applyTheme(builtinTheme(theme)!);
let records:KnowledgeRecord[]=[{
  schema:1,id:'11111111-1111-4111-8111-111111111111',revision:1,kind:'reusable_lesson',namespace:'worker',status:'active',origin:'worker',
  summary:'延迟审批必须在提交时再次核对版本',problem:'审批期间文件被其他会话修改，旧提案造成重复写入',
  action:'提交前核对文件哈希与候选状态；发生冲突则停止并重新生成提案。',rationale:'过期审批、并发与重放回归已通过。',
  applicability:['存在延迟审批的文件写入'],exceptions:['不能只在生成提案时检查一次'],expectedFutureUse:'避免审批覆盖新内容或重复添加同一结论',
  evidence:[{id:'event-1',source:'gui-session',eventTime:1792320000000,verification:'test',turnId:'turn-42'}],createdAt:1,updatedAt:2,decisionReason:'有明确问题、修复方法和回归依据',history:[]
}];
const api:KnowledgeApi={
  historySources:async()=>[],history:async()=>({messages:[],truncated:false}),
  govern:async()=>{throw new Error('预览不执行治理');},undoGovernance:async()=>{},
  create:async()=>({disposition:'rejected',reason:'预览未配置创建'}),
  process:async()=>{},
  restore:async input=>records.find(r=>r.id===input.id)!,
  list:async()=>({records:structuredClone(records),active:records.filter(r=>r.status==='active').length,pending:records.filter(r=>r.status==='pending').length,history:0,startedAt:1}),
  search:async()=>[],
  decide:async input=>{const r=records.find(r=>r.id===input.id)!;r.status=input.decision==='revalidate'?'needs_revalidation':input.decision==='archive'?'archived':input.decision==='approve'?'active':'rejected';r.revision++;return structuredClone(r);},
  revise:async input=>{const r=records.find(r=>r.id===input.id)!;Object.assign(r,input.draft,{status:'pending',revision:r.revision+1});return structuredClone(r);},
  confirm:async input=>{const r=records.find(r=>r.id===input.id)!;r.revision++;r.userManaged=true;return structuredClone(r);},
  promoteHost:async()=>{throw new Error('预览未配置跨工作区复制');},
  supersede:async input=>records.find(r=>r.id===input.id)!,
  evidence:async()=>({status:'unavailable',reason:'预览夹具没有真实快照'})
};
createRoot(document.getElementById('root')!).render(<main style={{minHeight:'100vh',background:'var(--surface-canvas)'}}><KnowledgePanel api={api} workspaceKey="fixture" onClose={()=>{}}/></main>);
