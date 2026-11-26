/**
 * chat-surface 三处 IPC 错误路径回归（审计 chat-surface F-01，2026-10-26 修复）：
 * 直接实例化 AgentSessionSurfaceStore（与 test/chat-mode-setmode-tips.mjs 同款转译装载器），
 * 注入可控 deps.flashTip 与拒绝的 IPC 应答——断言：
 * - setModelParameter IPC 拒绝：返回 {ok:false,error}、flashTip 收到文案、无未处理 rejection；
 * - changePreset（pi 会话）setPiMode 拒绝：flashTip 收到文案、无未处理 rejection、状态不变。
 * orchestratorSurface.setModel 的同款 .catch（tipFn）与既有 setMode/setThinking 守卫同文件同构，
 * 离线断言不覆盖该行；人工验证：断开调度模型配置后切换模型应弹提示。
 * 还原修复即红。运行: node test/chat-surface-ipc-errors.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loader(overrides, additions) {
  const cache = new Map();
  const load = (abs) => {
    abs = path.resolve(abs);
    const rel = path.relative(root, abs).replaceAll('\\', '/');
    if (Object.hasOwn(overrides, rel)) return overrides[rel];
    if (cache.has(abs)) return cache.get(abs).exports;
    const module = { exports: {} };
    cache.set(abs, module);
    const source = fs.readFileSync(abs, 'utf8') + (additions[rel] || '');
    const code = ts.transpileModule(source, {
      fileName: abs,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React
      }
    }).outputText;
    const req = (spec) => {
      if (Object.hasOwn(overrides, spec)) return overrides[spec];
      if (!spec.startsWith('.')) return require(spec);
      const base = path.resolve(path.dirname(abs), spec);
      const file = [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), base].find(
        (p) => fs.existsSync(p) && fs.statSync(p).isFile()
      );
      if (!file) throw new Error('missing dependency ' + spec);
      return /\.tsx?$/.test(file) ? load(file) : require(file);
    };
    new Function('require', 'module', 'exports', '__filename', '__dirname', code)(
      req,
      module,
      module.exports,
      abs,
      path.dirname(abs)
    );
    return module.exports;
  };
  return (rel) => load(path.join(root, rel));
}

const delay = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
};

function makeEnv() {
  const historyGate = deferred();
  const tips = [];
  const unhandled = [];
  process.on('unhandledRejection', (r) => unhandled.push(r));
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  global.window = {
    setTimeout,
    clearTimeout,
    api: {
      agentSession: {
        getHarnessModelSelections: async () => ({}),
        getHistory: () => historyGate.promise,
        setPiMode: () => Promise.reject(new Error('pi-mode IPC down')),
        setModelParameters: () => Promise.reject(new Error('param IPC down'))
      },
      config: { get: async () => ({}) },
      on: () => () => undefined
    }
  };
  return { historyGate, tips, unhandled };
}

async function main() {
  const env = makeEnv();
  const load = loader(
    { 'src/renderer/src/store.tsx': {}, 'src/renderer/src/sessionJump.ts': {} },
    { 'src/renderer/src/chatSurface/agentSessionSurface.tsx': '\nexport { AgentSessionSurfaceStore as Store };' }
  );
  const { Store } = load('src/renderer/src/chatSurface/agentSessionSurface.tsx');
  const s = new Store('s', { pi: true, cursor: false, claude: false, acp: false, codex: false });
  s.attach('pi', { flashTip: (t) => env.tips.push(t), t: (k, o) => Object.entries(o ?? {}).reduce((acc, [key, v]) => acc.replaceAll(`{{${key}}}`, String(v)), k) });
  env.historyGate.resolve({ messages: [], mode: 'auto', busy: false });
  await delay(0);

  // 1) setModelParameter：IPC 拒绝 → {ok:false,error} + flashTip + 无未处理 rejection
  const before = s.getSnapshot();
  const r = await s.setModelParameter('thinking', 'high');
  await delay(0);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'param IPC down');
  assert.ok(env.tips.some((t) => String(t).includes('param IPC down')), `flashTip 收到错误文案，实际: ${JSON.stringify(env.tips)}`);

  // 2) changePreset（pi 会话）：setPiMode 拒绝 → flashTip + 状态不变 + 无未处理 rejection
  await s.changePreset('plan');
  await delay(0);
  assert.ok(env.tips.some((t) => String(t).includes('pi-mode IPC down')), `changePreset flashTip，实际: ${JSON.stringify(env.tips)}`);
  assert.equal(s.getSnapshot().mode, before.mode, '模式未被失败请求改变');

  assert.equal(env.unhandled.length, 0, '不得有未处理 rejection');
  console.log('chat-surface-ipc-errors: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
