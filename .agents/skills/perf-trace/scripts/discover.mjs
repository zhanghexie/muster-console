// node discover.mjs [port ...] -- OS discovery is Windows-only; no reload, launch, or app API calls.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeApplicationTargets, listTargets } from './cdp-client.mjs';

try {
  let candidates = process.argv.slice(2).map(port => ({ port: Number(port) }));
  if (!candidates.length) {
    if (process.platform !== 'win32') throw new Error('Pass the known CDP port on non-Windows hosts');
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./discover-ports.ps1', import.meta.url))], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    const parsed = raw ? JSON.parse(raw) : [];
    candidates = Array.isArray(parsed) ? parsed : [parsed];
  }
  const results = await Promise.allSettled(candidates.map(async candidate => ({ ...candidate, targets: describeApplicationTargets(await listTargets(candidate.port)) })));
  const available = results.filter(result => result.status === 'fulfilled' && result.value.targets.length).map(result => result.value);
  if (!available.length) throw new Error('No local CDP endpoint found; do not restart or attach a different instance without checking');
  console.log(JSON.stringify(available, null, 2));
} catch (error) { console.error(`[discover] ${error.message}`); process.exitCode = 1; }
