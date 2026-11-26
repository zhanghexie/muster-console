/**
 * GUI 会话上下文用量持久化：
 * - shared/guiContextUsage：可否落盘、fork 占位、陈旧快照
 * - GuiSessionStore：lastUsage 写入/读回/refresh 清空
 * - AgentSessionHost：回合后持久化、重启 getHistory 恢复、fork 不复用、refresh 重置
 * 运行: node test/gui-context-usage.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');

const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-usage-shared-'));
const sharedEntry = path.join(root, 'src/shared/guiContextUsage.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(sharedEntry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: sharedEntry
});
const sharedOut = path.join(tmpShared, 'guiContextUsage.mjs');
fs.writeFileSync(sharedOut, outputText, 'utf8');
const {
  isForkPlaceholderUsage,
  isPersistableUsage,
  parseLastUsage,
  toLastUsage,
  staleUsageView,
  liveUsageView
} = await import(pathToFileURL(sharedOut).href);

// ---------- 纯函数 ----------
assert.equal(isForkPlaceholderUsage({ tokens: 0, contextWindow: 200000 }), true, 'tokens===0 是 fork 占位');
assert.equal(isForkPlaceholderUsage({ tokens: 88, contextWindow: 200000 }), false);
assert.equal(isForkPlaceholderUsage(null), false);

assert.equal(isPersistableUsage(null), false);
assert.equal(isPersistableUsage({ tokens: 0, contextWindow: 200000 }), false, '占位不入持久化');
assert.equal(isPersistableUsage({ tokens: 12800, contextWindow: 200000 }), true);
assert.equal(isPersistableUsage({ tokens: null, contextWindow: 200000 }), true, 'compact 后 tokens 未知仍可写窗口');
assert.equal(isPersistableUsage({ tokens: null, contextWindow: 0 }), false, 'Cursor 空窗+未知 tokens 不写');
assert.equal(isPersistableUsage({ tokens: 42, contextWindow: 0 }), true, 'Cursor 已用 N 可写');
assert.equal(isPersistableUsage({ tokens: -1, contextWindow: 200000 }), false);

assert.equal(parseLastUsage({ tokens: 10, contextWindow: 100, ts: 0 }), null, 'ts<=0 拒');
assert.deepEqual(parseLastUsage({ tokens: 10, contextWindow: 100, ts: 1700000000000 }), {
  tokens: 10,
  contextWindow: 100,
  ts: 1700000000000
});
assert.equal(parseLastUsage({ tokens: 0, contextWindow: 100, ts: 1700000000000 }), null, '占位不解析');
assert.equal(parseLastUsage({ tokens: 10, contextWindow: 100 }), null);

const last = toLastUsage({ tokens: 99, contextWindow: 200 }, 1700000000001);
assert.deepEqual(last, { tokens: 99, contextWindow: 200, ts: 1700000000001 });
assert.equal(toLastUsage({ tokens: 0, contextWindow: 200 }, 1700000000001), null);
assert.deepEqual(staleUsageView(last), {
  tokens: 99,
  contextWindow: 200,
  ts: 1700000000001,
  stale: true
});
assert.deepEqual(liveUsageView({ tokens: 99, contextWindow: 200 }, 9), {
  tokens: 99,
  contextWindow: 200,
  ts: 9
});

require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText: out } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(out, filename);
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
const { GuiSessionStore } = require(path.join(root, 'src/main/agentSession/persist.ts'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });

function makeFakeDriver(usageHolder) {
  const state = {
    connects: 0,
    queue: null,
    resolveConnect: null,
    conn: null
  };
  const driver = {
    runtimeId: 'pi',
    supportsImages: false,
    supportsSeed: true,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'hot',
    connect() {
      state.connects += 1;
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
                if (this.items.length) {
                  yield this.items.shift();
                } else if (this.closed) {
                  return;
                } else {
                  await tick(5);
                }
              }
            }
          };
          state.queue = q;
          const conn = {
            events: q,
            async send() {},
            async abort() {
              q.closed = true;
            },
            async close() {
              q.closed = true;
            },
            getContextUsage() {
              return usageHolder.usage;
            }
          };
          state.conn = conn;
          resolve(conn);
        };
      });
    }
  };
  return { driver, state };
}

function makeHost(tmp) {
  const sessionsDb = new Map();
  const created = [];
  const ctx = {
    store: { loadSessions: () => [] },
    runtimes: { list: builtinHarnessFixtures },
    getWindow: () => null,
    sessions: {
      engineSweepRoster: () => [],
      get: (id) => sessionsDb.get(id),
      applyActivitySignal: () => {},
      touchUsed: () => {},
      updateGuiMode: () => {},
      updateThinkingLevel: () => {},
      updatePiMode: () => {},
      updateModelOverride: () => {},
      updateRuntimeHandle: () => {},
      resetRuntimeHandle: () => {},
      createTerminal: async (opts) => {
        const s = {
          id: `fork-${created.length + 1}`,
          name: opts.name ?? 'fork',
          runtime: opts.runtime ?? 'pi',
          type: 'terminal',
          cwd: opts.cwd ?? tmpShared
        };
        created.push(s);
        sessionsDb.set(s.id, s);
        return s;
      }
    },
    config: {
      get: () => ({
        workspaces: [],
        llm: {
          providers: [{ id: 'p1', name: 'Fixture provider', baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'm1', name: 'Fixture model' }], enabled: true }],
          activeProviderId: 'p1',
          activeModelId: 'm1'
        },
        agentRules: []
      }),
      effectiveMcp: () => ({ servers: [] })
    },
    bgTasks: null,
    __sessionsDb: sessionsDb,
    __created: created
  };
  const host = new AgentSessionHost(ctx, { userDataDir: tmp });
  return { host, ctx };
}

const session = (id, extra = {}) => ({
  id,
  name: id,
  runtime: 'pi',
  type: 'terminal',
  cwd: tmpShared,
  ...extra
});

async function runTurn(host, ctx, state, id, text) {
  ctx.__sessionsDb.set(id, session(id));
  const sendP = host.send(id, text);
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  state.queue.push({ type: 'turn-complete' });
  await sleep(60);
}

// ---------- Store：写入 / 读回 / 省略 lastUsage 不丢 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-usage-store-'));
  const store = new GuiSessionStore(tmp);
  const msgs = [{ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 }];
  store.save('s1', msgs, { tokens: 12800, contextWindow: 200000, ts: 1700000001000 });
  store.flushSync();
  assert.deepEqual(store.loadLastUsage('s1'), {
    tokens: 12800,
    contextWindow: 200000,
    ts: 1700000001000
  });
  store.save('s1', [...msgs, { id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], ts: 2 }]);
  store.flushSync();
  assert.equal(store.load('s1').length, 2, '只改消息');
  assert.equal(store.loadLastUsage('s1').tokens, 12800, '省略 lastUsage 不丢盘上用量');
  store.save('s1', msgs, null);
  store.flushSync();
  assert.equal(store.loadLastUsage('s1'), null, '显式 null 清空');
}

// ---------- Host：回合后持久化 + 重启 getHistory 恢复 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-usage-host-'));
  const usageHolder = { usage: { tokens: 88000, contextWindow: 200000 } };
  const { driver, state } = makeFakeDriver(usageHolder);
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  host.open(session('s1'));
  await runTurn(host, ctx, state, 's1', 'hello');
  host.flushPersist();
  const live = host.getHistory('s1');
  assert.equal(live.usage.tokens, 88000, '连接在时返回实时用量');
  assert.equal(live.usage.stale, undefined, '实时不标 stale');

  const store = new GuiSessionStore(tmp);
  const persisted = store.loadLastUsage('s1');
  assert.ok(persisted, '回合后落盘 lastUsage');
  assert.equal(persisted.tokens, 88000);
  assert.equal(persisted.contextWindow, 200000);
  assert.ok(persisted.ts > 0);

  // 模拟重启：新 Host、未建连接
  const { host: host2, ctx: ctx2 } = makeHost(tmp);
  ctx2.__sessionsDb.set('s1', session('s1'));
  const disk = host2.getHistory('s1');
  assert.equal(disk.usage.tokens, 88000, '未打开也能从转写恢复');
  assert.equal(disk.usage.stale, true, '恢复值标 stale');
  assert.ok(disk.usage.ts > 0);

  host2.open(session('s1'));
  const opened = host2.getHistory('s1');
  assert.equal(opened.usage.tokens, 88000, 'open 后连接未建仍显示 lastUsage');
  assert.equal(opened.usage.stale, true);
}

// ---------- Host：fork 不复用 lastUsage；占位用量不落盘 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-usage-fork-'));
  const usageHolder = { usage: { tokens: 50000, contextWindow: 200000 } };
  const { driver, state } = makeFakeDriver(usageHolder);
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  host.open(session('s1'));
  await runTurn(host, ctx, state, 's1', 'src');
  host.flushPersist();
  const srcHist = host.getHistory('s1');
  const srcMsgId = srcHist.messages.find((m) => m.role === 'user').id;

  const forked = await host.forkSession('s1', srcMsgId);
  assert.equal(forked.ok, true);
  const forkId = forked.sessionId;
  host.flushPersist();
  const store = new GuiSessionStore(tmp);
  assert.equal(store.loadLastUsage(forkId), null, 'fork 转写不带源会话 lastUsage');

  // mock createTerminal 不走真实 launch/open，这里补 open（会吃 pendingFork）
  ctx.__sessionsDb.set(forkId, session(forkId));
  host.open(session(forkId));
  usageHolder.usage = { tokens: 0, contextWindow: 200000 };
  const sendP = host.send(forkId, 'continue');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  // 种子回放后 resume-token 推 context：占位 0 不得写入
  state.queue.push({ type: 'resume-token', token: 'tok-fork' });
  await sleep(40);
  host.flushPersist();
  assert.equal(store.loadLastUsage(forkId), null, 'fork 占位用量不落盘');

  usageHolder.usage = { tokens: 1200, contextWindow: 200000 };
  state.queue.push({ type: 'turn-complete' });
  await sleep(60);
  host.flushPersist();
  const afterTurn = store.loadLastUsage(forkId);
  assert.ok(afterTurn, 'fork 后第一真实回合才落盘');
  assert.equal(afterTurn.tokens, 1200);
}

// ---------- Host：GUI refresh 重置 lastUsage ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-usage-refresh-'));
  const usageHolder = { usage: { tokens: 777, contextWindow: 200000 } };
  const { driver, state } = makeFakeDriver(usageHolder);
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  host.open(session('s1'));
  await runTurn(host, ctx, state, 's1', 'hi');
  host.flushPersist();
  assert.ok(new GuiSessionStore(tmp).loadLastUsage('s1'), 'refresh 前有 lastUsage');

  usageHolder.usage = null;
  await host.refresh('s1');
  host.flushPersist();
  assert.equal(new GuiSessionStore(tmp).loadLastUsage('s1'), null, 'refresh 清掉落盘用量');
  const hist = host.getHistory('s1');
  assert.equal(hist.usage, undefined, 'refresh 后 getHistory 不再回落旧用量');
}

console.log('gui-context-usage: ok');
