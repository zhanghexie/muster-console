import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFromFile } from 'electron-vite';
import { optimizeDeps, resolveConfig } from 'vite';

// Start with an empty cache and no discovery by visiting the optional editor.
// All bare imports used by its first render must be ready in the initial optimizer run.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-editor-vite-'));
try {
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' });
  const resolved = await resolveConfig({ ...config.renderer, root: path.resolve('src/renderer'),
    configFile: false, cacheDir, logLevel: 'silent', optimizeDeps: { ...config.renderer.optimizeDeps, entries: [] } }, 'serve');
  const meta = await optimizeDeps(resolved);
  for (const file of ['agentChat/FormattedRequestJson.tsx', 'editor/workbenchCmTheme.ts']) {
    const source = fs.readFileSync(path.join(resolved.root, 'src', file), 'utf8');
    for (const match of source.matchAll(/^import (?!type ).* from '([^'.][^']*)';/gm)) {
      if (match[1] !== 'react') assert.ok(meta.optimized[match[1]], 'Lazy editor would introduce a late dependency: ' + match[1]);
    }
  }
  console.log('Cold Vite cache contained the optional JSON editor dependencies before first access.');
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
