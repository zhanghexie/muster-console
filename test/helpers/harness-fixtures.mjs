import fs from 'node:fs';
/** Fixtures use the real declarative seed, never a second catalogue in the service. */
export function builtinHarnessFixtures() {
  return JSON.parse(fs.readFileSync(new URL('../../src/main/runtime/builtins/registry.json', import.meta.url), 'utf8')).runtimes;
}
