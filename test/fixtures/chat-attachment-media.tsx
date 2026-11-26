import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { markWebGatewayActive } from '../../src/renderer/src/webGatewayEnvironment';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
markWebGatewayActive();
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const metadata = (name: string) => '[Attachment metadata]\n' + JSON.stringify({ name, processing: 'path-only',
  sourcePath: `C:\\app\\conversation-attachments\\${'a'.repeat(20)}\\abcdef123456-${name}` });
function App() {
  const [show, setShow] = React.useState(false);
  const [opened, setOpened] = React.useState('');
  return <main style={{ padding: 16, minHeight: '100vh', background: 'var(--bg-panel)' }}>
    {!show ? <button onClick={() => setShow(true)}>加载附件</button> : <ChatMessageView quiet onFileLink={setOpened}
      message={{ id: 'm', role: 'user', createdAt: 1, content: `看看这个视频和报告\n\n${metadata('演示视频.webm')}\n\n${metadata('项目报告.pdf')}` }} />}
    <output data-testid="opened">{opened ? '已请求打开文件' : ''}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
