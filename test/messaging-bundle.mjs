import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, '.tmp', 'messaging-bundle-'));
let host;
try {
  const output = path.join(temp, 'bundle');
  execFileSync(process.execPath, ['scripts/build-messaging.mjs', output], { cwd: root, stdio: 'pipe', timeout: 30000 });
  const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
  const { MessagingHost } = await import(pathToFileURL(compile('main/messaging/messagingHost.ts')).href);
  host = new MessagingHost({
    dataDir: path.join(temp, 'synthetic-data'),
    credentials: {
      async resolve() {}, async describe() { return { configured: false }; },
      async set() { throw new Error('No accounts in packaging smoke'); }, async unset() {}
    },
    createOfficeHarness: () => ({ async ensureRunning() {}, stopManagedProcess() {} }),
    runtimeLoader: async () => {
      const bundle = await import(pathToFileURL(path.join(output, 'channel-runtime.mjs')).href);
      return { createRuntime() {
        const runtime = bundle.createRuntime();
        return { async install(...args) {
          try { return await runtime.install(...args); }
          catch (error) { console.error(`Synthetic bundle startup: ${args[0]}`, error); throw error; }
        } };
      } };
    }
  });
  host.start();
  const deadline = Date.now() + 10000;
  while (host.status().state === 'initializing' && Date.now() < deadline) await setImmediate();
  assert.equal(host.status().state, 'ready');
  for (const channel of host.status().channels.filter(value => value.supported)) {
    const result = await host.invoke(channel.key, 'connection.status');
    assert.equal(result.ok, true, `${channel.key}: ${JSON.stringify(result)}`);
  }
  assert.equal((await host.invoke('dsh-im-settings', 'settings.inbound-ttl.get')).error.code, 'unknown-channel');
  const attribution = fs.readFileSync(path.join(output, 'dsh-im-attribution.txt'), 'utf8');
  assert.ok(attribution.includes('MIT License'));
  assert.ok(attribution.includes('Baileys'));
  const olm = await import('@matrix-org/olm');
  await olm.default.init();
  assert.equal(typeof olm.default.Account, 'function');
  console.log('built ESM channels, account RPC, Matrix WASM and attribution load successfully');
} finally {
  await host?.stopAndWait();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
