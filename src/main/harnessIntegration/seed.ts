import fs from 'node:fs';
import path from 'node:path';
import type { AgentRuntimeEntry } from '../../shared/types';
/** Compatibility callers use the same bundled registry declarations as RuntimeHost. */
export function builtinHarnessEntries(): AgentRuntimeEntry[] {
  const here = typeof __dirname === 'string' ? __dirname : process.cwd();
  const candidates = [path.join(here, 'runtime/builtins/registry.json'), path.join(here, '../runtime/builtins/registry.json'), path.resolve(process.cwd(), 'src/main/runtime/builtins/registry.json')];
  const file = candidates.find(file => fs.existsSync(file));
  if (!file) throw new Error('Bundled harness registry is unavailable');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { runtimes: AgentRuntimeEntry[] }).runtimes
    .map(entry => entry.manifest ? { ...entry, integrations: entry.manifest.integrations ?? entry.integrations } : entry);
}
