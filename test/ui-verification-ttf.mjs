/** Real capture helper must bundle, serve and load a TTF-only production-style font. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execute } from './helpers/execute.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = path.join(root, '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(tempRoot, 'ui-ttf-'));
try {
  const result = await execute(process.execPath, [
    '.agents/skills/ui-verification/scripts/capture-component.mjs',
    '--fixture', 'test/fixtures/ui-verification-ttf.tsx',
    '--scenario', 'test/fixtures/ui-verification-ttf-scenario.mjs',
    '--target', '.ttf-fixture', '--styles', 'base', '--out', output,
    '--font', 'Fixture TTF', '--themes', 'light', '--widths', '780'
  ], { cwd: root, timeoutMs: 45_000 });
  assert.equal(result.code, 0, result.out);
  console.log('ui-verification-ttf: TTF bundle, response and browser font load passed');
} finally {
  assert.equal(path.dirname(output), tempRoot);
  fs.rmSync(output, { recursive: true, force: true });
}
