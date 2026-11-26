import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'muster-domain-mcp-session-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-mcp-session-compile'));
const { ExtensionMcpSessionManager } = await import(pathToFileURL(compile('main/extensions/extensionMcpSession.ts')).href);
const runtimeWorkerFile = compile('main/extensions/extensionRuntimeWorker.ts');
const hostSource = fs.readFileSync(path.join(repo, 'src', 'main', 'extensions', 'extensionMcpSession.ts'), 'utf8');
assert.doesNotMatch(hostSource, /import\s*\(/, '主进程 MCP 管理器禁止动态加载扩展 descriptor');
assert.match(fs.readFileSync(path.join(repo, 'src', 'main', 'extensions', 'extensionRuntimeWorker.ts'), 'utf8'), /mode === 'mcp'/, 'MCP descriptor 必须经 owned worker 执行');

const pkg = path.join(tmp, 'bookshelf');
fs.mkdirSync(path.join(pkg, 'agent', 'mcp'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'agent', 'mcp', 'bookshelf.mjs'), `
  export default ({ descriptorPath }) => ({
    name: 'books',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    cwd: '.',
  });
`);

const identity = {
  extensionId: 'bookshelf', extensionInstanceId: 'ws:bookshelf:main', workspaceId: 'ws',
  sourceRootId: 'root', packageFingerprint: 'package-extension:test', surfaceId: 'main'
};
const manifest = {
  id: 'bookshelf', name: '书架', scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain/runtime.mjs', queries: [], commands: [], events: [] },
  agent: { profile: 'scheduler-pi', skills: [], mcp: ['agent/mcp/bookshelf.mjs'] },
  data: { workspace: true, shared: false }, permissions: ['agent.state', 'agent.mcp']
};
const resources = {
  sessionId: 'agent-1', extensionId: 'bookshelf', extensionInstanceId: identity.extensionInstanceId,
  packageFingerprint: identity.packageFingerprint, systemPrompt: undefined, skills: [],
  mcp: [{ relativePath: 'agent/mcp/bookshelf.mjs', absolutePath: path.join(pkg, 'agent', 'mcp', 'bookshelf.mjs') }],
  trust: 'trusted-once'
};

let seenConfig;
let closed = 0;
const manager = new ExtensionMcpSessionManager({
  runtimeWorkerFile,
  createHub(config) {
    seenConfig = config;
    return {
      async listAllTools() {
        return [
          { server: 'books', name: 'list_books', description: '列出书籍', inputSchema: { type: 'object', properties: {} } },
          { server: 'books', name: 'reorder_books', description: '重新整理书架', inputSchema: { type: 'object', required: ['order'], properties: { order: { type: 'array' } } } }
        ];
      },
      async callToolResult(server, tool, args, beforeCall) {
        beforeCall?.();
        return { isError: false, text: JSON.stringify({ server, tool, args }) };
      },
      async close() { closed++; }
    };
  }
});

const untrusted = { ...resources, sessionId: 'agent-untrusted', trust: 'untrusted' };
await assert.rejects(() => manager.open({ sessionId: 'agent-untrusted', identity, manifest, packageRoot: pkg, resources: untrusted }), /显式信任/);
const noPermission = { ...manifest, permissions: ['agent.state'] };
await assert.rejects(() => manager.open({ sessionId: 'agent-no-permission', identity, manifest: noPermission, packageRoot: pkg, resources: { ...resources, sessionId: 'agent-no-permission' } }), /agent\.mcp/);
const noMcpManifest = { ...manifest, agent: { ...manifest.agent, mcp: [] }, permissions: ['agent.state'] };
assert.deepEqual(await manager.open({ sessionId: 'agent-no-mcp', identity, manifest: noMcpManifest, packageRoot: pkg, resources: { ...resources, sessionId: 'agent-no-mcp', mcp: [], trust: 'untrusted' } }), []);

const tools = await manager.open({ sessionId: resources.sessionId, identity, manifest, packageRoot: pkg, resources });
assert.deepEqual(tools.map(tool => tool.id), [
  'ext.bookshelf.mcp.books.list_books',
  'ext.bookshelf.mcp.books.reorder_books'
]);
assert.equal(seenConfig.enabled, true);
assert.equal(seenConfig.servers[0].cwd, pkg);
assert.equal(seenConfig.servers[0].name, 'books');
assert.deepEqual(tools[0].parameters, { type: 'object', properties: {} });
assert.equal(tools[0].permissionClass, 'mcp');
assert.match(await tools[0].execute({}, { sessionId: resources.sessionId, cwd: pkg }), /list_books/);
await assert.rejects(() => tools[0].execute({}, { sessionId: 'other', cwd: pkg }), /identity mismatch/);

await manager.close(resources.sessionId);
assert.equal(closed, 1);
assert.deepEqual(manager.toolsForSession(resources.sessionId), []);
await manager.closeAll();

let failedHubClosed = 0;
const failedManager = new ExtensionMcpSessionManager({
  runtimeWorkerFile,
  createHub() {
    return {
      async listAllTools() { throw new Error('connect failed'); },
      async callToolResult() { throw new Error('unreachable'); },
      async close() { failedHubClosed++; }
    };
  }
});
await assert.rejects(() => failedManager.open({ sessionId: 'agent-failed', identity, manifest, packageRoot: pkg, resources: { ...resources, sessionId: 'agent-failed' } }), /connect failed/);
assert.equal(failedHubClosed, 1);
console.log('extensions-mcp-session: ok');



