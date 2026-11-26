/**
 * T2.3：GUI 宿主工具注册面 ↔ 系统提示目录一致性。
 * 仿 gui-worker-prompt.mjs：政策层目录必须列引擎实际能调到的名字，
 * 且与 tools/registry.ts 组装的 hostTools 集合同源（按角色常驻 + 当前预设的按需目录）。
 * 运行: node test/gui-host-mcp-catalog.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-mcp-'));
const compile = createSharedCompiler(root, tmp);

const { buildGuiWorkerSystemPrompt } = await import(
  pathToFileURL(compile('shared/guiWorkerPrompt.ts')).href
);
const { CHAT_RUNTIME_CAPABILITIES } = await import(
  pathToFileURL(compile('shared/agentRuntimeCapabilities.ts')).href
);

const {
  HOST_STATUS_TOOL_IDS,
  HOST_COMMUNICATION_TOOL_IDS,
  HOST_OBSERVE_TOOL_IDS,
  HOST_SHARE_TOOL_IDS,
  BG_TOOL_IDS,
  listHostToolIds
} = await import(pathToFileURL(compile('shared/hostTools/index.ts')).href);

const {residentHostToolIds}=await import(pathToFileURL(compile('shared/toolDiscovery.ts')).href);
const {filterResidentHostTools}=await import(pathToFileURL(compile('main/agentSession/tools/discovery.ts')).href);
function expectedHostIds(runtimeId) {
 const caps=CHAT_RUNTIME_CAPABILITIES[runtimeId];
 const preset=['codex-agent','acp-agent'].includes(caps.transport)?'acp-subset':'gui-full';
 const privateIds=listHostToolIds(preset).filter(id=>!id.startsWith('bgtasks.')||(caps.bgtasks&&(caps.bgtasksSpawn||id!=='bgtasks.spawn')));
 const exposed=filterResidentHostTools(privateIds.map(id=>({id,label:id,description:id,permissionClass:'read',parameters:{type:'object',properties:{}},execute:async()=>id})));
 // R5：常驻终态清单 × preset 求交（发现层 2 项已退役）
 const resident=new Set(residentHostToolIds('worker'));
 assert.deepEqual(exposed.map(x=>x.id).sort(),[...new Set(privateIds.filter(id=>resident.has(id)))].sort(),'Worker 常驻面 = 终态清单 ∩ preset');
 return exposed.map(x=>x.id);
}

{
  assert.equal(CHAT_RUNTIME_CAPABILITIES.claude.bgtasks, true, 'claude 注册 bgtasks');
  assert.equal(Boolean(CHAT_RUNTIME_CAPABILITIES.claude.bgtasksSpawn), false, 'claude 不开 spawn');
  assert.equal(CHAT_RUNTIME_CAPABILITIES.acp.bgtasks, true, 'acp 注册 bgtasks');
  assert.equal(Boolean(CHAT_RUNTIME_CAPABILITIES.acp.bgtasksSpawn), false, 'acp 不开 spawn');
  assert.equal(CHAT_RUNTIME_CAPABILITIES.acp.transport, 'acp-agent');
  assert.equal(CHAT_RUNTIME_CAPABILITIES.pi.modeSwitchReconnects, false);
  assert.equal(CHAT_RUNTIME_CAPABILITIES.claude.modeSwitchReconnects, false);
  assert.equal(CHAT_RUNTIME_CAPABILITIES['codex-gui'].modeSwitchReconnects, false);
  assert.equal(CHAT_RUNTIME_CAPABILITIES.acp.modeSwitchReconnects, true);
  assert.equal(CHAT_RUNTIME_CAPABILITIES.pi.modelOverridePolicy, 'reconnect');
  assert.equal(CHAT_RUNTIME_CAPABILITIES.claude.modelOverridePolicy, 'reconnect');
  assert.equal(CHAT_RUNTIME_CAPABILITIES['codex-gui'].modelOverridePolicy, 'reconnect');
  assert.equal(CHAT_RUNTIME_CAPABILITIES.acp.modelOverridePolicy, 'reconnect');
  assert.equal(CHAT_RUNTIME_CAPABILITIES.pi.thinkingPolicy, 'hot');
}

{
  // driver 源码能力位须与能力表同值（Host 读 driver，渲染/工具面读表）
  const flags = [
    ['pi', 'false'],
    ['claude', 'false'],
    ['codex', undefined],
    ['acp', undefined]
  ];
  for (const [dir, want] of flags) {
    const src = fs.readFileSync(
      path.join(root, 'src/main/agentSession/drivers', dir, 'driver.ts'),
      'utf8'
    );
    const m = src.match(/readonly modeSwitchReconnects\s*=\s*(true|false)/);
    assert.equal(m?.[1], want, `${dir} Core 权限切换标志`);
    assert.match(src, /readonly modelOverridePolicy/);
    assert.match(src, /readonly thinkingPolicy/);
  }
}

{
  const src = fs.readFileSync(path.join(root, 'src/main/agentSession/tools/registry.ts'), 'utf8');
  for (const token of [
    'buildCatalogHostTools',
    'buildBgTaskTools',
    'caps.bgtasks',
    'hostTools.map'
  ]) {
    assert.ok(src.includes(token), `registry.ts 须含 ${token}`);
  }
}

const STATUS_QUARTET = [
  'sessions.setStatus',
  'sessions.rename',
  'sessions.requestIntegrate',
  'sessions.isolate',
  'ui.notify',
  'ui.reminders',
  'ui.suggestReplies'
];
assert.deepEqual(HOST_STATUS_TOOL_IDS, STATUS_QUARTET, '状态、提醒与建议回复工具契约');

{
  const pty = listHostToolIds('pty-allowlist');
  const gui = listHostToolIds('gui-full');
  const acp = listHostToolIds('acp-subset');
  assert.equal(pty.includes('bgtasks.shell'), false, 'pty 不含 bgtasks');
  assert.ok(!gui.includes('bgtasks.spawn'),'不再通过后台命令派生会话');
  assert.equal(acp.includes('bgtasks.spawn'), false, 'acp-subset 不含 spawn');
  assert.ok(acp.includes('bgtasks.shell'), 'acp-subset 含 shell');
  // B1 MCP 中转两工具：三 preset 全员（未配置 server 时 search 空清单不报错）
  for (const id of ['mcp.search', 'mcp.call']) {
    assert.ok(pty.includes(id), `pty-allowlist 含 ${id}`);
    assert.ok(gui.includes(id), `gui-full 含 ${id}`);
    assert.ok(acp.includes(id), `acp-subset 含 ${id}`);
  }
  // R2 browser 域 run 化：三 preset 只投影 browser.run，25 个直调名从 Worker 面退役
  for (const id of [...HOST_STATUS_TOOL_IDS, ...HOST_COMMUNICATION_TOOL_IDS, ...HOST_OBSERVE_TOOL_IDS, ...HOST_SHARE_TOOL_IDS]) {
    if (/^(panel|desktop)\.(?!run$)/.test(id)) {
      assert.ok(!pty.includes(id) && !gui.includes(id) && !acp.includes(id), `${id} is internal after domain projection`);
    } else if (id === 'turnChanges.trackFiles') {
      assert.ok(!pty.includes(id) && gui.includes(id) && acp.includes(id), '轮次文件登记仅供 GUI/ACP');
    } else {
      assert.ok(pty.includes(id), `pty-allowlist 含 ${id}`);
    }
  }
  for (const ids of [pty, gui, acp]) {
    assert.ok(ids.includes('browser.run'), 'browser.run 全 preset 投影');
    assert.ok(ids.includes('panel.run') && ids.includes('desktop.run'), 'panel and desktop run entries are exposed');
    assert.ok(!ids.some((id) => /^browser\.(?!run$)/.test(id)), 'browser 直调名退出全部 preset');
  }
}

const claudeIds = expectedHostIds('claude');
assert.ok(claudeIds.includes('sessions.setStatus'));
// B1：GUI Worker 常驻面含 MCP 中转两工具（与 residentHostToolIds('worker') 同步）
assert.ok(claudeIds.includes('mcp.search') && claudeIds.includes('mcp.call'), '中转两工具进 GUI 常驻目录');
// R4：后台任务四件套进 GUI 常驻目录（caps.bgtasks=true；PTY preset 差分剔除）
for (const id of ['bgtasks.shell', 'bgtasks.wait', 'bgtasks.list', 'bgtasks.kill']) {
  assert.ok(listHostToolIds('acp-subset').includes(id), `私有目录含 ${id}`);
  assert.ok(claudeIds.includes(id), `R4 后台工具常驻 ${id}`);
}
// R4：记忆/智能界面/持久执行进 GUI 常驻目录
for (const id of ['memory.search','memory.list','memory.note','memory.remember','ui.render','ui.inspect','node_repl.js','share.set']) {
  assert.ok(claudeIds.includes(id), `R4 GUI 常驻 ${id}`);
}
assert.ok(!claudeIds.includes('bgtasks.spawn'), 'claude 面不含 spawn');

{
  const p = buildGuiWorkerSystemPrompt({
    cwd: 'E:\\ws\\proj',
    mode: 'default',
    tools: claudeIds.map(id => ({ id: 'host.' + id, description: 'DESC_SENTINEL' })),
    hostToolNamePrefix: 'mcp__muster__'
  });
  assert.doesNotMatch(p, /curl|MUSTER_STATUS_URL|DESC_SENTINEL|Registered Tools/);
  for (const id of ['sessions_setStatus', 'mcp_search', 'mcp_call', 'ui_render']) {
    assert.ok(p.includes('mcp__muster__host_' + id), 'uses registered engine name for ' + id);
  }
}

{
  const acpIds = expectedHostIds('acp');
  // ACP 与其他 GUI 共享宿主记忆，智能界面和 node_repl 仍由 preset 区分。
  for (const id of ['bgtasks.shell', 'browser.run', 'mcp.search', 'sessions.setArchived', 'ui.notify']) {
    assert.ok(acpIds.includes(id), `ACP 常驻 ${id}`);
  }
  for (const id of ['memory.search', 'memory.list', 'memory.get', 'memory.note', 'memory.journal', 'memory.journalGet',
    'memory.remember', 'memory.confirm', 'memory.correct', 'memory.correctionStatus']) {
    assert.ok(acpIds.includes(id), 'ACP projects ' + id);
  }
  const prompt = buildGuiWorkerSystemPrompt({
    tools: acpIds.map(id => ({ id: 'host.' + id })), hostToolNamePrefix: 'mcp__muster__'
  });
  assert.match(prompt, /mcp__muster__host_memory_search/);
  assert.match(prompt, /mcp__muster__host_memory_journal/);
  assert.match(prompt, /mcp__muster__host_memory_remember/);
  for (const id of ['ui.render', 'ui.inspect', 'node_repl.js']) {
    assert.ok(!acpIds.includes(id), `ACP preset 剔除 ${id}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] gui-host-mcp-catalog');
