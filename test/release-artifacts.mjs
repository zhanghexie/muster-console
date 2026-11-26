import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const script = path.join(root, 'scripts', 'verify-release-artifacts.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-artifacts-'));

try {
  fs.writeFileSync(path.join(temp, `MetaAgent-${version}-Setup.exe`), 'windows');
  fs.writeFileSync(path.join(temp, `muster_${version}_x64.deb`), 'linux');
  execFileSync(process.execPath, [script, temp], { cwd: root, stdio: 'pipe' });
  const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.artifacts.map(item => item.file), [`MetaAgent-${version}-Setup.exe`, `muster_${version}_x64.deb`]);

  const invalid = path.join(temp, 'invalid');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'Muster-Setup.exe'), 'missing-version');
  assert.throws(() => execFileSync(process.execPath, [script, invalid], { cwd: root, stdio: 'pipe' }), /missing package version/);
  console.log('release-artifacts: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
