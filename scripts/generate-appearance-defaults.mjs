/** Generate both host/SDK fallback palettes from the production pure resolver. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from '../test/helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-appearance-defaults-'));
const start = '/* resolved-appearance:start */';
const end = '/* resolved-appearance:end */';
const check = process.argv.includes('--check');
try {
  const compile = createSharedCompiler(root, temporary);
  const { DEFAULT_RESOLVED_DARK } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
  const declarations = Object.entries(DEFAULT_RESOLVED_DARK.cssVars)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, value]) => `  ${key}: ${value};`).join('\n');
  let drift = false;
  for (const relative of ['src/renderer/src/styles/base.css', 'src/main/extensions/sdk/theme.css', 'src/renderer/index.html']) {
    const boot = relative.endsWith('index.html');
    const bootKeys = ['--surface-frame', '--surface-raised', '--status-danger-bg', '--status-danger-fg', '--status-danger-border'];
    const values = boot ? Object.entries(DEFAULT_RESOLVED_DARK.cssVars).filter(([key]) => bootKeys.includes(key)).map(([key,value]) => `  ${key}: ${value};`).join('\n') : declarations;
    const block = `${start}\n:root {\n${values}\n}\n${end}`;
    const filename = path.join(root, relative);
    const source = fs.readFileSync(filename, 'utf8');
    const from = source.indexOf(start), to = source.indexOf(end);
    if ((from >= 0) !== (to >= 0) || (from >= 0 && to < from)) throw new Error(`Broken appearance markers: ${relative}`);
    const next = from >= 0
      ? source.slice(0, from) + block + source.slice(to + end.length)
      : boot ? source.replace('<style>', `<style>\n${block}`) : source.replace(/:root\s*\{/, `${block}\n\n:root {`);
    if (next === source) continue;
    if (check) { drift = true; console.error(`Appearance defaults drift: ${relative}`); }
    else { fs.writeFileSync(filename, next, 'utf8'); console.log(`Generated ${relative}`); }
  }
  if (drift) process.exitCode = 1;
} finally {
  // The target is the exact directory returned by mkdtemp, within the system temp directory.
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(path.resolve(temporary)) !== parent || !path.basename(temporary).startsWith('muster-appearance-defaults-')) {
    throw new Error('Unexpected temporary appearance directory');
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
