import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-agent-resources-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-agent-resources-compile'));
const { ExtensionAgentResourceManager, formatExtensionAgentResourcePrompt } = await import(pathToFileURL(compile('main/extensions/extensionAgentResources.ts')).href);
const pkg = path.join(tmp, 'bookshelf');
fs.mkdirSync(path.join(pkg, 'agent', 'skills'), { recursive: true });
fs.mkdirSync(path.join(pkg, 'agent', 'mcp'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'system.md'), '整理书架时优先保持用户顺序。');
fs.writeFileSync(path.join(pkg, 'agent', 'skills', 'bookshelf.md'), '# bookshelf');
fs.writeFileSync(path.join(pkg, 'agent', 'mcp', 'bookshelf.mjs'), 'export default {};');

const manifest = {
  id: 'bookshelf',
  name: '书架',
  scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain/runtime.mjs', queries: [], commands: [], events: [] },
  agent: { profile: 'scheduler-pi', systemPrompt: 'system.md', skills: ['agent/skills/bookshelf.md'], mcp: ['agent/mcp/bookshelf.mjs'] },
  data: { workspace: true, shared: false },
  permissions: ['agent.state', 'agent.mcp']
};

const manager = new ExtensionAgentResourceManager();
await assert.rejects(() => manager.mount({ packageRoot: pkg, manifest, sessionId: 's1', extensionInstanceId: 'i1', packageFingerprint: 'package-extension:x', mcpTrust: 'untrusted' }), /显式信任/);
const mount = await manager.mount({ packageRoot: pkg, manifest, sessionId: 's1', extensionInstanceId: 'i1', packageFingerprint: 'package-extension:x', mcpTrust: 'trusted-once' });
assert.equal(mount.skills.length, 1);
assert.equal(mount.mcp.length, 1);
assert.match(formatExtensionAgentResourcePrompt(mount), /整理书架/);
assert.match(formatExtensionAgentResourcePrompt(mount), /不会因人的操作自动发送/);
assert.equal(await manager.readSkill('s1', 'agent/skills/bookshelf.md'), '# bookshelf');
await assert.rejects(() => manager.readSkill('s1', 'agent/skills/missing.md'), /not declared/);
assert.equal(manager.get('s1'), mount);
await assert.rejects(() => manager.mount({ packageRoot: pkg, manifest, sessionId: 's1', extensionInstanceId: 'i2', packageFingerprint: 'package-extension:y', mcpTrust: 'trusted-once' }), /已绑定其他包/);
manager.release('s1');
assert.equal(manager.get('s1'), undefined);

const outside = path.join(tmp, 'outside.md');
fs.writeFileSync(outside, 'outside');
const escaped = { ...manifest, agent: { ...manifest.agent, systemPrompt: '../outside.md', mcp: [] }, permissions: ['agent.state'] };
await assert.rejects(() => manager.mount({ packageRoot: pkg, manifest: escaped, sessionId: 's2', extensionInstanceId: 'i2', packageFingerprint: 'package-extension:z' }), /越过包根/);
console.log('extensions-agent-resources: ok');


