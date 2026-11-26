/** Real Pi discovery/collisions plus source-aware host injection, aliases and task copies. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pi from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-skills-'));
const originalHome = os.homedir;
const isolatedHome = path.join(temp, 'home'); fs.mkdirSync(isolatedHome);
os.homedir = () => isolatedHome; syncBuiltinESMExports();
const compiled = path.join(temp, 'compiled'); const compile = createSharedCompiler(repo, compiled);
const load = async rel => import(pathToFileURL(compile(rel)).href);
const { createSkillSourceLoader, workspaceSkillPaths, workspaceSkillFolders } = await load('main/agent/skillSources.ts');
const { captureWorkspaceExecutionContext: capture } = await load('main/workspaceExecutionContext.ts');
const { createPiApprovalExtension } = await load('main/agentSession/drivers/pi/approvalExtension.ts');
const { createSchedulerDirectoryExtension } = await load('main/agent/providers/directoryExtension.ts');
const { decideToolCallPermission } = await load('main/agentSession/tools/policy.ts');
const { canReadDiscoveredSkill } = await load('main/agent/skillReadAccess.ts');
compile('main/agent/skillInject.ts');
fs.writeFileSync(path.join(compiled, 'main/agent/piElectronCompat.mjs'), 'export const patchElectronForPi = () => {};');
const { prepareEngineSkillText, appendNamedSkillsToBrief, SkillTurnBudget } = await load('main/agent/skillInject.ts');
const { skillsToSlashItems } = await load('shared/composerSkills.ts');
const writeSkill = (root, name, body, options = '') => {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: Local fixture ${name}\n${options}---\n\n${body}\n`);
  return file;
};
const discover = async (cwd, agentDir, context) => {
  const loader = createSkillSourceLoader(pi, { cwd, agentDir, additionalSkillPaths: workspaceSkillPaths(cwd, context),
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, cwd, agentDir, context);
  await loader.reload({ resolveProjectTrust: async () => true });
  return { loader, skills: loader.getSkills().skills.map(skill => skill.musterSkill) };
};
try {
  const [a, b, c, outside, agentDir, tree] = ['a', 'b', 'c', 'outside', 'agent', 'tree'].map(name => path.join(temp, name));
  for (const dir of [a, b, c, outside, agentDir, tree]) fs.mkdirSync(dir);
  const fileA = writeSkill(path.join(a, '.agents/skills'), 'fixture-collision', 'BODY FROM A');
  const fileB = writeSkill(path.join(b, '.agents/skills'), 'fixture-collision', 'BODY FROM B');
  writeSkill(path.join(isolatedHome, '.agents/skills'), 'fixture-user', 'USER BODY');
  writeSkill(path.join(isolatedHome, '.agents/skills'), 'fixture-disabled', 'EXPLICIT ONLY BODY', 'disable-model-invocation: true\n');
  writeSkill(path.join(b, '.agents/skills'), 'fixture-b-only', 'ONLY B BODY');
  writeSkill(path.join(c, '.agents/skills'), 'fixture-added', 'NEW ROOT BODY');
  fs.mkdirSync(path.join(a, '.cursor')); fs.symlinkSync(path.join(a, '.agents/skills'), path.join(a, '.cursor/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const nested = path.join(b, 'nested'); fs.mkdirSync(nested);
  writeSkill(path.join(nested, '.agents/skills'), 'fixture-nested', 'NESTED BODY');
  const ws = { id: 'ws', name: 'Project', path: a, controlRoot: a, defaultRootId: 'a', rootsRevision: 1,
    roots: [{ id: 'a', path: a, label: 'Alpha' }, { id: 'b', path: b, label: 'Beta' }, { id: 'nested', path: nested, label: 'Nested' }] };
  const cfg = { workspaces: [ws], activeWorkspaceId: 'elsewhere' };
  const session = { id: 'worker', name: 'Worker', type: 'terminal', createdAt: 0, workspaceId: 'ws', cwd: a };
  const context = capture(cfg, session);
  const found = await discover(a, agentDir, context);
  const skills = found.skills.filter(skill => skill.name.startsWith('fixture-'));
  assert.equal(skills.filter(skill => skill.name === 'fixture-collision').length, 2, 'SDK collision losers remain selectable');
  assert.equal(skills.filter(skill => skill.name === 'fixture-user').length, 1, 'user paths are loaded once');
  assert.equal(skills.filter(skill => skill.filePath === fileA).length, 1, 'Junction aliases are deduplicated by real file');
  assert.ok(skills.some(skill => skill.name === 'fixture-nested' && skill.source.rootIds.includes('nested')));
  const aSkill = skills.find(skill => skill.filePath === fileA); const bSkill = skills.find(skill => skill.filePath === fileB);
  assert.equal(aSkill.commandName, 'root:a/fixture-collision'); assert.equal(bSkill.commandName, 'root:b/fixture-collision');
  assert.notEqual(aSkill.id, bSkill.id);
  assert.ok(found.loader.getSkills().skills.some(skill => skill.name === bSkill.commandName), 'native Pi receives the same qualified command');
  assert.equal(found.loader.getSkills().skills.find(skill => skill.name === 'fixture-disabled').disableModelInvocation, true);
  assert.ok(!pi.formatSkillsForPrompt(found.loader.getSkills().skills).includes('fixture-disabled'), 'native model-invocation restriction remains intact');
  const deps = { listSkills: async (_cwd, passedContext) => { assert.equal(passedContext, context); return skills; } };
  const prepare = (text, extra = {}) => prepareEngineSkillText(text, { cwd: a, workspaceContext: context, sessionId: 'worker',
    budget: new SkillTurnBudget(), deps, ...extra });
  const ambiguous = await prepare('/skill:fixture-collision');
  assert.match(ambiguous.warning, /root:a\/fixture-collision/); assert.match(ambiguous.warning, /root:b\/fixture-collision/);
  assert.ok(!ambiguous.text.includes('BODY FROM')); assert.deepEqual(ambiguous.injectedIds, []);
  const picked = await prepare('/skill:root:b/fixture-collision use this');
  assert.ok(picked.text.includes('BODY FROM B')); assert.ok(!picked.text.includes('BODY FROM A'));
  assert.deepEqual(picked.injectedIds, [bSkill.id]); assert.ok(picked.text.includes(path.dirname(fileB)));
  const local = await prepare('Please use fixture-collision'); assert.ok(local.text.includes('BODY FROM A')); assert.ok(!local.text.includes('BODY FROM B'));
  assert.deepEqual(local.injectedIds, [aSkill.id]);
  const foreign = await prepare('Please use fixture-b-only'); assert.ok(!foreign.text.includes('ONLY B BODY'));
  const foreignPicked = await prepare('/skill:root:b/fixture-b-only'); assert.ok(foreignPicked.text.includes('ONLY B BODY'));
  const qualifiedMention = await prepare('Please use root:b/fixture-collision');
  assert.ok(qualifiedMention.text.includes('BODY FROM B')); assert.ok(!qualifiedMention.text.includes('BODY FROM A'), 'qualified token suffix is not a local bare mention');
  const already = await prepare('fixture-collision', { alreadyInjected: local.injectedIds }); assert.ok(!already.text.includes('BODY FROM A'));
  const explicitAgain = await prepare('/skill:root:a/fixture-collision', { alreadyInjected: local.injectedIds }); assert.ok(explicitAgain.text.includes('BODY FROM A'));
  const brief = await appendNamedSkillsToBrief('brief', 'fixture-collision', { cwd: a, workspaceContext: context,
    sessionId: 'brief', budget: new SkillTurnBudget(), deps });
  assert.ok(brief.appended.includes(fileA)); assert.ok(!brief.appended.includes(fileB)); assert.ok(!brief.appended.includes('BODY FROM A'));
  const selectedBrief = await appendNamedSkillsToBrief('brief', '/skill:root:b/fixture-collision', { cwd: a, workspaceContext: context,
    sessionId: 'brief', budget: new SkillTurnBudget(), deps });
  assert.ok(selectedBrief.appended.includes(fileB)); assert.ok(!selectedBrief.appended.includes(fileA)); assert.ok(!selectedBrief.appended.includes('BODY FROM B'));
  const menu = skillsToSlashItems(skills, 'fixture-collision', 'Skill');
  assert.deepEqual(menu.map(item => item.insert).sort(), ['/skill:root:a/fixture-collision ', '/skill:root:b/fixture-collision ']);
  assert.ok(menu.some(item => item.label.includes('Alpha') && item.description.includes(a)));

  // Default/order changes retain current task scope; a new root only enters a newly captured scope.
  ws.path = b; ws.defaultRootId = 'b'; ws.roots.reverse(); ws.rootsRevision++;
  ws.roots.push({ id: 'c', path: c }); ws.rootsRevision++;
  const same = await discover(a, agentDir, context); assert.ok(!same.skills.some(skill => skill.name === 'fixture-added'));
  const next = await discover(a, agentDir, capture(cfg, session)); assert.ok(next.skills.some(skill => skill.name === 'fixture-added'));
  ws.roots = ws.roots.filter(root => root.id !== 'b' && root.id !== 'nested'); ws.defaultRootId = 'a'; ws.path = a; ws.rootsRevision++;
  const removed = await discover(a, agentDir, capture(cfg, session)); assert.ok(!removed.skills.some(skill => skill.filePath === fileB));
  assert.equal(removed.skills.find(skill => skill.filePath === fileA).commandName, 'fixture-collision');
  const invalidBrief = await appendNamedSkillsToBrief('brief', '/skill:root:b/fixture-collision', { cwd: a,
    workspaceContext: capture(cfg, session), sessionId: 'brief', budget: new SkillTurnBudget(),
    deps: { listSkills: async () => removed.skills } });
  assert.match(invalidBrief.warning, /来源已不可用/); assert.ok(!invalidBrief.appended.includes('BODY FROM A'));

  // Task-mapped skills use the task checkout, not the read-only source copy.
  writeSkill(path.join(tree, '.agents/skills'), 'fixture-collision', 'BODY FROM TASK TREE');
  const isolated = capture(cfg, { ...session, cwd: tree, worktreePath: tree, worktreeSource: { mainRepo: a } });
  assert.ok(workspaceSkillFolders(tree, isolated).includes(tree)); assert.ok(!workspaceSkillFolders(tree, isolated).includes(a));
  const taskSkills = await discover(tree, agentDir, isolated);
  const taskSkill = taskSkills.skills.find(skill => skill.name === 'fixture-collision');
  assert.ok(taskSkill.filePath.startsWith(tree)); assert.deepEqual(taskSkill.source.rootIds, ['a']);

  // Cached metadata cannot read a different file after a symlink is retargeted.
  const linkDir = path.join(a, '.agents/skills/linked-fixture-root'); fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  const oneDir = path.join(a, 'skills-one'); const twoDir = path.join(outside, 'skills-two');
  writeSkill(oneDir, 'fixture-linked', 'SAFE LINK BODY'); writeSkill(twoDir, 'fixture-linked', 'RETARGETED BODY');
  fs.symlinkSync(oneDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await discover(a, agentDir, capture(cfg, session)); const linkedSkill = linked.skills.find(skill => skill.name === 'fixture-linked');
  fs.unlinkSync(linkDir); fs.symlinkSync(twoDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  const denied = await prepareEngineSkillText('/skill:fixture-linked', { cwd: a, workspaceContext: context, sessionId: 'worker',
    budget: new SkillTurnBudget(), deps: { listSkills: async () => [linkedSkill] } });
  assert.match(denied.warning, /identity changed/); assert.ok(!denied.text.includes('RETARGETED BODY')); assert.deepEqual(denied.injectedIds, []);

  // A whole project skill directory may alias the already discovered global directory.
  // Physical deduplication keeps the global entry, but every equivalent path must share
  // its read grant without widening it to adjacent files or nested link destinations.
  {
    const aliasProject = path.join(temp, 'alias-project');
    fs.mkdirSync(path.join(aliasProject, '.agents'), { recursive: true });
    const globalSkills = path.join(isolatedHome, '.agents', 'skills');
    const aliasRoot = path.join(aliasProject, '.agents', 'skills');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(globalSkills, aliasRoot, linkType);
    const aliasWorkspace = { id: 'alias-ws', name: 'Alias', path: aliasProject, controlRoot: aliasProject,
      defaultRootId: 'alias', rootsRevision: 1, roots: [{ id: 'alias', path: aliasProject }] };
    const aliasConfig = { workspaces: [aliasWorkspace], activeWorkspaceId: 'alias-ws' };
    const aliasScope = capture(aliasConfig, { ...session, workspaceId: 'alias-ws', cwd: aliasProject });
    const aliasFound = await discover(aliasProject, agentDir, aliasScope);
    const published = aliasFound.loader.getSkills().skills.filter(skill => skill.name === 'fixture-user');
    assert.equal(published.length, 1, 'global and project directory aliases publish one physical skill');
    assert.ok(!published[0].filePath.startsWith(aliasProject), 'the published entry uses the global path');
    const packageRoot = path.dirname(published[0].filePath);
    fs.mkdirSync(path.join(packageRoot, 'references'));
    fs.writeFileSync(path.join(packageRoot, 'references', 'usage.md'), 'reference');
    fs.writeFileSync(path.join(outside, 'not-a-skill.txt'), 'outside');
    fs.symlinkSync(outside, path.join(packageRoot, 'escape'), linkType);
    const shortcut = path.join(aliasProject, 'documentation-shortcut');
    fs.symlinkSync(packageRoot, shortcut, linkType);
    let guiCall, schedulerCall;
    const getSkills = () => aliasFound.loader.getSkills().skills;
    createPiApprovalExtension({ sessionId: 'worker', cwd: aliasProject, workspaceContext: aliasScope, getSkills,
      getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }),
      hostToolIds: [], hostClassOf: () => 'read', log: () => {} })({ on: (_event, callback) => { guiCall = callback; } });
    createSchedulerDirectoryExtension({ config: { get: () => aliasConfig } }, aliasScope, getSkills)(
      { on: (_event, callback) => { schedulerCall = callback; } });
    const invoke = (handler, toolName, target) => handler({ toolName, toolCallId: 'skill-alias', input: { path: target } });
    for (const handler of [guiCall, schedulerCall]) {
      for (const alias of [path.join(aliasRoot, 'fixture-user'), shortcut]) {
        assert.equal(await invoke(handler, 'read', path.join(alias, 'SKILL.md')), undefined, 'a deduplicated package alias is readable');
        assert.equal(await invoke(handler, 'read', path.join(alias, 'references', 'usage.md')), undefined, 'references share the package read scope through aliases');
        assert.equal((await invoke(handler, 'read', path.join(alias, 'escape', 'not-a-skill.txt'))).block, true, 'an alias cannot read a nested link outside the package');
        assert.equal((await invoke(handler, 'write', path.join(alias, 'SKILL.md'))).block, true, 'an alias read grant never permits writing');
      }
    }
    assert.equal(canReadDiscoveredSkill(path.join(shortcut, 'SKILL.md'), []), false, 'an undiscovered alias has no read grant');
    const replacementRoot = path.join(outside, 'replacement-global');
    writeSkill(replacementRoot, 'fixture-user', 'UNPUBLISHED REPLACEMENT');
    fs.unlinkSync(aliasRoot); fs.symlinkSync(replacementRoot, aliasRoot, linkType);
    for (const handler of [guiCall, schedulerCall]) {
      assert.equal((await invoke(handler, 'read', path.join(aliasRoot, 'fixture-user', 'SKILL.md'))).block, true, 'retargeting an alias cannot reuse the old physical package grant');
      assert.equal(await invoke(handler, 'read', published[0].filePath), undefined, 'retargeting an unrelated alias does not revoke the unchanged published package');
    }
    fs.unlinkSync(path.join(packageRoot, 'escape'));
  }

  // Existing project links to external skill packages remain supported. Discovery
  // publishes the link identity and must revoke that grant if the link is retargeted.
  {
    const hostFixture = path.join(temp, 'host-domain-fixture');
    writeSkill(hostFixture, 'browser', 'HOST DOMAIN SKILL BODY');
    fs.symlinkSync(path.join(hostFixture, 'browser'), path.join(a, '.agents/skills', 'browser'), process.platform === 'win32' ? 'junction' : 'dir');
    const hostFound = await discover(a, agentDir, capture(cfg, session));
    const hostSkill = hostFound.skills.find(skill => skill.name === 'browser');
    assert.ok(hostSkill, 'host domain skill is discoverable through the delivered link');
    assert.equal(fs.realpathSync(hostSkill.filePath), fs.realpathSync(path.join(hostFixture, 'browser', 'SKILL.md')));
    const hostInjected = await prepareEngineSkillText('/skill:browser', { cwd: a, workspaceContext: context, sessionId: 'worker',
      budget: new SkillTurnBudget(), deps: { listSkills: async () => hostFound.skills } });
    assert.ok(hostInjected.text.includes('HOST DOMAIN SKILL BODY'), 'body loads through the link');
    const hostDir = path.dirname(hostSkill.filePath);
    fs.mkdirSync(path.join(hostFixture, 'browser', 'references'));
    fs.writeFileSync(path.join(hostFixture, 'browser', 'references', 'usage.md'), 'reference');
    fs.writeFileSync(path.join(hostFixture, 'neighbor.txt'), 'outside skill');
    fs.symlinkSync(hostFixture, path.join(hostFixture, 'browser', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    let guiCall, schedulerCall;
    const scope = capture(cfg, session);
    const skills = () => hostFound.loader.getSkills().skills;
    createPiApprovalExtension({ sessionId: 'worker', cwd: a, workspaceContext: scope, getSkills: skills,
      getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }),
      hostToolIds: [], hostClassOf: () => 'read', log: () => {} })({ on: (_event, callback) => { guiCall = callback; } });
    createSchedulerDirectoryExtension({ config: { get: () => cfg } }, scope, skills)(
      { on: (_event, callback) => { schedulerCall = callback; } });
    const invoke = (handler, toolName, target) => handler({ toolName, toolCallId: 'skill-access', input: { path: target } });
    for (const handler of [guiCall, schedulerCall]) {
      assert.equal(await invoke(handler, 'read', hostSkill.filePath), undefined, 'discovered junction skill is readable');
      assert.equal(await invoke(handler, 'read', path.join(hostFixture, 'browser', 'SKILL.md')), undefined, 'physical skill path is readable');
      assert.equal(await invoke(handler, 'read', path.join(hostDir, 'references', 'usage.md')), undefined, 'skill references are readable');
      assert.equal((await invoke(handler, 'read', path.join(hostFixture, 'neighbor.txt'))).block, true, 'neighbor is not granted');
      assert.equal((await invoke(handler, 'read', path.join(hostDir, 'escape', 'neighbor.txt'))).block, true, 'nested junction cannot escape');
      assert.equal((await invoke(handler, 'write', hostSkill.filePath)).block, true, 'skill read grant never enables writes');
    }
    assert.equal(canReadDiscoveredSkill(hostSkill.filePath, []), false, 'unpublished or disabled skill has no grant');
    const deniedByRule = decideToolCallPermission({ mode: 'auto', planExecuting: false, engineToolName: 'read',
      input: { path: hostSkill.filePath }, cwd: a, workspaceContext: scope, hostToolIds: [], hostClassOf: () => 'read',
      allowSkillRead: file => canReadDiscoveredSkill(file, skills()),
      userRules: [{ id: 'deny-read', tool: 'read', action: 'deny' }] });
    assert.equal(deniedByRule.decision, 'deny', 'skill grant does not override an explicit deny rule');
    assert.equal(deniedByRule.ruleId, 'deny-read');
    const hostLink = path.join(a, '.agents/skills', 'browser');
    const replacement = path.join(temp, 'replacement-browser'); fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, 'SKILL.md'), '---\nname: browser\ndescription: replacement browser\n---\nreplacement');
    fs.unlinkSync(hostLink); fs.symlinkSync(replacement, hostLink, process.platform === 'win32' ? 'junction' : 'dir');
    for (const handler of [guiCall, schedulerCall]) {
      assert.equal((await invoke(handler, 'read', hostSkill.filePath)).block, true, 'retargeted skill link is denied until rediscovery');
    }
    await hostFound.loader.reload({ resolveProjectTrust: async () => true });
    for (const handler of [guiCall, schedulerCall]) {
      assert.equal(await invoke(handler, 'read', hostSkill.filePath), undefined, 'rediscovery publishes the new skill identity');
    }
  }

  // Actual listAgentSkills uses a scope key rather than the previous cwd-only short cache.
  compile('main/agent/skillsList.ts');
  fs.writeFileSync(path.join(compiled, 'main/agent/piElectronCompat.mjs'), 'export const patchElectronForPi = () => {};');
  const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
  const shim = path.join(compiled, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(shim, 'index.js'), `export * from ${JSON.stringify(sdkUrl)};`);
  const { listAgentSkills } = await load('main/agent/skillsList.ts');
  // Remove the intentionally retargeted fixture before this fresh native discovery.
  fs.unlinkSync(linkDir);
  const cachedBefore = await listAgentSkills(a, capture(cfg, session)); assert.ok(!cachedBefore.some(skill => skill.name === 'fixture-b-only'));
  ws.roots.push({ id: 'b', path: b }); ws.rootsRevision++;
  const cachedAfter = await listAgentSkills(a, capture(cfg, session)); assert.ok(cachedAfter.some(skill => skill.name === 'fixture-b-only'));
  console.log('workspace-skills: native discovery/qualified collision recovery, physical dedup, source-local injection, task copies, revocation and scope cache passed');
} finally { os.homedir = originalHome; syncBuiltinESMExports(); fs.rmSync(temp, { recursive: true, force: true }); }
