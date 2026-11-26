import '@workbench/.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ExtensionUiDialog } from '@workbench/src/renderer/src/components/ExtensionUiDialog';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { UiDialogRequest } from '@workbench/src/shared/uiDialog';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
function App() {
  const [request, setRequest] = React.useState<UiDialogRequest | null>({ requestId: 'first', kind: 'prompt', title: '输入项目说明', message: '请填写后继续。宿主可以取消本次请求。', defaultValue: '中文草稿 · draft', placeholder: '项目说明' });
  React.useEffect(() => {
    (window as any).dialogResponses = [];
    (window as any).cancelHostDialog = () => setRequest(null);
    (window as any).openNextDialog = () => setRequest({ requestId: 'next', kind: 'prompt', title: '下一条请求', placeholder: '下一条说明' });
  }, []);
  return <main className="dialog-fixture" style={{ minHeight: '100vh', padding: 16, color: 'var(--ink)', background: 'var(--bg-panel)' }}>
    <p>项目工作区</p><p>宿主取消后，对话框退出，工作区继续可用。</p>
    <ExtensionUiDialog request={request} onRespond={(...args) => { (window as any).dialogResponses.push(args); setRequest(null); }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
