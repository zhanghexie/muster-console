/**
 * 跨通道一致性：同一 preset 下 ID 集、MCP 名、权限档一致。
 * 运行: node test/host-tool-channels.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-tool-ch-'));
const compile = createSharedCompiler(root, tmp);

const { listHostToolIds, listHostToolMetas, hostToolPermissionClass, hostToolMcpName, PTY_HOST_TOOL_ALLOWLIST } =
  await import(pathToFileURL(compile('shared/hostTools/index.ts')).href);
const { listInboundMcpToolsFromCatalog, toInboundMcpToolName } = await import(
  pathToFileURL(compile('shared/inboundMcp.ts')).href
);
const { decideToolPermission } = await import(pathToFileURL(compile('shared/guiWorkerPolicy.ts')).href);
const { HOST_TOOL_ADAPTERS } = await import(pathToFileURL(compile('main/hostTools/adapters.ts')).href);

assert.deepEqual([...HOST_TOOL_ADAPTERS], ['in-process', 'stdio-mcp', 'http+brief']);

for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
  const ids = listHostToolIds(preset);
  const mcp = listInboundMcpToolsFromCatalog(ids, (id) => ({
    description: id,
    parameters: { type: 'object', properties: {} }
  }));
  assert.equal(mcp.length, ids.length, `${preset} MCP 投影条数`);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(mcp[i].name, hostToolMcpName(ids[i]));
    assert.equal(mcp[i].name, toInboundMcpToolName(ids[i]));
  }
  const classes = new Set(ids.map((id) => hostToolPermissionClass(id)));
  assert.ok(classes.size >= 1);
}

{
  const pty = listHostToolIds('pty-allowlist');
  assert.deepEqual([...pty], [...PTY_HOST_TOOL_ALLOWLIST]);
  for (const m of listHostToolMetas('pty-allowlist')) {
    const auto = decideToolPermission({
      mode: 'auto',
      planExecuting: false,
      permissionClass: m.permissionClass,
      pathInsideRoot: true,
      mcpReadOnly: false
    });
    const viaStdio = decideToolPermission({
      mode: 'auto',
      planExecuting: false,
      permissionClass: hostToolPermissionClass(m.id),
      pathInsideRoot: true,
      mcpReadOnly: false
    });
    assert.equal(auto, viaStdio, `${m.id} 权限决策跨通道一致`);
  }
}

assert.equal(hostToolPermissionClass('sessions.setStatus'), 'status');
assert.equal(
  decideToolPermission({
    mode: 'ask',
    planExecuting: false,
    permissionClass: 'status',
    pathInsideRoot: true,
    mcpReadOnly: false
  }),
  'auto'
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] host-tool-channels');
