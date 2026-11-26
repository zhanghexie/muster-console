import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/renderer/src/i18n';
import {StoreProvider} from '../../src/renderer/src/store';
import {AgentFloat} from '../../src/renderer/src/panels/AgentFloat';
import {applyTheme} from '../../src/renderer/src/theme';
import {builtinTheme} from '../../src/shared/theme';
import type {MemoryCuratorSnapshot} from '../../src/shared/memoryCurator';

// Full production AgentFloat, both ChatSurfaces, composer primitives and motion.
// Only host data and transport are simulated; no real project or memory is read.
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme')==='light'?'light':'dark')!);
const workspace={id:'memory-subsystem-fixture',name:'调度与记忆子系统',path:'E:/fixture',openedAt:1};
const snapshot:MemoryCuratorSnapshot={workspaceId:workspace.id,sessionId:'isolated-memory',generation:1,status:'idle',paused:false,pending:0,failed:0,running:false,updatedAt:1,
  model:{name:'隔离记忆模型'},messages:[{id:'memory-original',role:'assistant',parts:[{kind:'text',text:'记忆子系统只处理有依据的知识。关闭面板仍保留当前草稿与阅读位置。'}],ts:1}]};
const telemetry={sent:[] as string[],cleared:0,reads:0,accept:true,paused:0};
const listeners=new Set<(value:MemoryCuratorSnapshot)=>void>();
const defaults:Record<string,unknown>={
  'workspaces.list':{workspaces:[workspace],activeWorkspaceId:workspace.id},
  'config.get':{workspaces:[workspace],activeWorkspaceId:workspace.id,locale:'zh-CN'},
  'chat.history':[{id:'dispatch-original',role:'assistant',content:'这是调度会话。记忆子系统从下方打开，表头仍属于调度。',createdAt:1}],
  'chat.state':{busy:false},'chat.getMode':null,'chat.clear':{ok:true},
  'chat.context':{provider:'fixture',modelId:'fixture',modelName:'隔离调度模型',tokens:null,percent:null,contextWindow:128000},
  'bgTasks.list':{tasks:[]},'workflow.overview':{workflows:[],active:[],recent:[]},
  'workspaceFile.get':{workspaceId:workspace.id,config:{}},
  'agent.listModes':[], 'agent.listModels':[],
};
const original=window.api;
function api(route='',parent:any=original):any{
  return new Proxy(()=>{},{
    get:(_,key)=>key==='then'?undefined:api(route?`${route}.${String(key)}`:String(key),parent[key]),
    apply:(_,__,args)=>{
      if(route==='memoryCurator.state'){telemetry.reads++;return Promise.resolve(structuredClone(snapshot));}
      if(route==='memoryCurator.onChanged'){listeners.add(args[0]);return()=>listeners.delete(args[0]);}
      if(route==='memoryCurator.send'){telemetry.sent.push(args[1]);return Promise.resolve({accepted:telemetry.accept});}
      if(route==='memoryCurator.setPaused'){
        telemetry.paused++;snapshot.paused=args[1];snapshot.status=args[1]?'paused':'idle';snapshot.updatedAt++;
        for(const listener of listeners)listener(structuredClone(snapshot));return Promise.resolve(structuredClone(snapshot));
      }
      if(route==='memoryCurator.clear'){snapshot.generation++;snapshot.messages=[];snapshot.updatedAt++;for(const listener of listeners)listener(structuredClone(snapshot));return Promise.resolve(structuredClone(snapshot));}
      if(route==='chat.clear')telemetry.cleared++;
      if(Object.hasOwn(defaults,route))return Promise.resolve(structuredClone(defaults[route]));
      return parent(...args);
    }
  });
}
window.api=api();
(window as any).__memorySubsystem={telemetry,snapshot,accept:(value:boolean)=>{telemetry.accept=value;}};
localStorage.setItem('muster.agentPanelSize',JSON.stringify({w:innerWidth<=1100?360:620,h:740}));
function App():React.JSX.Element{
  const [slot,setSlot]=React.useState<HTMLDivElement|null>(null);
  return <StoreProvider><div className="memory-subsystem-fixture" style={{height:'100vh',minWidth:0}}>
    <p style={{padding:12,margin:0}}>正式 AgentFloat / ChatSurface / 输入组件；IPC 为隔离夹具，不连接真实记忆。</p>
    <aside style={{position:'absolute',left:12,bottom:12,width:180}} ref={setSlot}/>
    <AgentFloat wsStackSlot={slot}/>
  </div></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
