/**
 * 宿主工具 spec 投影：preset → ID 集；pty 白名单与 catalog 投影一致。
 * 运行: node test/host-tool-spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-tool-spec-'));
const compile = createSharedCompiler(root, tmp);

const {
  listHostToolIds,
  hostToolMcpName,
  hostToolPermissionClass,
  PTY_HOST_TOOL_ALLOWLIST,
  HOST_TOOL_METAS
} = await import(pathToFileURL(compile('shared/hostTools/index.ts')).href);

const { toInboundMcpToolName, listInboundMcpToolsFromCatalog } = await import(
  pathToFileURL(compile('shared/inboundMcp.ts')).href
);

assert.equal(hostToolMcpName('sessions.setStatus'), 'sessions_setStatus');
assert.equal(toInboundMcpToolName('sessions.setStatus'), hostToolMcpName('sessions.setStatus'));
assert.equal(hostToolPermissionClass('sessions.observe'), 'read');
assert.equal(hostToolPermissionClass('events.subscribe'), 'status');
assert.equal(hostToolPermissionClass('events.unsubscribe'), 'status');
assert.equal(hostToolPermissionClass('browser.click'), 'browser');
assert.equal(hostToolPermissionClass('bgtasks.shell'), 'shell');

const pty = listHostToolIds('pty-allowlist');
assert.deepEqual([...pty], [...PTY_HOST_TOOL_ALLOWLIST]);
assert.equal(pty.some((id) => id.startsWith('bgtasks.')), false);

const listed = listInboundMcpToolsFromCatalog(pty, (id) => ({
  description: id,
  parameters: { type: 'object', properties: {} }
}));
assert.equal(listed.length, pty.length);
assert.equal(listed[0].name, hostToolMcpName(pty[0]));

const gui = new Set(listHostToolIds('gui-full'));
const acp = new Set(listHostToolIds('acp-subset'));
assert.equal(gui.has('bgtasks.spawn'), false, '子代理统一用 sessions.create，不保留专用 spawn 入口');
for (const ids of [gui, acp, new Set(pty)]) {
  for (const id of ['sessions.create', 'sessions.observe', 'sessions.message', 'sessions.readMessages'])
    assert.ok(ids.has(id), `${id} 在全部 harness 工具面可用`);
}
assert.ok(gui.has('sessions.observe'));
assert.ok(gui.has('sessions.observe'));
assert.ok(gui.has('sessions.search'));
assert.ok(gui.has('llm.quota'));
assert.ok(gui.has('sessions.observe'));
assert.ok(gui.has('events.subscribe'));
assert.ok(gui.has('events.unsubscribe'));
assert.ok(gui.has('events.register'));
assert.ok(gui.has('events.emit'));
assert.equal(gui.has('events.review'), false, 'events.review 仅调度，不进 Worker 工具面');
assert.ok(gui.has('sessions.observe'));
assert.ok(gui.has('share.set'));
assert.ok(pty.includes('sessions.observe'));
assert.ok(pty.includes('sessions.search'));
assert.ok(pty.includes('sessions.observe'));
assert.ok(pty.includes('events.subscribe'));
assert.ok(pty.includes('events.register'));
assert.ok(pty.includes('events.emit'));
assert.equal(pty.includes('events.review'), false);
assert.ok(pty.includes('share.set'));
assert.equal(acp.has('bgtasks.spawn'), false);
for (const id of acp) assert.ok(gui.has(id), `acp-subset ⊆ gui-full: ${id}`);
for (const id of pty) assert.ok(gui.has(id), `pty-allowlist ⊆ gui-full: ${id}`);

assert.ok(HOST_TOOL_METAS.every((m) => m.mcpName === m.id.replace(/\./g, '_')));

assert.equal(HOST_TOOL_METAS.some(m => m.id === 'bgtasks.spawn'), false, '元数据也不保留已移除的子代理后门');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] host-tool-spec');
