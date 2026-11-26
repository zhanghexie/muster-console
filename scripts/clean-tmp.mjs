#!/usr/bin/env node
/**
 * Local artifact lifecycle cleanup (cross-platform: Windows / macOS / Linux).
 *
 * Problem: `.tmp/`, `test-results/run-*` and `release/` accumulate forever.
 * Playwright cleans successful runs on exit. Failed and historical runs can
 * be pruned alongside the other local artifacts with this script.
 *
 * Policy:
 *   - `.tmp/<entry>`          remove entries older than --older-than days
 *   - `test-results/run-*`    keep newest --keep-runs, remove older ones
 *   - `release/*-Setup.*`     keep newest --keep-releases, remove older ones
 *   - never touch sources, evidence chains, or live build inputs
 *
 * Default is DRY-RUN. `--apply` MOVES candidates to a same-volume quarantine
 * directory (instant rename, fully reversible). This script never permanently
 * deletes anything — clearing the quarantine is a deliberate human action.
 *
 * Dry-run reports counts only (stat-ing a historically accumulated tree with
 * ~1M files takes minutes). Add --measure for exact byte counts. --apply
 * measures by default; add --no-measure to skip it.
 *
 * Usage:
 *   node scripts/clean-tmp.mjs
 *   node scripts/clean-tmp.mjs --measure
 *   node scripts/clean-tmp.mjs --apply
 *   node scripts/clean-tmp.mjs --apply --older-than 7 --keep-runs 10
 *   npm run clean:tmp -- --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const num = (name, fallback) => {
  const n = Number(option(name, String(fallback)));
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number for ${name}: ${option(name, '')}`);
  return n;
};

const apply = flag('--apply');
const measureSizes = flag('--measure') || (apply && !flag('--no-measure'));
const olderThanDays = num('--older-than', 14);
const keepRuns = num('--keep-runs', 20);
const keepReleases = num('--keep-releases', 2);
const trash = path.resolve(option('--trash', path.resolve(root, '..', '_metaagent-cleanup-trash', new Date().toISOString().slice(0, 10))));
const cutoff = Date.now() - olderThanDays * 864e5;
const activeCutoff = Date.now() - 60 * 60 * 1000; // never move anything written in the last hour

// Hard protection: live build inputs, expensive-to-rebuild caches, evidence chains.
// `.tmp/ui-captures` is intentionally protected: docs/features and docs/plans
// reference its paths as visual acceptance evidence.
const TMP_KEEP = new Set(['desktop-driver', 'i18n-mt-model', 'hermes-mcp-venv', 'ui-captures']);
const INSTALLER_RE = /-Setup\.exe$|\.(dmg|AppImage|deb|rpm)$/i;

const candidates = [];
const protectedEntries = [];
const skipped = { active: 0, fresh: 0, symlink: 0, missing: 0 };

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { skipped.missing++; return []; }
}
function mtimeOf(p) {
  try { return fs.lstatSync(p).mtimeMs; } catch { return 0; }
}
function add(rel, reason, mtime) {
  candidates.push({ rel, reason, mtime: new Date(mtime).toISOString() });
}
function eligible(mtime) {
  if (!mtime || mtime > activeCutoff) { skipped.active++; return false; }
  if (mtime > cutoff) { skipped.fresh++; return false; }
  return true;
}

// 1) .tmp top-level entries
const tmpDir = path.join(root, '.tmp');
for (const e of entries(tmpDir)) {
  const full = path.join(tmpDir, e.name);
  const rel = path.posix.join('.tmp', e.name);
  if (e.isSymbolicLink()) { skipped.symlink++; continue; }
  if (TMP_KEEP.has(e.name)) { protectedEntries.push(rel); continue; }
  const m = mtimeOf(full);
  if (eligible(m)) add(rel, 'tmp-ttl', m);
}

// 2) test-results/run-* — ranking based, not purely age based
const trDir = path.join(root, 'test-results');
const runs = entries(trDir)
  .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
  .map((e) => ({ name: e.name, m: mtimeOf(path.join(trDir, e.name)) }))
  .sort((a, b) => b.m - a.m);
for (let i = keepRuns; i < runs.length; i++) {
  const m = runs[i].m;
  if (m > cutoff) { skipped.fresh++; continue; }
  if (!m || m > activeCutoff) { skipped.active++; continue; }
  add(path.posix.join('test-results', runs[i].name), 'old-e2e-run', m);
}

// 3) release installers (+ their .blockmap siblings)
const relDir = path.join(root, 'release');
const installers = entries(relDir)
  .filter((e) => e.isFile() && INSTALLER_RE.test(e.name))
  .map((e) => ({ name: e.name, m: mtimeOf(path.join(relDir, e.name)) }))
  .sort((a, b) => b.m - a.m);
for (let i = keepReleases; i < installers.length; i++) {
  const m = installers[i].m;
  if (m > cutoff) { skipped.fresh++; continue; }
  if (!m || m > activeCutoff) { skipped.active++; continue; }
  add(path.posix.join('release', installers[i].name), 'old-installer', m);
  const bm = installers[i].name + '.blockmap';
  if (fs.existsSync(path.join(relDir, bm))) add(path.posix.join('release', bm), 'old-installer', m);
}

function measure(abs) {
  const st = fs.lstatSync(abs);
  if (st.isFile()) return { bytes: st.size, files: 1 };
  let bytes = 0, files = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let list;
    try { list = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const f = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) {
        try { const s = fs.statSync(f); bytes += s.size; files++; } catch { /* unreadable */ }
      }
    }
  }
  return { bytes, files };
}

for (const c of candidates) {
  const abs = path.join(root, c.rel);
  if (!fs.existsSync(abs)) { c.bytes = null; c.files = null; c.missing = true; continue; }
  if (measureSizes) Object.assign(c, measure(abs));
  else { c.bytes = null; c.files = null; }
}

const totalBytes = candidates.reduce((s, c) => s + (c.bytes || 0), 0);
const sizeText = measureSizes ? `${(totalBytes / 1048576).toFixed(0)} MB` : 'unmeasured (use --measure)';
const mode = apply ? 'APPLY (move to quarantine)' : 'DRY-RUN (no changes)';
console.log(`[clean-tmp] ${mode}`);
console.log(`[clean-tmp] root=${root}`);
console.log(`[clean-tmp] policy: older-than=${olderThanDays}d keep-runs=${keepRuns} keep-releases=${keepReleases} active-skip=60m`);
console.log(`[clean-tmp] candidates: ${candidates.length} entries, ${sizeText}`);
console.log(`[clean-tmp] skipped: active=${skipped.active} fresh=${skipped.fresh} symlink=${skipped.symlink} missing=${skipped.missing}`);
for (const c of candidates.slice(0, 25)) {
  const size = c.bytes == null ? '     ?' : (c.bytes / 1048576).toFixed(0).padStart(6);
  console.log(`   ${size} MB  ${c.mtime.slice(0, 10)}  ${c.reason.padEnd(14)} ${c.rel}`);
}
if (candidates.length > 25) console.log(`   ... ${candidates.length - 25} more (see manifest with --apply)`);
for (const p of protectedEntries) console.log(`[clean-tmp] PROTECTED (evidence/build input): ${p}`);

if (!apply) {
  console.log(`[clean-tmp] nothing changed. To move these to a reversible quarantine: node scripts/clean-tmp.mjs --apply`);
  console.log(`[clean-tmp] add --measure to include exact byte counts in dry-run (slow on large trees)`);
  console.log(`[clean-tmp] quarantine target: ${trash}`);
  process.exit(0);
}

if (candidates.length === 0) { console.log('[clean-tmp] nothing to do.'); process.exit(0); }

const report = [];
const BATCH = 10;
for (let i = 0; i < candidates.length; i += BATCH) {
  const batch = candidates.slice(i, i + BATCH);
  for (const c of batch) {
    if (c.missing) continue;
    const src = path.join(root, c.rel);
    const dst = path.join(trash, c.rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      const ok = !fs.existsSync(src) && fs.existsSync(dst);
      report.push({ ...c, dest: dst, status: ok ? 'moved' : 'VERIFY-FAILED' });
    } catch (err) {
      report.push({ ...c, dest: dst, status: 'FAILED: ' + err.message });
    }
  }
  const slice = report.slice(-batch.length);
  const ok = slice.filter((r) => r.status === 'moved').length;
  console.log(`[clean-tmp] batch ${Math.floor(i / BATCH) + 1}: ${ok}/${batch.length} moved`);
  for (const r of slice.filter((x) => x.status !== 'moved')) console.log(`   !! ${r.rel} -> ${r.status}`);
}

fs.mkdirSync(trash, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const manifest = path.join(trash, `cleanup-${stamp}.json`);
const moved = report.filter((r) => r.status === 'moved');
const movedBytes = moved.reduce((s, r) => s + (r.bytes || 0), 0);
fs.writeFileSync(manifest, JSON.stringify({
  createdAt: new Date().toISOString(),
  root, trash, policy: { olderThanDays, keepRuns, keepReleases, measured: measureSizes },
  movedCount: moved.length,
  movedBytes: measureSizes ? movedBytes : null,
  restore: 'rename each trash/<rel> back to root/<rel>; see manifest items',
  items: report
}, null, 2));
console.log(`[clean-tmp] moved ${moved.length} entries${measureSizes ? `, ${(movedBytes / 1048576).toFixed(0)} MB` : ''}`);
console.log(`[clean-tmp] manifest: ${manifest}`);
console.log(`[clean-tmp] reversible: rename items back from quarantine. This script never permanently deletes.`);
if (moved.length < report.length) process.exitCode = 1;
