// 从 Muster config.json 重新生成 Muster Core 的模型配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name !== '--user-data-root' || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Expected --user-data-root PATH; received ${name}`);
    }
    options.userDataRoot = path.resolve(argv[++i]);
  }
  return options;
}

export function resolveSyncRoots(options, { storageDirectory, platform = process.platform, env = process.env, home = os.homedir() }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const appDataRoot = platform === 'win32'
    ? env.APPDATA || paths.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || paths.join(home, '.config');
  return {
    appDataRoot,
    userDataRoot: options.userDataRoot || paths.join(appDataRoot, storageDirectory)
  };
}

export function syncOnce(roots, { StorageRootResolver, syncPiConfigFromApp, readFile = fs.readFileSync }) {
  const resolver = new StorageRootResolver({ userDataPath: roots.userDataRoot, appDataPath: roots.appDataRoot });
  const coreHome = resolver.resolve('app', 'muster-core');
  const config = JSON.parse(readFile(resolver.file('config'), 'utf8'));
  const result = syncPiConfigFromApp(config, coreHome);
  return { providerId: result.providerId, modelId: result.modelId, providers: result.providers, agentDir: result.agentDir };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-pi-sync-'));
  try {
    const { createSharedCompiler } = await import(pathToFileURL(path.join(root, 'test/helpers/shared-compile.mjs')).href);
    const compile = createSharedCompiler(root, temp);
    const identity = await import(pathToFileURL(compile('shared/productIdentity.ts')).href);
    const storage = await import(pathToFileURL(compile('main/runtimeKernel/storageRootResolver.ts')).href);
    const pi = await import(pathToFileURL(compile('main/agent/piConfigSync.ts')).href);
    const roots = resolveSyncRoots(options, { storageDirectory: identity.PRODUCT_STORAGE_DIR });
    console.log(JSON.stringify(syncOnce(roots, { ...storage, ...pi }), null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
