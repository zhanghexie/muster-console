/** Explicit integration: real GUI driver/SDK/CLI ownership, zero inference prompts.
 * Run directly: node test/integration/claude-driver-owner-live.mjs
 * Native user configuration is consumed by the SDK; no Muster runtime data is read.
 * Probe-only options disable hooks/tools and session persistence. This is not a
 * model turn, GUI end-to-end test, or validation of every native configuration.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const HANDSHAKE_MS = 15_000;
const CLEANUP_MS = 15_000;
const scratch = path.resolve('.tmp');
fs.mkdirSync(scratch, { recursive: true });
const folder = fs.mkdtempSync(path.join(scratch, 'claude-driver-owner-live-'));
const cwd = path.join(folder, 'workspace'), userDataDir = path.join(folder, 'userData');
fs.mkdirSync(cwd); fs.mkdirSync(userDataDir);
const probes = [];
let api, failure;

async function bounded(operation, timeout, label, cancel = () => {}) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { cancel(); } finally { reject(new Error(`${label} timed out after ${timeout}ms`)); }
      }, timeout);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  const source = file => JSON.stringify(path.resolve(file));
  const entry = path.join(folder, 'entry.ts'), target = path.join(folder, 'entry.cjs');
  fs.writeFileSync(entry, `export {ClaudeRuntimeDriver} from ${source('src/main/agentSession/drivers/claude/driver.ts')}; export {shutdownControlledChildren} from ${source('src/main/agentSession/process/controlledChild.ts')};`);
  await build({ entryPoints: [entry], outfile: target, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const guardian = path.join(folder, 'agentSession/drivers/codex/worker/windows-job.ps1');
  fs.mkdirSync(path.dirname(guardian), { recursive: true });
  fs.copyFileSync('src/main/agentSession/drivers/codex/worker/windows-job.ps1', guardian);
  api = createRequire(import.meta.url)(target);
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  for (const closeVia of ['driver', 'sdk']) {
    const probe = { closeVia, controller: new AbortController(), prompts: 0, feedEnded: false,
      closes: 0, events: [], logs: [], connection: undefined, query: undefined, child: undefined, pump: undefined };
    probes.push(probe);
    const driver = new api.ClaudeRuntimeDriver({ config: { get: () => ({ claude: { isolateConfig: false } }) } },
      { userDataDir }, {
        loadSdk: async () => sdk,
        queryFn({ prompt, options }) {
          assert.equal(typeof options.spawnClaudeCodeProcess, 'function', 'use the production GUI spawn callback');
          const spawn = options.spawnClaudeCodeProcess;
          // Observe the production PromptFeed without supplying any user input.
          // Fail before forwarding an unexpected value, so the probe cannot infer.
          const guardedPrompt = {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const _value of prompt) {
                  probe.prompts++;
                  throw new Error('No-inference probe unexpectedly received a user prompt');
                }
              } finally { probe.feedEnded = true; }
            }
          };
          probe.query = sdk.query({ prompt: guardedPrompt, options: {
            ...options, abortController: probe.controller,
            tools: [], hooks: {}, settings: { disableAllHooks: true }, persistSession: false,
            permissionMode: 'dontAsk',
            spawnClaudeCodeProcess(input) {
              assert.equal(probe.child, undefined, 'one native child per GUI connection');
              const child = probe.child = spawn(input);
              child.once('close', () => { probe.closes++; });
              return child;
            }
          } });
          return probe.query;
        }
      });
    await bounded((async () => {
      probe.connection = await driver.connect({
        sessionId: `claude-owner-live-${closeVia}`, cwd, systemPromptAppend: '', firstPromptPrefix: '',
        mode: 'default', planExecuting: false, permissionMode: 'default', automaticPermissions: false,
        modeController: {}, hostTools: [], requestApproval: async () => ({ approved: false }),
        getPolicyState: () => ({ mode: 'default', planExecuting: false }),
        log: (level, message) => { probe.logs.push({ level, message }); }
      });
      probe.pump = (async () => { for await (const event of probe.connection.events) probe.events.push(event.type); })();
      void probe.pump.catch(() => {});
      assert.equal(typeof probe.query?.initializationResult, 'function', 'installed SDK must expose initialization without a prompt');
      const initialized = await probe.query.initializationResult();
      assert.ok(initialized && typeof initialized === 'object', 'real SDK/CLI initialization completed');
      assert.ok(probe.child, 'the real SDK used the production process owner');
      assert.equal(probe.prompts, 0);
      assert.equal(probe.closes, 0, 'the streaming connection remains open after initialization');
    })(), HANDSHAKE_MS, `${closeVia}: SDK initialization`, () => probe.controller.abort());

    if (closeVia === 'driver') {
      await bounded(Promise.all([probe.connection.close(), probe.connection.close()]), CLEANUP_MS,
        'concurrent GUI connection close', () => probe.controller.abort());
    } else {
      // Exercise the actual SDK's idle stream termination as well as Host close.
      probe.query.close();
      await bounded(probe.pump, CLEANUP_MS, 'SDK idle stream close', () => probe.controller.abort());
      await bounded(probe.connection.close(), CLEANUP_MS, 'GUI close after SDK stream end');
    }
    await bounded(probe.connection.close(), CLEANUP_MS, 'repeat GUI connection close');
    await bounded(probe.pump, CLEANUP_MS, 'GUI event stream completion');
    assert.equal(probe.closes, 1, 'close resolves only after the actual owned child reports closure, exactly once');
    assert.equal(probe.feedEnded, true, 'the production PromptFeed has been ended');
    assert.equal(probe.prompts, 0, 'neither connection submits an inference prompt');
    assert.equal(probe.events.some(type => ['text-delta', 'thinking-delta', 'tool-start', 'turn-complete'].includes(type)), false,
      'initialization and closure must not invent a model turn');
    assert.equal(probe.logs.some(item => /回收未确认|资源清理失败/.test(item.message)), false, 'SDK closure must not leave a failed cleanup barrier');
  }
  assert.equal(probes.length, 2, 'a second real streaming connection can initialize and close after the first');
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const probe of probes) {
    probe.controller.abort();
    if (probe.connection) {
      try { await bounded(probe.connection.close(), CLEANUP_MS, 'final GUI connection cleanup'); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  try { await bounded(api?.shutdownControlledChildren() ?? Promise.resolve(), CLEANUP_MS, 'controlled child shutdown'); }
  catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Claude live owner probe cleanup was not confirmed');
    console.error(`Retained failed probe artifacts: ${folder}`);
  } else {
    assert.equal(path.dirname(path.resolve(folder)), scratch);
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
if (failure) throw failure;
console.log('real Claude GUI driver/SDK ownership passed: two streaming connections, concurrent/repeated close and SDK idle stream close; zero inference prompts');
