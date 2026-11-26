/**
 * fork / 交接能力矩阵 + claude fork argv。
 * Run: node test/fork-capability.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cap-'));

function loadTs(rel) {
  const entry = path.join(root, rel);
  const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: entry
  });
  const out = path.join(tmp, path.basename(rel, '.ts') + '.mjs');
  fs.writeFileSync(out, outputText, 'utf8');
  return import(pathToFileURL(out).href);
}

const cap = await loadTs('src/shared/forkCapability.ts');
const {
  forkSupportOf,
  canForkOrHandover,
  claudeForkArgv,
  CLAUDE_FORK_SESSION_SUPPORTED
} = cap;

assert.equal(forkSupportOf('pi'), 'gui');
assert.equal(forkSupportOf('cursor'), 'gui');
assert.equal(forkSupportOf('custom', 'chat'), 'gui');
assert.equal(forkSupportOf('claude-code'), CLAUDE_FORK_SESSION_SUPPORTED ? 'claude' : 'none');
assert.equal(forkSupportOf('cursor-cli'), 'none');
assert.equal(forkSupportOf('opencode'), 'none');
assert.equal(forkSupportOf(undefined), 'none');
assert.equal(canForkOrHandover('pi'), true);
assert.equal(canForkOrHandover('cursor-cli'), false);
assert.equal(canForkOrHandover('opencode', 'pty'), false);
assert.equal(canForkOrHandover('anything', 'chat'), true);

const argv = claudeForkArgv('src-uuid', 'new-uuid');
assert.deepEqual(argv, [
  'claude',
  '--resume',
  'src-uuid',
  '--fork-session',
  '--session-id',
  'new-uuid'
]);
assert.notEqual(argv[2], argv[5], '源 id 与新 id 不得相同');

const { resolveLaunch } = await import(
  pathToFileURL(path.join(root, 'src/main/runtime/builtins/scripts/claude-code.mjs')).href
);
const forked = await resolveLaunch({
  mode: 'fork',
  sessionId: 'new-uuid',
  extraArgs: [],
  forkFromSessionId: 'src-uuid'
});
const blob = `${forked.command} ${forked.args.join(' ')}`;
assert.match(blob, /--resume/);
assert.match(blob, /--fork-session/);
assert.match(blob, /--session-id/);
assert.match(blob, /src-uuid/);
assert.match(blob, /new-uuid/);

const started = await resolveLaunch({ mode: 'start', sessionId: 'sid', extraArgs: [] });
const startBlob = `${started.command} ${started.args.join(' ')}`;
assert.match(startBlob, /--session-id/);
assert.doesNotMatch(startBlob, /--fork-session/);

const resumed = await resolveLaunch({ mode: 'resume', sessionId: 'sid', extraArgs: [] });
const resumeBlob = `${resumed.command} ${resumed.args.join(' ')}`;
assert.match(resumeBlob, /--resume/);
assert.doesNotMatch(resumeBlob, /--fork-session/);

console.log('fork-capability: all assertions passed');
