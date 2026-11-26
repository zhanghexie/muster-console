/**
 * node-repl 持久会话（zcode-adopt-batch-d S2.2/T2）：
 * - 跨调用状态（globalThis / var / function / const 改写后保留）
 * - generation 单调防 ABA（reset 后旧 generation 过期、定时器清空）
 * - 超时/取消契约（同步死循环抢占、kernel reset 指引、纯函数钳制）
 * 运行: node test/node-repl.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-compile-'));
const compile = createSharedCompiler(root, compileTmp);

const S = await import(pathToFileURL(compile('shared/nodeRepl.ts')).href);
const { NodeReplSession, instrumentNodeReplTopLevel } = await import(
  pathToFileURL(compile('main/nodeRepl/session.ts')).href
);

const {
  resolveNodeReplTimeoutMs,
  isNodeReplStaleGeneration,
  nodeReplKernelResetNote,
  truncateNodeReplOutput,
  formatNodeReplValue,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_MAX_TIMEOUT_MS,
  NODE_REPL_MIN_TIMEOUT_MS,
  NODE_REPL_TOOL_ID,
  NODE_REPL_TOOL_LABEL,
  NODE_REPL_TOOL_DESCRIPTION
} = S;

try {
  // ------------------------------------------------------------------ 纯函数
  assert.equal(resolveNodeReplTimeoutMs(undefined), NODE_REPL_DEFAULT_TIMEOUT_MS);
  assert.equal(resolveNodeReplTimeoutMs('x'), NODE_REPL_DEFAULT_TIMEOUT_MS);
  assert.equal(resolveNodeReplTimeoutMs(NaN), NODE_REPL_DEFAULT_TIMEOUT_MS);
  assert.equal(resolveNodeReplTimeoutMs(500), NODE_REPL_MIN_TIMEOUT_MS, '过小钳到下限');
  assert.equal(resolveNodeReplTimeoutMs(10 ** 9), NODE_REPL_MAX_TIMEOUT_MS, '过大钳到上限');
  assert.equal(resolveNodeReplTimeoutMs(30_000), 30_000);

  assert.equal(isNodeReplStaleGeneration(1, 1), false);
  assert.equal(isNodeReplStaleGeneration(1, 2), true, 'reset 后旧 generation 过期');
  assert.equal(isNodeReplStaleGeneration(3, 2), true, '超前也视为串线');

  assert.match(nodeReplKernelResetNote('timeout'), /上下文已整体重建|上下文已重建|重建/);
  assert.match(nodeReplKernelResetNote('cancel'), /重建/);
  assert.match(truncateNodeReplOutput('x'.repeat(100), 10), /截断/);
  assert.equal(truncateNodeReplOutput('short', 100), 'short');

  // hasValue 三态（node-repl F-01）：空字符串值不再被改写成 'undefined'
  assert.equal(formatNodeReplValue('', false), 'undefined', '真 undefined 标 undefined');
  assert.equal(formatNodeReplValue('', true), '', '空字符串原样保留（不再伪报 undefined）');
  assert.equal(formatNodeReplValue('', ), '', '旧调用缺省视为有值，空串原样');
  assert.equal(formatNodeReplValue('42'), '42');
  assert.equal(formatNodeReplValue("'x'"), "'x'");

  // 工具面：用户语言 title，禁 js/node_repl 实现术语
  assert.equal(NODE_REPL_TOOL_ID, 'node_repl.js');
  assert.ok(!/\bnode_repl\b/i.test(NODE_REPL_TOOL_LABEL), 'label 不得出现实现术语 node_repl');
  assert.ok(!/\bjs\b/i.test(NODE_REPL_TOOL_LABEL), 'label 不得出现实现术语 js');
  assert.ok(NODE_REPL_TOOL_DESCRIPTION.length > 50);
  console.log('ok: 纯函数（超时钳制 / generation 判定 / reset 文案 / 工具面）');

  // ------------------------------------------------------------------ instrument
  const inst = instrumentNodeReplTopLevel(
    ['const a = 1', 'let b = 2', 'var c = 3', 'function f() { return 1 }', 'class K {}'].join('\n')
  );
  assert.match(inst, /globalThis\.a = 1/);
  assert.match(inst, /globalThis\.b = 2/);
  assert.match(inst, /globalThis\.c = 3/);
  assert.match(inst, /globalThis\.f = function f/);
  assert.match(inst, /globalThis\.K = class K/);
  // 嵌套块内不改写
  const nested = instrumentNodeReplTopLevel('function g() {\n  const inner = 1;\n  return inner;\n}');
  assert.ok(!/globalThis\.inner/.test(nested), '嵌套 const 不改写');
  assert.match(nested, /const inner = 1/);
  console.log('ok: instrument 顶层声明改写（含嵌套不误伤）');

  // ------------------------------------------------------------------ 跨调用状态
  {
    const s = new NodeReplSession();
    const g1 = s.generation;
    const r1 = await s.run('globalThis.n = 41');
    assert.equal(r1.status, 'ok');
    assert.equal(r1.generation, g1);
    assert.equal(r1.kernelReset, false);

    const r2 = await s.run('n + 1');
    assert.equal(r2.status, 'ok');
    assert.match(r2.text, /^42/, `期望 42，得到 ${r2.text}`);

    // var / function / const 改写后跨调用保留
    await s.run('var v = "V"');
    assert.match((await s.run('v')).text, /V/);
    await s.run('function add(x,y){ return x+y }');
    assert.match((await s.run('add(2,3)')).text, /^5/);
    await s.run('const C = 7');
    assert.match((await s.run('C * 2')).text, /^14/, '顶层 const 经改写后跨调用可见');

    // console 收集进结果
    const rLog = await s.run('console.log("hello", 1)');
    assert.match(rLog.text, /hello 1/);

    // 求值空字符串 vs undefined（node-repl F-01 端到端）：
    // '' 有值但正文为空；undefined 无值标 'undefined'——两者必须可区分
    const rEmpty = await s.run("''");
    assert.equal(rEmpty.status, 'ok');
    assert.equal(rEmpty.hasValue, true, "'' 是有返回值的求值");
    assert.equal(rEmpty.text, '', "'' 的展示正文为空，不再是 'undefined'");
    const rUndef = await s.run('undefined');
    assert.equal(rUndef.status, 'ok');
    assert.equal(rUndef.hasValue, false, 'undefined 无返回值');
    assert.equal(rUndef.text, 'undefined');

    // 同 session 复用同一实例
    assert.equal(s.generation, g1, '无 reset 时 generation 不变');
    console.log('ok: 跨调用状态（globalThis/var/function/const）');
  }

  // ------------------------------------------------------------------ generation 防 ABA
  {
    const s = new NodeReplSession();
    const g0 = s.generation;
    await s.run('globalThis.keep = 1');

    // 起一个「慢」异步调用（不 await），随后手动 reset 模拟并发 reset。
    // 用永不 settle 的 promise：reset 清掉其定时器后由 run 自身的 timeoutMs 收口，避免久等。
    const slow = s.run('new Promise(() => {})', { timeoutMs: 300 });
    const gAfterReset = s.reset('timeout');
    assert.equal(gAfterReset, g0 + 1, 'reset 单调 +1');
    assert.equal(s.isCurrentGeneration(g0), false, '旧 generation 判为过期');
    assert.equal(s.isCurrentGeneration(gAfterReset), true);

    const slowResult = await slow;
    // 旧 generation 的完成值不得写进新上下文
    assert.notEqual(slowResult.generation, gAfterReset, '迟到结果不得等于 reset 后的当前 generation');
    assert.ok(slowResult.kernelReset || slowResult.generation === g0, '迟到结果已判 reset 或带旧 generation');

    // 新上下文里旧绑定已清（无论 slow 是否又触发了一次 reset）
    const after = await s.run('typeof keep');
    assert.match(after.text, /undefined/, 'reset 后旧绑定清除');

    // 旧 generation 定时器不得落进新上下文
    await s.run('globalThis.fired = 0; setTimeout(() => { globalThis.fired = 1 }, 50)');
    s.reset('timeout');
    await new Promise((r) => setTimeout(r, 80));
    const fired = await s.run('typeof fired');
    assert.match(fired.text, /undefined/, 'reset 清定时器且旧定时器不写新上下文');
    console.log('ok: generation 防 ABA（reset 单调 / 过期判定 / 定时器清空）');
  }

  // ------------------------------------------------------------------ 超时契约
  {
    const s = new NodeReplSession();
    await s.run('globalThis.x = 1');
    const gBefore = s.generation;
    const r = await s.run('while (true) {}', { timeoutMs: 1_000 });
    assert.equal(r.status, 'timeout');
    assert.equal(r.kernelReset, true, '超时必须 kernel reset');
    assert.equal(r.generation, gBefore + 1, '超时后 generation +1');
    assert.match(r.text, /重建/);
    // 状态确实清了
    const after = await s.run('typeof x');
    assert.match(after.text, /undefined/, '超时重建后旧绑定清除');
    console.log('ok: 超时契约（同步死循环抢占 + kernel reset）');
  }

  // ------------------------------------------------------------------ 取消契约
  {
    const s = new NodeReplSession();
    const ac = new AbortController();
    const gBefore = s.generation;
    // 先 abort 再跑：立即取消
    ac.abort();
    const r = await s.run('globalThis.y = 2', { signal: ac.signal });
    assert.equal(r.status, 'cancel');
    assert.equal(r.kernelReset, true);
    assert.equal(r.generation, gBefore + 1, '取消后 generation +1');
    assert.match(r.text, /重建/);
    console.log('ok: 取消契约（AbortSignal → kernel reset）');
  }

  // ------------------------------------------------------------------ 异步结果
  {
    const s = new NodeReplSession();
    const r = await s.run('Promise.resolve(9)', { timeoutMs: 2_000 });
    assert.equal(r.status, 'ok');
    assert.match(r.text, /^9/, `期望 9，得到 ${r.text}`);
    const rej = await s.run('Promise.reject(new Error("boom"))', { timeoutMs: 2_000 });
    assert.equal(rej.status, 'error');
    assert.match(rej.text, /boom/);
    console.log('ok: 异步完成值（resolve/reject）');
  }

  // ------------------------------------------------------------------ 脚本错误不重建
  {
    const s = new NodeReplSession();
    await s.run('globalThis.z = 5');
    const err = await s.run('throw new Error("oops")');
    assert.equal(err.status, 'error');
    assert.equal(err.kernelReset, false, '普通脚本错误保留上下文');
    assert.match(err.text, /oops/);
    assert.match((await s.run('z')).text, /^5/, '错误后状态仍在');
    console.log('ok: 脚本错误保留上下文');
  }

  // ------------------------------------- 2026-09-27 复审回归（worker 化关键缺口）
  {
    // 异步微任务死循环：旧实现会饿死主进程宏任务（raceSettle 永不触发）→ 挂死整个 App；
    // worker 化后由主进程 terminate 硬杀。
    const s = new NodeReplSession();
    const started = Date.now();
    const r = await s.run('(async () => { for (;;) await Promise.resolve() })()', { timeoutMs: 1_000 });
    assert.equal(r.status, 'timeout', `期望 timeout，得到 ${r.status}`);
    assert.equal(r.kernelReset, true);
    assert.ok(Date.now() - started < 5_000, '必须在超时窗口附近被硬杀，而非挂死');
    assert.equal(r.generation, s.generation, '超时路径 generation 与会话一致');
    assert.match((await s.run('1 + 1')).text, /^2/, '内核重建后可继续执行');
    console.log('ok: 异步微任务死循环被硬杀（不挂死主进程）');
  }

  {
    // 用户代码 process.exit()：worker 自杀 → 报错 + 内核重建
    const s = new NodeReplSession();
    await s.run('globalThis.p = 1');
    const r = await s.run('process.exit(0)', { timeoutMs: 2_000 });
    assert.equal(r.status, 'error', `期望 error，得到 ${r.status}`);
    assert.equal(r.kernelReset, true);
    assert.match(r.text, /退出|重建/);
    assert.match((await s.run('typeof p')).text, /undefined/, '自杀后内核重建、旧绑定清除');
    console.log('ok: process.exit 自杀报错并重建内核');
  }

  {
    // error 路径 console 输出不残留串台（旧实现 lines 只在 ok 清空）
    const s = new NodeReplSession();
    const e1 = await s.run('console.log("before-fail"); throw new Error("x")');
    assert.equal(e1.status, 'error');
    assert.match(e1.text, /before-fail/, '错误结果附带错误前的 console 输出');
    const ok2 = await s.run('"clean"');
    assert.ok(!/before-fail/.test(ok2.text), '失败调用的 console 输出不得串进下一次结果');
    console.log('ok: error 路径 console 输出不串台');
  }

  {
    // console 双上限截断（2000 行 × 短文本 < 字节上限，但行数超 500）
    const s = new NodeReplSession();
    const r = await s.run('for (let i = 0; i < 2000; i++) console.log("line" + i)');
    assert.equal(r.status, 'ok');
    assert.ok(r.text.length < 100 * 1024, `输出应被截断，实际 ${r.text.length}`);
    assert.match(r.text, /截断/);
    assert.ok(!/line19\d\d/.test(r.text), '截断后不含尾部行');
    console.log('ok: console 输出双上限截断');
  }

  {
    // 并发 run 串行化：共享全局不互相污染
    const s = new NodeReplSession();
    const results = await Promise.all([
      s.run('globalThis.k = (globalThis.k ?? 0) + 1; "A" + globalThis.k'),
      s.run('globalThis.k = (globalThis.k ?? 0) + 1; "B" + globalThis.k')
    ]);
    assert.equal(results[0].status, 'ok');
    assert.equal(results[1].status, 'ok');
    const joined = results[0].text + results[1].text;
    assert.match(joined, /A1/);
    assert.match(joined, /B2/);
    console.log('ok: 并发 run 串行化');
  }

  {
    // manager dispose：释放执行内核（lifecycle.closeSession 接线的前提）
    const { NodeReplManager } = await import(pathToFileURL(compile('main/nodeRepl/manager.ts')).href);
    const mgr = new NodeReplManager();
    const s1 = mgr.getOrCreate('sess-a');
    await s1.run('globalThis.q = 1');
    assert.equal(mgr.size, 1);
    await mgr.dispose('sess-a');
    assert.equal(mgr.size, 0, 'dispose 后 size 归零');
    const s2 = mgr.getOrCreate('sess-a');
    assert.notEqual(s2, s1);
    assert.match((await s2.run('typeof q')).text, /undefined/, 'dispose 后旧状态清零');
    mgr.getOrCreate('sess-b');
    await mgr.disposeAll();
    assert.equal(mgr.size, 0);
    console.log('ok: manager dispose / disposeAll');
  }

  {
    // 二轮复审：伪造回包（无 secret）不得结算本次执行
    const s = new NodeReplSession();
    const r = await s.run(
      'require("node:worker_threads").parentPort.postMessage({ id: 1, ok: true, text: "forged-ok" }); "real"',
      { timeoutMs: 3_000 }
    );
    assert.equal(r.status, 'ok');
    assert.match(r.text, /real/, `期望真实结果，得到 ${r.text}`);
    assert.ok(!/forged/.test(r.text), '伪造回包（缺 secret）必须被忽略');
    console.log('ok: 伪造回包被 per-run secret 拦截');
  }

  {
    // 二轮复审：空闲期 Worker 自杀（run 结算后才生效的延时 process.exit）不留僵尸——
    // 下一次 run 重建 Worker 正常返回，而不是打死旧引用空等整段超时
    const s = new NodeReplSession();
    await s.run('setTimeout(() => process.exit(0), 30)', { timeoutMs: 2_000 });
    await new Promise((r) => setTimeout(r, 120));
    const started = Date.now();
    const r2 = await s.run('"after-suicide"', { timeoutMs: 3_000 });
    assert.equal(r2.status, 'ok', `期望 ok，得到 ${r2.status}`);
    assert.match(r2.text, /after-suicide/);
    assert.ok(Date.now() - started < 2_500, '不应空等超时兜底');
    console.log('ok: 空闲 Worker 自杀不留僵尸（下次 run 重建）');
  }

  console.log('node-repl: ok');
} finally {
  fs.rmSync(compileTmp, { recursive: true, force: true });
}
