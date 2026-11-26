import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-leaf-routing-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const load = async f => import(pathToFileURL(compile('main/' + f)).href);
  const { backdropsDir } = await load('frameBackdropFiles.ts');
  const { userAvatarFilePath } = await load('userAvatarFile.ts');
  const { handoverSessionDirectory } = await load('handover/paths.ts');
  const { instancePortsPath, loadInstancePorts, saveInstancePorts } = await load('instance/portsFile.ts');
  const { extensionDataDirectory } = await load('extensions/extensionData.ts');
  const id = '00000000-0000-4000-8000-000000000001';
  const manifest = { id: 'demo', scope: 'global', data: { shared: true } };
  const root = path.join(temp, 'current');
  assert.equal(backdropsDir(root), path.join(root, 'backdrops'));
  assert.equal(userAvatarFilePath(root), path.join(root, 'avatars', 'user.png'));
  assert.equal(handoverSessionDirectory(root, id), path.join(root, 'session-handovers', id));
  assert.equal(extensionDataDirectory(root, 'workspace', manifest, 'shared'), path.join(root, 'extension', 'data', 'shared', 'global', 'demo'));
  saveInstancePorts(root, { instanceId: id, shellApiPort: 1234 });
  assert.equal(instancePortsPath(root), path.join(root, 'instance-ports.json'));
  assert.equal(loadInstancePorts(root).shellApiPort, 1234);
  const old = path.join(temp, 'metaagent-workbench');
  for (const action of [() => backdropsDir(old), () => userAvatarFilePath(old), () => handoverSessionDirectory(old, id),
    () => extensionDataDirectory(old, 'workspace', manifest), () => loadInstancePorts(old),
    () => saveInstancePorts(old, { instanceId: id })]) assert.throws(action, /legacy product storage/);
  assert.equal(fs.existsSync(old), false, 'even instance-port save refuses before mkdir');
  console.log('Storage leaves: in-place layout, extension ownership, port roundtrip and pre-access legacy refusal passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
