/** Consolidation still operates on discovered universal-root sources only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-consolidation-'));
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
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(project, { recursive: true });
const makeSkill = (base, name, body) => {
  const dir = path.join(base, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n${body}\n`);
  return dir;
};
makeSkill(home, 'same-name', 'global');
makeSkill(project, 'same-name', 'project');
const service = new SkillsManagementService({ homeDir: home, userDataDir: path.join(temporary, 'data'), getProjectPaths: () => [project], watch: false });
try {
  const scope = { kind: 'project', projectPath: project };
  const initial = service.list(scope);
  const selected = initial.skills.find(skill => skill.name === 'same-name' && skill.scope.kind === 'project')?.id;
  assert.ok(selected);
  const preview = service.previewConsolidation(scope, 'same-name', selected);
  assert.equal(preview.destination, path.join(home, '.agents', 'skills', 'same-name'));
  assert.equal(preview.candidates.length, 2);
  assert.ok(preview.removePaths.length >= 1);
  assert.equal(preview.selectedId, selected);
  const result = service.consolidate({ scope, name: 'same-name', skillId: selected, expectedFingerprint: preview.fingerprint });
  assert.equal(result.snapshot.skills.filter(skill => skill.name === 'same-name').length, 1);
  assert.equal(fs.readFileSync(path.join(home, '.agents', 'skills', 'same-name', 'SKILL.md'), 'utf8').includes('project'), true);
  console.log('skill-consolidation: ok');
} finally {
  service.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
}
