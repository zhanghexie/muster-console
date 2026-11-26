// node compare.mjs <baseline.json> <after.json> -- refuses incomparable captures.
import fs from 'node:fs';
import { compareCompatibility, compareStepResults } from './metrics.mjs';

try {
  const [baselinePath, afterPath] = process.argv.slice(2);
  if (!baselinePath || !afterPath) throw new Error('Usage: node compare.mjs <baseline.json> <after.json>');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  const reasons = compareCompatibility(baseline, after);
  if (reasons.length) throw new Error(`Incomparable captures: ${reasons.join(', ')}`);
  const warnings = [];
  const readinessChanged = baseline.readinessPolicy !== after.readinessPolicy;
  if (readinessChanged) warnings.push('Readiness policy differs or one capture predates visibility filtering; navigation readyMs deltas are omitted. Review the manifest and target-switch witnesses before interpreting navigation timing.');
  const rows = baseline.results.map((before, index) => compareStepResults(before, after.results[index], { readinessChanged }));
  const incomparable = rows.filter(row => !row.comparable).length;
  console.log(JSON.stringify({ baseline: baselinePath, after: afterPath, status: incomparable ? 'partially-incomparable' : 'comparable', incomparableSteps: incomparable, warnings, rows, interpretation: 'Negative deltas indicate less measured cost only for comparable rows. Incomparable rows deliberately contain no benefit deltas. Cadence/lateness tolerance is max(10%, 2ms); observation duration tolerance is max(10%, 100ms). No pass/fail FPS threshold is used.' }, null, 2));
  if (incomparable) process.exitCode = 1;
} catch (error) { console.error(`[compare] FAILED: ${error.message}`); process.exitCode = 1; }
