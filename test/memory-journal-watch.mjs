/** The current journal source must be watched and identified without consulting old layouts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-journal-watch-'));
try {
  const compile = createSharedCompiler(repo, tmp);
  const { watchMemorySources } = await import(pathToFileURL(compile('main/memory/indexer.ts')).href);
  const { assembleJournalSection } = await import(pathToFileURL(compile('main/memory/injection.ts')).href);
  const workspace = path.join(tmp, 'workspace');
  const relative = path.join('.muster', 'memory', 'journal');
  const journal = path.join(workspace, relative);
  fs.mkdirSync(journal, { recursive: true });
  let notify;
  const invalidated = new Promise(resolve => { notify = resolve; });
  const watcher = watchMemorySources(workspace, { debounceMs: 20, onInvalidate: notify });
  assert.ok(watcher, 'the actual current journal directory must have a watcher');
  try {
    fs.writeFileSync(path.join(journal, '2026-01-02.md'), 'isolated fixture');
    let timer;
    const dirs = await Promise.race([invalidated, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('journal change was not observed')), 4000); })]).finally(() => clearTimeout(timer));
    assert.ok(dirs.includes(relative));
  } finally { watcher.close(); }
  const section = assembleJournalSection('fixture entry', '2026-01-02', 1000).text;
  assert.match(section, /\.muster\/memory\/journal\/2026-01-02\.md/);
  assert.doesNotMatch(section, /docs\/journal/);
  console.log('memory-journal-watch: current isolated journal watch and source label passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
