/** Explicit integration probe: real installed SDK/CLI, supportedModels only, no inference prompt. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = path.resolve('.tmp'); fs.mkdirSync(scratch, { recursive: true });
const folder = fs.mkdtempSync(path.join(scratch, 'claude-owned-catalog-live-'));
let api;
try {
  const source = file => JSON.stringify(path.resolve(file));
  const entry = path.join(folder, 'entry.ts'), target = path.join(folder, 'entry.cjs');
  fs.writeFileSync(entry, `export {listClaudeModels} from ${source('src/main/agentSession/drivers/claude/models.ts')}; export {shutdownControlledChildren} from ${source('src/main/agentSession/process/controlledChild.ts')};`);
  await build({ entryPoints: [entry], outfile: target, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const guardian = path.join(folder, 'agentSession/drivers/codex/worker/windows-job.ps1'); fs.mkdirSync(path.dirname(guardian), { recursive: true });
  fs.copyFileSync('src/main/agentSession/drivers/codex/worker/windows-job.ps1', guardian);
  api = createRequire(import.meta.url)(target);
  const result = await api.listClaudeModels({ cwd: process.cwd(), userDataDir: folder, isolateConfig: false, refresh: true, signal: AbortSignal.timeout(20_000) });
  await api.shutdownControlledChildren();
  if (!result.ok) throw new Error(`Real Claude catalog probe failed: ${result.error}`);
  console.log(`real Claude SDK/CLI catalog and owned process release passed (${result.items.length} models; no inference prompt)`);
} finally {
  await api?.shutdownControlledChildren();
  assert.equal(path.dirname(path.resolve(folder)), scratch);
  fs.rmSync(folder, { recursive: true, force: true });
}
