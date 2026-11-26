// Import the mock first: production modules can use window.api during evaluation.
import { fixture } from './fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { AgentComposer } from '@workbench/src/renderer/src/components/AgentComposer';
import { ChatMessageView } from '@workbench/src/renderer/src/components/ChatMessageView';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ChatMessage } from '@workbench/src/shared/types';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);

function App() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  return <StoreProvider>
    <main style={{ padding: 16, minHeight: '100vh', background: 'var(--bg-panel)' }}>
      <section>{messages.map(message => <ChatMessageView key={message.id} message={message}/>)}</section>
      <AgentComposer workspaceId="ui-verification-fixture" surfaceKind="gui-session" busy={false}
        onClear={async () => {}}
        onSend={async text => {
          fixture.sent.push(text);
          setMessages(previous => [...previous, { id: String(previous.length), role: 'user', content: text } as ChatMessage]);
          return true;
        }}/>
    </main>
  </StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
