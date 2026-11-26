import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ChatTranscript } from '@workbench/src/renderer/src/chatSurface/ChatTranscript';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ChatMessage } from '@workbench/src/shared/types';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const now = Date.now();
const messages: ChatMessage[] = [
  { id: 'user', role: 'user', content: '请检查任务', createdAt: now },
  { id: 'scheduler', role: 'user', source: 'scheduler', content: '调度发来的任务', createdAt: now },
  { id: 'agent', role: 'user', source: 'agent', sourceAgent: { sessionId: 'child', name: '子代理' }, content: '子代理报告', createdAt: now },
  { id: 'host', role: 'user', host: true, content: '邮箱收到一封新信', createdAt: now },
  { id: 'answer', role: 'assistant', content: '', createdAt: now, parts: [
    { kind: 'tool', toolCall: { id: 'read', name: 'sessions.readMessages', arguments: '{}', status: 'ok', result: JSON.stringify({ messages: [
      { id: 'mail', from: 'host', read: true, text: '编排事件：任务状态已更新。' }
    ] }) } },
    { kind: 'text', text: '已经读到消息，正在核对。' },
    { kind: 'tool', toolCall: { id: 'suggest', name: 'ui.suggestReplies', arguments: '{}', status: 'ok', result: '{}' } },
    { kind: 'text', text: '处理完成。' }
  ] }
];
createRoot(document.getElementById('root')!).render(<main style={{ height: 720, display: 'flex' }}>
  <ChatTranscript sessionId="mail-fold-fixture" messages={messages} busy={false} model={{ toDisplay: message => message }} />
</main>);
