/**
 * GUI 会话 store setMode 错误提示与串行队列（U2 补充，2026-10-02 修复）：
 * 直接实例化 AgentSessionSurfaceStore（转译副本，与 docs/audits/evidence/review-4-7-2026-10-02.cjs
 * 同款加载方式），注入可控 deps.flashTip 与可控 IPC 应答——断言：
 * - 请求失败/异常错误提示保留（deps.flashTip 收到 error 文案）；
 * - 连发三次（串行队列按发出顺序落定，链不断）；
 * - dispose（切会话）后晚到的失败不提示、不改状态。
 * 还原修复即红：去掉 runSetMode 的 flashTip/epoch 校验或退回无条件回滚，断言转红。
 * 运行: node test/chat-mode-setmode-tips.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 与审计探针同款加载器：真实源码转译，仅在指定副本追加内部类 export */
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
  const promise = new Promise((a) => {
    resolve = a;
  });
  return { promise, resolve };
};

/** 可控 IPC 环境：getHistory/setMode 应答门 + agentSession:event 通道 */
function makeEnv() {
  const callbacks = new Map();
  const historyGate = deferred();
  const modeReplies = [];
  const tips = [];
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  global.window = {
    setTimeout,
    clearTimeout,
    api: {
      agentSession: {
        getHarnessModelSelections: async () => ({}),
        getHistory: () => historyGate.promise,
        setMode: () => {
          const d = deferred();
          modeReplies.push(d);
          return d.promise;
        }
      },
      config: { get: async () => ({}) },
      on: (c, fn) => {
        callbacks.set(c, fn);
        return () => callbacks.delete(c);
      }
    }
  };
  return { callbacks, historyGate, modeReplies, tips };
}

async function main() {
  // ── 1. 错误提示保留 + 串行队列链不断 ──
  {
    const env = makeEnv();
    const load = loader(
      { 'src/renderer/src/store.tsx': {}, 'src/renderer/src/sessionJump.ts': {} },
      { 'src/renderer/src/chatSurface/agentSessionSurface.tsx': '\nexport { AgentSessionSurfaceStore as Store };' }
    );
    const { Store } = load('src/renderer/src/chatSurface/agentSessionSurface.tsx');
    const s = new Store('s', { pi: true, cursor: false, claude: false, acp: false, codex: false });
    s.attach('pi', { flashTip: (t) => env.tips.push(t), t: (k, o) => Object.entries(o ?? {}).reduce((s, [key, v]) => s.replaceAll(`{{${key}}}`, String(v)), k) });
    // 初始历史（mode=auto 落定 confirmedMode）
    env.historyGate.resolve({ messages: [], mode: 'auto', busy: false });
    await delay(0);

    // 连发三档（串行队列）
    const p1 = s.setMode('default');
    await delay(0);
    const p2 = s.setMode('plan');
    await delay(0);
    const p3 = s.setMode('ask');
    assert.equal(s.getSnapshot().mode, 'ask', '乐观显示最新点击');
    // 三个请求按发出顺序落定：1 失败（被取代，不回滚）→ 2 失败（被取代）→ 3 失败（最新 ⇒ 回滚 confirmed=auto）
    env.modeReplies[0].resolve({ ok: false, error: 'e1' });
    await p1;
    await delay(0);
    assert.equal(s.getSnapshot().mode, 'ask', '旧失败不回滚新乐观');
    env.modeReplies[1].resolve({ ok: false, error: 'e2' });
    await p2;
    await delay(0);
    assert.equal(s.getSnapshot().mode, 'ask');
    env.modeReplies[2].resolve({ ok: false, error: 'e3' });
    await p3;
    assert.equal(s.getSnapshot().mode, 'auto', '最新失败回滚到最后确认值');
    assert.deepEqual(
      env.tips,
      ['e1', 'e2', 'e3'],
      '每个失败都保留错误提示（不吞错）'
    );

    // 链未断：后续 setMode 照常执行
    const p4 = s.setMode('plan');
    await delay(0);
    env.modeReplies[3].resolve({ ok: true });
    await p4;
    assert.equal(s.getSnapshot().mode, 'plan', '队列恢复（链未断）');

    // ── 2. dispose 后晚到失败：不提示、不改状态 ──
    const p5 = s.setMode('ask');
    await delay(0);
    s.dispose();
    env.modeReplies[4].resolve({ ok: false, error: 'late-failure' });
    await p5;
    // dispose 前用户乐观选择的 ask 保留（死 store 不再渲染，新生命周期重拉权威值）；
    // 晚到失败不得回滚它（回滚即「晚到回调改状态」，还原修复会观察到 plan）
    assert.equal(s.getSnapshot().mode, 'ask', 'dispose 后晚到失败不改状态');
    assert.ok(!env.tips.includes('late-failure'), 'dispose 后晚到失败不提示');
  }

  // ── 3. 异常路径：throw 也提示且回滚正确基准 ──
  {
    const env = makeEnv();
    const load = loader(
      { 'src/renderer/src/store.tsx': {}, 'src/renderer/src/sessionJump.ts': {} },
      { 'src/renderer/src/chatSurface/agentSessionSurface.tsx': '\nexport { AgentSessionSurfaceStore as Store };' }
    );
    const { Store } = load('src/renderer/src/chatSurface/agentSessionSurface.tsx');
    const s = new Store('t', { pi: true, cursor: false, claude: false, acp: false, codex: false });
    s.attach('pi', { flashTip: (t) => env.tips.push(t), t: (k, o) => Object.entries(o ?? {}).reduce((s, [key, v]) => s.replaceAll(`{{${key}}}`, String(v)), k) });
    env.historyGate.resolve({ messages: [], mode: 'auto', busy: false });
    await delay(0);
    const p1 = s.setMode('plan');
    await delay(0);
    global.window.api.agentSession.setMode = () => Promise.reject(new Error('ipc blew up'));
    // 直接对队列注入异常：先恢复可控实现拿不到——改为在下一请求注入
    env.modeReplies[0].resolve({ ok: false, error: 'before-crash' });
    await p1;
    const p2 = s.setMode('default');
    await p2; // 走到注入的 reject
    assert.equal(s.getSnapshot().mode, 'auto', '异常回滚到确认基准');
    assert.ok(env.tips.some((x) => x.includes('ipc blew up')), '异常文案提示保留');
  }

  console.log('chat-mode-setmode-tips: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
