import fs from 'node:fs';
import path from 'node:path';

/** Broad source scans and implementation-text guards belong in an explicit audit. */
const AUDITS = new Set([
  'catalog-public-surface.mjs', 'composer-material-css.mjs', 'composer-overlay.mjs',
  'css-syntax.mjs', 'design-lint.mjs', 'glass-surfaces-css.mjs', 'i18n-coverage.mjs',
  'jump-bottom-hover-css.mjs', 'main-cjs-externals.mjs', 'memory-overview-css.mjs',
  'motion-skeleton-css.mjs', 'packaging-file-filters.mjs', 'renderer-safe-shared.mjs',
  'service-source-layout.mjs', 'sessions-slide-css.mjs', 'settings-css.mjs', 'surface-parity.mjs',
  'test-hygiene.mjs', 'impact-select.mjs', 'theme-del-keyboard-css.mjs', 'updater-notify-wiring.mjs'
]);

export const SMOKE_TESTS = [
  'run-scope.mjs', 'test-policy.mjs', 'gate-plan.mjs',
  'chat-time.mjs', 'board-status.mjs',
  'ws-protocol.mjs', 'declaration-trust.mjs', 'gui-worker-policy.mjs'
];
export const SMOKE_SPECS = [
  'test/unit/confirm-dialog.spec.tsx', 'test/unit/motion-presence.spec.tsx'
];

/** Classification is visible through --list; full runs still include every offline test. */
export function testProfile(root, name) {
  const source = fs.readFileSync(path.join(root, 'test', name), 'utf8');
  if (name.endsWith('-visual.mjs') || /\bchromium\.launch\s*\(/.test(source)) return 'visual';
  if (/\b(?:execFileSync|spawnSync|spawn|execFile)\(\s*['"]git['"]|\bexecSync\(\s*[`'"]git\b/.test(source)) return 'integration';
  if (AUDITS.has(name)) return 'audit';
  return 'daily';
}

/** A configuration change requests broad coverage; the daily tier is an explicit smoke subset. */
export function dailySelection(root, allFiles, changed, selectAffected) {
  const daily = allFiles.filter(name => testProfile(root, name) === 'daily');
  const broad = selectAffected(root, daily, changed);
  if (!broad.reason.startsWith('all')) return limitDaily(broad, changed);
  const narrowChanges = changed.filter(file =>
    (file.startsWith('src/') || file.startsWith('test/')) &&
    !file.startsWith('test/helpers/') && file !== 'test/run.mjs' &&
    fs.existsSync(path.join(root, file))
  );
  const affected = selectAffected(root, daily, narrowChanges);
  const selected = new Set([...SMOKE_TESTS.filter(name => daily.includes(name)), ...affected.selected]);
  return limitDaily({ selected: daily.filter(name => selected.has(name)), matched: affected.matched, reason: `quick-smoke（${broad.reason}）`, broad: true }, changed);
}

function limitDaily(plan, changed) {
  const controlsRequired = changed.some(file => file.startsWith('src/renderer/') || file === 'test/capability-ui-controls.mjs');
  if (controlsRequired && !plan.selected.includes('capability-ui-controls.mjs')) plan.selected.push('capability-ui-controls.mjs');
  const self = new Set(changed.filter(file => file.startsWith('test/')).map(file => file.slice(5)));
  if (controlsRequired) self.add('capability-ui-controls.mjs');
  const matched = new Set(plan.matched);
  // For narrow changes, proven dependency hits outrank generic alwaysRun guards.
  const rank = name => self.has(name) ? 0 : plan.broad
    ? SMOKE_TESTS.includes(name) ? 1 : matched.has(name) ? 2 : 3
    : matched.has(name) ? 1 : SMOKE_TESTS.includes(name) ? 2 : 3;
  const ranked = [...plan.selected].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  // Modified tests always run. Remaining related coverage is a bounded daily sample.
  const selected = ranked.slice(0, Math.max(16, ranked.filter(name => self.has(name)).length));
  return { ...plan, selected, deferredRelated: ranked.filter(name => !selected.includes(name)) };
}

export function dailyUnitPlan(root, changed, plan) {
  if (plan.mode === 'none') return plan;
  const direct = new Set(changed.filter(file => /test\/unit\/.*\.spec\.tsx?$/.test(file)));
  const basenames = changed.filter(file => file.startsWith('src/')).map(file => path.basename(file).replace(/\.tsx?$/, ''));
  const specificNames = basenames.filter(name => !['types', 'index', 'config', 'internal', 'setup'].includes(name));
  const scores = new Map();
  const candidates = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.spec\.tsx?$/.test(entry.name)) {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        const source = fs.readFileSync(file, 'utf8');
        scores.set(relative, specificNames.filter(name => source.includes(name)).length);
        if (direct.has(relative) || SMOKE_SPECS.includes(relative) || plan.files?.includes(relative) || basenames.some(name => source.includes(name))) {
          candidates.push(relative);
        }
      }
    }
  };
  walk(path.join(root, 'test/unit'));
  const rank = file => direct.has(file) ? 0 : SMOKE_SPECS.includes(file) ? 1 : 2;
  candidates.sort((a, b) => rank(a) - rank(b) || (scores.get(b) - scores.get(a)) || a.localeCompare(b));
  const files = candidates.slice(0, Math.max(6, direct.size));
  return { mode: 'files', files };
}
