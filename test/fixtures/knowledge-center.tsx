import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/renderer/src/i18n';
import {StoreProvider} from '../../src/renderer/src/store';
import {KnowledgeCenter} from '../../src/renderer/src/components/KnowledgeCenter';
import {applyTheme} from '../../src/renderer/src/theme';
import {builtinTheme} from '../../src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme')==='light'?'light':'dark')!);
const fallback=window.api;
const workspace={id:'memory-ui-fixture',name:'记忆界面验证',path:'E:/fixture'};
const config={workspaces:[workspace],activeWorkspaceId:workspace.id,locale:'zh-CN'};
const base={namespace:'worker',kind:'stable_constraint',revision:2,applicability:['开发工作区'],evidence:[],history:[],createdAt:1,updatedAt:1};
const snapshot={records:[
 {...base,id:'archived',status:'archived',summary:'已停止使用的旧构建约束'},
 {...base,id:'revalidate',status:'needs_revalidation',summary:'需要重新核对的部署约束',history:[{revision:1,summary:'旧部署约束'}]},
 {...base,id:'candidate',status:'pending',summary:'待确认的版本核对规则'},
 {...base,id:'profile',namespace:'profile',kind:'user_preference',status:'active',summary:'优先用中文说明结论'}
],active:1,pending:1,history:0,startedAt:1,processing:{pending:0,failed:4,errors:['工作区事件 a123：记忆抽取超时','调度事件 b123：记忆抽取超时','调度事件 c123：记忆抽取超时','调度事件 d123：价值审查依据不能在原始事件中定位']}};
// Only IPC is mocked: render the production center, children and workspace provider together.
(window as any).api=new Proxy(fallback,{get(target,key){
 if(key==='config')return {get:async()=>config};
 if(key==='workspaces')return {list:async()=>config};
 if(key==='knowledge')return {list:async()=>snapshot,historySources:async()=>[{id:'original',name:'原始部署会话',namespace:'worker'}]};
 if(key==='memoryCenter')return {intents:async()=>({items:[]})};
 return Reflect.get(target,key);
}});
createRoot(document.getElementById('root')!).render(
 <div style={{display:'flex',height:'100vh',background:'var(--surface-canvas)'}}>
  <StoreProvider><KnowledgeCenter onClose={()=>{}}/></StoreProvider>
 </div>
);
