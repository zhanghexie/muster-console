/** Actual SDK filesystem reads, not merely filtering unwanted skills after discovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';
import { edits, patchSource } from '../scripts/patch-pi-skill-discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-roots-'));
const home = path.join(temp, 'home'), cwd = path.join(temp, 'parent/project'), agentDir = path.join(temp, 'pi-home');
for (const dir of [home, cwd, agentDir]) fs.mkdirSync(dir, { recursive: true });
const originalHome = os.homedir; os.homedir = () => home; syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const shim = path.join(temp, 'node_modules/yaml'); fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'index.js'), `module.exports=require(${JSON.stringify(require.resolve('yaml'))});`);
const compile = createSharedCompiler(root, temp);
const load = relative => import(pathToFileURL(compile(relative)).href);
const seed = (directory, name) => {
  const dir = path.join(directory, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated discovery fixture\n---\nBody\n`);
  return dir;
};
let service, bridge;
try {
  const pi = await import('@earendil-works/pi-coding-agent');
  const { createSkillSourceLoader } = await load('main/agent/skillSources.ts');
  const { piSkillRootPaths } = await load('main/agent/piSkillRoots.ts');
  const { canReadDiscoveredSkill } = await load('main/agent/skillReadAccess.ts');
  assert.deepEqual(piSkillRootPaths('C:\\Users\\me', ['D:\\work'], path.win32), ['C:\\Users\\me\\.agents\\skills', 'D:\\work\\.agents\\skills']);
  for (const prefix of ['/home/me', '/Users/me']) assert.deepEqual(piSkillRootPaths(prefix, ['/work'], path.posix), [`${prefix}/.agents/skills`, '/work/.agents/skills']);
  seed(path.join(home, '.agents/skills'), 'global-ok');
  seed(path.join(cwd, '.agents/skills'), 'project-ok');
  const memory = seed(path.join(home, '.muster/skills'), 'memory');
  const staleMemoryLink = path.join(cwd, '.agents/skills/memory');
  fs.symlinkSync(path.join(home, '.metaagent/skills/memory'), staleMemoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(path.join(staleMemoryLink, 'SKILL.md')), false);
  seed(path.join(home, '.muster/skills'), 'muster-extensions');
  seed(path.join(home, '.muster/skills'), 'ui-widget-design');
  const external = seed(path.join(temp, 'linked-source'), 'linked-ok');
  fs.symlinkSync(external, path.join(cwd, '.agents/skills/linked-ok'), process.platform === 'win32' ? 'junction' : 'dir');
  const packageRoot = path.join(temp, 'package');
  const forbidden = [path.join(home, '.claude/skills'), path.join(home, '.codex/skills'), path.join(home, '.cursor/skills'),
    path.join(home, '.pi/agent/skills'), path.join(home, '.pi/skills'), path.join(agentDir, 'skills'),
    path.join(cwd, '.claude/skills'), path.join(cwd, '.codex/skills'), path.join(cwd, '.pi/skills'),
    path.join(cwd, '.cursor/skills'), path.join(path.dirname(cwd), '.agents/skills'), path.join(packageRoot, 'skills'), path.join(temp, 'extra-skills')];
  forbidden.forEach((dir, i) => seed(dir, `forbidden-${i}`));
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-skills', pi: { skills: ['skills'] } }));
  const { SkillsManagementService, isPublicHostSkillPath } = await load('main/capabilityManagement/skills.ts');
  for (const [hostHome, paths] of [['C:\\Users\\me', path.win32], ['/Users/me', path.posix], ['/home/me', path.posix]]) {
    const hostRoot = paths.join(hostHome, '.muster', 'skills');
    assert.equal(isPublicHostSkillPath(paths.join(hostRoot, 'memory', 'SKILL.md'), hostRoot, paths), true);
    assert.equal(isPublicHostSkillPath(paths.join(hostHome, '.muster', 'memory', 'journal.md'), hostRoot, paths), false);
    assert.equal(isPublicHostSkillPath(paths.join(hostRoot, 'local', 'SKILL.md'), hostRoot, paths), false);
  }
  bridge = await load('main/capabilityManagement/runtimeSkills.ts');
  service = new SkillsManagementService({ homeDir: home, userDataDir: path.join(temp, 'data'), watch: false,
    getRuntimes: builtinHarnessFixtures, getProjectPaths: p => p ? [cwd] : [cwd] });
  bridge.setSkillsManagementService(service);
  const settings = pi.SettingsManager.inMemory({ skills: [forbidden.at(-1)], packages: [packageRoot] }, { projectTrusted: true });
  const prompt = path.join(temp, 'custom-prompt.md'); fs.writeFileSync(prompt, '---\ndescription: Prompt retained\n---\nPrompt body');
  const makeLoader = () => createSkillSourceLoader(pi, { cwd, agentDir, settingsManager: settings,
    additionalSkillPaths: forbidden, additionalPromptTemplatePaths: [prompt],
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, cwd, agentDir);
  const blockedReads = [], originals = {};
  const isForbidden = file => forbidden.some(dir => { const rel = path.relative(dir, path.resolve(String(file))); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
  for (const key of ['readdirSync', 'readFileSync', 'statSync', 'lstatSync']) {
    originals[key] = fs[key];
    fs[key] = (file, ...args) => { if (isForbidden(file)) blockedReads.push({ key, file: String(file) }); return originals[key](file, ...args); };
  }
  syncBuiltinESMExports();
  let loader;
  try {
    const upstream = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true,
      noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await upstream.reload({ resolveProjectTrust: async () => true });
    assert.ok(blockedReads.length > 0, 'control: upstream noSkills still reads excluded fixture directories');
    blockedReads.length = 0;
    loader = makeLoader();
    await loader.reload({ resolveProjectTrust: async () => true });
    loader.extendResources({ skillPaths: [{ path: forbidden.at(-1), metadata: { source: 'fixture', scope: 'user', origin: 'package' } }] });
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
  assert.deepEqual(blockedReads, [], 'neither SDK nor policy scans excluded skill sources');
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), ['global-ok', 'linked-ok', 'project-ok']);
  assert.ok(!loader.getSkills().skills.some(skill => skill.filePath.startsWith(path.join(home, '.muster'))),
    'ordinary skill discovery leaves host-owned domain instructions outside SDK injection');
  assert.equal(loader.getPrompts().prompts.length, 1, 'non-skill resources retain their explicit loader path');
  service.dispose();
  const sandboxHome = path.join(temp, 'sandbox-home');
  seed(path.join(sandboxHome, '.agents/skills'), 'sandbox-global');
  service = new SkillsManagementService({ homeDir: sandboxHome, userDataDir: path.join(temp, 'sandbox-data'), watch: false,
    getRuntimes: builtinHarnessFixtures, getProjectPaths: p => p ? [cwd] : [cwd] });
  bridge.setSkillsManagementService(service);
  const sandboxLoader = makeLoader();
  await sandboxLoader.reload({ resolveProjectTrust: async () => true });
  const sandboxSkills = sandboxLoader.getSkills().skills;
  assert.ok(sandboxSkills.some(skill => skill.name === 'sandbox-global'));
  assert.ok(!sandboxSkills.some(skill => skill.name === 'global-ok'), 'managed sandbox home does not fall back to the OS user skills');
  const memoryFile = path.join(memory, 'SKILL.md');
  assert.equal(canReadDiscoveredSkill(memoryFile, sandboxSkills), false, 'skill discovery grants no implicit access to the other home');
  const fresh = path.join(temp, 'empty-project'); fs.mkdirSync(fresh);
  bridge.setSkillsManagementService(undefined);
  const reloadable = createSkillSourceLoader(pi, { cwd: fresh, agentDir, noExtensions: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true }, fresh, agentDir);
  await reloadable.reload({ resolveProjectTrust: async () => true });
  seed(path.join(fresh, '.agents/skills'), 'created-later');
  await reloadable.reload({ resolveProjectTrust: async () => true });
  assert.ok(reloadable.getSkills().skills.some(skill => skill.name === 'created-later'), 'reload discovers a newly created canonical directory');
  const sdkCore = path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'core');
  const { loadSkillsCooperatively } = await import(pathToFileURL(path.join(sdkCore, 'skills.js')));
  const batch = path.join(fresh, '.agents/skills/cooperative-fixture');
  for (let i = 0; i < 80; i++) seed(batch, `yield-${i}`);
  const discoveryOptions = { cwd, agentDir, skillPaths: [batch], includeDefaults: false };
  const expected = pi.loadSkills(discoveryOptions);
  let reads = 0, completed = false;
  const midScanReads = [];
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(batch)) reads++; return originalRead(file, ...args); };
  syncBuiltinESMExports();
  const observe = () => { if (!completed) { midScanReads.push(reads); setImmediate(observe); } };
  setImmediate(observe);
  try {
    const actual = await loadSkillsCooperatively(discoveryOptions);
    assert.deepEqual(actual, expected, 'cooperative SDK scan preserves synchronous parsing, diagnostics and order');
  } finally { completed = true; fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  assert.ok(midScanReads.some(count => count > 0 && count < reads), 'SDK yields while actual skill files are still being read');
  // Source tagging must also yield, not move the freeze to the override after discovery.
  let inOverride = false, sourceReads = 0;
  const midSourceReads = [];
  const originalNative = fs.realpathSync.native;
  fs.realpathSync.native = (...args) => { if (inOverride) sourceReads++; return originalNative(...args); };
  class ObservedLoader extends pi.DefaultResourceLoader {
    constructor(options) {
      super({ ...options, musterSkillsOverride: async base => {
        inOverride = true;
        const observeSource = () => { if (inOverride) { midSourceReads.push(sourceReads); setImmediate(observeSource); } };
        setImmediate(observeSource);
        try { return await options.musterSkillsOverride(base); } finally { inOverride = false; }
      } });
    }
  }
  try {
    const sourceLoader = createSkillSourceLoader({ ...pi, DefaultResourceLoader: ObservedLoader }, {
      cwd: fresh, agentDir, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      settingsManager: pi.SettingsManager.inMemory({}, { projectTrusted: true }) }, fresh, agentDir);
    await sourceLoader.reload({ resolveProjectTrust: async () => true });
    assert.equal(sourceLoader.getSkills().skills.filter(s => s.name.startsWith('yield-')).length, 80);
    assert.ok(midSourceReads.some(count => count > 0 && count < sourceReads), 'source override yields between physical identity reads');
  } finally { fs.realpathSync.native = originalNative; }
  for (const [name, changes] of Object.entries(edits)) {
    const patched = fs.readFileSync(path.join(sdkCore, name), 'utf8');
    assert.equal(patchSource(name, patched), patched, 'installation patch is idempotent');
    const legacy = patched.replace(/\bmuster([A-Z][A-Za-z]+)/g, 'metaagent$1').replace(/\b(get|set)Muster/g, '$1Metaagent');
    assert.equal(patchSource(name, legacy), patched, 'postinstall upgrades the currently installed old patch identifiers atomically');
    if (name !== 'skills.js') {
      const drift = legacy.replace('this.metaagentExplicitSkills = options.metaagentExplicitSkills === true;', 'this.metaagentExplicitSkills = true;');
      assert.throws(() => patchSource(name, drift), /SDK changed/, 'an edited old patch is rejected instead of inserting a duplicate override');
    }
    const [lastOriginal, lastReplacement] = changes.at(-1);
    assert.equal(patchSource(name, patched.replaceAll(lastReplacement, lastOriginal)), patched, 'known partial patch upgrades retain exact validation');
    let original = patched;
    for (const [before, after] of [...changes].reverse()) original = original.replaceAll(after, before);
    assert.equal(patchSource(name, original), patched, 'clean dependency receives the exact reviewed patch');
    assert.throws(() => patchSource(name, original.replace(changes[0][0], '// sdk drift')), /SDK changed/, 'version drift cannot silently retain broad discovery');
  }
  const identityLoader = makeLoader();
  assert.equal(identityLoader.getMusterExplicitSkills(), true);
  assert.equal(identityLoader.musterSkillDiscoveryVersion, 2);
  assert.equal(identityLoader.getMetaagentExplicitSkills, undefined);
  assert.equal(identityLoader.setMetaagentSkillPaths, undefined);
  assert.throws(() => createSkillSourceLoader({ ...pi, DefaultResourceLoader: class {} }, { cwd, agentDir }, cwd, agentDir), /兼容补丁未加载/);
  console.log('Pi canonical roots: excluded sources never read, symlinks/reload/prompt resources and cross-platform paths passed');
} finally {
  bridge?.setSkillsManagementService(undefined); service?.dispose();
  os.homedir = originalHome; syncBuiltinESMExports();
  assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true });
}
