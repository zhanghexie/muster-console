/** Observation watches the two universal roots and does not enumerate host storage. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-skill-observation-'));
const require = createRequire(import.meta.url);
const yamlDirectory = path.dirname(require.resolve('yaml/package.json'));
const yamlShim = path.join(temporary, 'node_modules', 'yaml');
fs.mkdirSync(yamlShim, { recursive: true });
fs.writeFileSync(path.join(yamlShim, 'package.json'), JSON.stringify({ name: 'yaml', main: 'index.cjs' }));
fs.writeFileSync(path.join(yamlShim, 'index.cjs'), `module.exports = require(${JSON.stringify(yamlDirectory)});\n`);
const compile = createSharedCompiler(root, temporary);
const { SkillsManagementService } = await import(pathToFileURL(compile('main/capabilityManagement/skills.ts')).href);
const home = path.join(temporary, 'home');
const project = path.join(temporary, 'project');
fs.mkdirSync(path.join(home, '.agents', 'skills', 'one'), { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(home, '.agents', 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: one\n---\n');
const service = new SkillsManagementService({ homeDir: home, userDataDir: path.join(temporary, 'data'), getProjectPaths: () => [project], watch: false });
try {
  const snapshot = service.list({ kind: 'project', projectPath: project });
  assert.equal(snapshot.errors.length, 0);
  assert.equal(snapshot.skills.length, 1);
  assert.ok(snapshot.directories.every(directory => directory.path.includes('.agents\\skills') || directory.path.includes('.agents/skills')));
  console.log('capability-skills-observation: ok');
} finally {
  service.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
}
