/** Host skills stay in the private host root and are never projected into a workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'host-domain-skills-'));
const compile = createSharedCompiler(root, temporary);
const { hostSkillDomainDirs, resolveHostSkillRootDir } = await import(pathToFileURL(compile('main/metaAgent/hostDomainSkills.ts')).href);
const { SKILL_ROOT } = await import(pathToFileURL(compile('main/capabilities/catalog/runFactory.ts')).href);
const scaffoldSrc = fs.readFileSync(path.join(root, 'src/main/metaAgent/scaffold.ts'), 'utf8');
const provisionSrc = fs.readFileSync(path.join(root, 'src/main/metaAgent/hostSkillProvision.ts'), 'utf8');
try {
  assert.equal(SKILL_ROOT, '~/.muster/skills');
  assert.equal(resolveHostSkillRootDir(), path.join(os.homedir(), '.muster', 'skills'));
  const domains = [...hostSkillDomainDirs()];
  assert.equal(domains.length, 19, '宿主声明域技能数量');
  assert.ok(domains.includes('core-context'));
  assert.ok(domains.includes('panel'), 'panel domain skill ships with the host');
  assert.ok(domains.includes('github'), 'GitHub domain skill ships with the host');
  assert.ok(domains.includes('muster-extensions'));
  assert.ok(domains.includes('ui-widget-design'));
  assert.doesNotMatch(scaffoldSrc, /ensureExtensionsSkill|ensureUiWidgetSkill/);
  assert.ok(!scaffoldSrc.includes('linkHostDomainSkills'));
  assert.ok(!provisionSrc.includes("'~/.muster/skills'"));
  assert.ok(!fs.existsSync(path.join(root, 'src/main/metaAgent/skillLinks.ts')));
  console.log('host-domain-skills: ok');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
