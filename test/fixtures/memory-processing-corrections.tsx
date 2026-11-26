/** Production processing view and CSS; deterministic IPC only, never app storage. */
import '../../.agents/skills/ui-verification/assets/fixture-api';
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/renderer/src/i18n';
import {applyLocaleSetting} from '../../src/shared/i18n';
import {MemoryProcessingView} from '../../src/renderer/src/components/MemoryProcessingView';
import {useMemoryCenterRoute} from '../../src/renderer/src/memoryCenterRoute';
import {applyTheme} from '../../src/renderer/src/theme';
import {builtinTheme} from '../../src/shared/theme';
import type {MemoryCuratorApi,MemoryCuratorQueueEntry} from '../../src/shared/memoryCurator';

const correction={memoryId:'memory-subscription',revision:4,problem:'原结论没有说明何时取消监听。',evidence:'组件卸载时仍收到订阅回调；检查订阅返回的清理函数。',suggestion:'离开页面时调用取消函数。'};
const base:MemoryCuratorQueueEntry={id:'correction-request',kind:'candidate',text:JSON.stringify(correction),namespace:'worker',state:'pending',archived:false,createdAt:1792886400000,availableAt:1792886400000,attempts:0,evidenceCount:2,correction};
const rows:Record<string,MemoryCuratorQueueEntry>={
  queued:base,
  updated:{...base,state:'done',attempts:1,result:{disposition:'updated',reason:'已核对清理函数并生成新版本。',targetId:correction.memoryId,targetRevision:4,recordId:correction.memoryId,recordRevision:5}},
  failed:{...base,state:'failed',attempts:1,error:'原记忆已从 r4 更新，请重新读取后提交。'},
  needs_user:{...base,state:'done',attempts:1,result:{disposition:'needs_user',reason:'原版本由用户确认，自动整理不会覆盖。',targetId:correction.memoryId,targetRevision:4,recordId:correction.memoryId,recordRevision:4,proposedCorrection:{decision:'correct',draft:{kind:'reusable_lesson',summary:'页面卸载时调用订阅返回的取消函数。',action:'在清理回调中取消监听。',rationale:'避免页面退出后继续处理事件。',applicability:['页面持有独立订阅'],exceptions:['跨页面共享的持久监听器'],expectedFutureUse:'防止重复事件与资源泄漏'}}}}
};
let current='queued';
const fail=async()=>{throw new Error('该调用不在只读截图夹具范围内');};
const api:MemoryCuratorApi={
  inspect:async(_workspace,input)=>({items:[rows[current]],total:1,offset:input?.offset??0,limit:30}),
  state:async()=>({workspaceId:'fixture',sessionId:null,generation:1,status:'idle',paused:false,pending:current==='queued'?1:0,failed:current==='failed'?1:0,running:false,messages:[],updatedAt:1}),
  onChanged:()=>()=>{},send:fail,setPaused:fail,clear:fail,setArchived:fail
};
const original=window.api;
window.api=new Proxy(original,{get:(target,key)=>key==='memoryCurator'?api:Reflect.get(target,key)});
function Fixture():React.JSX.Element{
  const [mode,setMode]=useState(current),route=useMemoryCenterRoute();
  return <main className="memory-processing-corrections-fixture" style={{height:'100vh',display:'flex',flexDirection:'column',minWidth:0,background:'var(--surface-canvas)'}}>
    <nav aria-label="截图场景" className="knowledge-actions">{Object.keys(rows).map(key=><button key={key} className="ui-btn" onClick={()=>{current=key;setMode(key);}}>{key}</button>)}</nav>
    <MemoryProcessingView key={mode} workspaceId="fixture" snapshot={null} initialFilter="all" onRefresh={async()=>{}} onOpenConversation={()=>{}}/>
    <output aria-label="记忆跳转">{route?`${route.tab}:${route.entryId}`:''}</output>
  </main>;
}
applyLocaleSetting('zh-CN');
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme')==='light'?'light':'dark')!);
createRoot(document.getElementById('root')!).render(<Fixture/>);
