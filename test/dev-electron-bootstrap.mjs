import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const temp = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'muster dev electron '));
assert.equal(path.dirname(fs.realpathSync(root)), temp);

function writeFixture(name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runDev(env = {}) {
  return spawnSync(process.execPath, ['scripts/dev.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      ELECTRON_EXEC_PATH: '',
      ELECTRON_OVERRIDE_DIST_PATH: '',
      TEST_ELECTRON_BINARY: '',
      ...env
    }
  });
}

try {
  writeFixture('scripts/free-dev-port.mjs', 'export const rendererDevPort = () => 5188; export const freeDevPorts = () => {};');
  for (const name of ['dev.mjs', 'run-electron-vite.mjs']) {
    fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
  }
  writeFixture('src/main/runtime/builtins/registry.json', '{"runtimes":[]}');
  fs.mkdirSync(path.join(root, 'src/main/runtime/builtins/scripts'));

  // Use Electron's real entry point with an offline installer fixture.
  const electronDir = path.join(root, 'node_modules/electron');
  fs.mkdirSync(electronDir, { recursive: true });
  fs.copyFileSync(require.resolve('electron'), path.join(electronDir, 'index.js'));
  writeFixture('node_modules/electron/install.js', `
    const fs = require('node:fs');
    const path = require('node:path');
    const binary = process.env.TEST_ELECTRON_BINARY;
    if (!binary) {
      console.error('fixture download failed');
      process.exit(1);
    }
    const file = path.join(__dirname, 'dist', binary);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.writeFileSync(path.join(__dirname, 'path.txt'), binary);
  `);
  writeFixture('node_modules/electron-vite/package.json', '{}');
  writeFixture('node_modules/electron-vite/bin/electron-vite.js', `
    const fs = require('node:fs');
    const path = require('node:path');
    const electronDir = path.dirname(require.resolve('electron'));
    const pathFile = path.join(electronDir, 'path.txt');
    const electron = process.env.ELECTRON_EXEC_PATH || (fs.existsSync(pathFile)
      && path.join(electronDir, 'dist', fs.readFileSync(pathFile, 'utf8')));
    if (!electron || !fs.existsSync(electron)) throw new Error('Electron executable missing at Vite startup');
    console.log('Vite started with ' + electron);
  `);

  const pathFile = path.join(electronDir, 'path.txt');
  for (const binary of ['electron.exe', 'Electron.app/Contents/MacOS/Electron', 'electron']) {
    const result = runDev({ TEST_ELECTRON_BINARY: binary });
    assert.equal(result.status, 0, result.error ?? result.stderr);
    assert.ok(result.stdout.includes(`Vite started with ${path.join(electronDir, 'dist', binary)}`));
    assert.equal(fs.readFileSync(pathFile, 'utf8'), binary);

    const warm = runDev();
    assert.equal(warm.status, 0, warm.error ?? warm.stderr);
    fs.unlinkSync(pathFile);
  }

  writeFixture('custom electron', '');
  const customPath = path.join(root, 'custom electron');
  const overridden = runDev({ ELECTRON_EXEC_PATH: customPath });
  assert.equal(overridden.status, 0, overridden.error ?? overridden.stderr);
  assert.ok(overridden.stdout.includes(`Vite started with ${customPath}`));
  assert.equal(fs.existsSync(pathFile), false);

  const failed = runDev();
  assert.equal(failed.status, 1, failed.error ?? failed.stderr);
  assert.match(failed.stderr, /fixture download failed/);
  assert.doesNotMatch(failed.stdout, /Vite started/);
  console.log('dev-electron-bootstrap: passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
