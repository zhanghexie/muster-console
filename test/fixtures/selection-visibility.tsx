import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { SelectionMenuHost } from '@workbench/src/renderer/src/components/SelectionMenuHost';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(<StoreProvider>
  <main style={{ position: 'relative', margin: 20, height: 420, background: 'var(--surface-canvas)', color: 'var(--fg-primary)' }}>
    <div id="scroll" data-sel-area="default" style={{ overflow: 'auto', height: '100%', padding: 16 }}>
      <div style={{ height: 260 }}>会话正文 · 滚动验证</div>
      <span id="selected">send-queue-pane</span>
      <div style={{ height: 700 }}>后续会话正文</div>
    </div>
    <div id="composer" style={{ position: 'absolute', bottom: 0, left: 8, right: 8, height: 140, padding: 20, background: 'var(--surface-raised)', border: '1px solid var(--border-default)', borderRadius: 16 }}>
      输入框覆盖区
    </div>
    <SelectionMenuHost />
  </main>
</StoreProvider>);
