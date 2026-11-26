import { spawn } from 'node:child_process';
import type { ExtensionPackageSnapshot } from './extensionPackageSnapshot';
import { createExtensionModuleFormatResolver, fingerprintExtensionSnapshot } from './extensionPackageSnapshot';

// This fixed program parses supplied strings but never links or evaluates them.
// A browser .js resource can be either a classic script or an ES module even
// when the Node package defaults to CommonJS; declared Node entries stay strict.
const PARSER = String.raw`
const vm = require('node:vm');
const readline = require('node:readline');
const errors = [];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (errors.length >= 8) return;
  try {
    const item = JSON.parse(line);
    let source = Buffer.from(item.bytes, 'base64').toString('utf8');
    if (source.startsWith('#!')) source = '//' + source.slice(2);
    const parse = format => format === 'module'
      ? new vm.SourceTextModule(source, { identifier: item.path })
      : new vm.Script('(function(exports,require,module,__filename,__dirname){\n' + source + '\n})', { filename: item.path });
    try { parse(item.format); }
    catch (error) { if (!item.alternateFormat) throw error; try { parse(item.alternateFormat); } catch { throw error; } }
  } catch (error) {
    let name = 'source';
    try { name = String(JSON.parse(line).path); } catch {}
    errors.push(name + ': ' + String(error && error.message || error).slice(0, 1000));
  }
});
lines.on('close', () => process.stdout.write(JSON.stringify({ errors })));
`;

/** Reject broken JS before review without running extension top-level code. */
export async function checkExtensionPackageSyntax(snapshot: ExtensionPackageSnapshot, signal?: AbortSignal): Promise<void> {
  if (fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) throw new Error('Extension snapshot was modified');
  const files = snapshot.files.filter(file => /\.(mjs|cjs|js)$/i.test(file.path));
  if (!files.length) return;
  if (signal?.aborted) throw new Error('Extension syntax check was cancelled');
  const format = createExtensionModuleFormatResolver(snapshot);
  const nodeEntries = new Set<string>();
  try {
    const raw = JSON.parse(snapshot.files.find(file => file.path === 'extension.json')!.bytes.toString('utf8').replace(/^\uFEFF/, ''));
    for (const value of [raw.domain?.entry, raw.commandEntry, ...(Array.isArray(raw.agent?.mcp) ? raw.agent.mcp : [])]) {
      if (typeof value === 'string') nodeEntries.add(value);
    }
  } catch { /* Manifest validation reports malformed manifests separately. */ }
  const inputs = files.map(file => {
    if (file.bytes.length > 16 * 1024 * 1024) throw new Error(`Extension JavaScript file exceeds the syntax-check limit: ${file.path}`);
    const resolved = format(file.path);
    const alternateFormat = /\.js$/i.test(file.path) && !nodeEntries.has(file.path) ? (resolved === 'module' ? 'commonjs' : 'module') : undefined;
    return { file, format: resolved, alternateFormat };
  });
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-vm-modules', '-e', PARSER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '', diagnostics = '', timedOut = false, overflow = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  timer.unref();
  const abort = (): void => { child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 32_768) { overflow = true; child.kill(); } });
  child.stderr.on('data', chunk => { if (diagnostics.length < 2000) diagnostics += String(chunk).slice(0, 2000 - diagnostics.length); });
  // Prevent an EPIPE from escaping while the cancellation/exit path handles it.
  child.stdin.on('error', () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    // `close` waits for stdout/stderr to drain; `exit` can precede the result.
    child.on('close', code => {
      if (signal?.aborted) return reject(new Error('Extension syntax check was cancelled'));
      if (timedOut) return reject(new Error('Extension syntax check timed out'));
      if (overflow) return reject(new Error('Extension syntax checker returned excessive output'));
      if (code !== 0) return reject(new Error(`Extension syntax checker failed: ${diagnostics.trim() || code}`));
      try {
        const result: unknown = JSON.parse(output);
        if (!result || typeof result !== 'object' || !Array.isArray((result as { errors?: unknown }).errors)) throw new Error('Invalid syntax-check result');
        const errors = (result as { errors: unknown[] }).errors;
        if (errors.length) throw new Error(`Extension JavaScript syntax error: ${errors.map(String).join('; ')}`);
        resolve();
      } catch (error) { reject(error); }
    });
  });
  void done.catch(() => {});
  try {
    for (const input of inputs) {
      if (signal?.aborted) throw new Error('Extension syntax check was cancelled');
      const line = JSON.stringify({ path: input.file.path, format: input.format, alternateFormat: input.alternateFormat, bytes: input.file.bytes.toString('base64') }) + '\n';
      await new Promise<void>((resolve, reject) => child.stdin.write(line, error => error ? reject(error) : resolve()));
    }
    child.stdin.end();
    await done;
  } catch (error) {
    child.kill();
    await done.catch(() => {});
    if (signal?.aborted) throw new Error('Extension syntax check was cancelled');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
