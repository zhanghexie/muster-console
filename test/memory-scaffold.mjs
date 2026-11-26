/**
 * scaffold 收编测试（memory-system-plan A2）：
 * 1. ensureMetaAgentScaffold 清理旧记忆托管块，保留项目指令；
 * 2. 不创建、改写或备份旧 journal 技能，重复打开也不恢复删除的技能；
 * 3. 幂等零 diff：二次 ensure 内容不变，用户自写内容不被覆盖；
 * 运行: node test/memory-scaffold.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scaffold-'));
const compile = createSharedCompiler(root, tmp);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const scaffold = await import(pathToFileURL(compile('main/metaAgent/scaffold.ts')));

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-ws-'));

// Fresh workspace startup does not create harness documents or project skill links.
scaffold.ensureMetaAgentScaffold(ws);
for (const name of ['AGENTS.md', 'CLAUDE.md']) {
  assert.equal(fs.existsSync(path.join(ws, name)), false);
}
assert.equal(fs.existsSync(path.join(ws, '.agents', 'skills', 'memory')), false, 'scaffold does not seed a project memory link');

const skillPath = path.join(ws, '.agents', 'skills', 'journal', 'SKILL.md');
assert.equal(fs.existsSync(skillPath),false,'new workspace does not install the retired journal skill');

// Opening a workspace must not convert a legacy managed journal skill to a
// memory pointer, create a backup, or recreate the skill after deletion.
const wsLegacy = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-legacy-journal-'));
const legacyDir = path.join(wsLegacy, '.agents', 'skills', 'journal');
const legacySkillPath = path.join(legacyDir, 'SKILL.md');
const legacyBackupPath = path.join(legacyDir, 'SKILL.pre-memory.md');
const oldSkill = 'x-muster-skill: journal\nold journal instructions';
fs.mkdirSync(legacyDir, { recursive: true });
fs.writeFileSync(legacySkillPath, oldSkill);
// Retire both marker namespaces, keeping BOM, CRLF and user instructions byte-for-byte.
const userPrefix = '\uFEFF# Project instructions\r\n\r\n';
const userSuffix = '\r\nProject-specific instructions.\r\n';
const oldMemory = '<!-- metaagent-memory:begin -->\r\nRead .agents/skills/memory/SKILL.md\r\n<!-- metaagent-memory:end -->\r\n';
const oldHost = '<!-- muster:begin -->\nHost instructions\n<!-- muster:end -->\n';
const renamedMemory = '<!-- muster-memory:begin -->\nMemory instructions\n<!-- muster-memory:end -->\n';
const preserved = path.join(wsLegacy, 'AGENTS.md');
const generated = path.join(wsLegacy, 'CLAUDE.md');
const alias = path.join(wsLegacy, 'agent.md');
const malformed = '<!-- metaagent:begin -->\nUser text after an incomplete marker.\n';
const outsideDoc = path.join(tmp, 'external-instructions.md');
fs.writeFileSync(preserved, userPrefix + oldMemory + userSuffix);
fs.writeFileSync(generated, oldHost + '\n' + renamedMemory);
fs.writeFileSync(alias, malformed);
fs.writeFileSync(outsideDoc, oldHost);
const sharedFile = path.join(wsLegacy, 'AGENTs.MD');
if (process.platform !== 'win32' && !fs.existsSync(sharedFile)) fs.linkSync(outsideDoc, sharedFile);
scaffold.ensureMetaAgentScaffold(wsLegacy);
assert.equal(fs.readFileSync(preserved, 'utf8'), userPrefix + userSuffix);
assert.equal(fs.existsSync(generated), false, 'remove obsolete generated-only files');
assert.equal(fs.readFileSync(alias, 'utf8'), malformed, 'preserve incomplete blocks');
assert.equal(fs.readFileSync(outsideDoc, 'utf8'), oldHost, 'hard-linked files are excluded');
assert.equal(fs.readFileSync(legacySkillPath, 'utf8'), oldSkill, 'opening does not convert a legacy skill');
assert.equal(fs.existsSync(legacyBackupPath), false, 'opening does not create a compatibility backup');
fs.unlinkSync(legacySkillPath);
scaffold.ensureMetaAgentScaffold(wsLegacy);
assert.equal(fs.existsSync(legacySkillPath), false, 'same-process reopen does not recreate a deleted skill');
const restartedScaffold = await import(`${pathToFileURL(compile('main/metaAgent/scaffold.ts'))}?restart`);
restartedScaffold.ensureMetaAgentScaffold(wsLegacy);
assert.equal(fs.existsSync(legacySkillPath), false, 'new-process reopen does not recreate a deleted skill');
assert.equal(fs.existsSync(legacyBackupPath), false, 'new-process reopen does not create a backup');

// Worker 注入尾注教学（还原即红：改回「追加 docs/memory/MEMORY.md」即转红）
const teachingSrc = [
  path.join(root, 'src', 'shared', 'workerBrief.ts'),
  path.join(root, 'src', 'shared', 'guiWorkerPrompt.ts'),
  path.join(root, 'src', 'main', 'agentSession', 'drivers', 'pi', 'modeHooksExtension.ts')
];
for (const p of teachingSrc) {
  const src = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(src, /追加.*MEMORY\.md/, `教学不得再教追加 MEMORY.md：${path.basename(p)}`);
  assert.match(src, /buildWorkerMemoryGuidance|MEMORY_WRITE_TEACHING_LINE|不要直接改删/, `教学须指向工具/禁止直改：${path.basename(p)}`);
}

const extDir = path.join(ws, '.muster', 'extensions', 'daily-report');
assert.equal(fs.existsSync(extDir), false, 'scaffold does not publish an unreviewed extension');
assert.equal(fs.existsSync(path.join(ws, '.agents', 'skills', 'muster-extensions')), false, 'scaffold does not seed the host extension skill');
assert.equal(fs.existsSync(path.join(ws, '.agents', 'skills', 'ui-widget-design')), false, 'scaffold does not seed the host UI skill');
for (const dir of ['extensions', 'workflows']) {
  assert.equal(fs.existsSync(path.join(ws, '.muster', dir, 'README.md')), false, 'scaffold does not seed authoring guides');
}
console.log('ok: first ensure leaves host authoring skills to host provisioning');

// A subsequent reopen cannot restore the retired blocks.
scaffold.ensureMetaAgentScaffold(wsLegacy);
assert.equal(fs.readFileSync(preserved, 'utf8'), userPrefix + userSuffix);
assert.equal(fs.existsSync(generated), false);

// ---------- 用户内容保护 ----------
// 1. 用户自写 journal skill（无标记）不被覆盖
const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-ws2-'));
const userSkillDir = path.join(ws2, '.agents', 'skills', 'journal');
fs.mkdirSync(userSkillDir, { recursive: true });
fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '---\nname: journal\ndescription: 我自己的技能\n---\n\n自定义内容', 'utf8');
scaffold.ensureMetaAgentScaffold(ws2);
assert.equal(
  fs.readFileSync(path.join(userSkillDir, 'SKILL.md'), 'utf8'),
  '---\nname: journal\ndescription: 我自己的技能\n---\n\n自定义内容',
  '用户自写 skill 不被种子覆盖'
);

// 2. 用户自建的 daily-report（无托管标记）不被覆盖
const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-ws3-'));
const userExtDir = path.join(ws3, '.muster', 'extensions', 'daily-report');
fs.mkdirSync(userExtDir, { recursive: true });
fs.writeFileSync(path.join(userExtDir, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'daily-report', name: '我的日报' }, null, 2));
scaffold.ensureMetaAgentScaffold(ws3);
const kept = JSON.parse(fs.readFileSync(path.join(userExtDir, 'extension.json'), 'utf8'));
assert.equal(kept.name, '我的日报', '用户自建同名扩展不被覆盖');
console.log('ok: user content protected');

fs.rmSync(ws, { recursive: true, force: true });
assert.equal(path.dirname(wsLegacy), path.resolve(os.tmpdir()));
assert.ok(path.basename(wsLegacy).startsWith('scaffold-legacy-journal-'));
fs.rmSync(wsLegacy, { recursive: true, force: true });
fs.rmSync(ws2, { recursive: true, force: true });
fs.rmSync(ws3, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('memory-scaffold: all ok');
