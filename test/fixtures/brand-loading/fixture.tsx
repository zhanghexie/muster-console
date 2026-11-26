import '../../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { BrandBootLoader } from '@workbench/src/renderer/src/components/BrandLoader';
import { OperationButton } from '@workbench/src/renderer/src/components/OperationButton';
import { FileDiffView } from '@workbench/src/renderer/src/panels/FileDiffView';
import { ComposerSendButtons } from '@workbench/src/renderer/src/components/agentComposer/ComposerSendButtons';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
function App() {
 const [busy, setBusy] = React.useState(false);
 const [submitting, setSubmitting] = React.useState(false);
 const [reading, setReading] = React.useState(false);
 const flight = React.useRef<null | (() => void)>(null);
 return <main style={{minHeight:'100vh'}}><BrandBootLoader/><div style={{position:'fixed',bottom:80,left:40,right:40,padding:24,background:'var(--surface-raised)',color:'var(--fg-primary)',borderRadius:16}}>发送控件<div style={{position:'relative',height:44}}><ComposerSendButtons submitting={submitting} busy={busy} onStop={()=>setBusy(false)} inputLocked={false} hasText imagesCount={0} onSubmit={()=>{setSubmitting(true);setBusy(true);}}/></div><button onClick={()=>setSubmitting(false)}>模拟发送已确认</button>
 <div style={{display:'flex',gap:12,marginTop:12}}><OperationButton onAction={()=>new Promise<void>(resolve=>{flight.current=resolve})}>刷新模型目录</OperationButton><button onClick={()=>flight.current?.()}>模拟请求完成</button><button onClick={()=>setReading(v=>!v)}>切换 Diff 读取</button></div>
 {reading ? <FileDiffView loading diffText=""/> : null}</div></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
