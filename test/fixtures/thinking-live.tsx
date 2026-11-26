import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ChatMessageView } from '@workbench/src/renderer/src/components/ChatMessageView';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ChatDisplayPart, ChatMessage } from '@workbench/src/shared/types';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);

function tool(id: string, command: string, status: 'ok' | 'running'): ChatDisplayPart {
  return { kind: 'tool', toolCall: { id, name: 'bash', arguments: JSON.stringify({ command }), status } };
}

function Fixture(): React.JSX.Element {
  const [input, setInput] = React.useState('');
  const [thought, setThought] = React.useState('');
  const [complete, setComplete] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const [toolStage, setToolStage] = React.useState(0);
  const parts: ChatDisplayPart[] = [];
  if (toolStage >= 1) parts.push(tool('first', 'git status', 'ok'));
  parts.push({ kind: 'thinking', text: thought });
  if (toolStage >= 3) parts.push(tool('second', 'npm test', 'running'));
  const message: ChatMessage = {
    id: 'live-thinking', role: 'assistant', content: '', createdAt: 1,
    parts: toolStage === 1 ? parts.slice(0, 1) : complete ? [{ kind: 'text', text: '回复已开始。' }] : parts
  };
  return <main style={{ minHeight: '100vh', padding: 24, background: 'var(--surface-canvas)', color: 'var(--fg-primary)' }}>
    <div style={{ maxWidth: 680, margin: 'auto' }}>
      <p>实时思考</p>
      <div data-testid="message-width" style={{ width: narrow ? 'min(100%, 200px)' : '100%' }}>
        <ChatMessageView message={message} streaming={!complete} quiet />
        <div data-testid="following-content" style={{ marginTop: 12 }}>下一条内容的位置</div>
      </div>
      <div style={{ marginTop: 24 }}>
        <input aria-label="思考文本" value={input} onChange={event => setInput(event.target.value)} />
        <button onClick={() => setThought(input)}>更新思考</button>
        <button onClick={() => setNarrow(value => !value)}>切换宽度</button>
        <button onClick={() => setComplete(true)}>结束思考</button>
        <button onClick={() => { setComplete(false); setToolStage(stage => stage + 1); }}>推进工具链</button>
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
