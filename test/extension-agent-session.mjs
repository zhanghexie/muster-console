import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-agent-session-'));
const compile = createSharedCompiler(root, tmp);
const module = await import(pathToFileURL(compile('shared/extensionAgentSession.ts')).href);
const { extensionAgentSessionKey, isExtensionAgentSessionMeta, sameExtensionAgentSession } = module;

const binding = {
  kind: 'extension-agent',
  extensionId: 'daily-report',
  extensionInstanceId: 'daily-report:workspace-a',
  workspaceId: 'workspace-a',
  sourceRootId: 'root-a',
  packageFingerprint: 'sha256:abc',
  surfaceId: 'main',
  runtimeId: 'pi'
};

assert.equal(isExtensionAgentSessionMeta(binding), true);
assert.equal(extensionAgentSessionKey(binding), 'workspace-a:daily-report:daily-report:workspace-a:main');
assert.equal(sameExtensionAgentSession(binding, { ...binding }), true);
assert.equal(sameExtensionAgentSession(binding, { ...binding, packageFingerprint: 'sha256:def' }), false);
assert.equal(isExtensionAgentSessionMeta({ ...binding, runtimeId: 'codex' }), false);
assert.equal(isExtensionAgentSessionMeta({ ...binding, extensionId: '' }), false);

console.log('extension-agent-session: PASS');
