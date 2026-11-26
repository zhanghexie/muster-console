/** Opt-in SDK compatibility patch: skip implicit skill discovery before filesystem IO.
 * Default SDK callers retain upstream behavior. Exact anchors fail on SDK drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const edits = {
  'package-manager.js': [
    ['        this.cwd = resolvePath(options.cwd);', '        this.musterExplicitSkills = options.musterExplicitSkills === true;\n        this.cwd = resolvePath(options.cwd);', 1],
    ['for (const resourceType of RESOURCE_TYPES) {', 'for (const resourceType of RESOURCE_TYPES) {\n                if (this.musterExplicitSkills && resourceType === "skills") continue;', 4],
    ['const projectAgentsSkillDirs = projectTrusted', 'const projectAgentsSkillDirs = !this.musterExplicitSkills && projectTrusted', 1],
    ['addResources("skills", collectAutoSkillEntries(', 'if (!this.musterExplicitSkills) addResources("skills", collectAutoSkillEntries(', 4],
  ],
  'resource-loader.js': [
    ['import { loadSkills } from "./skills.js";', 'import { loadSkills, loadSkillsCooperatively } from "./skills.js";', 1],
    ['        this.cwd = resolvePath(options.cwd);', '        this.musterExplicitSkills = options.musterExplicitSkills === true;\n        this.cwd = resolvePath(options.cwd);', 1],
    ['        this.packageManager = new DefaultPackageManager({', '        this.packageManager = new DefaultPackageManager({\n            musterExplicitSkills: this.musterExplicitSkills,', 1],
    ['    getSkills() {', '    getMusterExplicitSkills() { return this.musterExplicitSkills; }\n    setMusterSkillPaths(paths) { if (!this.musterExplicitSkills) throw new Error("Explicit skill discovery is disabled"); this.additionalSkillPaths = [...paths]; }\n    getSkills() {', 1],
    ['const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);', 'const skillPaths = this.musterExplicitSkills ? [] : this.normalizeExtensionPaths(paths.skillPaths ?? []);', 1],
    ['        this.skillsOverride = options.skillsOverride;', '        this.skillsOverride = options.skillsOverride;\n        this.musterSkillDiscoveryVersion = 2;\n        this.musterSkillsOverride = options.musterSkillsOverride;\n        this.musterCooperativeSkills = this.musterExplicitSkills && options.musterCooperativeSkills !== false;', 1],
    ['        this.updateSkillsFromPaths(skillPaths, metadataByPath);', '        let preparedSkills = this.musterCooperativeSkills\n            ? await loadSkillsCooperatively({ cwd: this.cwd, agentDir: this.agentDir, skillPaths, includeDefaults: false }) : undefined;\n        if (preparedSkills && this.musterSkillsOverride) preparedSkills = await this.musterSkillsOverride(preparedSkills);\n        this.updateSkillsFromPaths(skillPaths, metadataByPath, preparedSkills);', 1],
    ['const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;', 'const resolvedSkills = preparedSkills && this.musterSkillsOverride ? skillsResult : this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;', 1],
    ['    updateSkillsFromPaths(skillPaths, metadataByPath) {\n        let skillsResult;\n        if (this.noSkills', '    updateSkillsFromPaths(skillPaths, metadataByPath, preparedSkills) {\n        let skillsResult;\n        if (preparedSkills) { skillsResult = preparedSkills; }\n        else if (this.noSkills', 1],
  ],
  'skills.js': [
    ['export function loadSkillsFromDir(options) {', `function drainSkillsSteps(steps) {
    let next; do { next = steps.next(); } while (!next.done); return next.value;
}
export async function loadSkillsCooperatively(options) {
    const steps = loadSkillsSteps(options);
    let started = performance.now(), count = 0;
    while (true) {
        const next = steps.next();
        if (next.done) return next.value;
        if (++count >= 32 || performance.now() - started >= 4) {
            await new Promise(resolve => setImmediate(resolve));
            started = performance.now(); count = 0;
        }
    }
}
export function loadSkillsFromDir(options) {`, 1],
    ['    return loadSkillsFromDirInternal(dir, source, true);', '    return drainSkillsSteps(loadSkillsFromDirInternal(dir, source, true));', 1],
    ['function loadSkillsFromDirInternal(', 'function* loadSkillsFromDirInternal(', 1],
    ['        for (const entry of entries) {', '        for (const entry of entries) {\n            yield;', 2],
    ['const subResult = loadSkillsFromDirInternal(', 'const subResult = yield* loadSkillsFromDirInternal(', 1],
    ['export function loadSkills(options) {', 'export function loadSkills(options) { return drainSkillsSteps(loadSkillsSteps(options)); }\nfunction* loadSkillsSteps(options) {', 1],
    ['    function addSkills(result) {', '    function* addSkills(result) {', 1],
    ['        for (const skill of result.skills) {', '        for (const skill of result.skills) {\n            yield;', 1],
    ['        addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));', '        yield* addSkills(yield* loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));', 1],
    ['        addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));', '        yield* addSkills(yield* loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));', 1],
    ['    for (const rawPath of skillPaths) {', '    for (const rawPath of skillPaths) {\n        yield;', 1],
    ['                addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));', '                yield* addSkills(yield* loadSkillsFromDirInternal(resolvedPath, source, true));', 1],
    ['                    addSkills({ skills: [result.skill], diagnostics: result.diagnostics });', '                    yield* addSkills({ skills: [result.skill], diagnostics: result.diagnostics });', 1],
  ],
};

export function patchSource(name, source) {
  const changes = edits[name];
  if (!changes) throw new Error(`Unknown Pi patch target: ${name}`);
  const normalized = source.replace(/\r\n/g, '\n');
  // Upgrade only the known development SDK patch identifiers. This touches
  // installed dependency code, never application data or a runtime alias.
  let next = normalized.replace(/\b(?:metaagentExplicitSkills|metaagentSkillsOverride|metaagentSkillDiscoveryVersion|metaagentCooperativeSkills|getMetaagentExplicitSkills|setMetaagentSkillPaths)\b/g,
    name => name.replace('metaagent', 'muster').replace('Metaagent', 'Muster'));
  // Peel every complete known edit first. Any remaining injected identifier is
  // an edited/unknown patch, so fail before writing any of the three files.
  for (const [original, replacement, count] of [...changes].reverse()) {
    const present = next.split(replacement).length - 1;
    if (present === count) next = next.replaceAll(replacement, original);
    else if (present !== 0) throw new Error(`Pi SDK changed; review skills discovery patch: ${name}: partial patched block`);
  }
  if (/\b(?:musterExplicitSkills|musterSkillsOverride|musterSkillDiscoveryVersion|musterCooperativeSkills|getMusterExplicitSkills|setMusterSkillPaths|loadSkillsCooperatively|loadSkillsSteps|drainSkillsSteps)\b/.test(next))
    throw new Error(`Pi SDK changed; review skills discovery patch: ${name}: unknown patched block`);
  for (const [original, replacement, count] of changes) {
    if (next.split(original).length - 1 !== count) throw new Error(`Pi SDK changed; review skills discovery patch: ${name}: ${original}`);
    next = next.replaceAll(original, replacement);
  }
  return next === normalized ? source : next;
}

export function patchPiSkillDiscovery() {
  const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const core = path.join(path.dirname(sdkEntry), 'core');
  // Validate every file before modifying any dependency file.
  const files = Object.keys(edits).map(name => {
    const file = path.join(core, name), source = fs.readFileSync(file, 'utf8');
    return { file, source, next: patchSource(name, source) };
  });
  for (const { file, source, next } of files) if (source !== next) fs.writeFileSync(file, next);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchPiSkillDiscovery();
  console.log('Pi explicit skill discovery patch verified');
}
