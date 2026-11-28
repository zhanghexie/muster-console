import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkPackagedExtensionWorker } from '../test/helpers/packaged-extension-worker.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');

function findExecutable(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findExecutable(file);
      if (found) return found;
      continue;
    }
    if (process.platform === 'win32' && entry.name === 'MusterConsole.exe') return file;
    if (process.platform === 'darwin' && entry.name === 'Muster Console' && file.includes(`.app${path.sep}Contents${path.sep}MacOS${path.sep}`)) return file;
    if (process.platform === 'linux' && entry.name === 'muster-console') return file;
  }
  return undefined;
}

const releaseRoot = path.resolve(process.env.MUSTER_PACKAGED_RELEASE ?? path.join(root, 'release'));
const executable = process.env.MUSTER_PACKAGED_EXECUTABLE || findExecutable(releaseRoot);
if (!executable || !fs.existsSync(executable)) throw new Error(`Packaged Electron executable not found under ${releaseRoot}`);

const configuredProfile = process.env.MUSTER_PACKAGED_PROFILE_DIR;
const profile = configuredProfile ? path.resolve(configuredProfile) : fs.mkdtempSync(path.join(os.tmpdir(), 'muster-packaged-smoke-'));
fs.mkdirSync(profile, { recursive: true });
const env = {
  ...process.env,
  MUSTER_INSTANCE_ID: `packaged-smoke-${process.pid}`,
  MUSTER_PACKAGED_SMOKE: '1',
  MUSTER_PACKAGED_USER_DATA: profile
};
for (const key of ['ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];

let app;
let failed = false;
try {
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], cwd: root, env, timeout: 60_000 });
  const window = await app.firstWindow();
  await window.waitForSelector('.app-shell', { timeout: 60_000 });
  if (await window.locator('body').getAttribute('data-boot-failed')) throw new Error('Packaged app reported boot failure');
  const resourcesPath = await app.evaluate(() => process.resourcesPath);
  await checkPackagedExtensionWorker(executable, resourcesPath);
  console.log('packaged extension worker handshake passed');
  console.log(`packaged smoke passed: ${executable}`);
} catch (error) {
  failed = true;
  throw error;
} finally {
  await app?.close().catch(() => {});
  if (failed && process.env.MUSTER_PACKAGED_KEEP_PROFILE === '1') {
    console.error(`packaged smoke userData preserved: ${profile}`);
  } else {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
