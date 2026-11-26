import '../../.agents/skills/ui-verification/assets/fixture-api';
// Capture with --styles base,float,board,memory --target .memory-usage-fixture.
// Only the outer two-tab shell is fixture code. Both bodies, cards, controls,
// histories, queue filters and navigation actions use production components.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { applyLocaleSetting } from '../../src/shared/i18n';
import type { KnowledgeApi, KnowledgeRecord, KnowledgeSnapshot } from '../../src/shared/knowledge';
import type { MemoryCuratorApi, MemoryCuratorQueueEntry, MemoryCuratorQueueQuery, MemoryCuratorSnapshot } from '../../src/shared/memoryCurator';
import { MemoryProcessingView } from '../../src/renderer/src/components/MemoryProcessingView';
import { KnowledgePanel } from '../../src/renderer/src/components/KnowledgePanel';
import { useMemoryCenterRoute } from '../../src/renderer/src/memoryCenterRoute';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

const workspaceId = 'memory-usage-fixture';
const at = Date.parse('2026-10-22T03:00:00.000Z');
const clone = <T,>(value: T): T => structuredClone(value);
const target: KnowledgeRecord = {
  schema: 1, id: 'fixture-subscription', revision: 2, namespace: 'worker', kind: 'reusable_lesson', status: 'active', origin: 'worker',
  summary: '组件卸载时取消订阅，避免页面离开后重复收到事件',
  problem: '页面切换后旧订阅仍持有回调，导致同一事件被重复处理。',
  action: '让订阅函数返回清理函数，并在 React effect 的清理阶段调用；重新订阅前核对旧订阅已经释放。',
  rationale: '隔离组件夹具覆盖挂载、卸载与再次挂载；它不能代替真实 Electron 进程验收。',
  expectedFutureUse: '排查页面切换后的重复事件时，先核对订阅生命周期。',
  applicability: ['React effect 内创建的事件订阅'], exceptions: ['生命周期独立于页面的后台服务'],
  evidence: [{ id: 'fixture-evidence', source: 'fixture-component-test', eventTime: at - 60_000, verification: 'test', turnId: 'fixture-turn' }],
  createdAt: at - 120_000, updatedAt: at, decisionReason: '在声明的生命周期范围内可复用；依据仅来自隔离夹具。',
  history: [{ revision: 1, summary: '订阅函数需要提供明确的清理入口', status: 'pending', at: at - 120_000 }]
};
const fact: KnowledgeRecord = {
  schema: 1, id: 'fixture-task-fact', revision: 1, namespace: 'worker', kind: 'task_fact', status: 'archived', origin: 'worker',
  summary: '本次隔离夹具完成了事件订阅卸载回归', applicability: [], evidence: clone(target.evidence),
  taskId: 'fixture-task', expiresAt: at + 90 * 86_400_000, createdAt: at, updatedAt: at,
  decisionReason: '单次任务事实只供追溯，不作为长期经验常驻注入。', history: []
};
const records = new Map([target, fact].map(record => [record.id, clone(record)]));
const deletedIds = new Set<string>();
const queue: MemoryCuratorQueueEntry[] = [
  { id: 'fixture-running', kind: 'candidate', namespace: 'worker', state: 'running', archived: false, createdAt: at, availableAt: at, attempts: 1, evidenceCount: 2,
    text: '核对当前候选与已有知识的适用条件；证据只来自本次受控夹具，不能写成跨平台真机验收。' },
  { id: 'fixture-failed', kind: 'candidate', namespace: 'scheduler', state: 'failed', archived: false, createdAt: at - 10_000, availableAt: at, attempts: 2, evidenceCount: 1,
    text: '核对页面切换后重复回调的候选是否与已有订阅清理经验相同。', error: '示例提供商请求超时；没有收到整理决策，候选仍保留供重试。' },
  { id: 'fixture-saved', kind: 'candidate', namespace: 'worker', state: 'done', archived: false, createdAt: at - 20_000, availableAt: at, attempts: 1, evidenceCount: 2,
    text: '组件卸载需要释放事件订阅，并记录适用范围与例外。',
    result: { disposition: 'active', recordId: target.id, reason: '保存为带适用条件的经验；原始依据仅证明隔离组件行为。' } },
  { id: 'fixture-history', kind: 'candidate', namespace: 'worker', state: 'done', archived: false, createdAt: at - 30_000, availableAt: at, attempts: 1, evidenceCount: 1,
    text: '本次订阅卸载回归已经完成。',
    result: { disposition: 'retained_ephemeral', recordId: fact.id, reason: '这是本次任务的事实，留入有保留期的历史，不自动晋升为经验。' } },
  { id: 'fixture-discarded', kind: 'candidate', namespace: 'worker', state: 'done', archived: false, createdAt: at - 40_000, availableAt: at, attempts: 1, evidenceCount: 0,
    text: '所有组件都不会再出现订阅问题。',
    result: { disposition: 'discarded', reason: '缺少支持这一泛化结论的原始依据，本次不保留。' } },
  { id: 'fixture-older-archived', kind: 'candidate', namespace: 'worker', state: 'done', archived: true, createdAt: at - 8 * 86_400_000, availableAt: at - 8 * 86_400_000, attempts: 1, evidenceCount: 0,
    text: '七天前已完成的整理记录，当前只在已归档中展示。',
    result: { disposition: 'discarded', reason: '该旧记录没有可复用结论；归档不会删除或恢复任何知识。' } }
];
type Phase = 'running' | 'failed' | 'retrying' | 'settled';
let phase: Phase = 'running', paused = false, revision = 0;
const listeners = new Set<(snapshot: MemoryCuratorSnapshot) => void>();
const telemetry = {
  ready: false, phase, retryCount: 0, subscriptions: 0, unsubscriptions: 0, activeListeners: 0,
  snapshotPollActive: false, snapshotPolls: 0, staleSnapshots: 0, sharedTargetRevision: 0,
  conversationOpens: 0, settingsOpens: 0, deletedReceipts: [] as KnowledgeRecord[],
  archiveChanges: [] as Array<{ candidateId: string; archived: boolean; knowledgeStatus: KnowledgeRecord['status']; processCount: number }>,
  inspected: [] as Array<{ workspaceId: string; input: MemoryCuratorQueueQuery }>,
  calls: [] as Array<{ path: string; args: unknown[] }>, navigations: [] as Array<{ tab: string; entryId?: string }>
};
function call(path: string, ...args: unknown[]): void { telemetry.calls.push({ path, args: clone(args) }); }
function owned(id: string): void { if (id !== workspaceId) throw new Error('Fixture workspace identity mismatch'); }
function curatorState(): MemoryCuratorSnapshot {
  const running = !paused && (phase === 'running' || phase === 'retrying');
  const failed = queue.filter(item => item.state === 'failed' && !item.archived).length;
  return {
    workspaceId, sessionId: 'fixture-memory-session', generation: 1, status: paused ? 'paused' : running ? 'running' : failed ? 'error' : 'idle',
    paused, running, pending: queue.filter(item => ['pending', 'deferred'].includes(item.state)).length, failed,
    messages: [], updatedAt: at + revision, model: { providerId: 'fixture-provider', modelId: 'fixture-model', name: '夹具记忆模型' },
    ...(failed && !running ? { error: '示例提供商请求超时，等待显式重试。' } : {})
  };
}
function knowledgeSnapshot(): KnowledgeSnapshot {
  const current = [...records.values()], processing = curatorState();
  return clone({ records: current, deletedIds: [...deletedIds], active: current.filter(record => record.status === 'active' && record.kind !== 'task_fact').length,
    pending: current.filter(record => record.status === 'pending').length, history: current.filter(record => record.kind === 'task_fact').length,
    startedAt: at, profileInjectionChars: 0, processing: { pending: processing.pending, failed: processing.failed, errors: processing.error ? [processing.error] : [], running: processing.running, paused: processing.paused } });
}
const initialSnapshot = knowledgeSnapshot();
function emit(): void { const state = curatorState(); for (const listener of listeners) listener(clone(state)); }
function setPhase(next: Phase): void {
  phase = next; telemetry.phase = next; revision++;
  if (next === 'failed') queue[0] = { ...queue[0], state: 'pending' };
  if (next === 'retrying') queue[1] = { ...queue[1], state: 'running', error: undefined, attempts: queue[1].attempts + 1 };
  if (next === 'settled') {
    queue[0] = { ...queue[0], state: 'done', result: { disposition: 'discarded', reason: '当前材料只有夹具边界说明，无需另存一条重复经验。' } };
    queue[1] = { ...queue[1], state: 'done', error: undefined, result: { disposition: 'duplicate', recordId: target.id, reason: '重试后核对到已有相同知识，未新建重复条目。' } };
  }
  emit();
}
const curatorApi: MemoryCuratorApi = {
  state: async id => { owned(id); call('memoryCurator.state', id); return clone(curatorState()); },
  inspect: async (id, input = {}) => {
    owned(id); call('memoryCurator.inspect', id, input); telemetry.inspected.push({ workspaceId: id, input: clone(input) });
    const state = input.state ?? 'all', visibility = input.visibility ?? 'visible', offset = input.offset ?? 0, limit = input.limit ?? 30;
    const matching = queue.filter(item => (visibility === 'all' || item.archived === (visibility === 'archived')) &&
      (state === 'all' || (state === 'attention' ? item.state !== 'done' : state === 'queued' ? ['pending', 'running', 'deferred'].includes(item.state) : item.state === state)));
    return clone({ items: matching.slice(offset, offset + limit), total: matching.length, offset, limit });
  },
  setPaused: async (id, value) => { owned(id); call('memoryCurator.setPaused', id, value); paused = value; revision++; emit(); return clone(curatorState()); },
  setArchived: async (id, candidateId, archived) => {
    owned(id); call('memoryCurator.setArchived', id, candidateId, archived);
    const index = queue.findIndex(item => item.id === candidateId), item = queue[index];
    if (!item) throw new Error('整理记录不存在，请刷新后重试');
    if (!['done', 'failed'].includes(item.state)) throw new Error('正在处理的整理记录不能归档或恢复');
    if (item.archived === archived) return { changed: false };
    queue[index] = { ...item, archived }; revision++;
    telemetry.archiveChanges.push({ candidateId, archived, knowledgeStatus: records.get(target.id)!.status, processCount: telemetry.retryCount });
    emit(); return { changed: true };
  },
  onChanged: listener => {
    listeners.add(listener); telemetry.subscriptions++; telemetry.activeListeners = listeners.size;
    return () => { if (listeners.delete(listener)) telemetry.unsubscriptions++; telemetry.activeListeners = listeners.size; };
  },
  send: async () => { throw new Error('This read-only fixture does not execute a model'); },
  clear: async () => { throw new Error('Conversation clearing is outside this fixture'); }
};
const hostKnowledgeApi: KnowledgeApi = {
  list: async () => { call('knowledge.list', workspaceId); return knowledgeSnapshot(); },
  process: async () => {
    call('knowledge.process', workspaceId);
    if (phase !== 'failed' || paused) throw new Error('Fixture retry requires an idle failed candidate');
    telemetry.retryCount++; setPhase('retrying');
  },
  decide: async input => {
    call('knowledge.decide', workspaceId, input);
    const current = records.get(input.id);
    if (!current || input.decision !== 'archive' || current.revision !== input.revision || deletedIds.has(input.id)) throw new Error('Fixture deletion CAS mismatch');
    const receipt: KnowledgeRecord = { ...current, status: 'rejected', revision: current.revision + 1, updatedAt: at + 60_000,
      decisionReason: '用户删除：停止使用并阻止同义内容自动复活',
      history: [...current.history, { revision: current.revision, summary: current.summary, status: current.status, at: current.updatedAt }] };
    records.set(receipt.id, receipt); deletedIds.add(receipt.id); telemetry.deletedReceipts.push(clone(receipt));
    return clone(receipt);
  },
  search: async input => {
    call('knowledge.search', workspaceId, input);
    return [...records.values()].filter(record => record.status === 'active' && !deletedIds.has(record.id) && record.namespace === input.namespace && record.summary.includes(input.query))
      .map(record => ({ record: clone(record), score: 1, reason: '确定性夹具关键词匹配', applicability: 'needs_check' as const }));
  },
  evidence: async input => { call('knowledge.evidence', workspaceId, input); return { status: 'unavailable', reason: '确定性截图夹具没有真实工作区快照，不伪造 Diff。', files: [] }; },
  historySources: async () => { call('knowledge.historySources', workspaceId); return [{ id: 'fixture-original', name: '隔离夹具原始会话', namespace: 'worker' }]; },
  history: async input => { call('knowledge.history', workspaceId, input); return { messages: [{ id: 'fixture-original-turn', role: 'user', text: '请核对组件卸载时是否释放了事件订阅。', at, state: '夹具原始记录，未验证' }], truncated: false }; },
  create: async () => { throw new Error('Outside fixture scope'); }, govern: async () => { throw new Error('Outside fixture scope'); },
  undoGovernance: async () => { throw new Error('Outside fixture scope'); }, revise: async () => { throw new Error('Outside fixture scope'); },
  supersede: async () => { throw new Error('Outside fixture scope'); }, restore: async () => { throw new Error('Outside fixture scope'); },
  confirm: async () => { throw new Error('Outside fixture scope'); }, promoteHost: async () => { throw new Error('Outside fixture scope'); }
};
const fallbackApi = window.api;
window.api = new Proxy(fallbackApi, { get(previous, key) {
  if (key === 'memoryCurator') return curatorApi;
  if (key === 'knowledge') return { ...hostKnowledgeApi, process: async (id: string) => { owned(id); return hostKnowledgeApi.process(); } };
  return Reflect.get(previous, key);
} });
applyLocaleSetting('zh-CN'); document.documentElement.lang = 'zh-CN';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
let publishSnapshot: ((snapshot: KnowledgeSnapshot) => void) | null = null;

function Fixture(): React.JSX.Element {
  const [view, setView] = useState<'processing' | 'knowledge'>('processing');
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>(initialSnapshot);
  const route = useMemoryCenterRoute();
  const api = useMemo<KnowledgeApi>(() => ({ ...hostKnowledgeApi, list: async () => {
    const value = await hostKnowledgeApi.list(); setSnapshot(value); return value;
  } }), []);
  const onRefresh = useCallback(async () => api.list(), [api]);
  const openConversation = useCallback(() => { telemetry.conversationOpens++; }, []);
  const openSettings = useCallback(() => { telemetry.settingsOpens++; }, []);
  useEffect(() => {
    publishSnapshot = setSnapshot; telemetry.ready = true; telemetry.snapshotPollActive = true;
    void onRefresh();
    const timer = window.setInterval(() => { telemetry.snapshotPolls++; void onRefresh(); }, 30_000);
    return () => { window.clearInterval(timer); publishSnapshot = null; telemetry.ready = false; telemetry.snapshotPollActive = false; };
  }, [onRefresh]);
  useEffect(() => { telemetry.sharedTargetRevision = snapshot.records.find(record => record.id === target.id)?.revision ?? 0; }, [snapshot]);
  useEffect(() => {
    if (!route?.entryId) return;
    telemetry.navigations.push({ tab: route.tab, entryId: route.entryId }); setView('knowledge');
  }, [route?.nonce]);
  return <main className="memory-usage-fixture" style={{ height: '100vh', display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--surface-canvas)' }}>
    <p style={{ margin: 0, padding: '12px 16px', color: 'var(--fg-secondary)', fontSize: 'var(--font-caption)', lineHeight: 1.5 }}>
      生产组件截图夹具：外层仅承载视图，IPC 数据固定；不连接真实存储、模型或 Electron 宿主。
    </p>
    <nav className="memory-tabs" role="tablist" aria-label="组件截图视图">
      <button type="button" role="tab" className={`memory-tab${view === 'processing' ? ' is-active' : ''}`} aria-selected={view === 'processing'} onClick={() => setView('processing')}>整理记录</button>
      <button type="button" role="tab" className={`memory-tab${view === 'knowledge' ? ' is-active' : ''}`} aria-selected={view === 'knowledge'} onClick={() => setView('knowledge')}>知识列表</button>
    </nav>
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {view === 'processing' ? <MemoryProcessingView workspaceId={workspaceId} snapshot={snapshot} onRefresh={onRefresh} onOpenConversation={openConversation} onOpenSettings={openSettings} /> :
        <KnowledgePanel api={api} workspaceKey={workspaceId} sharedSnapshot={snapshot} focusEntryId={route?.entryId} />}
    </div>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
(window as any).__memoryUsage = {
  telemetry, workspaceId, targetId: target.id, targetSummary: target.summary,
  setLocale: (locale: 'zh-CN' | 'en') => { applyLocaleSetting(locale); document.documentElement.lang = locale; },
  showFailure: () => setPhase('failed'), finishRetry: () => { if (phase !== 'retrying') throw new Error('No fixture retry in progress'); setPhase('settled'); },
  pushStaleKnowledgeSnapshot: () => { if (!publishSnapshot) throw new Error('Fixture is not mounted'); telemetry.staleSnapshots++; publishSnapshot(clone(initialSnapshot)); },
  dispose: () => root.unmount()
};
root.render(<Fixture />);
