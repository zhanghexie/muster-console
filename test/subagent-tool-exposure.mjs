import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-exposure-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const compile = createSharedCompiler(process.cwd(), tmp);
const load = p => import(pathToFileURL(compile(p)).href);
const { HOST_COMMUNICATION_TOOL_IDS, hostToolBinding, hostToolPermissionClass, listHostToolIds } = await load('shared/hostTools/meta.ts');
const { getToolDef, isWorkerAllowedTool } = await load('main/capabilities/catalog.ts');
const { inboundMcpToolDefs } = await load('main/inboundMcp/toolList.ts');
const { workerPresetProjectedCatalog } = await load('main/capabilities/catalog/projectedCatalog.ts');

test('所有 Worker 预设常驻协作和自有合入请求，不获得调度权限', () => {
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    // R4：投影 = 常驻终态清单 ∩ preset（PTY/ACP 的缺席项由 preset 求交剔除）。
    // 名字用 MCP 下划线形态比对（node_repl.js 的下划线不是点号分隔符，不可逆回转）。
    const ids = inboundMcpToolDefs(preset).map(t => t.name);
    assert.deepEqual(new Set(ids), new Set(workerPresetProjectedCatalog(preset, preset === 'pty-allowlist').map(entry => entry.name.replace(/\./g, '_'))), preset);
    assert.ok(ids.includes('host_sessions_requestIntegrate'));
    for (const name of ['host_sessions_review', 'host_sessions_integrate', 'host_terminal_write', 'host_terminal_capture', 'askQuestion']) assert.ok(!ids.includes(name), 'no privilege expansion or duplicate native question tool: ' + name);
  }
});

test('派子代理与汇报都使用统一入口，可信身份由宿主绑定', () => {
  for (const id of ['sessions.create', 'sessions.message', 'sessions.readMessages']) {
    assert.ok(HOST_COMMUNICATION_TOOL_IDS.includes(id));
    assert.equal(hostToolBinding(id), 'actor');
    assert.ok(isWorkerAllowedTool(id));
    assert.equal('__actorSessionId' in getToolDef(id).parameters.properties, false);
  }
  assert.equal(getToolDef('sessions.message').parameters.properties.to.type, 'string');
  assert.equal(getToolDef('sessions.create').parameters.properties.asSubagent.type, 'boolean');
});

test('旧任务与专用汇报入口实际退出目录和 Worker 白名单', () => {
  for (const id of ['tasks.delegate', 'tasks.list', 'tasks.update', 'sessions.askScheduler', 'sessions.reportParent', 'sessions.reply']) {
    assert.equal(getToolDef(id), undefined);
    assert.equal(isWorkerAllowedTool(id), false);
    assert.equal(hostToolBinding(id), undefined);
  }
});

test('各预设无重复 ID，能力权限仍有明确分类', () => {
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    const ids = listHostToolIds(preset);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(['read', 'edit', 'shell', 'status', 'mcp', 'dynamic', 'browser'].includes(hostToolPermissionClass(id)), id);
  }
});
