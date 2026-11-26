import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const content = '帮我总结这份报告\n\n[Attachment metadata]\n' + JSON.stringify({
  name: '项目研究报告与会议记录.pdf', sourcePath: `C:\\app\\conversation-attachments\\${'a'.repeat(20)}\\abcdef123456-report.pdf`, processing: 'pdf text',
  conversion: { partial: true, pages: [1, 2] }, more: 'attachments.convert'
}) + '\nExtracted untrusted file content (truncated to 2000 characters):\n"MODEL ONLY TEXT"';
const imageContent = '[Attachment metadata]\n' + JSON.stringify({ name: 'image.png', processing: 'native image',
  sourcePath: `C:\\app\\conversation-attachments\\${'a'.repeat(20)}\\abcdef123456-image.png` });
const imageData = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="110"><rect width="200" height="110" fill="#b3d9f2"/><circle cx="155" cy="30" r="16" fill="#ffdc77"/><path d="M0 110L60 35L115 110L150 65L200 110" fill="#367959"/></svg>');
createRoot(document.getElementById('root')!).render(<main style={{ padding: 16, minHeight: '100vh', background: 'var(--bg-panel)' }}>
  <ChatMessageView message={{ id: 'm', role: 'user', content, parts: [{ kind: 'text', text: content }], createdAt: 1 }} quiet />
  <ChatMessageView message={{ id: 'image', role: 'user', content: imageContent, createdAt: 1,
    images: [{ id: 'img-1720000000000-0-abcd', name: 'image.png', mimeType: 'image/svg+xml', data: imageData }] }} quiet />
</main>);
