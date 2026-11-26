/**
 * 排队注入对调度可见：原生 GUI 输入忙时排队、胶囊计数及合入保守判定；旧投递事件不再存在。
 * 运行: node test/inject-queue-visibility.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-queue-vis-'));
const compile = createSharedCompiler(root, tmp);
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');

const {
  countInjectQueued,
  stripInjectQueueSuffix,
  formatInjectQueueCapsule
} = await import(pathToFileURL(compile('shared/injectQueue.ts')).href);

const { judgePipelineWorker } = await import(
  pathToFileURL(compile('shared/pipelineStatus.ts')).href
);

const { aggregateOrchEvents, orchEventKey, isOrchEventKind } = await import(
  pathToFileURL(compile('shared/notifyQueue.ts')).href
);

assert.equal(isOrchEventKind('inject_queued'), false);
assert.equal(isOrchEventKind('inject_drained'), false);

assert.equal(countInjectQueued([]), 0);
assert.equal(countInjectQueued([{ fromInject: true }, {}, { fromInject: true }]), 2);
assert.equal(countInjectQueued([{}]), 0);

assert.equal(stripInjectQueueSuffix('排查中 · 排队2'), '排查中');
assert.equal(stripInjectQueueSuffix('排队注入 3 条'), '');
assert.equal(formatInjectQueueCapsule('排查中', 2), '排查中 · 排队2');
assert.equal(formatInjectQueueCapsule('', 2), '排队注入 2 条');
assert.equal(formatInjectQueueCapsule('排查中 · 排队2', 3), '排查中 · 排队3');
assert.equal(formatInjectQueueCapsule('排查中 · 排队2', 0), '排查中');
console.log('ok: 胶囊叠字 / 计数');

// ---------- 机械判定：有未消化注入时 readyToMerge 必须翻保守 ----------
{
  const now = 1_700_000_000_000;
  const th = { stallMs: 15 * 60 * 1000 };
  const base = {
    phase: 'needs_you',
    lastActivityAt: now - 1000,
    uncommittedCount: 0,
    aheadCount: 1,
    canFastForward: true,
    dirtyOverlap: false,
    hasWorktree: true
  };
  assert.equal(judgePipelineWorker(base, now, th).kind, 'readyToMerge', '闸全过且无排队注入 → 可合入');
  assert.equal(judgePipelineWorker({ ...base, queuedInjects: 0 }, now, th).kind, 'readyToMerge');
  const held = judgePipelineWorker({ ...base, queuedInjects: 2 }, now, th);
  assert.equal(held.kind, 'mergeBlocked', '有未消化注入 → 不得给 readyToMerge');
  assert.equal(held.mergeBlocked, 'not_ready', '保守原因 not_ready（人工确认后再合）');
  // 更具体的 git 阻塞原因优先暴露，注入只在全过后拦
  const overlap = judgePipelineWorker({ ...base, queuedInjects: 2, dirtyOverlap: true }, now, th);
  assert.equal(overlap.mergeBlocked, 'dirty_overlap');
  console.log('ok: judge 排队注入保守（readyToMerge 翻 mergeBlocked/not_ready）');
}

// ---------- Host：忙时 fromInject 入队 → 胶囊 + 通知；消化最后一条 → 排空 ----------
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(outputText, filename);
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), isReady: () => true },
      ipcMain: { handle: () => {}, on: () => {} }
    };
  }
  return origLoad.apply(this, arguments);
};

const { AgentSessionHost } = require(path.join(root, 'src/main/agentSession/host.ts'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });

function makeFakeDriver() {
  const state = {
    sends: [],
    redirectReturns: false,
    queue: null,
    resolveConnect: null
  };
  const driver = {
    runtimeId: 'pi',
    supportsImages: false,
    supportsSeed: false,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'hot',
    connect() {
      return new Promise((resolve) => {
        state.resolveConnect = () => {
          const q = {
            items: [],
            closed: false,
            push(ev) {
              if (!this.closed) this.items.push(ev);
            },
            async *[Symbol.asyncIterator]() {
              while (true) {
                if (this.items.length) yield this.items.shift();
                else if (this.closed) return;
                else await tick(5);
              }
            }
          };
          state.queue = q;
          resolve({
            events: q,
            async send(text) {
              state.sends.push(text);
            },
            redirect() {
              return state.redirectReturns === true;
            },
            async abort() {
              q.closed = true;
            },
            async close() {
              q.closed = true;
            }
          });
        };
      });
    }
  };
  return { driver, state };
}

function makeHost(dir) {
  const sessionsDb = new Map();
  const ctx = {
    runtimes: { list: builtinHarnessFixtures },
    getWindow: () => null,
    store: { loadSessions: () => [...sessionsDb.values()] },
    sessions: {
      engineSweepRoster: () => [...sessionsDb.values()],
      get: (id) => sessionsDb.get(id),
      setQueuedInjects: (id, n) => {
        const s = sessionsDb.get(id);
        if (!s) return;
        if (n > 0) s.queuedInjects = n;
        else delete s.queuedInjects;
      },
      applyActivitySignal: () => {},
      touchUsed: () => {},
      updateGuiMode: () => {},
      updateThinkingLevel: () => {},
      updatePiMode: () => {},
      updateModelOverride: () => {},
      updateRuntimeHandle: () => {},
      resetRuntimeHandle: () => {},
      createTerminal: async (opts) => ({ id: 'new', ...opts })
    },
    config: {
      get: () => ({
        workspaces: [{ id: 'ws1', name: 'Queue test', path: tmp }],
        llm: {
          providers: [{ id: 'p1', baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'm1' }], enabled: true }],
          activeProviderId: 'p1',
          activeModelId: 'm1'
        },
        agentRules: []
      }),
      effectiveMcp: () => ({ servers: [] })
    },
    bgTasks: null
  };
  ctx.__sessionsDb = sessionsDb;
  const host = new AgentSessionHost(ctx, { userDataDir: dir });
  return { host, ctx };
}

const session = (id, extra = {}) => ({
  id,
  name: id,
  runtime: 'pi',
  type: 'terminal',
  cwd: tmp,
  workspaceId: 'ws1',
  orchestrated: true,
  ...extra
});

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-q-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(dir);
  host.registerDriver(driver);
  ctx.__sessionsDb.set('s1', session('s1', { liveStatus: { label: '排查中', kind: 'active', ts: 1 } }));
  host.open(session('s1'));

  const first = host.send('s1', '首条任务');
  await sleep(20);
  const q1 = await host.send('s1', '补充指令一', undefined, { fromInject: true });
  assert.equal(q1.queued, true, JSON.stringify(q1));
  assert.equal(ctx.__sessionsDb.get('s1').queuedInjects, 1, '胶囊计数 1');

  const q2 = await host.send('s1', '补充指令二', undefined, { fromInject: true });
  assert.equal(q2.queued, true);
  assert.equal(ctx.__sessionsDb.get('s1').queuedInjects, 2, '连续注入计数 2');
  assert.equal(
    formatInjectQueueCapsule(ctx.__sessionsDb.get('s1').liveStatus.label, 2),
    '排查中 · 排队2'
  );

  const userQ = await host.send('s1', '用户手打', undefined, { steerOnBusy: false });
  assert.equal(userQ.queued, true);
  assert.equal(ctx.__sessionsDb.get('s1').queuedInjects, 2, '用户手打不计入注入数');

  state.resolveConnect();
  await first;
  await sleep(40);
  // 队列：[注入1, 注入2, 用户]。首回合结束 → 开始消化注入1，剩注入2
  state.queue.push({ type: 'turn-complete' });
  await sleep(80);
  assert.equal(ctx.__sessionsDb.get('s1').queuedInjects, 1, '开始消化第一条注入后剩 1');

  // 注入1 结束 → 开始消化最后一条注入，计数清零并报 drained
  state.queue.push({ type: 'turn-complete' });
  await sleep(80);
  assert.equal(ctx.__sessionsDb.get('s1').queuedInjects, undefined, '开始消化最后一条注入 → 计数清零');

  await host.abort('s1');
  console.log('ok: Host 原生消息排队与胶囊计数');
}

console.log('inject-queue-visibility: all ok');
