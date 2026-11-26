import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { ChatMessageView } from '@workbench/src/renderer/src/components/ChatMessageView';
import { CompactDivider } from '@workbench/src/renderer/src/components/CompactDivider';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { setInteractionPreferences } from '@workbench/src/renderer/src/interactionPreferences';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ChatMessage } from '@workbench/src/shared/types';

// Only the tips route differs from the common mock; no real IPC or app data.
const baseApi = (window as any).api;
(window as any).__setActivityMotionPreference = (motion: 'system' | 'reduced') => setInteractionPreferences({ motion });
(window as any).api = new Proxy(baseApi, {
  get(target, key) {
    if (key !== 'config') return Reflect.get(target, key);
    return new Proxy(target.config, {
      get(config, method) {
        if (method === 'waitingTips') return async () => ({
          ok: true,
          path: '/example/waiting-tips.json',
          tips: [
            { 'zh-CN': '右键点击自己的消息，可以浏览会话历史并跳转。', en: 'Right-click your message to browse history.' },
            { 'zh-CN': '可以在会话中查找消息内容。', en: 'Search your conversation.' }
          ]
        });
        return Reflect.get(config, method);
      }
    });
  }
});

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const answer: ChatMessage = { id: 'wait', role: 'assistant', content: '', createdAt: 1 };

function Fixture(): React.JSX.Element {
  const [complete, setComplete] = React.useState(false);
  const tool = (id: string, name: string, input: object): ChatMessage => ({
    id, role: 'assistant', content: '', createdAt: 1,
    parts: [{ kind: 'tool', toolCall: { id, name, arguments: JSON.stringify(input), input, status: complete ? 'ok' : 'running' } }]
  });
  const thinking: ChatMessage = { id: 'thinking', role: 'assistant', content: '', createdAt: 1,
    parts: complete ? [{ kind: 'text', text: '思考结束。' }] : [{ kind: 'thinking', text: '正在整理解决思路。' }] };
  return <main style={{ minHeight: '100vh', padding: 24, background: 'var(--surface-canvas)', color: 'var(--fg-primary)' }}>
    <div style={{ maxWidth: 680, margin: 'auto' }}>
      <p>等待回复</p>
      <ChatMessageView message={complete ? { ...answer, parts: [{ kind: 'text', text: '已完成检查。' }] } : answer} streaming={!complete} quiet />
      <p>实时思考</p>
      <ChatMessageView message={thinking} streaming={!complete} quiet />
      <p>终端执行</p>
      <ChatMessageView message={tool('cmd', 'bash', { command: 'npm test' })} streaming={!complete} quiet />
      <p>工具执行</p>
      <ChatMessageView message={tool('tool', 'read_file', { path: 'src/app.ts' })} streaming={!complete} quiet />
      <p>文件写入</p>
      <ChatMessageView message={tool('write', 'write', { path: 'src/app.ts', content: 'example' })} streaming={!complete} quiet />
      <p>上下文压缩</p>
      <CompactDivider status={complete ? 'complete' : 'running'} />
      <button onClick={() => setComplete(value => !value)} style={{ marginTop: 28 }}>切换完成状态</button>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
