import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { freePort, jsonRequest, current, pause, accepted, deferred, unsupported, spawnOwned } from './_native.mjs';
import path from 'node:path';
import { filterExtraArgs, wrapWinCmd, assertManagedTerminalArgs } from './_helpers.mjs';

function resolveOpenCodeExe() {
  // Windows：npm 全局 node_modules 布局；POSIX：系统 npm prefix / 官方安装脚本(~/.opencode/bin) / ~/.local/bin
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
        ]
      : [
          '/usr/local/lib/node_modules/opencode-ai/bin/opencode',
          path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
          path.join(os.homedir(), '.local', 'bin', 'opencode')
        ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'opencode';
}

/** 宿主状态监控：OpenCode 无外部 hooks，改由本脚本（宿主进程内）轮询其原生
 * session server 的权威回合状态，经 MUSTER_STATUS_URL 上报 activity——
 * 与 _agent-hook.mjs 同通道、同 best-effort 纪律（无 URL/宿主未起/上报失败均静默）。
 * 这消除了 pty 输出启发式把「重绘字节」当工作的误判：底部状态动画、resize 全量
 * 重绘等视觉无变化的字节不再驱动「工作中」，回合在途/结束由 /session/status 定调。 */
export const OPENCODE_TURN_EVENT = 'opencode-turn';
export const OPENCODE_MONITOR_POLL_MS = 3_000;
export const OPENCODE_MONITOR_HEARTBEAT_MS = 20_000;
/** TUI 启动约 4.3s；连续网络失败超过该预算（pollMs×预算 ≈ 2 分钟）后停轮询 */
export const OPENCODE_MONITOR_FAIL_BUDGET = 40;

/** /session/status → 本会话是否在回合中。与 receiveMessage 的 idle 判定同口径取反。 */
export function openCodeSessionBusy(statuses, sessionId) {
  if (!statuses || typeof statuses !== 'object') return false;
  const own = statuses[sessionId];
  return !!(own && typeof own === 'object' && typeof own.type === 'string' && own.type !== 'idle');
}

/** 纯决策：状态翻转必报；busy 持续起过 heartbeatMs 补一次心跳（维持 active 新鲜度）。 */
export function nextMonitorReport({ prevBusy, observedBusy, now, lastReportAt, heartbeatMs = OPENCODE_MONITOR_HEARTBEAT_MS }) {
  if (prevBusy === undefined || prevBusy !== observedBusy) {
    return { report: true, activity: observedBusy ? 'active' : 'idle' };
  }
  if (observedBusy && lastReportAt !== undefined && now - lastReportAt >= heartbeatMs) {
    return { report: true, activity: 'active' };
  }
  return { report: false };
}

/** best-effort POST（不走 fetch：宿主 Electron 主进程不保证全局 fetch）。 */
function postStatus(url, body) {
  return new Promise((resolve) => {
    try {
      const target = new URL(url);
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request(target, {
        method: 'POST', timeout: 3_000,
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) }
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end(payload);
    } catch {
      resolve();
    }
  });
}

/** Run a bounded request against the CLI's authenticated local server. */
async function withOpenCodeServer(cwd, action) {
  const port = await freePort();
  const password = randomBytes(32).toString('hex');
  const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
  const owner = spawnOwned([resolveOpenCodeExe(), 'serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd, env: { ...process.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
  });
  try {
    const base = 'http://127.0.0.1:' + port;
    const request = (route, options) => jsonRequest(base + route, { headers, ...options });
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      owner.assertAlive();
      try { await request('/global/health'); }
      catch (error) {
        if (!['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) throw error;
        await pause(100);
        continue;
      }
      return await action(request);
    }
    throw new Error('OpenCode session server startup timed out');
  } finally { owner.dispose(); }
}

export async function allocate({ cwd }) {
  return withOpenCodeServer(cwd, async request => {
    const result = await request('/session?directory=' + encodeURIComponent(cwd), { method: 'POST', body: { title: 'Muster Console' }, timeout: 10_000 });
    if (!result?.id?.startsWith('ses_')) throw new Error('OpenCode returned no real session identity');
    return { sessionId: result.id };
  });
}

export async function resolveLaunch(input) {
  const { sessionId, cwd, extraArgs, probe, env } = input;
  const extra = filterExtraArgs(extraArgs);
  assertManagedTerminalArgs(input, extra, 'OpenCode', ['--session', '-s', '--continue', '-c', '--fork', '--server']);
  const executable = resolveOpenCodeExe();
  if (probe) return wrapWinCmd([executable, '--session', sessionId, ...extra]);
  if (extra.some(arg => /^(--port|--hostname)(=|$)/.test(arg)))
    throw new Error('OpenCode native mailbox owns --port/--hostname; remove conflicting runtime arguments');
  const port = await freePort();
  const password = randomBytes(32).toString('hex');
  let disposed = false;
  const stoppedNotices = new Set();
  let capability;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  const base = `http://127.0.0.1:${port}`;
  const directoryQuery = `?directory=${encodeURIComponent(cwd)}`;
  const statusUrl = env?.MUSTER_STATUS_URL?.trim();

  // 权威回合状态监控（宿主进程内轮询；dispose/连续失败自动停）。
  let monitorTimer = null;
  let monitorFails = 0;
  let prevBusy;
  let lastReportAt;
  const stopMonitor = () => {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  };
  const pollTurnStatus = async () => {
    if (disposed) return;
    try {
      const statuses = await jsonRequest(base + '/session/status' + directoryQuery, { headers, timeout: 3_000 });
      monitorFails = 0;
      const observedBusy = openCodeSessionBusy(statuses, sessionId);
      const decision = nextMonitorReport({ prevBusy, observedBusy, now: Date.now(), lastReportAt });
      prevBusy = observedBusy;
      if (decision.report) {
        lastReportAt = Date.now();
        await postStatus(statusUrl, { activity: decision.activity, event: OPENCODE_TURN_EVENT });
      }
    } catch {
      // TUI 未起/正在退出：不改动上报状态，连续超预算才停（避免死会话永久轮询）
      if (++monitorFails >= OPENCODE_MONITOR_FAIL_BUDGET) stopMonitor();
    }
  };
  if (statusUrl) {
    monitorTimer = setInterval(() => { void pollTurnStatus(); }, OPENCODE_MONITOR_POLL_MS);
    monitorTimer.unref?.();
  }
  return {
    ...wrapWinCmd([executable, '--port', String(port), '--hostname', '127.0.0.1', '--session', sessionId, ...extra]),
    env: { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    dispose() { disposed = true; stopMonitor(); },
    async receiveMessage(input) {
      if (disposed || !current(input)) return deferred('OpenCode launch 已过期');
      const base = `http://127.0.0.1:${port}`;
      const query = `?directory=${encodeURIComponent(input.cwd)}`;
      const request = (route, options) => jsonRequest(base + route + query, { headers, signal: input.signal, ...options });
      if (!capability) {
        let doc;
        try { doc = await request('/doc'); }
        catch (error) {
          if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) return deferred('OpenCode API 能力清单尚未就绪，未提交消息');
          if (error.httpStatus !== 404) throw error;
        }
        // The current TUI uses the legacy engine. The newer /api prompt route can
        // admit durable input without executing it in this TUI; endpoint discovery
        // alone must never select a different session execution path.
        capability = doc?.paths?.['/session/{sessionID}/prompt_async']?.post ? 'legacy' : 'unsupported';
      }
      if (capability === 'unsupported') return unsupported('OpenCode server 未公布与当前 TUI 对应的原生消息 API');
      let statuses;
      let interrupted = false;
      try { statuses = await request('/session/status'); }
      catch (error) {
        if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) return deferred('OpenCode TUI server 状态读取尚未就绪，未提交消息');
        throw error;
      }
      const idle = value => value && typeof value === 'object' && (!value[sessionId] || value[sessionId].type === 'idle');
      if (!idle(statuses)) {
        if (input.intent === 'normal') return deferred('OpenCode 正忙；普通信等待当前回合');
        if (stoppedNotices.has(input.messageId)) return deferred('OpenCode 已为此信停止过旧回合，等待新回合结束，不重复中止');
        if (!current(input)) return deferred('OpenCode launch 已过期');
        const stopped = await request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
        if (stopped !== true) throw new Error('OpenCode abort 未确认');
        interrupted = true;
        stoppedNotices.add(input.messageId);
        const until = Date.now() + 4500;
        do {
          if (!current(input)) return deferred('OpenCode launch 已过期，消息尚未提交');
          try { statuses = await request('/session/status'); }
          catch (error) {
            if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) return deferred('OpenCode 已确认 abort，等待状态读取恢复，消息未提交');
            throw error;
          }
          if (idle(statuses)) break;
          await pause(50);
        } while (Date.now() < until);
        if (!idle(statuses)) return deferred('OpenCode abort 后尚未确认 idle');
      }
      if (!current(input)) return deferred('OpenCode launch 已过期');
      await request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: 'POST', body: { messageID: 'msg_' + createHash('sha256').update(input.hostSessionId + '\0' + input.messageId).digest('hex'), parts: [{ type: 'text', text: input.text }] },
      });
      return accepted(interrupted || stoppedNotices.has(input.messageId) ? 'stopped-and-sent' : 'sent');
    },
  };
}

export function appendPrompt() {
  return false;
}

/** opentui 输入框支持 bracketed paste：TTY 注入走粘贴（文本原子进框、单次 Enter） */
export function pasteInput() {
  return true;
}

/** `--session` may create a missing conversation. Check the exact ID first. */
export async function checkResume({ cwd, sessionId }, withServer = withOpenCodeServer) {
  if (!sessionId?.startsWith('ses_') || sessionId.length <= 4 || /^ses_[0-9a-f]{24}$/.test(sessionId)) return 'unbound';
  return withServer(cwd, async request => {
    try {
      const session = await request(`/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(cwd)}`);
      if (session?.id !== sessionId) throw new Error('OpenCode did not return the requested session identity');
      return 'attempt';
    } catch (error) {
      if (error.httpStatus === 404) return 'missing';
      throw error;
    }
  });
}
