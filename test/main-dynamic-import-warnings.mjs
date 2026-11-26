import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'electron-vite';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const { config } = await resolveConfig({ root, logLevel: 'silent' }, 'build', 'production');
assert.ok(config?.main, 'Missing Electron main build configuration');

const modules = ['src/main/turnChanges/runtime.ts', 'src/main/agent/providers/piProvider.ts'];
const ineffectiveImports = new Set();

await build({
  ...config.main,
  // Keep the main-process bundling plugins without running the app's asset writers.
  plugins: config.main.plugins.filter(plugin => plugin.name.startsWith('vite:')),
  build: {
    ...config.main.build,
    write: false,
    rollupOptions: {
      ...config.main.build?.rollupOptions,
      onwarn(warning, warn) {
        if (warning.plugin === 'vite:reporter') {
          const message = warning.message.replaceAll('\\', '/');
          const module = modules.find(id => message.includes(`/${id} is dynamically imported by`));
          if (module && message.includes('dynamic import will not move module into another chunk')) {
            ineffectiveImports.add(module);
            return;
          }
        }
        warn(warning);
      }
    }
  }
});

assert.deepEqual([...ineffectiveImports], [], 'Main process emitted ineffective dynamic import warnings');
console.log('main-dynamic-import-warnings: all passed');
