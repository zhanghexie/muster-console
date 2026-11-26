/**
 * .muster scaffold 纯 FS 单测。
 * 运行: node test/metaagent-scaffold.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metaagent-scaffold-compile-'));
const compile = createSharedCompiler(root, compileTmp);
// 树式转译：scaffold 及其依赖（hostProtocol/workspaceFile/shared/i18n…）自动镜像带上
const entry = compile('main/metaAgent/scaffold.ts');

const {
  ensureMetaAgentScaffold,
  readWorkspaceFile,
  patchWorkspaceFile
} = await import(pathToFileURL(entry).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metaagent-scaffold-ws-'));
try {
  const r1 = ensureMetaAgentScaffold(tmp);
  assert.equal(r1.created, true);
  assert.equal(r1.path, path.join(tmp, '.muster'));

  assert.ok(fs.existsSync(path.join(tmp, '.muster', 'manifest.json')));
  assert.equal(fs.existsSync(path.join(tmp, '.muster', 'HOST.md')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.muster', 'HOST-EXT.md')), false);
  assert.ok(fs.existsSync(path.join(tmp, '.muster', '.gitignore')));
  assert.ok(fs.existsSync(path.join(tmp, '.muster', 'workspace.json')));
  assert.equal(fs.existsSync(path.join(tmp, '.muster', 'skills', 'metaagent-host')), false);

  // Host-owned authoring contracts are provisioned to ~/.muster/skills and
  // are never seeded into a project .agents/skills root.
  assert.equal(fs.existsSync(path.join(tmp, '.agents', 'skills', 'muster-extensions')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.agents', 'skills', 'ui-widget-design')), false);
  for (const dir of ['extensions', 'workflows']) {
    assert.equal(fs.existsSync(path.join(tmp, '.muster', dir, 'README.md')), false, `fresh workspaces do not seed the ${dir} guide`);
  }

  const oldExtensionReadme = fs.readFileSync(path.join(root, 'test/fixtures/retired-extension-readme.md'), 'utf8').replace(/\r\n/g, '\n');
  const existingWorkspace = path.join(tmp, 'existing');
  const extensionReadme = path.join(existingWorkspace, '.muster', 'extensions', 'README.md');
  const customReadme = path.join(existingWorkspace, '.muster', 'workflows', 'README.md');
  const workflowScript = path.join(path.dirname(customReadme), 'my-workflow', 'run.mjs');
  fs.mkdirSync(path.dirname(extensionReadme), { recursive: true });
  fs.mkdirSync(path.dirname(workflowScript), { recursive: true });
  fs.writeFileSync(extensionReadme, oldExtensionReadme.replace(/\n/g, '\r\n'));
  fs.writeFileSync(customReadme, '<!-- x-muster-readme: workflows -->\n\nMy workflow notes.\n');
  fs.writeFileSync(workflowScript, 'export default async () => 42;');
  ensureMetaAgentScaffold(existingWorkspace);
  assert.equal(fs.existsSync(extensionReadme), false, 'an unchanged copy of the retired extension guide is removed');
  assert.match(fs.readFileSync(customReadme, 'utf8'), /My workflow notes/);
  assert.equal(fs.readFileSync(workflowScript, 'utf8'), 'export default async () => 42;');
  fs.writeFileSync(extensionReadme, oldExtensionReadme + '\n\nLocal notes.');
  ensureMetaAgentScaffold(existingWorkspace);
  assert.match(fs.readFileSync(extensionReadme, 'utf8'), /Local notes/);

  const outside = path.join(tmp, 'outside');
  const linkedWorkspace = path.join(tmp, 'linked');
  const linkedExtensions = path.join(linkedWorkspace, '.muster', 'extensions');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.dirname(linkedExtensions), { recursive: true });
  fs.writeFileSync(path.join(outside, 'README.md'), oldExtensionReadme);
  fs.symlinkSync(outside, linkedExtensions, process.platform === 'win32' ? 'junction' : 'dir');
  ensureMetaAgentScaffold(linkedWorkspace);
  assert.equal(fs.readFileSync(path.join(outside, 'README.md'), 'utf8'), oldExtensionReadme, 'cleanup cannot follow a directory link out of the workspace');

  // 旧任务文件不再生成；既有私有数据仍继续忽略且不覆盖（进 .muster/.gitignore
  // 不随仓同步）+ 幂等不覆盖
  const tasksPath = path.join(tmp, '.muster', 'tasks.json');
  assert.equal(fs.existsSync(tasksPath), false, '不再播种共享任务表');
  assert.match(
    fs.readFileSync(path.join(tmp, '.muster', '.gitignore'), 'utf8'),
    /tasks\.json/,
    'tasks.json 是本地运行时状态，进 .gitignore（R-05）'
  );
  // 已有数据不覆盖；删除后 ensure（含快速路径）不重建
  fs.writeFileSync(tasksPath, JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'k', title: '手写', status: 'todo' }] }), 'utf8');
  ensureMetaAgentScaffold(tmp);
  assert.equal(JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks[0].title, '手写');
  fs.rmSync(tasksPath);
  ensureMetaAgentScaffold(tmp);
  assert.equal(fs.existsSync(tasksPath), false, '旧文件删除后不重建');

  const gitignore = fs.readFileSync(path.join(tmp, '.muster', '.gitignore'), 'utf8');
  assert.match(gitignore, /runtime\.json/);
  assert.match(gitignore, /local\//);
  // 发布前 schema v1：留言账本改为 userData 下的 SQLite，scaffold 不再生成
  // .muster/messages.json——gitignore 行移除（还原即红：scaffold 回退即本行转红）
  assert.doesNotMatch(gitignore, /messages\.json/, 'R-17：留言账本不落工作区，gitignore 无此行');
  assert.match(gitignore, /tasks\.json/, '任务表（R-05）本地运行时状态不进 git');
  assert.match(gitignore, /tasks-archive\.json/, 'R-07：归档文件同主表语义进 gitignore');
  // memory/=记忆派生态库 state.sqlite（memory-refactor §4.2 纯派生索引，删库可重建）
  // 不进 git（还原即红：DIR_GITIGNORE 回退掉 memory/ 行即本行转红——B1 评审 MAJOR）
  assert.match(gitignore, /memory\//, '记忆派生库 .muster/memory/ 是本地运行时状态，进 gitignore');

  for (const name of ['AGENTS.md', 'CLAUDE.md', 'agent.md']) {
    assert.equal(fs.existsSync(path.join(tmp, name)), false, 'scaffolding never creates harness instructions');
  }

  const userDoc = path.join(tmp, 'AGENTS.md');
  fs.writeFileSync(userDoc, '# Project instructions\r\n');
  const r2 = ensureMetaAgentScaffold(tmp);
  assert.equal(r2.created, false);
  assert.equal(fs.readFileSync(userDoc, 'utf8'), '# Project instructions\r\n');

  // workspace.json merge：改 sideToolsTab 后再 ensure，不被默认覆盖
  const wfPath = path.join(tmp, '.muster', 'workspace.json');
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  wf.sideToolsTab = 'git';
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
  ensureMetaAgentScaffold(tmp);
  assert.equal(JSON.parse(fs.readFileSync(wfPath, 'utf8')).sideToolsTab, 'git');

  // read / patch
  const read = readWorkspaceFile(tmp);
  assert.equal(read.sideToolsTab, 'git');
  const patched = patchWorkspaceFile(tmp, { filesTreeOpen: false, git: { repoSort: 'mtime' } });
  assert.equal(patched.filesTreeOpen, false);
  assert.equal(patched.git.repoSort, 'mtime');
  assert.equal(patched.git.repoListOpen, true);
  assert.equal(patched.sideToolsTab, 'git');

  // Workspace scaffolding no longer generates or discovers endpoint files.
  assert.equal(fs.existsSync(path.join(tmp, '.muster', 'runtime.json')), false);

  // A legacy generated document is retired, including when it contains configured rules.
  const oldCore = fs.readFileSync(path.join(root, 'test/fixtures/retired-host-protocol.md'), 'utf8').replace(/\r\n/g, '\n');
  const oldHostPath = path.join(existingWorkspace, '.muster', 'HOST.md');
  const customHostPath = path.join(linkedWorkspace, '.muster', 'HOST.md');
  fs.writeFileSync(oldHostPath, (oldCore + '\n## Global Conduct Rules (user-set; must be followed)\n1. Existing rule\n').replace(/\n/g, '\r\n'));
  const customHost = oldCore.replace('## Status phases', '## Project-specific status');
  fs.writeFileSync(customHostPath, customHost);
  const restarted = await import(pathToFileURL(entry).href + '?restart');
  restarted.ensureMetaAgentScaffold(existingWorkspace);
  restarted.ensureMetaAgentScaffold(linkedWorkspace);
  assert.equal(fs.existsSync(oldHostPath), false, 'the previous core document is removed on upgrade');
  assert.equal(fs.readFileSync(customHostPath, 'utf8'), customHost, 'a modified core is preserved');
  assert.match(fs.readFileSync(extensionReadme, 'utf8'), /Local notes./);

  // 清掉旧 skills/metaagent-host
  const legacy = path.join(tmp, '.muster', 'skills', 'metaagent-host');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy', 'utf8');
  ensureMetaAgentScaffold(tmp);
  assert.equal(fs.existsSync(legacy), false);

  // The scaffold does not create a project skill root for host-owned contracts.
  assert.equal(fs.existsSync(path.join(tmp, '.agents', 'skills')), false);

  console.log('metaagent-scaffold: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(compileTmp, { recursive: true, force: true });
}
