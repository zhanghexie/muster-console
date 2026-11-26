import { setDefault } from '../board-beam-color/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider, useSessionStore } from '@workbench/src/renderer/src/store';
import { GlobalBoard } from '@workbench/src/renderer/src/panels/GlobalBoard';
import { applyTheme, setWorkspaceAppearance } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import { boardReplyLine } from '@workbench/src/shared/boardReplyPreview';

const now = Date.now();
const workspaces = [{ id: 'board-ui', path: '/fixture', name: 'muster', openedAt: 1 }];
const sessions = [
  ['theme', '全局看板主题适配', 'working', 'idle', '检查深浅主题与工作区配色'],
  ['startup', '首次发送启动优化', 'idle', 'idle', '技能扫描已调整，等待下一轮实测'],
  ['review', '审阅功能稳定性修复', 'idle', 'needs_you', '修复已完成，等待真实模型验证'],
  ['layout', '工作区面板间距调整', 'idle', 'needs_you', '请查看卡片间距与文字层级'],
  ['memory', '记忆修订流程', 'idle', 'done', '修订流程及回归验证完成'],
  ['browser', '浏览器页面边界', 'idle', 'done', '已统一页面边缘和裁切'],
  ['docs', '功能文档整理', 'idle', 'done', '文档已更新，索引已同步']
].map(([id, name, lifecycle, phase, label], index) => ({
  id, name, lifecycle, type: 'terminal', launchKind: 'agent', runtime: 'muster-core',
  workspaceId: 'board-ui', status: 'running', createdAt: now - index * 3600000,
  lastUsedAt: now - index * 3600000,
  phase: { value: phase, source: 'model', ts: now - index * 3600000 },
  liveStatus: { label, ts: now - index * 3600000 },
  boardReplyPreview: id === 'theme'
    ? '这是一段足够长的看板卡片正文，用于验证在宽窗口和窄窗口中都最多显示两行，超出的部分显示省略号'.repeat(4)
    : id === 'startup' ? boardReplyLine('游戏已启动。玩得开心！ 🏁') : undefined
}));
setDefault('workspaces.list', { workspaces, activeWorkspaceId: 'board-ui' });
setDefault('config.get', { workspaces, activeWorkspaceId: 'board-ui', locale: 'zh-CN' });
setDefault('sessions.list', { sessions, activeId: 'theme' });
setDefault('boardTodos.list', [{
  id: 'board-todo', name: '预览检查', task: '代办正文第一行\n代办正文第二行\n代办正文第三行',
  workspaceId: 'board-ui', runtime: 'codex-gui', surface: 'chat', advanced: {}, isolate: false,
  createdAt: now, updatedAt: now
}]);
const mode = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(mode)!);
(window as any).__boardPalette = (custom: boolean, accent: boolean) => {
  const base = builtinTheme(mode)!;
  applyTheme(custom ? { ...base, colors: { ...base.colors, 'bg-panel': mode === 'dark' ? '#242039' : '#f3ece1' } } : base);
  setWorkspaceAppearance({ accent: '#9276d8', enabled: accent });
};
function Harness() {
  const { sessions } = useSessionStore();
  return <div className="app-shell" data-ready={sessions.length > 0} style={{ height: '100vh' }}>
    <GlobalBoard open onOpen={() => {}} onClose={() => {}} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<StoreProvider><Harness /></StoreProvider>);
