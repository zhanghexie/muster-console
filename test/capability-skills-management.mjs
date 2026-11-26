/** Universal skill roots: only global and project .agents/skills are managed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'universal-skill-roots-'));
const require = createRequire(import.meta.url);
const yamlDirectory = path.dirname(require.resolve('yaml/package.json'));
const yamlShim = path.join(temporary, 'node_modules', 'yaml');
fs.mkdirSync(yamlShim, { recursive: true });
fs.writeFileSync(path.join(yamlShim, 'package.json'), JSON.stringify({ name: 'yaml', main: 'index.cjs' }));
fs.writeFileSync(path.join(yamlShim, 'index.cjs'), `module.exports = require(${JSON.stringify(yamlDirectory)});\n`);
const compile = createSharedCompiler(root, temporary);
const { SkillsManagementService } = await import(pathToFileURL(compile('main/capabilityManagement/skills.ts')).href);
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
applyLocaleSetting('zh-CN');

const home = path.join(temporary, 'home');
const project = path.join(temporary, 'project');
const secondProjectRoot = path.join(temporary, 'second-root');
const userDataDir = path.join(temporary, 'user-data');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(secondProjectRoot, { recursive: true });
const service = new SkillsManagementService({ homeDir: home, userDataDir, getProjectPaths: value => value ? [project, secondProjectRoot] : [project], watch: false });
const write = (base, name, body = name) => {
  const dir = path.join(base, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n${body}\n`);
  return dir;
};
const byName = (snapshot, name) => snapshot.skills.find(skill => skill.name === name);
try {
  const globalDir = write(home, 'global-skill');
  const projectDir = write(project, 'project-skill');
  const hostDir = path.join(home, '.muster', 'skills', 'host-only');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'SKILL.md'), '---\nname: host-only\ndescription: host\n---\n\nprivate\n');

  const globalSnapshot = service.list({ kind: 'global' });
  assert.deepEqual(globalSnapshot.directories.map(directory => directory.path), [path.join(home, '.agents', 'skills')]);
  assert.equal(byName(globalSnapshot, 'global-skill').filePath, path.join(globalDir, 'SKILL.md'));
  assert.equal(byName(globalSnapshot, 'host-only'), undefined, 'host built-ins stay out of the management inventory');

  const projectSnapshot = service.list({ kind: 'project', projectPath: project });
  assert.deepEqual(projectSnapshot.directories.map(directory => directory.path).sort(), [path.join(home, '.agents', 'skills'), path.join(project, '.agents', 'skills'), path.join(secondProjectRoot, '.agents', 'skills')].sort());
  assert.ok(byName(projectSnapshot, 'global-skill'));
  assert.ok(byName(projectSnapshot, 'project-skill'));

  const created = service.createSkill({ scope: { kind: 'project', projectPath: project }, name: 'created-project', body: '# created' });
  assert.equal(fs.lstatSync(path.join(project, '.agents', 'skills', 'created-project')).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(secondProjectRoot, '.agents', 'skills', 'created-project')), false, 'creation does not project a link into another source root');
  assert.equal(created.skills.find(skill => skill.name === 'created-project').scope.kind, 'project');
  assert.equal(typeof service.registerDirectory, 'undefined');
  assert.equal(typeof service.setAssociations, 'undefined');
  console.log('capability-skills-management: ok');
} finally {
  service.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
}
