import { setDefault, emit } from './fixture-api';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider, useSessionStore } from '@workbench/src/renderer/src/store';
import { GlobalBoard } from '@workbench/src/renderer/src/panels/GlobalBoard';
import { applyTheme, setWorkspaceAppearance } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
const workspaces = [{ id: 'board-ui', path: 'E:/demo', name: '演示工作区', openedAt: 1 }];
const idle = { id:'needs-a',name:'检查 README 与工作面板',type:'terminal',launchKind:'agent',runtime:'cursor',workspaceId:'board-ui',createdAt:Date.now(),lastUsedAt:Date.now(),status:'running',lifecycle:'idle' };
setDefault('workspaces.list',{workspaces,activeWorkspaceId:'board-ui'});
setDefault('config.get',{workspaces,activeWorkspaceId:'board-ui',locale:'zh-CN'});
setDefault('sessions.list',{sessions:[idle],activeId:null});
setDefault('sessions.select',{ok:true});
setDefault('chat.state',{busy:false});
setDefault('chat.history',[]);
setDefault('boardTodos.list', []);
setDefault('chat.context',{});
setDefault('chat.getMode','default');
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
(window as any).__setBoardAccent = (accent: string, enabled: boolean) => setWorkspaceAppearance({ accent, enabled });
function Harness() {
 const [open,setOpen]=useState(false);
 const {sessions}=useSessionStore();
 return <><div className="app-shell" data-ready={sessions.length>0} style={{height:'100vh'}}>
  <header className="chrome-bar"><div className="chrome-menus"><button className="chrome-gboard-btn" id="toggle" onClick={()=>setOpen(v=>!v)}>全局看板</button><button id="notify" onClick={()=>emit('sessions:changed',{sessions:[{...idle,phase:{value:'needs_you',source:'model',ts:Date.now()}}],activeId:null})}>通知</button></div></header>
  <main style={{padding:40}}>会话工作面：背景内容保持可交互 <button id="clear-notify" onClick={()=>emit('sessions:changed',{sessions:[idle],activeId:null})}>恢复空闲</button></main>
 </div><GlobalBoard open={open} onOpen={()=>setOpen(true)} onClose={()=>setOpen(false)}/></>;
}
createRoot(document.getElementById('root')!).render(<StoreProvider><Harness/></StoreProvider>);
