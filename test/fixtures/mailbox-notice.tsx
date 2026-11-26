import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ChatMessageView } from '@workbench/src/renderer/src/components/ChatMessageView';
import { toDisplayMessage } from '@workbench/src/renderer/src/chatSurface/guiMessageView';
import { createGuiUserMessage } from '@workbench/src/shared/guiWorker';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const wake = toDisplayMessage(createGuiUserMessage({ id: 'wake', ts: 1, host: true,
  text: '【宿主收信提醒】邮箱收到 12 封新信。请用 sessions.readMessages 查看收件箱，再按 messageId 打开正文。提醒不代表信件已读或任务完成；无需回复本提醒。' }));
createRoot(document.getElementById('root')!).render(<main style={{ padding: 16, background: 'var(--bg-panel)', minHeight: '100vh' }}>
  <ChatMessageView message={{ id: 'u', role: 'user', content: '请核对长报告与最新结论。', createdAt: 1 }} />
  <section data-case="mailbox"><ChatMessageView message={wake} /></section>
  <section data-case="normal"><ChatMessageView message={{ id: 'a', role: 'assistant', content: '已主动打开信件，完整报告保存在邮箱，可按页继续读取。已读只表示打开过，处理结果需要另行回复。', createdAt: 1 }} /></section>
</main>);
