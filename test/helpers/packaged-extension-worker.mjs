import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Start the packaged extension worker and verify its startup IPC without loading an extension. */
export async function checkPackagedExtensionWorker(executable, resourcesPath) {
  const worker = path.join(resourcesPath, 'app.asar.unpacked', 'out/main/extensions/sdk/extension-runtime-worker.mjs');
  const child = spawn(executable, [worker], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    // The test runner and packaged Electron can use different V8 versions.
    serialization: 'json',
    windowsHide: true
  });
  const nonce = randomUUID();
  let timer;
  try {
    await new Promise((resolve, reject) => {
      let acknowledged = false;
      timer = setTimeout(() => reject(new Error('Packaged extension worker startup or exit timed out')), 10_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (acknowledged && code === 0) resolve();
        else reject(new Error(`Packaged extension worker failed its startup handshake (${code ?? signal})`));
      });
      child.on('message', message => {
        if (message?.type !== 'identityProof' || message.nonce !== nonce) return;
        acknowledged = true;
        if (child.connected) child.disconnect();
      });
      child.send({ type: 'identityChallenge', nonce });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
