/**
 * 双表面等价性护栏（ChatSurface 合同，docs/plans/implemented/chat-surface-plan.md）：
 * 静态断言两壳只经统一视图消费会话、协议只存在于适配器层、旧双态 prop 不回潮。
 * 行为等价由两适配器共享 deltaBatcher/ChatTranscript/ChatSurfaceView 单源保证。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let failed = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failed += 1;
  console.error(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
};

// ── ① 壳不得直连会话流协议（会话动作/流事件只准出现在适配器与人机交互卡）──
// chat.sessionsList/sessionOpen/sessionRename/sessionDelete 是历史抽屉的会话文件管理
// （面板级功能，非会话流合同），明确放行；其余 chat.*/agentSession.* 一律拦截。
const PROTOCOL_RE = /window\.api\.(?:chat|agentSession)\.(?!sessionsList|sessionOpen|sessionRename|sessionDelete)\S*/;
const PROTOCOL_ALLOWED = new Set([
  'src/renderer/src/chatSurface/orchestratorSurface.tsx',
  'src/renderer/src/chatSurface/agentSessionSurface.tsx',
  'src/renderer/src/chatSurface/guiApprovalCards.tsx', // 审批/提问卡直连应答 IPC（协议适配层）
  'src/renderer/src/chatSurface/guiMessageView.tsx' // 仅类型/映射，无 IPC；留白便于核对
]);
for (const shell of [
  'src/renderer/src/panels/AgentFloat.tsx',
  'src/renderer/src/panels/SchedulerOverview.tsx',
  'src/renderer/src/panels/SchedulerConversation.tsx',
  'src/renderer/src/agentChat/AgentChatView.tsx',
  'src/renderer/src/mobile/pages/ChatPage.tsx',
  'src/renderer/src/chatSurface/ChatSurfaceView.tsx',
  'src/renderer/src/chatSurface/ChatTranscript.tsx',
  'src/renderer/src/components/AgentComposer.tsx',
  'src/renderer/src/store.tsx'
]) {
  const src = read(shell);
  const hits = src
    .split('\n')
    .map((l, i) => (PROTOCOL_RE.test(l) ? `${i + 1}` : null))
    .filter(Boolean);
  if (hits.length === 0) ok(`${shell} 无直连会话协议`);
  else bad(`${shell} 直连了会话协议`, `行 ${hits.join(',')}（只准适配器/交互卡触碰）`);
}

// guiMessageView 若出现 IPC 调用即失败（上面白名单只是类型层豁免位）
{
  const src = read('src/renderer/src/chatSurface/guiMessageView.tsx');
  if (!PROTOCOL_RE.test(src)) ok('guiMessageView 纯映射（无 IPC）');
  else bad('guiMessageView 出现 IPC 调用', '审批/提问卡内容请经 guiApprovalCards');
}

// ── ② 壳必须经 ChatSurfaceView 渲染会话（手机壳同守：差异只许出现在壳层）──
for (const [shell, adapter] of [
  ['src/renderer/src/panels/AgentFloat.tsx', 'useOrchestratorSurface'],
  ['src/renderer/src/panels/SchedulerOverview.tsx', 'getOrchestratorSurface']
]) {
  const source = read(shell);
  if (source.includes(adapter) && source.includes('<SchedulerConversation')) {
    ok(`${shell} 复用调度会话视图`);
  } else {
    bad(`${shell} 未接入调度会话视图`);
  }
}
for (const [shell, marker] of [
  ['src/renderer/src/panels/SchedulerConversation.tsx', 'surface={surface}'],
  ['src/renderer/src/agentChat/AgentChatView.tsx', 'useAgentSessionSurface'],
  ['src/renderer/src/mobile/pages/ChatPage.tsx', 'useOrchestratorSurface'],
  ['src/renderer/src/mobile/pages/ChatPage.tsx', 'useAgentSessionSurface']
]) {
  const src = read(shell);
  if (/import\s*\{[^}]*ChatSurfaceView/.test(src) && src.includes(marker)) {
    ok(`${shell} 走统一视图（${marker}）`);
  } else {
    bad(`${shell} 未接入 ChatSurfaceView`);
  }
}

// ── ③ Composer 旧双态 prop 不回潮；新 prop 必备 ──
{
  const src = read('src/renderer/src/components/AgentComposer.tsx');
  if (/statusOverride/.test(src)) bad('AgentComposer 仍含 statusOverride（双态回潮）');
  else ok('AgentComposer 无 statusOverride');
  for (const prop of ['surfaceKind', 'chatStatus']) {
    if (src.includes(prop)) ok(`AgentComposer 具备 ${prop}`);
    else bad(`AgentComposer 缺 ${prop}`);
  }
}

// ── ④ 合同必选成员两个适配器都实现（协议演进漏一边 = 这里红）──
const REQUIRED_ACTIONS = [
  'send',
  'stop',
  'clear',
  'retry',
  'recallAborted',
  'cancelQueued',
  'fork'
];
const REQUIRED_CAPS = ['surfaceKind', 'draftKey'];
for (const adapter of [
  'src/renderer/src/chatSurface/orchestratorSurface.tsx',
  'src/renderer/src/chatSurface/agentSessionSurface.tsx'
]) {
  const src = read(adapter);
  for (const member of [...REQUIRED_ACTIONS, ...REQUIRED_CAPS]) {
    if (src.includes(member)) ok(`${adapter.split('/').pop()} 含 ${member}`);
    else bad(`${adapter.split('/').pop()} 缺合同成员 ${member}`);
  }
}

{
  const orch = read('src/renderer/src/chatSurface/orchestratorSurface.tsx');
  if (/fork:\s*true/.test(orch) && !/fork:\s*false/.test(orch)) {
    ok('orchestratorSurface caps.fork 开启');
  } else {
    bad('orchestratorSurface caps.fork 未开启', '调度面板应与中栏同款 fork');
  }
  if (/notes:\s*true/.test(orch) && !/notes:\s*false/.test(orch)) {
    ok('orchestratorSurface caps.notes 开启');
  } else {
    bad('orchestratorSurface caps.notes 未开启', '调度面板应接会话批注');
  }
  if (/setThinking:/.test(orch) && /thinking:/.test(orch)) {
    ok('orchestratorSurface 接线 thinking');
  } else {
    bad('orchestratorSurface 未接线 thinking', '调度面板应推 status.thinking 并接 actions.setThinking');
  }
  const float = read('src/renderer/src/panels/AgentFloat.tsx');
  if (float.includes('useSessionNotes') && float.includes('notesHost')) {
    ok('AgentFloat 注入 notesHost');
  } else {
    bad('AgentFloat 未注入 notesHost', '调度壳须经 useSessionNotes 挂批注宿主');
  }
  const view = read('src/renderer/src/chatSurface/ChatSurfaceView.tsx');
  if (view.includes('forkProps') && (view.match(/\{\.\.\.forkProps\}/g) || []).length >= 2) {
    ok('ChatSurfaceView 调度/GUI 转写都接 onFork');
  } else {
    bad('ChatSurfaceView 未把 onFork 接到双转写');
  }
  if ((view.match(/\{\.\.\.noteTranscriptProps\}/g) || []).length >= 2) {
    ok('ChatSurfaceView 调度/GUI 转写都接 notesHost');
  } else {
    bad('ChatSurfaceView 未把 notesHost 接到双转写');
  }
}

// ── ⑤ 会话级能力单一归属：旧容器已删、时间分隔/贴底逻辑无第二份 ──
if (!existsSync(join(root, 'src/renderer/src/agentChat/AgentTranscript.tsx'))) {
  ok('旧 AgentTranscript.tsx 已删（容器唯一）');
} else {
  bad('AgentTranscript.tsx 仍存在', '会话容器必须唯一（chatSurface/ChatTranscript.tsx）');
}
{
  const hits = [];
  for (const f of [
    'src/renderer/src/panels/AgentFloat.tsx',
    'src/renderer/src/agentChat/AgentChatView.tsx',
    'src/renderer/src/mobile/pages/ChatPage.tsx'
  ]) {
    const src = read(f);
    if (src.includes('chat-time-sep')) hits.push(`${f}:时间分隔`);
    if (src.includes('stickBottom')) hits.push(`${f}:贴底`);
    if (/shouldShowTimeSeparator/.test(src)) hits.push(`${f}:时间分隔函数`);
  }
  if (hits.length === 0) ok('壳内无自建时间分隔/贴底逻辑');
  else bad('壳内残留会话级逻辑副本', hits.join('、'));
}

// ── ⑥ store 不再承载调度聊天流（事件订阅已归适配器）──
{
  const src = read('src/renderer/src/store.tsx');
  const leftover = ["'agent:history'", "'agent:message'", "'agent:token'", "'agent:done'"].filter(
    (ev) => src.includes(ev)
  );
  if (leftover.length === 0) ok('store 无 agent:* 流订阅');
  else bad('store 残留流订阅', leftover.join('、'));
}

if (failed > 0) {
  console.error(`surface-parity: ${failed} 项不符`);
  process.exit(1);
}
console.log('surface-parity: 双表面护栏全部通过');
