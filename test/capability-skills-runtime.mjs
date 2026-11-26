/** Runtime bridge keeps host built-ins explicit while user skills use two universal roots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-skill-runtime-'));
const require = createRequire(import.meta.url);
const yamlDirectory = path.dirname(require.resolve('yaml/package.json'));
const yamlShim = path.join(temporary, 'node_modules', 'yaml');
fs.mkdirSync(yamlShim, { recursive: true });
fs.writeFileSync(path.join(yamlShim, 'package.json'), JSON.stringify({ name: 'yaml', main: 'index.cjs' }));
fs.writeFileSync(path.join(yamlShim, 'index.cjs'), `module.exports = require(${JSON.stringify(yamlDirectory)});\n`);
const compile = createSharedCompiler(root, temporary);
const { SkillsManagementService } = await import(pathToFileURL(compile('main/capabilityManagement/skills.ts')).href);
const { resolveHostSkillRootDir } = await import(pathToFileURL(compile('main/metaAgent/hostDomainSkills.ts')).href);
const home = path.join(temporary, 'home');
const project = path.join(temporary, 'project');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
fs.mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
const service = new SkillsManagementService({ homeDir: home, userDataDir: path.join(temporary, 'data'), getProjectPaths: () => [project], watch: false });
try {
  const piPaths = service.additionalSkillPaths([project], 'pi-gui');
  assert.ok(piPaths.includes(path.join(home, '.agents', 'skills')));
  assert.ok(piPaths.includes(path.join(project, '.agents', 'skills')));
  assert.ok(piPaths.includes(resolveHostSkillRootDir()), 'host Pi loading receives the private built-in root explicitly');
  const otherPaths = service.additionalSkillPaths([project], 'claude-cli');
  assert.ok(otherPaths.includes(path.join(home, '.agents', 'skills')));
  assert.ok(otherPaths.includes(path.join(project, '.agents', 'skills')));
  assert.ok(!otherPaths.includes(resolveHostSkillRootDir()), 'non-host targets do not receive host built-ins');
  console.log('capability-skills-runtime: ok');
} finally {
  service.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
}
