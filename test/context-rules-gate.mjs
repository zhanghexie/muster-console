import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-gate-'));
const compile = createSharedCompiler(root, tmp);

const { materializeGuiWorkerPrompt } = await import(pathToFileURL(compile('main/agentSession/prompt.ts')).href);
const { renderAgentRulesSection } = await import(pathToFileURL(compile('shared/agentConduct.ts')).href);
const { renderWorkerDirectoryScope } = await import(pathToFileURL(compile('shared/workspaceExecutionContext.ts')).href);

try {
  const work = path.join(tmp, 'workspace');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'Only the native engine reads this project document.');
  const rules = [{ id: 'host', enabled: true, text: 'Follow the currently configured host rule.' }];
  const context = { mappings: [{ sourcePath: work, worktreePath: work + '-task' }] };
  for (const runtimeId of ['pi', 'claude', 'codex-gui', 'acp', 'pi-external', 'zcode-gui']) {
    const toolset = { runtimeId, hostTools: [{ id: 'host.sessions.setStatus' }] };
    const { text: prompt, policy } = materializeGuiWorkerPrompt({ id: 'worker', cwd: work, worktreePath: work + '-task' }, 'default', toolset, {
      rules, workspaceContext: context, workspaceSection: 'Fixture workspace scope', memorySection: 'Existing workspace preference',
      piLoadsProjectContext: true
    });
    assert.match(prompt, /Your session ID in Muster is worker\.[\s\S]*Fixture workspace scope[\s\S]*host_sessions_setStatus/);
    assert.doesNotMatch(policy, /Fixture workspace scope/);
    assert.doesNotMatch(prompt, /AGENTS\.md|CLAUDE\.md/);
    assert.match(prompt, /Follow the currently configured host rule/);
    assert.match(prompt, /assigned isolated worktree/);
    assert.doesNotMatch(prompt, /Only the native engine|Assigned worktree|Current directory|Registered Tools/);
    assert.equal(prompt.includes('Existing workspace preference'), runtimeId !== 'pi', 'Pi supplies memory through its turn hooks');
  }
  const session = { id: 'worker', cwd: work };
  const piTools = { runtimeId: 'pi', hostTools: [] };
  fs.writeFileSync(path.join(work, 'AGENTS.md'), renderAgentRulesSection(rules));
  const nativeContext = materializeGuiWorkerPrompt(session, 'default', piTools, { rules, piLoadsProjectContext: true });
  assert.doesNotMatch(nativeContext.text, /Follow the currently configured host rule/);
  for (const [runtimeId, piLoadsProjectContext] of [['pi', false], ['acp', true]]) {
    const { text } = materializeGuiWorkerPrompt(session, 'default', { ...piTools, runtimeId }, { rules, piLoadsProjectContext });
    assert.match(text, /Follow the currently configured host rule/);
  }
  const rootDirectory = { path: work, physicalPath: work };
  const attachmentPath = path.join(tmp, 'attachments');
  const sharedRoot = {
    workspaceId: 'ws', workspaceName: 'Fixture', rootsRevision: 7, sourceRootId: 'root',
    cwd: work, controlRoot: work, controlPhysicalPath: work,
    roots: [{ rootId: 'root', path: work, label: 'Project' }],
    readableDirectories: [rootDirectory, { path: attachmentPath, physicalPath: attachmentPath }],
    writableDirectories: [rootDirectory],
    mappings: []
  };
  const compact = renderWorkerDirectoryScope(sharedRoot, 'engine note');
  assert.ok(compact.includes(`Source root root (Project) (rev 7), cwd: ${JSON.stringify(work)} (read/write, management root).`));
  assert.ok(compact.includes(`Additional read-only directories: ${JSON.stringify(attachmentPath)}.`));
  assert.doesNotMatch(compact, /Source folders|Read\/write directories:/);
  assert.match(renderWorkerDirectoryScope(sharedRoot, '', 'cli'), /Source folders[\s\S]*Read\/write directories: cwd\./);
  assert.match(renderWorkerDirectoryScope({
    ...sharedRoot, mappings: [{ rootId: 'root', sourcePath: work, worktreePath: work + '-task' }]
  }, ''), /Source folders[\s\S]*Isolation mappings/);
  console.log('ok: project rules are owned by the repository and live host rules travel with the Worker');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
