import './feedback-visual-api';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import { FeedbackCenter } from '@workbench/src/renderer/src/components/FeedbackCenter';
import type { FeedbackEntry, FeedbackSnapshot } from '@workbench/src/shared/feedback';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const first: FeedbackEntry = { id: 'visual-a', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: ['产品工作区 · GUI Worker (demo)'], appVersion: '0.1.31', aiChecked: true, kind: 'bug', title: '切换工作区后会话列表滚动位置丢失', area: '会话列表', context: '在两个工作区之间来回切换', actual: '切换回来后列表回到顶部。', expected: '恢复之前的阅读位置。', steps: '滚动会话列表，切换到其他工作区，再切回来。', impact: '需要重新寻找之前的会话。', evidence: '只在当前环境观察一次，尚未确认其他平台。', suggestion: '' };
const second: FeedbackEntry = { ...first, id: 'visual-b', title: '长任务结束后缺少明确通知而且很长很长的反馈标题应该被截断而不是撑高列表', area: '通知', kind: 'improvement' };
const initial: FeedbackSnapshot = { entries: [first, second] };
function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [open, setOpen] = useState(true);
  (window as any).__markFeedbackOpened = () => setSnapshot(current => ({ entries: current.entries.map(item => item.id === 'visual-a'
    ? { ...item, revision: item.revision + 1, status: 'opened' } : item) }));
  (window as any).__markFeedbackSubmitted = () => setSnapshot(current => ({ entries: current.entries.map(item => item.id === 'visual-a'
    ? { ...item, revision: item.revision + 1, status: 'submitted', issueUrl: 'https://gitlab.example.test/demo/workbench/-/issues/42' } : item) }));
  (window as any).__updateFeedbackContext = (context: string) => setSnapshot(current => ({ entries: current.entries.map(item => item.id === 'visual-a'
    ? { ...item, revision: item.revision + 1, context } : item) }));
  return <main style={{ minHeight: '100vh', padding: 24 }}><h1>MetaAgent</h1><p>工作区内容</p>
    <FeedbackCenter open={open} onClose={() => setOpen(false)} snapshot={snapshot} onSnapshot={setSnapshot} onRefresh={async () => {}}/>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<App/>);
Object.assign(window, { __remountFeedback: () => root.render(<App key="fallback"/>) });
