import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ChatMessageView } from '@workbench/src/renderer/src/components/ChatMessageView';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import { readMailPresentations } from '@workbench/src/shared/mailReadPresentation';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const result = JSON.stringify({ messages: [
  { id: 'mail-one', from: 'child', read: true, sourceAgent: { sessionId: 'child', name: '星探 · 通信核查', characterId: 'scout' },
    subject: '首轮检查结果', text: '已核对父子会话身份。\n普通信件应等待当前回合结束；运行中的 Agent 可以主动读信。\n下一步：检查长命令中断后的状态回报。', offset: 0, nextOffset: null },
  { id: 'mail-two', from: 'engineer', read: true, sourceAgent: { sessionId: 'engineer', name: '铆钉 · 代码检查', characterId: 'rivet' },
    text: '回归结果已准备。' + 'LongIdentifierWithoutSpaces'.repeat(8), offset: 4000, nextOffset: 4500 }
] });
const tool = { id: 'read', name: 'mcp_tool_call', input: { server: 'muster', tool: 'sessions_readMessages' }, arguments: '{}', status: 'ok' as const, result };
const pages = readMailPresentations([tool]);
createRoot(document.getElementById('root')!).render(<main style={{ padding: 16, background: 'var(--bg-panel)', minHeight: '100vh' }}>
  <ChatMessageView message={{ id: 'reply', role: 'assistant', createdAt: 1, content: '',
    displayItems: [{ kind: 'mail', id: 'host-mail', anchorPartIndex: 1, pages }], parts: [
    { kind: 'tool', toolCall: tool }, { kind: 'text', text: '我已读到两位 Agent 的反馈，正在核对。' }
  ] }} collapsedTurn quiet />
  <ChatMessageView message={{ id: 'user-preview', role: 'user', createdAt: 2, content: '用户消息也使用四角一致的大圆角。' }} quiet />
</main>);
