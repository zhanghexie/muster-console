import { fixture } from '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import '@workbench/src/renderer/src/styles/bgTasks.css';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import { SessionReminders } from '@workbench/src/renderer/src/components/SessionReminders';
import { AgentComposer } from '@workbench/src/renderer/src/components/AgentComposer';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import type { SessionReminder } from '@workbench/src/shared/sessionReminders';

let items: SessionReminder[] = [
  { id: 'first', text: '确认提醒入口的样式', createdAt: 1, completedAt: null, completedBy: null, sourceMessageId: 'm1' },
  { id: 'second', text: '确认改动合并的目标分支', createdAt: 2, completedAt: null, completedBy: null, sourceMessageId: 'm2' },
  { id: 'third', text: '确定提醒入口的位置', createdAt: 3, completedAt: 4, completedBy: 'ai', sourceMessageId: null }
];
const api = window.api;
(window as any).api = new Proxy(api, {
  get(target, key) {
    if (key === 'workflow') return { overview: async () => ({ workflows: [{ name: 'review', fingerprint: 'fixture', trust: 'trusted' }], active: [], recent: [] }) };
    if (key !== 'sessionReminders') return Reflect.get(target, key);
    return {
    list: async () => ({ scope: 'fixture', items: structuredClone(items) }),
    delete: async (_target: unknown, _scope: string, id: string) => {
      fixture.calls.push({ path: 'sessionReminders.delete', args: [id] });
      items = items.filter(item => item.id !== id);
    },
    setCompleted: async (_target: unknown, _scope: string, id: string, done: boolean) => {
      fixture.calls.push({ path: 'sessionReminders.setCompleted', args: [id, done] });
      items = items.map(item => item.id === id ? { ...item, completedAt: done ? Date.now() : null, completedBy: done ? 'user' : null } : item);
      return items.find(item => item.id === id);
    }
    };
  }
});
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(<StoreProvider><div className="reminder-visual-outer" style={{ padding: 16 }}>
  <div className="reminder-visual-header" style={{ height: 42, display: 'flex', alignItems: 'center', padding: '0 14px', background: 'var(--surface-chrome)', color: 'var(--fg-primary)' }}>调度会话</div>
  <div className="chat-surface-view reminder-visual-surface" style={{ height: 570, background: 'var(--surface-canvas)', overflow: 'hidden' }}>
    <div style={{ padding: '32px 24px', color: 'var(--fg-primary)', lineHeight: 2 }}>
      <p>调度 Agent</p><p>提醒入口的样式已经整理好了，等你确认喜欢的方向。</p>
      <p>另外，改动准备合并前，还需要你确认目标分支。</p>
      <p>有新的事件需要处理，之前的提醒仍然保留。</p>
    </div>
    <div className="agent-chat-composer-wrap">
      <AgentComposer workspaceId="ui-verification-fixture" surfaceKind="dispatch" busy={false} plusMenu
        onModeChange={() => {}} chatStatus={{ modelLabel: 'GLM-5.3' }} onClear={async () => {}} onSend={async () => true}
        reminders={<SessionReminders kind="scheduler" id="fixture" visible onOpenSource={() => true}/>}/>
    </div>
  </div>
</div></StoreProvider>);
