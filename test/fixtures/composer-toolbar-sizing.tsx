import { fixture } from '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { AgentComposer } from '@workbench/src/renderer/src/components/AgentComposer';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
createRoot(document.getElementById('root')!).render(<StoreProvider>
  <main style={{ padding: 16, minHeight: '100vh', background: 'var(--bg-panel)' }}>
    <AgentComposer workspaceId="toolbar-sizing" surfaceKind="gui-session" busy={false}
      plusMenu mode="auto" modeChipLabels={{ auto: '完全访问' }} onModeChange={() => {}} harnessId="muster-core"
      chatStatus={{ modelLabel: 'GLM-5.3', usage: { tokens: 32000, contextWindow: 100000 } }}
      replySuggestions={{ messageId: 'sizing', replies: ['不好意思刚才发断了，我的任务是：……（补全内容）', '帮我查一下实现', '帮我分析方案'] }}
      onClearReplySuggestions={async () => ({ ok: true, cleared: true })}
      onClear={async () => {}} onSend={async text => { fixture.sent.push(text); return true; }} />
  </main>
</StoreProvider>);
