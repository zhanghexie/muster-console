/**
 * Claude Agent SDK 冒烟（T2.0，结论先行；需本机 claude 订阅登录态 + 网络；npm test EXCLUDE）。
 *
 * 三种形态共用同一脚本（按环境自适配），验证 SDK 在本仓 GUI runtime 目标形态下可用：
 *   1. 纯 Node 对照组        : node test/claude-sdk-smoke.mjs
 *   2. Electron 主进程       : node_modules\electron\dist\electron.exe test/claude-sdk-smoke.mjs
 *      （GUI 子系统、无控制台——T2.0 核心问题：直接 import + spawn claude.exe 是否挂死/弹黑框）
 *   3. RUN_AS_NODE worker    : ELECTRON_RUN_AS_NODE=1 electron.exe test/claude-sdk-smoke.mjs
 *      （用于评估独立 NDJSON RPC worker 的替代形态）
 *
 * 验证点：
 *   - import SDK 是否成功、耗时；
 *   - 订阅鉴权（剥离 ANTHROPIC_API_KEY / CLAUDE* 后 query 走 apiKeySource 报告什么）；
 *   - 最小回合（allowedTools 空 + maxTurns 1）能否在超时内出 result；
 *   - 超时则 dump claude.exe 子进程状态判「挂死」；
 *   - 回合期间采样 claude.exe 主窗口标题，验证 windowsHide 是否兜住（hide-console 需求判定）；
 *   - 第一回合成功后用 resume 跑第二回合，验证跨回合连续性（T2.1 runtimeResumeToken 前提）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = Number(process.env.CLAUDE_SMOKE_TIMEOUT_MS || 150_000);
const isElectron = !!process.versions.electron;
const isRunAsNode = !!process.env.ELECTRON_RUN_AS_NODE;
const mode = isElectron ? (isRunAsNode ? 'electron-run-as-node' : 'electron-main') : 'node';

const log = (...a) => console.log(`[claude-sdk-smoke:${mode}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 剥离鉴权/嵌套会话类变量：强制订阅鉴权、防 CLAUDE_CODE_CHILD_SESSION 副作用。 */
function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ANTHROPIC|CLAUDE)[_A-Z0-9]*$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 采样 claude.exe 进程的窗口标题（GUI 无控制台形态下 spawn 是否弹黑框的实证）。
 *  用 PowerShell 直接输出 UTF-8，避免 tasklist 在中文系统輸出 GBK 乱码。 */
function sampleClaudeWindows() {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }"],
      { timeout: 8000, encoding: 'utf8' },
      (err, stdout) => resolve({ err: !!err, titles: (stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })
    );
  });
}

function dumpClaudeProcs() {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', "Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) cpu=$([math]::Round($_.CPU,1)) started=$($_.StartTime.ToString('HH:mm:ss'))\" }"],
      { timeout: 10000 },
      (err, stdout) => resolve(err ? `(dump failed: ${err.message})` : (stdout || '(no claude.exe process)').trim())
    );
  });
}

/** 跑一个 query 回合，带总超时与挂死诊断。返回收集到的消息摘要。 */
async function runTurn({ prompt, resume, cwd, windowSampler }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({
    prompt,
    options: {
      cwd,
      model: 'sonnet',
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
      includePartialMessages: false,
      env: scrubEnv(process.env),
      ...(resume ? { resume } : {})
    }
  });

  const seen = { init: null, assistantText: '', result: null, msgs: 0, other: new Set() };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    q.interrupt?.().catch(() => {});
  }, TIMEOUT_MS);

  try {
    for await (const msg of q) {
      seen.msgs++;
      if (windowSampler) windowSampler();
      if (msg.type === 'system' && msg.subtype === 'init') {
        seen.init = { api_key_source: msg.api_key_source ?? null, model: msg.model, session_id: msg.session_id, tools: msg.tools?.length };
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) if (block.type === 'text') seen.assistantText += block.text;
      } else if (msg.type === 'result') {
        seen.result = { subtype: msg.subtype, is_error: msg.is_error ?? false, duration_ms: msg.duration_ms, num_turns: msg.num_turns, session_id: msg.session_id, result: (msg.result || '').slice(0, 80) };
      } else {
        seen.other.add(msg.type);
      }
    }
  } catch (e) {
    if (timedOut) {
      log(`FAIL: 回合超时（${TIMEOUT_MS}ms），claude.exe 子进程状态：`);
      log(await dumpClaudeProcs());
      throw new Error(`turn timed out after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return seen;
}

async function main() {
  log('Node', process.version, 'electron', process.versions.electron || '-', 'platform', process.platform);

  // Electron 主进程形态：等 app ready 再动（贴近真实 driver 使用位置）
  if (mode === 'electron-main') {
    const { app } = await import('electron');
    if (process.type !== 'browser') {
      console.error('[claude-sdk-smoke] FAIL: electron-main 模式要求 browser 进程，当前 process.type=' + process.type);
      process.exit(2);
    }
    await app.whenReady().catch((e) => {
      console.error('[claude-sdk-smoke] FAIL: app.whenReady', e);
      process.exit(2);
    });
    log('electron app ready');
  }

  const t0 = performance.now();
  let sdk;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
    log(`ok: import SDK ${Math.round(performance.now() - t0)}ms, exports:`, Object.keys(sdk).slice(0, 8).join(','));
    assert.equal(typeof sdk.query, 'function', 'query 应为函数');
  } catch (e) {
    console.error(`[${mode}] FAIL: import SDK`, e);
    process.exit(1);
  }

  // 弹窗采样器：回合期间非阻塞采样（每 2s 一次）
  const windowTitles = new Set();
  let sampling = false;
  const sampler = () => {
    if (sampling) return;
    sampling = true;
    sampleClaudeWindows().then(({ titles }) => titles.forEach((t) => windowTitles.add(t))).finally(() => { sampling = false; });
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sdk-smoke-'));
  assert.ok(tmp.startsWith(os.tmpdir()), 'cwd 应为临时目录');

  let code = 0;
  try {
    // ── 回合 1：最小回合 ──────────────────────────────────────────
    log('turn1: 最小回合（无工具、单轮）');
    const t1 = await runTurn({ prompt: 'Reply with exactly: OK', cwd: tmp, windowSampler: sampler });
    log('turn1 init:', JSON.stringify(t1.init));
    log('turn1 result:', JSON.stringify(t1.result));
    if (t1.other.size) log('turn1 other msg types:', [...t1.other].join(','));
    assert.ok(t1.init, '应收到 system/init');
    assert.ok(t1.result && !t1.result.is_error, 'result 不应为 error');
    assert.match(t1.assistantText, /OK/i, '助手应回复 OK，实际: ' + t1.assistantText.slice(0, 100));

    // ── 回合 2：resume 连续性 ─────────────────────────────────────
    const sid = t1.result?.session_id || t1.init?.session_id;
    if (!sid) {
      log('skip: resume（未拿到 session_id）');
    } else {
      log(`turn2: resume ${sid}`);
      const t2 = await runTurn({
        prompt: 'My previous message asked you to reply with exactly one word. What word was it? Reply with just that word.',
        resume: sid,
        cwd: tmp,
        windowSampler: sampler
      });
      log('turn2 result:', JSON.stringify(t2.result));
      assert.ok(t2.result && !t2.result.is_error, 'resume 回合 result 不应为 error');
      assert.match(t2.assistantText, /OK/i, 'resume 回忆测试应答 OK，实际: ' + t2.assistantText.slice(0, 100));
    }

    // ── 弹窗实证 ──────────────────────────────────────────────────
    await sleep(500);
    log('claude.exe 窗口标题采样:', windowTitles.size ? JSON.stringify([...windowTitles]) : '(无可见窗口标题——windowsHide 兜住)');

    log(`结论: ${mode} 形态 import + 最小回合${sid ? ' + resume' : ''} 全部通过；apiKeySource=${t1.init?.api_key_source}`);
  } catch (e) {
    console.error(`[${mode}] FAIL:`, e instanceof Error ? e.message : String(e));
    code = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (mode === 'electron-main') {
    const { app } = await import('electron');
    app.exit(code); // 不走 quit：SDK 子进程可能挂住 event loop
    return;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('[claude-sdk-smoke] unhandled', e);
  process.exit(1);
});
