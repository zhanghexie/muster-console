import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-runtime-storage-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const load = f => import(pathToFileURL(compile('main/' + f)).href);
  const { StorageInventory } = await load('storage/inventory.ts');
  const { RuntimeHost } = await load('runtime/host.ts');
  const { EvidenceCollector } = await load('sessions/evidence.ts');
  const { HarnessModelSelectionStore } = await load('agentSession/harnessModelSelectionStore.ts');
  const { createSafetyService } = await load('safety/service.ts');
  const { setAlwaysRulesUserDataDir } = await load('capabilities/alwaysRules.ts');
  const mail = await load('metaAgent/messageStore.ts');
  const root = path.join(temp, 'current');
  assert.equal(new RuntimeHost({ userDataDir: root, builtinsDir: 'unused' }).rootDir, path.join(root, 'agent-runtimes'));
  mail.setAgentMessagesUserDataDir(root);
  assert.equal(mail.agentMessagesFilePath('workspace'), path.join(root, 'agent-messages', 'workspace.sqlite'));
  assert.deepEqual(new HarnessModelSelectionStore(root).read(), {});
  const old = path.join(temp, 'metaagent-workbench');
  for (const action of [
    () => new StorageInventory({ userData: old }),
    () => new RuntimeHost({ userDataDir: old, builtinsDir: 'unused' }),
    () => new EvidenceCollector({ userDataDir: old, getPtyTail: () => undefined, isBrowserShotEnabled: () => false }),
    () => new HarnessModelSelectionStore(old),
    () => createSafetyService({ userDataPath: old, reviewer: async () => { throw new Error('must not review'); } }),
    () => setAlwaysRulesUserDataDir(old),
    () => { mail.setAgentMessagesUserDataDir(old); return mail.agentMessagesFilePath('workspace'); }
  ]) assert.throws(action, /legacy product storage/);
  assert.equal(fs.existsSync(old), false);
  console.log('Runtime storage domains: stable runtime/mailbox layout and pre-access root refusal passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
