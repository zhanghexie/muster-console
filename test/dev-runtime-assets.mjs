import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyRuntimeBuiltins } from '../scripts/run-electron-vite.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-runtime-assets-'));
try {
  const source = path.join(root, 'src');
  const destination = path.join(root, 'out');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'registry.json'), '{"runtimes":[]}');
  fs.writeFileSync(path.join(source, 'scripts', 'fixture.mjs'), 'export default 1;');
  copyRuntimeBuiltins(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'registry.json'), 'utf8'), '{"runtimes":[]}');
  assert.equal(fs.readFileSync(path.join(destination, 'scripts', 'fixture.mjs'), 'utf8'), 'export default 1;');
  console.log('dev-runtime-assets: passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
