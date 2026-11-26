import '@workbench/.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { applyLocaleSetting } from '@workbench/src/shared/i18n';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import { ChatResetDialog } from '@workbench/src/renderer/src/components/ChatResetDialog';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!); applyLocaleSetting('en');
const snapshot = {messages: [], busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null};
const surface = {sessionId:'fixture',caps:{surfaceKind:'gui-session',draftKey:'fixture',images:false},subscribe:()=>()=>{},getSnapshot:()=>snapshot,actions:{send:async()=>true,clear:async()=>{},stop:()=>{},retry:()=>{},cancelQueued:()=>{}}};
function Fixture() { const [open,setOpen] = React.useState(true); return <main style={{minHeight:'100vh',background:'var(--bg-panel)'}}><ChatResetDialog target={open ? {workspaceId:'fixture',purpose:'dispatch',surface} : null} onClose={()=>setOpen(false)} /></main>; }
createRoot(document.getElementById('root')!).render(<Fixture/>);
