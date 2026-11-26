import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..'), temp = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(temp, 'agent-app-managed-image-'));
if (path.dirname(fs.realpathSync(folder)) !== temp) throw new Error('Unexpected test directory');
try {
  const bundle = path.join(folder, 'test.cjs');
  buildSync({ stdin: { contents: "export { managedImageSource } from './src/main/agentApps/managedImageSource'; export { agentAppsHost } from './src/main/capabilities/hosts/agentApps'; export { runAsAgentWorkspace, runAsSchedulerTool } from './src/main/agent/agentScope'; export { AGENT_APP_TOOL_DEFS } from './src/main/capabilities/catalog/agentApps';", resolveDir: root }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { managedImageSource, agentAppsHost, runAsAgentWorkspace, runAsSchedulerTool, AGENT_APP_TOOL_DEFS } = createRequire(import.meta.url)(bundle);
  const attachmentDir = path.join(folder, 'attachments'); fs.mkdirSync(attachmentDir);
  const owned = path.join(attachmentDir, '123456abcdef-image.png'); fs.writeFileSync(owned, 'fixture');
  const unrelated = path.join(folder, '123456abcdef-image.png'); fs.writeFileSync(unrelated, 'other');
  const wrongName = path.join(attachmentDir, 'arbitrary.png'); fs.writeFileSync(wrongName, 'other');
  assert.equal(await managedImageSource(attachmentDir, owned), fs.realpathSync(owned));
  await assert.rejects(managedImageSource(attachmentDir, unrelated), /当前调度会话/);
  await assert.rejects(managedImageSource(attachmentDir, wrongName), /当前调度会话/);
  await assert.rejects(managedImageSource(attachmentDir, 'relative.png'), /受管附件/);
  const calls = [], service = { importManagedImage: async (...args) => { calls.push(args); return { id: 'image' }; }, imagePath: async (...args) => { calls.push(args); return { path: 'managed' }; } };
  const invoke = args => runAsAgentWorkspace('one', () => runAsSchedulerTool(() => agentAppsHost['apps.run']({ agentApps: service }, args)));
  assert.throws(() => agentAppsHost['apps.run']({ agentApps: service }, { action: 'importImage', appId: 'photos', params: { sourcePath: owned } }), /bound scheduler/);
  await invoke({ action: 'importImage', appId: 'photos', params: { sourcePath: owned } });
  await invoke({ action: 'imagePath', appId: 'photos', params: { assetId: 'image' } });
  assert.deepEqual(calls, [['one', 'photos', owned], ['one', 'photos', 'image']]);
  assert.ok(AGENT_APP_TOOL_DEFS[0].parameters.properties.action.enum.includes('importImage'));
  assert.ok(AGENT_APP_TOOL_DEFS[0].parameters.properties.action.enum.includes('imagePath'));
  console.log('agent app image tools: scheduler scope and managed attachment boundaries passed');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
