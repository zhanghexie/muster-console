import React from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionMeta } from '../../src/shared/types';

const now = Date.now();
const workspaces = [{ id: 'meta', path: 'E:/fixture/meta', name: 'muster', openedAt: 1 }, { id: 'app', path: 'E:/fixture/app', name: 'MetaApp', openedAt: 1 }];
const sessions: SessionMeta[] = [
  ...Array.from({ length: 13 }, (_, n): SessionMeta => ({ id: `active-${n}`, name: n === 0 ? 'GLM 审查员·三线复审' : `工作面板 ${n + 24}`, type: 'terminal', launchKind: 'agent', runtime: n % 2 ? 'cursor' : 'pi', workspaceId: n % 3 ? 'app' : 'meta', createdAt: now - 60_000, lastUsedAt: now - 60_000, lifecycle: 'idle', status: 'idle', phase: { value: 'idle', source: 'model', ts: now }, liveStatus: { label: n === 0 ? '宿主五条修复复审 PASS（附验收说明，等待下一步）' : '排查会话搜索关键词换行问题', kind: 'info', ts: now }, orchestrated: n === 0 })),
  ...['倒挂对账未改等看', '【在排查】7117345583变身隐身', '编辑器卡顿匹配失败'].map((name, n): SessionMeta => ({ id: `needs-${n}`, name, type: 'terminal', launchKind: 'agent', runtime: 'cursor', workspaceId: 'app', createdAt: now - 60_000, lastUsedAt: now, lifecycle: 'idle', status: 'idle', phase: { value: 'needs_you', source: 'model', ts: now, label: '等验收' }, liveStatus: { kind: 'waiting', ts: now, label: ['停着，等你开口', '未 push，等你看转化 rebase', '编辑器卡顿嫌疑已收敛，等确认'][n] } })),
  ...['原型目录归档', '多模态UI审查员', '【在排查】7123290317', '【已提MR】12548', '调研UGC AI生成链路', '对照7两条ISM', '72合入temp并开MR'].map((name, n): SessionMeta => ({ id: `done-${n}`, name, type: 'terminal', launchKind: 'agent', runtime: n === 1 ? 'pi' : 'cursor', workspaceId: n < 2 ? 'meta' : 'app', createdAt: now - 60_000, lastUsedAt: now - 60_000, lifecycle: 'idle', status: 'idle', phase: { value: 'done', source: n > 1 ? 'user' : 'model', ts: now }, liveStatus: { kind: 'done', ts: now, label: '文档已写，等验收' }, ...(n === 2 ? { agentTaskId: 't-1', worktreeBranch: 'codex/board-layout', orchestrated: true } : {}) })),
  { id: 'archived', name: '已归档示例', type: 'terminal', launchKind: 'agent', runtime: 'pi', workspaceId: 'app', createdAt: now, lastUsedAt: now, archived: true, lifecycle: 'exited', status: 'exited' }
];
const callbacks = new Map<string, Set<(data: unknown) => void>>();
const calls: unknown[] = [];
const defaults: Record<string, unknown> = { 'workspaces.list': { workspaces, activeWorkspaceId: 'app' }, 'config.get': { workspaces, activeWorkspaceId: 'app', locale: 'zh-CN' }, 'sessions.list': { sessions, activeId: null }, 'runtimes.list': [], 'agentTasks.listAll': { byWorkspace: {} }, 'notify.list': [], 'chat.state': { busy: false }, 'agent.listSkills': [], 'boardTodos.list': [] };
function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
    apply: (_, __, args) => {
      if (route === 'on') { const [channel, fn] = args; const set = callbacks.get(channel) ?? new Set(); set.add(fn); callbacks.set(channel, set); return () => set.delete(fn); }
      calls.push({ route, args });
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
(window as any).api = api();
(window as any).__uiFixture = { unmocked: [], calls };
async function mount() {
  await import('../../src/renderer/src/i18n');
  const { StoreProvider } = await import('../../src/renderer/src/store');
  const { BoardPanel } = await import('../../src/renderer/src/panels/BoardPanel');
  const { builtinTheme } = await import('../../src/shared/theme');
  const { applyTheme } = await import('../../src/renderer/src/theme');
  const { markNeedsRead } = await import('../../src/renderer/src/panels/needsReadStore');
  const { setFreeViewMode, setFilterActiveWorkspace } = await import('../../src/renderer/src/panels/freeViewStore');
  setFreeViewMode('status'); setFilterActiveWorkspace(false);
  for (let n = 0; n < 3; n++) markNeedsRead(`needs-${n}`);
  applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
  createRoot(document.getElementById('root')!).render(<StoreProvider><div className="g-board-sheet" style={{ position: 'relative', width: 'calc(100vw - 32px)', height: 'calc(100vh - 40px)', margin: '20px 16px' }}><BoardPanel onClose={() => {}} /></div></StoreProvider>);
}
void mount();
