/**
 * Pi 计量状态机自测（pi-trajectory-plan v3 §4.3，B1'）：
 * - TTFT：text/thinking/toolcall 流首现打点（纯工具调用响应补盲）；
 * - retry：onResponse 响应数 - 1（单响应无 retry 字段；无调用打开时忽略）；
 * - turn_end：usage 归一（cache/reasoning 正数才落）累入 calls；
 * - finalize：回合墙钟 + 各调用 usage 累计 + model 取末次 + calls 明细；幂等；
 * - onSend：新回合清零（未收口的残留作废）。
 * Run: node test/pi-call-metrics.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'main', 'agentSession', 'drivers', 'pi', 'callMetrics.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-call-metrics-'));
const outFile = path.join(tmp, 'callMetrics.mjs');
{
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
}
const { PiCallMetrics } = await import(pathToFileURL(outFile).href);

// ---------- 单调用：TTFT / usage 归一 / 无 retry ----------
{
  const m = new PiCallMetrics();
  m.onSend(1000);
  m.onTurnStart(1100);
  m.onResponse(); // 单次响应
  m.onChunk(1200); // 首个流事件
  m.onTurnEnd({ role: 'assistant', model: 'glm-5', usage: { input: 100, output: 20, cacheRead: 0, reasoning: 7 } }, 1500);
  const s = m.finalize(1600);
  assert.ok(s, 'finalize 应产出 summary');
  assert.equal(s.durationMs, 600, '回合墙钟 = finalize - send');
  assert.deepEqual(s.usage, {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 7
  }, 'cacheRead=0 不落，reasoning 正数落');
  assert.equal(s.model, 'glm-5');
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.ttftMs, 100, 'TTFT = 首 chunk - turn_start');
  assert.equal(c.durationMs, 400, '单调用时长 = turn_end - turn_start');
  assert.equal(c.retry, undefined, '单次响应无 retry 字段');
  assert.equal(m.finalize(2000), undefined, 'finalize 幂等（再调返回 undefined）');
}

// ---------- pi-ai>=1.1 原生 durationMs 优先于事件墙钟 ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(100);
  m.onResponse();
  // 事件墙钟 400（turn_end 500 - turn_start 100），原生单调时钟 377：取原生值
  m.onTurnEnd({ usage: { input: 10, output: 5 }, stopReason: 'length', durationMs: 377 }, 500);
  const s = m.finalize(600);
  assert.equal(s.calls[0].stopReason, 'length');
  assert.equal(s.calls[0].durationMs, 377, '原生 durationMs（单调时钟）优先');
}
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(100);
  m.onResponse();
  m.onTurnEnd({ usage: { input: 10, output: 5 } }, 500); // 无原生字段：回落墙钟
  const s = m.finalize(600);
  assert.equal(s.calls[0].durationMs, 400, '缺原生字段回落事件墙钟');
}

// ---------- usage.cost 透传（目录有价才落，0 视为未知价不落） ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(0);
  m.onResponse();
  m.onTurnEnd({ usage: { input: 100, output: 50, cost: { total: 0.0125 } } }, 10);
  const s = m.finalize(20);
  assert.equal(s.calls[0].usage.costUsd, 0.0125, 'cost.total>0 落 costUsd');
  assert.equal(s.usage.costUsd, 0.0125, '回合 summary 累计 costUsd');
}
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(0);
  m.onResponse();
  // 无价模型：calculateCost 出 0 —— 不落字段（未知价≠免费）
  m.onTurnEnd({ usage: { input: 10, output: 5, cost: { total: 0 } } }, 10);
  const s = m.finalize(20);
  assert.equal(s.calls[0].usage.costUsd, undefined, 'cost=0（未知价）不落 costUsd');
}

// ---------- 纯工具调用响应：toolcall 打点即 TTFT（补盲回归） ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(100);
  // 没有任何 text/thinking chunk，只有 toolcall 流事件
  m.onChunk(180);
  m.onTurnEnd({ usage: { input: 10, output: 5 } }, 300);
  const s = m.finalize(400);
  assert.equal(s.calls[0].ttftMs, 80, 'toolcall 流首现也作 TTFT 打点');
}

// ---------- retry：同调用多次响应 ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(0);
  m.onResponse();
  m.onResponse();
  m.onResponse(); // 3 次响应 = 2 次重试
  m.onChunk(50);
  m.onTurnEnd({ usage: { input: 1, output: 1 } }, 100);
  assert.equal(m.finalize(200).calls[0].retry, 2);
}

// ---------- onResponse 无调用打开时忽略（压缩等空闲期请求不污染） ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onResponse(); // turn 未开：忽略
  m.onTurnStart(10);
  m.onTurnEnd({ usage: { input: 2, output: 2 } }, 20);
  const s = m.finalize(30);
  assert.equal(s.calls[0].retry, undefined, '空闲期 onResponse 不计 retry');
}

// ---------- 多调用累计：usage 求和 / model 取末次 / 零 usage 调用跳过 ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(0);
  m.onChunk(10);
  m.onTurnEnd({ usage: { input: 100, output: 50, cacheWrite: 30 }, model: 'a' }, 100);
  // 第二次调用：无 usage（失败/缺省）
  m.onTurnStart(100);
  m.onResponse();
  m.onResponse();
  m.onChunk(150);
  m.onTurnEnd({ model: 'b' }, 200);
  const s = m.finalize(300);
  assert.deepEqual(
    s.usage,
    { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 30 },
    'usage 只累计有值的调用'
  );
  assert.equal(s.model, 'b', 'model 取末次有值调用');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].model, 'a');
  assert.equal(s.calls[1].usage, undefined);
  assert.equal(s.calls[1].retry, 1);
}

// ---------- onSend 清零：未收口的残留作废 ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(0);
  m.onTurnEnd({ usage: { input: 5, output: 5 } }, 10);
  m.onSend(1000); // 未 finalize 就开新回合（异常路径）
  m.onTurnStart(1100);
  m.onChunk(1200);
  m.onTurnEnd({ usage: { input: 1, output: 1 }, model: 'n' }, 1300);
  const s = m.finalize(1400);
  assert.equal(s.calls.length, 1, '残留调用被新回合作废');
  assert.equal(s.model, 'n');
  assert.equal(s.usage.inputTokens, 1);
}

// ---------- usage 缺 input/output 时不归一 ----------
{
  const m = new PiCallMetrics();
  m.onSend(0);
  m.onTurnStart(0);
  m.onChunk(5);
  m.onTurnEnd({ usage: { cacheRead: 9 } }, 10);
  const s = m.finalize(20);
  assert.equal(s.usage, undefined, '无 input/output 的 usage 不落');
  assert.equal(s.calls[0].usage, undefined);
}

console.log('ok   pi-call-metrics');
