import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const require = createRequire(import.meta.url), root = path.resolve('.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-usage-'));
const compile = createSharedCompiler(root, tmp);
let skills;
try {
  const { CapabilityUsageService } = await import(pathToFileURL(compile('main/capabilityManagement/usage.ts')));
  const { resolveUsage } = await import(pathToFileURL(compile('shared/capabilityUsage.ts')));
  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
  const file = path.join(tmp, 'usage.json');
  let changed = 0;
  const usage = new CapabilityUsageService(file, () => changed++);
  const global = { kind: 'global' }, harness = { kind: 'harness', runtimeId: 'custom' }, workspace = { kind: 'workspace', workspaceId: 'w1' };
  const set = (scope, enabled, kind = 'skill', resourceIds = ['s']) => usage.set({ scope, kind, resourceIds, enabled, expectedRevision: usage.snapshot().revision });
  set(global, false); set(harness, true); set(workspace, true);
  assert.equal(resolveUsage(usage.snapshot(), 'skill', 's', { runtimeId: 'custom', workspaceId: 'w1' }).blockedBy, 'global');
  set(global, true); set(harness, false);
  assert.equal(usage.allows('skill', 's', { runtimeId: 'custom' }), false);
  assert.equal(usage.allows('skill', 's', { runtimeId: 'other' }), true);
  set(harness, true); set(workspace, false);
  assert.equal(usage.allows('skill', 's', { workspaceId: 'w1' }), false);
  assert.equal(usage.allows('skill', 's', { workspaceId: 'w2' }), true);
  assert.equal(new CapabilityUsageService(file).allows('skill', 's', { workspaceId: 'w1' }), false);
  set(global, false, 'mcp', ['*']);
  assert.equal(usage.allows('mcp', 'server'), false);
  assert.equal(usage.allows('skill', 'unrelated'), true);
  assert.throws(() => usage.set({ scope: global, kind: 'skill', resourceIds: ['s'], enabled: true, expectedRevision: 0 }), /变化/);
  applyLocaleSetting('en');
  assert.throws(() => usage.set({ scope: global, kind: 'skill', resourceIds: ['s'], enabled: true, expectedRevision: 0 }), /Usage settings have changed/);
  assert.throws(() => usage.set({ scope: global, kind: 'skill', resourceIds: [], enabled: true, expectedRevision: usage.snapshot().revision }), /Invalid capability usage settings/);
  applyLocaleSetting('zh-CN');
  assert.ok(changed > 0);
  // External modification is detected and loaded, never overwritten by stale revision.
  fs.writeFileSync(file, JSON.stringify({ revision: 100, disabled: [] }));
  assert.throws(() => set(global, false), /外部修改/);
  assert.equal(usage.snapshot().revision, 100);

  const shim = path.join(tmp, 'node_modules', 'yaml'); fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  fs.writeFileSync(path.join(shim, 'index.cjs'), `module.exports=require(${JSON.stringify(require.resolve('yaml'))});`);
  const { SkillsManagementService } = await import(pathToFileURL(compile('main/capabilityManagement/skills.ts')));
  const w1 = path.join(tmp, 'w1'), w2 = path.join(tmp, 'w2'); fs.mkdirSync(w1); fs.mkdirSync(w2);
  const home = path.join(tmp, 'home'), source = path.join(home, '.agents', 'skills', 'demo', 'SKILL.md');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, '---\nname: demo\ndescription: demo\n---\nbody');
  skills = new SkillsManagementService({ homeDir: home, userDataDir: path.join(tmp, 'data'), watch: false,
    isUsageAllowed: (id, runtimeId, projects) => usage.allows('skill', id, { runtimeId, workspaceId: projects[0] ? path.basename(projects[0]) : undefined }) });
  const asset = skills.list(global).skills[0]; assert.ok(asset);
  assert.equal(skills.filterRuntimeSkills([{ filePath: source }], 'custom-gui', [w1]).length, 1);
  const skillHarness = { kind: 'harness', runtimeId: 'custom-gui' };
  set(workspace, false, 'skill', [asset.id]);
  assert.equal(skills.filterRuntimeSkills([{ filePath: source }], 'custom-gui', [w1]).length, 0);
  assert.equal(skills.filterRuntimeSkills([{ filePath: source }], 'custom-gui', [w2]).length, 1);
  set(skillHarness, false, 'skill', ['*']);
  assert.deepEqual(skills.additionalSkillPaths([], 'custom-gui'), []);
  assert.equal(skills.filterRuntimeSkills([{ filePath: source }], 'custom-gui', [w2]).length, 0);
  assert.ok(fs.existsSync(source));

  // capability-management F-01：损坏的 capability-usage.json 不得让构造器 throw
  // （否则中断 IPC 注册链，其后 handler 全不注册）；照 skills store 范式降级空策略
  // （fail-open）+ startupError 写入口拒绝覆盖，原坏文件保留现场。还原修复即红。
  const corruptFile = path.join(tmp, 'corrupt-usage.json');
  fs.writeFileSync(corruptFile, '{"revision":1,"disabled":[{"kind":"skill"', 'utf8');
  const degraded = new CapabilityUsageService(corruptFile, () => changed++);
  assert.equal(degraded.snapshot().revision, 0, '损坏后降级空策略');
  assert.deepEqual(degraded.snapshot().disabled, [], '损坏后无任何禁用规则');
  assert.equal(degraded.allows('skill', 'anything'), true, '降级期间 fail-open 不误伤能力');
  assert.ok(degraded.getStartupError().includes('无法读取能力使用设置'), 'startupError 显式可查');
  assert.throws(() => degraded.set({ scope: global, kind: 'skill', resourceIds: ['s'], enabled: false, expectedRevision: 0 }), /无法读取能力使用设置/);
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{"revision":1,"disabled":[{"kind":"skill"', '坏文件保留现场不被覆盖');

  console.log('capability usage persistence, precedence, isolation, and real skill filtering passed');

  const bundle = path.join(tmp, 'relay.mjs');
  await require('esbuild').build({ stdin: { contents: `export {mcpHost,closeAllMcpRelayHubs} from './src/main/capabilities/hosts/mcp'; export {CapabilityUsageService,setCapabilityUsageService} from './src/main/capabilityManagement/usage'; export {runAsAgentSession} from './src/main/agent/agentScope';`, resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: [{ name: 'hub-boundary', setup(build) {
    build.onLoad({ filter: /agent[\\/]mcpHub\.ts$/ }, () => ({ contents: `export class McpHub {
      constructor(cfg){this.cfg=cfg;} enabledServers(){return this.cfg.servers.filter(s=>s.enabled);}
      async listAllTools(names){return this.enabledServers().filter(s=>!names||names.has(s.name)).map(s=>({server:s.name,name:'run',description:'demo',inputSchema:{}}));}
      async describeTool(server){return {server,name:'run',description:'demo',inputSchema:{}};}
      async callToolResult(server,tool,args,beforeCall){await globalThis.__beforeUsageCall?.();beforeCall?.();globalThis.__usageCalls++;return {text:'ok',isError:false};}
      async close(){}
    }`, loader: 'ts' }));
  } }] });
  const relay = await import(pathToFileURL(bundle));
  const relayUsage = new relay.CapabilityUsageService(path.join(tmp, 'relay-usage.json')); relay.setCapabilityUsageService(relayUsage);
  const config = { mcp: { enabled: true, servers: [{ name: 'one', enabled: true }, { name: 'two', enabled: true }] } };
  const sessions = { a: { workspaceId: 'w1', runtime: 'custom' }, b: { workspaceId: 'w1', runtime: 'other' } };
  const ctx = { config: { get: () => config, effectiveMcp: () => config.mcp }, sessions: { get: id => sessions[id] }, resolveBubbleWorkspaceId: () => 'w1' };
  const toggle = (scope, id, enabled) => relayUsage.set({ scope, kind: 'mcp', resourceIds: [id], enabled, expectedRevision: relayUsage.snapshot().revision });
  toggle(harness, 'one', false);
  const search = await relay.runAsAgentSession('a', () => relay.mcpHost['mcp.search'](ctx, {}));
  assert.ok(!JSON.stringify(search).includes('"one"')); assert.ok(JSON.stringify(search).includes('"two"'));
  await assert.rejects(relay.runAsAgentSession('a', () => relay.mcpHost['mcp.call'](ctx, { server: 'one', tool: 'run', runtimeId: 'other' })), /Unknown MCP/);
  globalThis.__usageCalls = 0;
  assert.equal(await relay.runAsAgentSession('b', () => relay.mcpHost['mcp.call'](ctx, { server: 'one', tool: 'run' })), 'ok');
  assert.equal(globalThis.__usageCalls, 1);
  globalThis.__beforeUsageCall = () => { toggle(workspace, 'two', false); };
  await assert.rejects(relay.runAsAgentSession('a', () => relay.mcpHost['mcp.call'](ctx, { server: 'two', tool: 'run' })), /disabled/);
  assert.equal(globalThis.__usageCalls, 1, 'disable during connection cannot dispatch a tool');
  delete globalThis.__beforeUsageCall; delete globalThis.__usageCalls;
  relay.closeAllMcpRelayHubs(); relay.setCapabilityUsageService(undefined);
  console.log('MCP trusted caller, discovery, known-name bypass, and pre-dispatch checks passed');
} finally { skills?.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); }
