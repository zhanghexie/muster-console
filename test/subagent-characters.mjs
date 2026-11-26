import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-characters-'));
try {
  const compile = createSharedCompiler(root, tmp), load = rel => import(pathToFileURL(compile(rel)).href);
  const { SUBAGENT_CHARACTERS: roles, getSubagentCharacter, selectSubagentCharacter, subagentSessionName, coerceSourceAgentIdentity } = await load('shared/subagentCharacters.ts');
  const { en } = await load('shared/i18n/locales/en.ts');
  for (const role of roles) {
    assert.ok(Object.hasOwn(en, role.name), `${role.id}: name translation`);
    assert.ok(Object.hasOwn(en, role.role), `${role.id}: role translation`);
  }
  assert.equal(roles.length, 24);
  assert.equal(new Set(roles.map(c => c.id)).size, 24); assert.equal(new Set(roles.map(c => c.name)).size, 24);
  const files = fs.readdirSync(path.join(root, 'src/renderer/src/assets/subagents')).filter(f => f.endsWith('.webp'));
  assert.deepEqual(files.sort(), roles.map(c => `${c.id}.webp`).sort());
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, 'src/renderer/src/assets/subagents', file));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.equal(bytes.toString('ascii', 12, 16), 'VP8X', `${file}: extended WebP carries alpha`);
    assert.ok(bytes[20] & 0x10, `${file}: transparent symbol, no baked-in sheet background`);
    assert.equal(bytes.readUIntLE(24, 3) + 1, 256); assert.equal(bytes.readUIntLE(27, 3) + 1, 256);
  }
  for (let i = 0; i < roles.length * 2; i++) {
    assert.equal(selectSubagentCharacter('same UI task').id, roles[i % roles.length].id, 'round robin wraps regardless of task keywords');
  }
  assert.equal(selectSubagentCharacter('UI', 'quantum').id, 'quantum', 'queued/legacy choice is stable');
  assert.throws(() => selectSubagentCharacter('UI', '../image'), /未知子代理角色/);
  assert.equal(selectSubagentCharacter('UI').id, roles[0].id, 'explicit/invalid choices do not advance rotation');
  assert.equal(getSubagentCharacter('unknown'), undefined);
  assert.equal(subagentSessionName('pixel', '按钮布局'), '像素 · 按钮布局');
  assert.equal(subagentSessionName('pixel', '像素 · 按钮布局'), '像素 · 按钮布局', '排队重放不能重复加角色名');
  assert.equal(subagentSessionName('pixel', 'x'.repeat(200)).length, 80);
  const truncated = subagentSessionName('pixel', '布'.repeat(200));
  assert.equal(truncated.length, 80); assert.ok(truncated.endsWith('…'), 'F-06：截断补省略号');
  const emoji = subagentSessionName('pixel', '😀'.repeat(200));
  assert.ok(emoji.length <= 80); assert.ok(emoji.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]/.test(emoji.slice(-2, -1)), 'F-06：代理对不被劈成半个');

  const identity = { sessionId: 'child', name: '像素 · 布局', characterId: 'pixel' };
  assert.deepEqual(coerceSourceAgentIdentity({ ...identity, url: 'https://untrusted/image' }), identity);
  assert.equal(coerceSourceAgentIdentity({ ...identity, characterId: '../image' }).characterId, undefined);
  const { createGuiUserMessage, guiChatMessageEqual, migrateGuiChatMessage, sanitizeRestoredMessages } = await load('shared/guiWorker.ts');
  const message = createGuiUserMessage({ id: 'm', text: '汇报', ts: 1, source: 'agent', sourceAgent: identity, queued: true });
  assert.deepEqual(message.sourceAgent, identity);
  identity.name = '已经改名'; assert.equal(message.sourceAgent.name, '像素 · 布局', '发送时拷贝快照');
  const restored = JSON.parse(JSON.stringify(message));
  assert.equal(guiChatMessageEqual(message, restored), true);
  for (const key of ['sessionId', 'name', 'characterId']) assert.equal(guiChatMessageEqual(message, { ...restored, sourceAgent: { ...restored.sourceAgent, [key]: 'changed' } }), false, key);
  assert.deepEqual(migrateGuiChatMessage({ id: 'm', role: 'user', text: '汇报', source: 'agent', sourceAgent: restored.sourceAgent }).sourceAgent, restored.sourceAgent);
  assert.deepEqual(sanitizeRestoredMessages([restored])[0].sourceAgent, restored.sourceAgent);
  const { GuiSessionStore } = await load('main/agentSession/persist.ts');
  const diskStore = new GuiSessionStore(tmp);
  diskStore.save('role-history', [message]); diskStore.flushSync();
  assert.deepEqual(new GuiSessionStore(tmp).load('role-history')[0].sourceAgent, restored.sourceAgent, '真实历史文件重载保留身份快照');
  assert.equal(createGuiUserMessage({ id: 'user', text: '手打', ts: 1, sourceAgent: identity }).sourceAgent, undefined);
  const { cloneOrchestratorForkMessage } = await load('shared/orchestratorFork.ts');
  assert.deepEqual(cloneOrchestratorForkMessage({ id: 'm', role: 'user', content: '汇报', createdAt: 1, source: 'agent', sourceAgent: restored.sourceAgent }).sourceAgent, restored.sourceAgent);
  const { buildAgentTerminalSession } = await load('main/sessions/createTerminal.ts');
  const session = buildAgentTerminalSession({ id: 'c', now: 1, statusToken: 't', inWs: 0, runtime: 'pi', cwd: tmp, workspaceId: 'w', name: '像素 · 布局', parentSessionId: 'p', subagentCharacterId: 'pixel' });
  assert.equal(JSON.parse(JSON.stringify(session)).subagentCharacterId, 'pixel');
  const { getToolDef } = await load('main/capabilities/catalog.ts');
  assert.equal(getToolDef('sessions.create').parameters.properties.characterId, undefined, 'avatar choice is host-owned');
  console.log('subagent-characters: assets, model choices, fallback, naming and identity/history roundtrip passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
