/** Private no-op test host. Parent controls only processes created by this fixture. */
import { pathToFileURL } from 'node:url';

const [moduleFile, jobFile, driverFile, missingFile, mode] = process.argv.slice(2);
const { ManagedStdioTransport } = await import(pathToFileURL(moduleFile));
const ownerFile = new URL('../agentSession/process/owner.mjs', pathToFileURL(moduleFile));
const jobModule = new URL('../agentSession/process/windowsJob.mjs', pathToFileURL(moduleFile));
const { spawnOwnedProcess } = await import(ownerFile);
const { WindowsJob } = await import(jobModule);
let guardian, wrapper, owner, started = false;
const originalAssign = WindowsJob.prototype.assign;
WindowsJob.prototype.assign = function() { guardian = this.guardian; return originalAssign.call(this); };
const send = message => { if (process.connected) process.send(message); };
const spawn = config => {
  if (mode === 'bad-challenge') config = { ...config, identityChallenge: async () => 'x'.repeat(43) };
  if (mode === 'slow-challenge') config = { ...config, identityChallenge: (_child, _nonce, signal) => new Promise((_resolve, reject) => {
    send({ type: 'challenge-entered' });
    const abort = () => reject(new Error('fixture challenge cancelled'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }) };
  owner = spawnOwnedProcess(config); wrapper = owner.child;
  // This report contains only facts about the fixture's own bootstrap.
  send({ type: 'plan', job: config.windows.kind, hasPrivateArgs: config.args.every(arg => !arg.includes(driverFile) && !arg.includes(missingFile)),
    coverage: owner.coverage, wrapperPid: wrapper.pid });
  return owner;
};
const command = mode === 'missing-driver' ? missingFile : process.execPath;
const args = mode === 'missing-driver' ? [] : [driverFile];
const transport = new ManagedStdioTransport(command, process.env, 250, args, spawn, mode === 'asset-resolve' ? undefined : jobFile);
process.once('disconnect', () => process.exit(1));
transport.onmessage = message => {
  if (message.method === 'fixture-ready') send({ type: 'fixture-ready', wrapperPid: wrapper.pid,
    driverPid: message.params.pid, childPid: message.params.childPid, guardianPid: guardian?.pid });
};
transport.onclose = () => send({ type: 'wrapper-closed' });
transport.onerror = () => send({ type: 'transport-error' });
process.on('message', async message => {
  if (message === 'kill-guardian') {
    if (!guardian || guardian.exitCode !== null || guardian.signalCode !== null) return send({ type: 'guardian-kill-failed' });
    send({ type: 'guardian-killed', ok: guardian.kill('SIGKILL') });
  } else if (message === 'close') {
    const first = transport.close(), second = transport.close();
    try { await Promise.all([first, second]); send({ type: 'close-result', same: first === second, ok: true }); }
    catch { send({ type: 'close-result', same: first === second, ok: false }); }
  } else if (message === 'exit') {
    try { await transport.close(); } catch { /* unconfirmed cleanup stays a failure for the caller */ }
    process.exit(0);
  }
});
try {
  await transport.start(); started = true;
  send({ type: 'started' });
} catch (error) {
  send({ type: 'start-failed', wrapperPid: wrapper?.pid, guardianPid: guardian?.pid,
    cleanupUnconfirmed: error instanceof AggregateError, started });
}
