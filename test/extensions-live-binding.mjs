import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-live-binding-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { resolveLiveExtensionBinding } = await import(pathToFileURL(compile('main/extensions/extensionLiveBinding.ts')).href);
  const rootPath = path.join(temp, 'workspace');
  fs.mkdirSync(rootPath, { recursive: true });
  const workspace = {
    id: 'ws', name: 'Workspace', path: rootPath, controlRoot: rootPath,
    roots: [{ id: 'root', path: rootPath }], defaultRootId: 'root', rootsRevision: 3, openedAt: 0
  };
  const manifest = { id: 'bookshelf', name: 'Bookshelf', scope: 'global', surface: { kind: 'sidebar', entry: 'ui/panel.html' } };
  const packageInfo = {
    descriptor: { scope: 'global', extensionId: 'bookshelf', directory: path.join(temp, 'package'), copiedPerWorkspace: false },
    manifest, fingerprint: 'package-extension:test', files: []
  };
  let record = { scope: 'global', extensionId: 'bookshelf', directory: packageInfo.descriptor.directory, fingerprint: packageInfo.fingerprint, enabled: true };
  let currentWorkspace = workspace;
  let activated = true;
  const dependencies = {
    catalog: { get: () => record },
    workspace: () => currentWorkspace,
    isWorkspaceActivated: () => activated,
    developmentTrust: { canRun: () => true }
  };
  const binding = await resolveLiveExtensionBinding({ workspaceId: 'ws', extensionId: 'bookshelf', scope: 'global', packageInfo }, dependencies);
  assert.equal(binding.sourceRoot.id, 'root');
  binding.assertCurrent();
  await assert.rejects(() => resolveLiveExtensionBinding({ workspaceId: 'ws', extensionId: 'bookshelf', scope: 'global', sourceRootId: 'root', packageInfo }, { ...dependencies, workspace: () => undefined }), /workspace is unavailable/);

  activated = false;
  assert.throws(() => binding.assertCurrent(), /changed/);
  activated = true;
  currentWorkspace = { ...workspace, rootsRevision: 4 };
  assert.throws(() => binding.assertCurrent(), /changed/);
  currentWorkspace = workspace;
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => binding.assertCurrent(aborted.signal), /aborted/i);

  record = { ...record, enabled: false };
  await assert.rejects(() => resolveLiveExtensionBinding({ workspaceId: 'ws', extensionId: 'bookshelf', scope: 'global', packageInfo }, dependencies), /disabled/);
  record = { ...record, enabled: true };

  const projectPath = path.join(rootPath, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const projectWorkspace = { ...workspace, roots: [{ id: 'root', path: rootPath }, { id: 'project', path: projectPath }] };
  const projectManifest = { ...manifest, scope: 'project', project: { kind: 'relative', path: 'project' } };
  const projectPackageInfo = {
    descriptor: { scope: 'project', extensionId: 'bookshelf', directory: path.join(rootPath, '.muster', 'extensions', 'bookshelf'), controlRoot: rootPath, copiedPerWorkspace: true },
    manifest: projectManifest, fingerprint: 'package-extension:project', files: []
  };
  record = { ...record, scope: 'project', fingerprint: projectPackageInfo.fingerprint, directory: projectPackageInfo.descriptor.directory, enabled: true };
  const projectBinding = await resolveLiveExtensionBinding({ workspaceId: 'ws', extensionId: 'bookshelf', scope: 'project', controlRoot: rootPath, sourceRootId: 'project', packageInfo: projectPackageInfo }, { ...dependencies, workspace: () => projectWorkspace });
  assert.equal(projectBinding.sourceRoot.id, 'project');
  await assert.rejects(() => resolveLiveExtensionBinding({ workspaceId: 'ws', extensionId: 'bookshelf', scope: 'project', controlRoot: rootPath, sourceRootId: 'root', packageInfo: projectPackageInfo }, { ...dependencies, workspace: () => projectWorkspace }), /different project/);
  console.log('extensions-live-binding: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
