import { fixture } from '../../.agents/skills/ui-verification/assets/fixture-api';
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { AgentComposer } from '@workbench/src/renderer/src/components/AgentComposer';
import { useSmoothComposerHeight } from '@workbench/src/renderer/src/chatSurface/smoothComposerHeight';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
function App() {
  const wrap = useRef<HTMLDivElement>(null);
  useSmoothComposerHeight(wrap);
  return <StoreProvider><main className="chat-surface-view" style={{ height: '100vh', background: 'var(--bg-panel)' }}>
    <div className="agent-chat-composer-wrap" ref={wrap}>
      <AgentComposer workspaceId="reply-height" surfaceKind="gui-session" busy={false}
        replySuggestions={{messageId:'one', replies:['好的', '请继续检查', '再说明一下']}}
        onClearReplySuggestions={async () => ({ok:true, cleared:true})} onClear={async () => {}}
        onSend={async text => {fixture.sent.push(text); return true;}} />
    </div>
  </main></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
