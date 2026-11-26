/** Retired workspace runtime discovery: real scaffold/app ensure never touches an old file. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'metaagent-runtime-retirement-'));
const compileTmp = path.join(temporary, 'compile');
const compile = createSharedCompiler(root, compileTmp);
const scaffold = await import(pathToFileURL(compile('main/metaAgent/scaffold.ts')).href);
const appEntry = compile('main/metaAgent/ensureForApp.ts');
// Exercise the real application ensure functions without a userData trust ledger.
// Declaration trust is outside this filesystem-retirement test and has its own coverage.
fs.writeFileSync(path.join(compileTmp, 'main/agent/declarationTrustSources.mjs'), 'export function registerPendingPhaseOne() {}\n');
const { ensureWorkspaceMetaAgent, ensureAllWorkspacesMetaAgent } = await import(pathToFileURL(appEntry).href);
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
const bare = path.join(temporary, 'bare');
const legacy = path.join(temporary, 'legacy');
fs.mkdirSync(bare, { recursive: true });
fs.mkdirSync(path.join(legacy, '.muster'), { recursive: true });
const oldRuntime = path.join(legacy, '.muster', 'runtime.json');
const sentinel = '{"baseUrl":"http://retired.invalid","token":"fixture-only-do-not-read"}\n';
fs.writeFileSync(oldRuntime, sentinel);
const before = fs.statSync(oldRuntime);
const notifications = [];
let shellAccess = 0;
const context = {
  config: { get: () => ({ activeWorkspaceId: 'bare', workspaces: [{ id: 'bare', path: bare }, { id: 'legacy', path: legacy }] }) },
  notify: { push: notice => notifications.push(notice) }
};
Object.defineProperty(context, 'shellApi', { get() { shellAccess++; throw new Error('workspace ensure must not depend on the HTTP server'); } });
const originals = new Map();
const touched = [];
const fileKey = value => typeof value === 'string' ? path.resolve(value) : value instanceof URL ? path.resolve(fileURLToPath(value)) : '';
try {
  assert.equal(scaffold.writeRuntimeJson, undefined, 'retired unconditional writer has no public export');
  assert.equal(scaffold.writeRuntimeIfScaffolded, undefined, 'retired conditional writer has no public export');
  // Any read, write, stat, deletion or rename of the legacy discovery file fails loudly.
  for (const method of ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'unlinkSync', 'rmSync', 'renameSync']) {
    const original = fs[method]; originals.set(method, original);
    fs[method] = function (...args) {
      const paths = method === 'renameSync' ? args.slice(0, 2) : args.slice(0, 1);
      if (paths.some(value => fileKey(value) === path.resolve(oldRuntime))) {
        touched.push(method); throw new Error(`retired runtime access: ${method}`);
      }
      return original.apply(this, args);
    };
  }
  try {
    ensureWorkspaceMetaAgent(context, bare);
    ensureAllWorkspacesMetaAgent(context);
    scaffold.ensureMetaAgentScaffold(legacy);
    const missing = path.join(temporary, 'missing');
    ensureWorkspaceMetaAgent(context, missing);
  } finally {
    for (const [method, original] of originals) fs[method] = original;
    originals.clear();
  }
  assert.deepEqual(touched, [], 'startup and workspace ensure must never access old runtime data');
  assert.equal(shellAccess, 0, 'scaffolding does not ask for or require a running Shell API');
  assert.equal(fs.existsSync(path.join(bare, '.muster', 'runtime.json')), false, 'new workspace has no endpoint-discovery file');
  assert.equal(fs.readFileSync(oldRuntime, 'utf8'), sentinel, 'old file is preserved verbatim, not migrated or cleaned');
  assert.equal(fs.statSync(oldRuntime).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(oldRuntime).ino, before.ino);
  assert.ok(fs.existsSync(path.join(bare, '.muster', 'manifest.json')));
  assert.ok(notifications.some(notice => notice.text.includes('.muster')));
  try {
    applyLocaleSetting('en');
    const invalid = { config: { get: () => ({ workspaces: [{ id: 'invalid', rootsError: 'original diagnostic' }] }) }, notify: { push: notice => notifications.push(notice) } };
    ensureAllWorkspacesMetaAgent(invalid);
    assert.equal(notifications.at(-1).sessionName, 'Workbench');
    assert.equal(notifications.at(-1).text, 'Workbench · original diagnostic');
  } finally { applyLocaleSetting('zh-CN'); }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    assert.equal(fs.existsSync(path.join(bare, name)), false, 'startup leaves root instructions alone');
  }
  assert.match(fs.readFileSync(path.join(legacy, '.muster', '.gitignore'), 'utf8'), /^runtime\.json$/m, 'legacy discovery data remains ignored');

  const shellSource = fs.readFileSync(path.join(root, 'src/main/protocol/shellApi.ts'), 'utf8');
  assert.doesNotMatch(shellSource, /refreshRuntimeFiles|writeRuntime(?:Json|IfScaffolded)|runtime\.json|buildStatusProtocolHint/);
  assert.match(shellSource, /shell-api\.json/, 'host debug endpoint file remains');
  assert.match(shellSource, /this\.writeEndpointFile\(\)/, 'HTTP server still publishes its diagnostic endpoint');
  assert.match(shellSource, /statusUrlForToken/, 'session-bound HTTP URLs remain');
  const startup = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.doesNotMatch(startup, /refreshRuntimeFiles|writeRuntime(?:Json|IfScaffolded)/);
  for (const key of ['MUSTER_HOST', 'MUSTER_SHELL_API', 'MUSTER_STATUS_URL', 'MUSTER_TOOL_URL', 'MUSTER_SESSION_TOKEN', 'MUSTER_SELF']) assert.ok(startup.includes(key), `${key}: trusted process identity is retained`);
  console.log('metaagent-ensure-for-app: runtime discovery retired; public scaffolding and environment identity preserved');
} finally {
  for (const [method, original] of originals) fs[method] = original;
  fs.rmSync(temporary, { recursive: true, force: true });
}
