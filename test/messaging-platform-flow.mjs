import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { setImmediate } from 'node:timers/promises';
import { createProductionController } from '../src/main/messaging/dsh-im/adapters/host/channels/office/production.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-messaging-platform-flow-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const appDir = path.join(temp, 'compiled');
const compile = createSharedCompiler(root, appDir);
await build({
  entryPoints: [path.join(root, 'src/main/attachments/worker.ts')],
  outfile: path.join(appDir, 'out/main/attachments/worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent'
});
const { MusterMessagingSessionHost } = await import(pathToFileURL(compile('main/messaging/sessionHost.ts')).href);
const { messagingTurnIdentity } = await import(
  pathToFileURL(compile('main/messaging/sessionAuthority.ts')).href
);

test('AI Office creates its owned Session and completes the accepted task once', { timeout: 15_000 }, async () => {
  const workspace = { id: 'test-workspace', path: path.join(temp, 'workspace'), name: 'Fixture' };
  fs.mkdirSync(workspace.path);
  const sessions = new Map();
  const subscribers = new Set();
  const prompts = [];
  const submissions = [];
  const replies = [];
  const diagnostics = [];
  const logger = { warn: (...args) => diagnostics.push(args), error: (...args) => diagnostics.push(args), info() {}, debug() {} };
  const gui = {
    semanticRoot: path.join(temp, 'user-data'),
    getDriver(runtime) { return runtime === 'pi' ? {} : undefined; },
    listPiModes() { return []; },
    open() {},
    onPush(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    getHistoryRange() { return undefined; },
    currentAssistantMessageId() { return undefined; },
    sendMessagingInput(sessionId, request) {
      prompts.push({ sessionId, ...request });
      const { assistantMessageId } = messagingTurnIdentity(request.requestId);
      queueMicrotask(() => {
        const event = { kind: 'sync', sessionId, messages: [{
          id: assistantMessageId, role: 'assistant', ts: Date.now(), finishedAt: Date.now(),
          parts: [{ kind: 'text', text: `Fixture reply ${prompts.length}` }]
        }] };
        for (const listener of [...subscribers]) listener(event);
      });
      return { status: 'accepted', turnId: assistantMessageId };
    }
  };
  const host = new MusterMessagingSessionHost({
    config: { get: () => ({ activeWorkspaceId: workspace.id, workspaces: [workspace] }) },
    agentSessions: gui,
    sessions: {
      createTerminal(options) {
        submissions.push(options);
        const session = {
          ...options, ...options.inheritMeta,
          id: `fixture-session-${sessions.size + 1}`, cwd: workspace.path, name: 'Fixture session'
        };
        sessions.set(session.id, session);
        return session;
      },
      list: () => [...sessions.values()],
      get: id => sessions.get(id),
      flushPersist() {},
      rename() {}
    }
  });
  const jobId = 'job-' + '1'.repeat(32);
  const credentials = new Map();
  const production = await createProductionController({
    credentials: {
      async resolve(ref) { return { value: credentials.get(ref) }; },
      async set(ref, value) { credentials.set(ref, value); },
      async unset(ref) { credentials.delete(ref); },
    },
    logger: () => logger,
  }, { storageRoot: path.join(temp, 'office-data') }, {
    createOfficeHarness: options => host.createHarness(options, 'office'),
    transport: {
      async heartbeat() { return { jobs: [{ id: jobId }, { id: jobId }] }; },
      async stream({ signal, onOpen }) {
        onOpen();
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      },
      async getJob() { return { job: { id: jobId, workspaceAlias: 'fixture', instructionPreset: 'review', markdown: 'Fixture task' } }; },
      async acceptJob() { return { leaseToken: 'fixture-lease' }; },
      async progressJob() {},
      async completeJob(id, lease, result) { replies.push({ id, lease, ...result }); },
      async failJob(_id, _lease, failure) { diagnostics.push(failure); },
    },
  });
  try {
    await production.controller.configure({
      baseUrl: 'http://127.0.0.1:9090', deviceId: 'fixture-device', deviceToken: 'fixture-token-'.repeat(3),
      workspaces: { fixture: workspace.path }, instructionPresets: { review: 'Check the task' }, maxConcurrency: 1,
    });
    let status = await production.controller.status();
    while (!status.health?.jobs?.completed && !status.health?.jobs?.failed) {
      await setImmediate();
      status = await production.controller.status();
    }
    assert.equal(status.health.jobs.failed, 0, JSON.stringify(diagnostics));
    assert.equal(status.health.jobsOffered, 1);
    assert.equal(submissions.length, 1);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /Fixture task/);
    assert.deepEqual(replies, [{ id: jobId, lease: 'fixture-lease', sessionId: prompts[0].sessionId, resultMarkdown: 'Fixture reply 1' }]);
  } finally {
    await production.close();
    await host.stopAndWait();
  }
});
