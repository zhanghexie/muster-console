/** Real node-pty output -> production manager -> bounded wait. No external CLI/model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

if (!process.argv.includes('--pty-child')) {
  // A naturally exited ConPTY retains its output worker. Calling node-pty.kill()
  // again enumerates the dead console (AttachConsole failed). Release the fixture's
  // owning process after assertions instead, without private SDK APIs or hiding stderr.
  const child = fork(fileURLToPath(import.meta.url), ['--pty-child'], {stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let output = '', errors = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
  const closed = new Promise(resolve => child.once('exit', resolve));
  const timer = setTimeout(() => child.kill(), 12000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', () => reject(Error('PTY fixture exited before reporting: ' + errors)));
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(errors, '', 'real PTY fixture must have no unexpected stderr');
    process.stdout.write(output);
  } finally { child.kill(); await closed; clearTimeout(timer); }
} else {
try { await check(); process.send({ok:true}); }
catch (error) { process.send({ok:false,error:error.stack || String(error)}); }
}

async function check() {
const require = createRequire(import.meta.url), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-pty-'));
const compile = createSharedCompiler(process.cwd(), dir);
const entry = compile('main/pty/manager.ts'), waitEntry = compile('main/pty/outputWait.ts');
const shim = path.join(dir, 'node_modules/node-pty');
fs.mkdirSync(shim, {recursive:true});
fs.writeFileSync(path.join(shim, 'package.json'), '{"main":"index.cjs"}');
fs.writeFileSync(path.join(shim, 'index.cjs'), `exports.spawn=require(${JSON.stringify(require.resolve('node-pty'))}).spawn;`);
const { PtyManager } = await import(pathToFileURL(entry).href);
const { createOwnedInteractivePty } = await import(pathToFileURL(compile('main/pty/interactiveOwner.ts')).href);
const { waitForTerminalOutput: wait } = await import(pathToFileURL(waitEntry).href);
const source = new PtyManager(() => null, options => createOwnedInteractivePty({ ...options,
  jobPath: path.join(process.cwd(), 'src/main/agentSession/drivers/codex/worker/windows-job.ps1'), koffiPath: require.resolve('koffi') })), script = path.join(dir, 'cli.cjs');
fs.writeFileSync(script, `process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdin.resume();
process.stdout.write('READY\\n');let line='';
process.stdin.on('data',data=>{for(const ch of data){if(ch==='\\r'||ch==='\\n'){
 if(line==='go'){process.stdout.write('DO');setTimeout(()=>process.stdout.write('NE\\n'),20);}
 if(line==='exit')setTimeout(()=>process.exit(7),20);line='';
}else line+=ch;}});`);
try {
  await source.spawn('fixture', {command:process.execPath,args:[script]}, dir, 100, 25);
  assert.equal((await wait(source, 'fixture', {text:'READY',timeoutMs:5000})).reason, 'text');
  const after = source.getOutputCursor('fixture');
  assert.equal(source.write('fixture','go\r'), true);
  // Deliberately allow output before capture, reproducing the write -> model -> capture gap.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await wait(source, 'fixture', {text:'DONE',timeoutMs:2000}, {after})).reason, 'text');
  assert.equal((await wait(source, 'fixture', {quietMs:50,timeoutMs:2000})).reason, 'quiet');
  assert.equal(source.isRunning('fixture'), true, 'quiet is not process completion');
  const exit = wait(source, 'fixture', {text:'never',timeoutMs:3000}); source.write('fixture','exit\r');
  const result = await exit;
  assert.equal(result.reason, 'exited'); assert.equal(result.exitCode, 7);
  console.log(`terminal-output-pty: OK (${process.platform}, real output/cursor/quiet/exit)`);
} finally {
  await source.killAllAndWait();
  fs.rmSync(dir, {recursive:true,force:true});
}
}
