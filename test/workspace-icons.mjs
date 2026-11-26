import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-icons-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { WORKSPACE_ICONS, DEFAULT_WORKSPACE_ICON, workspaceIconId, workspaceIconValue } = await import(pathToFileURL(compile('shared/workspaceIcons.ts')).href);
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')).href);
  assert.equal(WORKSPACE_ICONS.length, 36); assert.equal(new Set(WORKSPACE_ICONS.map(i => i.id)).size, 36);
  assert.equal(new Set(WORKSPACE_ICONS.map(i => i.label)).size, 36);
  assert.deepEqual(WORKSPACE_ICONS.filter(icon => !Object.hasOwn(en, icon.label)).map(icon => icon.label), [], 'workspace icon labels need English translations');
  assert.equal(workspaceIconId(DEFAULT_WORKSPACE_ICON), 'development');
  assert.equal(WORKSPACE_ICONS[24].id, 'gamepad');
  const files = fs.readdirSync(path.join(root, 'src/renderer/src/assets/workspaces'));
  assert.deepEqual(files.filter(f => f.endsWith('.webp')).sort(), WORKSPACE_ICONS.map(i => `${i.id}.webp`).sort());
  for (const icon of WORKSPACE_ICONS) {
    assert.equal(workspaceIconId(JSON.parse(JSON.stringify(workspaceIconValue(icon.id)))), icon.id);
    const data = fs.readFileSync(path.join(root, 'src/renderer/src/assets/workspaces', `${icon.id}.webp`));
    assert.equal(data.toString('ascii', 0, 4), 'RIFF'); assert.equal(data.toString('ascii', 8, 12), 'WEBP');
    assert.equal(data.toString('ascii', 12, 16), 'VP8X'); assert.ok(data[20] & 0x10, `${icon.id} transparent`);
    assert.equal(data.readUIntLE(24,3)+1,256); assert.equal(data.readUIntLE(27,3)+1,256);
  }
  for (const invalid of [undefined, '🤖', 'data:image/png;base64,AA', 'news', 'builtin-workspace:no-such-icon', 'builtin-workspace:../../file']) assert.equal(workspaceIconId(invalid), undefined);
  assert.throws(() => workspaceIconValue('unknown'), /Unknown workspace icon/);
  console.log('workspace-icons: 36 unique stable IDs, all transparent 256px assets, whitelist and gamepad passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
