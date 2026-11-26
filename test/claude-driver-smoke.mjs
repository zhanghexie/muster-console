/**
 * Claude GUI driver 在线冒烟（T2.1；npm test EXCLUDE——需本机 claude 可用鉴权 + 网络）。
 * 与 T2.0 的 test/claude-sdk-smoke.mjs 互补：那个验证 SDK 三形态基线，这个驱动
 * ClaudeRuntimeDriver 本体——流式 prompt 回合模型（AsyncIterable 常驻子进程）、
 * 事件映射、resume 续聊、宿主工具 MCP 注册面、abort。
 *
 * 跑法（任意一种，鉴权走本机 claude 配置链）：
 *   node test/claude-driver-smoke.mjs
 *   node_modules\electron\dist\electron.exe test/claude-driver-smoke.mjs   （主进程形态）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 树式转译 driver 包（与离线回放同法；产物放仓内 .tmp 以解析 zod）——
const tmp = path.join(root, '.tmp', 'claude-driver-smoke');
fs.rmSync(tmp, { recursive: true, force: true });
const TYPE_ONLY = /(?:import|export)\s+type\s+(?:\{[^}]*\}|\w+)\s+from\s+'[^']+';?\r?\n/g;
const REL = /(from\s+|import\s*\(\s*)'(\.[^']*)'/g;
const done = new Set();
function emitOne(absTs) {
  const rel = path.relative(path.join(root, 'src'), absTs);
  const out = path.join(tmp, rel.replace(/\.ts$/, '.mjs'));
  if (done.has(rel)) return out;
  done.add(rel);
  const src = fs.readFileSync(absTs, 'utf8').replace(TYPE_ONLY, '');
  const deps = [];
  const rewritten = src.replace(REL, (_m, head, spec) => {
    const base = path.resolve(path.dirname(absTs), spec);
    const dep = fs.existsSync(`${base}.ts`) ? `${base}.ts` : path.join(base, 'index.ts');
    if (!fs.existsSync(dep)) throw new Error(`解析不到依赖 ${spec}`);
    deps.push(dep);
    return `${head}'${spec}.mjs'`;
  });
  const js = ts.transpileModule(rewritten, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: absTs
  }).outputText;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, js, 'utf8');
  for (const d of deps) emitOne(d);
  return out;
}
const driverEntry = emitOne(path.join(root, 'src/main/agentSession/drivers/claude/driver.ts'));
const { ClaudeRuntimeDriver } = await import(pathToFileURL(driverEntry).href);

const TIMEOUT_MS = Number(process.env.CLAUDE_SMOKE_TIMEOUT_MS || 150_000);
const log = (...a) => console.log('[claude-driver-smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, timeout = TIMEOUT_MS) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await sleep(50);
  }
}

async function main() {
  const isElectron = !!process.versions.electron;
  if (isElectron && process.type === 'browser') {
    const { app } = await import('electron');
    await app.whenReady();
    log('electron app ready');
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-driver-smoke-'));
  const hostCalls = [];
  const hostTools = [
    {
      id: 'sessions.setStatus',
      label: '状态',
      description: '上报会话状态',
      parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['needs_you', 'done'] }, note: { type: 'string' } } },
      permissionClass: 'status',
      execute: async (args) => {
        hostCalls.push({ id: 'sessions.setStatus', args });
        return 'status-ok';
      }
    },
    {
      id: 'ui.notify',
      label: '通知',
      description: '发通知',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      permissionClass: 'status',
      execute: async (args) => {
        hostCalls.push({ id: 'ui.notify', args });
        return 'notify-ok';
      }
    },
    {
      id: 'bgtasks.list',
      label: '列后台',
      description: '列出后台任务',
      parameters: { type: 'object', properties: {} },
      permissionClass: 'read',
      execute: async () => {
        hostCalls.push({ id: 'bgtasks.list' });
        return '[]';
      }
    }
  ];
  const logs = [];
  const input = (extra = {}) => ({
    sessionId: 'smoke-1',
    cwd,
    systemPromptAppend: '【测试政策层】回答保持极简。',
    mode: 'default',
    planExecuting: false,
    permissionMode: 'acceptEdits',
    modeController: {},
    hostTools,
    requestApproval: async () => ({ approved: true }),
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: (level, msg) => logs.push(`[${level}] ${msg}`),
    ...extra
  });

  const driver = new ClaudeRuntimeDriver(
    {},
    { userDataDir: tmp },
    {
      // plain node 下 import('electron') 会触发 electron 包懒下载二进制：注入决策避免卡顿；
      // electron 主进程形态不注入、走真路径（resolveClaudeExecutable 内部判 isPackaged）
      ...(process.versions.electron
        ? {}
        : { resolveExecutable: async () => ({ ok: true, packaged: false }) })
    }
  );
  const collect = (conn) => {
    const events = [];
    void (async () => {
      for await (const ev of conn.events) events.push(ev);
    })();
    return events;
  };

  let code = 0;
  let resumeToken = null;
  try {
    // ── 回合 1：最小回合 + 事件序列 + resume-token ──
    log('turn1: connect + 最小回合');
    const conn1 = await driver.connect(input());
    const ev1 = collect(conn1);
    await conn1.send('Reply with exactly: OK');
    await waitFor(() => ev1.some((e) => e.type === 'turn-complete' || e.type === 'error'), 'turn1 收口');
    const err1 = ev1.find((e) => e.type === 'error');
    if (err1) throw new Error(`turn1 error 事件: ${err1.message}`);
    const tok = ev1.find((e) => e.type === 'resume-token');
    assert.ok(tok, '应收到 resume-token（init/result 的 session_id）');
    resumeToken = tok.token;
    const text = ev1.filter((e) => e.type === 'text-delta').map((e) => e.delta).join('');
    assert.match(text, /OK/i, `助手应回 OK，实际: ${text.slice(0, 120)}`);
    log(`turn1 ok（token=${resumeToken.slice(0, 8)}…，事件 ${ev1.length} 条，text="${text.slice(0, 40)}"）`);

    // ── 回合 2：同连接续发（流式常驻子进程多回合）──
    log('turn2: 同连接第二回合');
    await conn1.send('My previous message asked you to reply with exactly one word. What word was it? Reply with just that word.');
    await waitFor(() => ev1.filter((e) => e.type === 'turn-complete').length >= 2, 'turn2 收口');
    const text2 = (() => {
      const last = ev1.filter((e) => e.type === 'turn-complete')[1];
      const idx = ev1.indexOf(last);
      return ev1
        .slice(0, idx)
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join('')
        .slice(-40);
    })();
    assert.match(text2, /OK/i, `同连接第二回合应回忆 OK，实际尾部: ${text2}`);
    log('turn2 ok（同连接多回合成立）');
    await conn1.close();

    // ── 回合 3：新连接 + resume 续聊（跨连接 transcript 召回）+ 宿主工具注册面 ──
    log('turn3: resume 续聊');
    const conn3 = await driver.connect(input({ resumeToken }));
    const ev3 = collect(conn3);
    await conn3.send('Once more: what was that one word? Reply with just the word.');
    await waitFor(() => ev3.some((e) => e.type === 'turn-complete' || e.type === 'error'), 'turn3 收口');
    const err3 = ev3.find((e) => e.type === 'error');
    if (err3) throw new Error(`turn3 error 事件: ${err3.message}`);
    const text3 = ev3.filter((e) => e.type === 'text-delta').map((e) => e.delta).join('');
    assert.match(text3, /OK/i, `resume 回合应仍记得 OK，实际: ${text3.slice(0, 120)}`);
    log('turn3 ok（resume 召回成立）');

    // ── abort：interrupt 生效（回合中停止 → 收口且无错误）──
    log('turn4: abort 中止');
    await conn3.send('Count slowly from 1 to 100, one number per line.');
    await sleep(3000);
    await conn3.abort();
    await waitFor(
      () => ev3.filter((e) => e.type === 'turn-complete' || e.type === 'error').length >= 2,
      'abort 后收口',
      60_000
    );
    const errsAfterAbort = ev3.filter((e) => e.type === 'error');
    assert.equal(errsAfterAbort.length, 0, `abort 后不应有错误事件: ${errsAfterAbort[0]?.message}`);
    await conn3.close();
    log('turn4 ok（interrupt 收口干净）');

    // ── 进程内 MCP：模型应能发现并调用宿主工具（createSdkMcpServer 注册面）──
    log('turn5: 进程内 MCP 宿主工具');
    const conn5 = await driver.connect(input());
    const ev5 = collect(conn5);
    await conn5.send(
      'Call the mcp__muster__sessions_setStatus tool with note "smoke". After the tool returns, reply with exactly: MCP-OK'
    );
    await waitFor(
      () => ev5.some((e) => e.type === 'turn-complete' || e.type === 'error'),
      'turn5 收口'
    );
    const err5 = ev5.find((e) => e.type === 'error');
    if (err5) throw new Error(`turn5 error 事件: ${err5.message}`);
    assert.ok(
      hostCalls.some((c) => c.id === 'sessions.setStatus'),
      `应经进程内 MCP 调到 sessions.setStatus，实际调用: ${JSON.stringify(hostCalls)}`
    );
    log(`turn5 ok（宿主工具调用 ${hostCalls.length} 次）`);
    await conn5.close();

    log('全部通过；init 日志：', logs.filter((l) => l.includes('会话就绪')).slice(-1)[0] ?? '(无)');
  } catch (e) {
    console.error('[claude-driver-smoke] FAIL:', e instanceof Error ? e.message : String(e));
    console.error(logs.join('\n'));
    code = 1;
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (process.versions.electron && process.type === 'browser') {
    const { app } = await import('electron');
    app.exit(code);
    return;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('[claude-driver-smoke] unhandled', e);
  process.exit(1);
});
