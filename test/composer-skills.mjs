/**
 * Composer 技能菜单收录 + /skill:name 展开（与 Pi _expandSkillCommand 同形态）。
 * 运行: node test/composer-skills.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-skills-'));
const compile = createSharedCompiler(root, tmp);
const {
  skillsToSlashItems,
  parseSkillCommand,
  stripSkillFrontmatter,
  expandSkillCommand
} = await import(pathToFileURL(compile('shared/composerSkills.ts')).href);

const skills = [
  { name: 'journal', description: '写工作日志' },
  { name: 'demo-helper', description: '演示技能' }
];

const listed = skillsToSlashItems(skills, '', 'Skill');
assert.equal(listed.length, 2, '空查询应收录全部 skill');
assert.equal(listed[0].id, 'skill:journal');
assert.equal(listed[0].label, '/skill:journal');
assert.equal(listed[0].insert, '/skill:journal ');
assert.ok(
  listed.some((i) => i.id.startsWith('skill:')),
  '菜单收录必须含 skill（GUI/调度同一函数，无表面特判）'
);

const filtered = skillsToSlashItems(skills, 'jour', 'Skill');
assert.equal(filtered.length, 1);
assert.equal(filtered[0].id, 'skill:journal');

const byPrefix = skillsToSlashItems(skills, 'skill:demo', 'Skill');
assert.equal(byPrefix.length, 1);
assert.equal(byPrefix[0].id, 'skill:demo-helper');

assert.equal(skillsToSlashItems(skills, 'no-such', 'Skill').length, 0);

assert.deepEqual(parseSkillCommand('/skill:journal'), { name: 'journal', args: '' });
assert.deepEqual(parseSkillCommand('/skill:journal\n继续写'), { name: 'journal', args: '继续写' });
assert.deepEqual(parseSkillCommand('/skill:journal 请记一笔'), {
  name: 'journal',
  args: '请记一笔'
});
assert.equal(parseSkillCommand('请用 /skill:journal'), null, '非开头不展开');
assert.equal(parseSkillCommand('/skill:'), null);

const raw = `---
name: journal
description: 写工作日志
---

# 工作日志

按格式写入 docs/journal/。
`;
const body = stripSkillFrontmatter(raw);
assert.equal(body, '# 工作日志\n\n按格式写入 docs/journal/。');

const expanded = expandSkillCommand('/skill:journal 请记一笔', [
  {
    name: 'journal',
    filePath: 'E:/ws/.agents/skills/journal/SKILL.md',
    baseDir: 'E:/ws/.agents/skills/journal',
    body
  }
]);
assert.match(expanded, /^<skill name="journal" location="E:\/ws\/\.agents\/skills\/journal\/SKILL.md">/);
assert.match(expanded, /References are relative to E:\/ws\/\.agents\/skills\/journal\./);
assert.match(expanded, /# 工作日志/);
assert.match(expanded, /按格式写入 docs\/journal\/。/);
assert.ok(expanded.endsWith('</skill>\n\n请记一笔'), '参数跟在 skill 块后');
assert.ok(!expanded.includes('name: journal'), 'frontmatter 不得进展开正文');

const unknown = expandSkillCommand('/skill:missing', [
  { name: 'journal', filePath: '/x', baseDir: '/x', body }
]);
assert.equal(unknown, '/skill:missing', '未知技能原文通过');

const plain = expandSkillCommand('普通消息', [
  { name: 'journal', filePath: '/x', baseDir: '/x', body }
]);
assert.equal(plain, '普通消息');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] composer-skills');
