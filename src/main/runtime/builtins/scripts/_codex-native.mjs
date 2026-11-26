import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { freePort, spawnOwned, connectRpc, cliOutput, cliLaunch, pause, current, accepted, deferred, unsupported } from './_native.mjs';

/** Read-only fallback for versions which cannot return turns in thread/read. Never
 * infer idle here: the API supplies active state and turn/steer validates the ID. */
export async function readActiveCodexTurn(file) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return undefined;
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const payload = entry?.payload;
      if (entry?.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload?.type)) return undefined;
      if (entry?.type === 'event_msg' && payload?.type === 'task_started' || entry?.type === 'turn_context') {
        if (typeof payload?.turn_id === 'string' && payload.turn_id.length < 256) return payload.turn_id;
      }
    }
  } catch { /* Native state remains active/unknown; never guess a turn ID. */ }
  finally { await handle?.close().catch(() => {}); }
  return undefined;
}

/** Remote resume/fork keeps the server thread's permission policy. Codex 0.166
 * rejects TUI permission flags on those paths, although new threads accept them. */
export function remoteExistingTuiArgs(args) {
  const kept = [];
  const removed = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { kept.push(...args.slice(i)); break; }
    if (['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--approve-for-me', '--full-auto'].includes(arg)) {
      removed.push(arg); continue;
    }
    if (/^(--ask-for-approval|--sandbox|--profile)=/.test(arg)) { removed.push(arg.split('=')[0]); continue; }
    if (['--ask-for-approval', '--sandbox', '--profile', '-a', '-s', '-p'].includes(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error(`Codex 权限参数 ${arg} 缺少值`);
      removed.push(arg); i++; continue;
    }
    if (arg === '-c' || arg === '--config') {
      const value = args[i + 1];
      if (value === undefined || value === '--') throw new Error(`Codex 配置参数 ${arg} 缺少值`);
      if (/^(approval_policy|sandbox_mode|approvals_reviewer|sandbox_workspace_write\.|permissions\.)\s*=/.test(value)) {
        removed.push(arg); i++; continue;
      }
      kept.push(arg, value); i++; continue;
    }
    kept.push(arg);
  }
  return { args: kept, removed };
}

/** This connection controls the very same server/thread rendered by the attached TUI. */
export async function prepareCodexTui({ mode, sessionId, cwd, isolatedWorktree, extraArgs, forkFromSessionId, WebSocket, env, executable = 'codex' }, legacy,
  { probeCli = cliOutput, allocatePort = freePort, startOwner = spawnOwned, openRpc = connectRpc, launchCli = cliLaunch, monitorIntervalMs = 3000 } = {}) {
  const help = await probeCli([executable, '--help'], cwd);
  const fallback = reason => {
    const args = [...extraArgs];
    const separator = args.indexOf('--');
    const optionsEnd = separator < 0 ? args.length : separator;
    const canAvoidSharedDaemon = help.includes('--no-daemon');
    if (canAvoidSharedDaemon && !args.slice(0, optionsEnd).includes('--no-daemon')) args.splice(optionsEnd, 0, '--no-daemon');
    return { ...legacy(args),
      ...(!canAvoidSharedDaemon ? { warning: '当前 Codex 无法禁用共享后台，宿主工具可能无法识别会话身份；请升级 Codex 并重新启动该会话。' } : {}),
      receiveMessage: async () => unsupported(reason) };
  };
  if (!help.includes('--remote-auth-token-env')) return fallback('此 Codex CLI 无认证 remote TUI；保留兼容终端兜底，请升级以启用 app-server 通信');
  const serverHelp = await probeCli([executable, 'app-server', '--help'], cwd);
  if (!serverHelp.includes('--ws-token-sha256')) return fallback('此 Codex app-server 无 capability-token 认证；保留兼容终端兜底');
  if (extraArgs.some(arg => /^(--remote|--remote-auth-token-env|--no-daemon)(=|$)/.test(arg)))
    throw new Error('Codex native mailbox owns its remote endpoint; remove conflicting runtime arguments');
  // codex 拒绝 --add-dir 与 --remote 同命令（"Configure additional workspace roots on the
  // server"）：宿主声明的额外 workspace roots 不能拼进 TUI 命令行，转为 app-server 进程级
  // config override（writable_roots 与 --add-dir 同语义：workspace-write 沙箱的额外可写根）。
  const writableRoots = [];
  const tuiArgs = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const inline = /^(--add-dir)=(.*)$/.exec(extraArgs[i]);
    if (inline) { writableRoots.push(inline[2]); continue; }
    if (extraArgs[i] === '--add-dir' && i + 1 < extraArgs.length) { writableRoots.push(extraArgs[i + 1]); i++; continue; }
    tuiArgs.push(extraArgs[i]);
  }
  // JSON.stringify 生成 TOML basic string：反斜杠转义与 JSON 兼容，中文/空格路径原样保留。
  const rootConfigArgs = writableRoots.length
    ? ['-c', `sandbox_workspace_write.writable_roots=[${writableRoots.map(root => JSON.stringify(root)).join(',')}]`]
    : [];
  if (!WebSocket) throw new Error('Codex native transport requires the host WebSocket service');
  const port = await allocatePort();
  const token = randomBytes(32).toString('hex');
  const url = `ws://127.0.0.1:${port}`;
  const owner = startOwner([executable, 'app-server', '--listen', url, '--ws-auth', 'capability-token',
    '--ws-token-sha256', createHash('sha256').update(token).digest('hex'), ...rootConfigArgs], { cwd, env: { ...process.env, ...env } });
  let rpc;
  let discoveryTimer;
  let monitorTimer;
  let disposed = false;
  const activityListeners = new Set();
  let lastActivity;
  let lastActivityAt = 0;
  let activityVersion = 0;
  let monitorGeneration = 0;
  let monitorFailed = false;
  const statusUrl = env?.MUSTER_STATUS_URL?.trim();
  const reportTurn = (activity, event = 'codex-turn') => {
    if (disposed) return;
    lastActivity = activity;
    lastActivityAt = Date.now();
    if (activityListeners.size) {
      for (const listener of activityListeners) {
        try { listener(activity, event); } catch (error) { console.error('[codex-native] activity listener failed:', error); }
      }
      return;
    }
    if (!statusUrl) return;
    try {
      const target = new URL(statusUrl);
      const payload = Buffer.from(JSON.stringify({ activity, event }));
      const req = http.request(target, { method: 'POST', timeout: 3_000,
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) } },
        (res) => { res.resume(); });
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end(payload);
    } catch { }
  };
  const dispose = () => { if (disposed) return; disposed = true; monitorGeneration++; clearTimeout(discoveryTimer); clearTimeout(monitorTimer); activityListeners.clear(); rpc?.dispose(); owner.dispose(); };
  try {
    const until = Date.now() + 15_000;
    let lastError;
    while (!rpc && Date.now() < until) {
      owner.assertAlive();
      try { rpc = await openRpc(WebSocket, url, token); } catch (error) { lastError = error; await pause(100); }
    }
    if (!rpc) throw lastError ?? new Error('Codex app-server startup timed out');
    const pending = !sessionId || sessionId.startsWith('codex-pending-');
    let threadId = mode !== 'fork' && !pending ? sessionId : undefined;
    const activeTurns = new Map();
    rpc.onNotification((method, params) => {
      if (method === 'turn/started' && params?.threadId && params?.turn?.id) {
        activeTurns.set(params.threadId, params.turn.id);
        if (params.threadId === threadId) { activityVersion++; reportTurn('active'); }
      } else if (method === 'turn/completed' && activeTurns.get(params?.threadId) === params?.turn?.id) {
        activeTurns.delete(params.threadId);
        if (params.threadId === threadId) { activityVersion++; reportTurn('idle'); }
      }
    });
    await rpc.request('initialize', { clientInfo: { name: 'muster-mailbox', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized', {});
    const listeners = new Set();
    let discovering;
    const discover = () => discovering ??= (async () => {
      if (disposed || threadId) return;
      const loaded = await rpc.request('thread/loaded/list', {});
      if (!Array.isArray(loaded?.data)) throw new Error('Codex loaded thread list returned an invalid shape');
      const candidates = loaded.data.filter(id => mode !== 'fork' || id !== forkFromSessionId);
      if (!candidates.length) return;
      if (candidates.length !== 1) throw new Error('Codex private server has multiple unbound threads; refusing to guess the TUI identity');
      threadId = candidates[0];
      for (const listener of listeners) listener(threadId);
    })().finally(() => { discovering = undefined; });
    const scheduleDiscovery = () => {
      if (disposed || threadId || !listeners.size) return;
      discoveryTimer = setTimeout(() => {
        void discover().catch(error => console.warn('[codex-native] TUI identity not yet bound:', error.message)).finally(scheduleDiscovery);
      }, 250);
      discoveryTimer.unref?.();
    };
    const monitor = async generation => {
      if (disposed || generation !== monitorGeneration || !activityListeners.size) return;
      try {
        owner.assertAlive();
        await discover();
        if (threadId && !disposed && generation === monitorGeneration && activityListeners.size) {
          const version = activityVersion;
          const snapshot = await rpc.request('thread/read', { threadId, includeTurns: false });
          if (!disposed && generation === monitorGeneration && activityListeners.size && version === activityVersion && snapshot?.thread?.id === threadId) {
            const observed = snapshot.thread.status?.type;
            if (observed === 'active' || observed === 'idle') {
              if (observed !== lastActivity) reportTurn(observed);
              else if (observed === 'active' && Date.now() - lastActivityAt >= 20_000) reportTurn(observed, 'codex-turn-heartbeat');
            }
          }
        }
        if (monitorFailed) console.info('[codex-native] activity monitoring recovered');
        monitorFailed = false;
      } catch (error) {
        if (!disposed && !monitorFailed) console.warn('[codex-native] activity monitoring failed:', error.message);
        monitorFailed = true;
      } finally {
        if (!disposed && generation === monitorGeneration && activityListeners.size) {
          monitorTimer = setTimeout(() => monitor(generation), monitorIntervalMs);
          monitorTimer.unref?.();
        }
      }
    };
    const command = mode === 'fork' && forkFromSessionId ? ['fork', forkFromSessionId] : pending ? [] : ['resume', sessionId];
    const resumeArgs = ['resume', 'fork'].includes(command[0]) ? remoteExistingTuiArgs(tuiArgs) : { args: tuiArgs, removed: [] };
    if (resumeArgs.removed.length) console.warn(`[codex-native] remote ${command[0]} uses the thread's saved permissions; ignored TUI flags: ${resumeArgs.removed.join(', ')}`);
    let nativeQueue = /\bqueue\s/.test(help);
    return {
      ...launchCli([executable, '--remote', url, '--remote-auth-token-env', 'MUSTER_CODEX_TOKEN', ...command, ...resumeArgs.args]),
      deliveryCapabilities: { interject: true, snapshot: false },
      env: { MUSTER_CODEX_TOKEN: token }, ...(threadId ? { externalSessionId: threadId } : {}), dispose,
      ...(owner.child?.pid ? { processIds: [owner.child.pid] } : {}),
      onSessionId(listener) {
        listeners.add(listener);
        if (threadId) listener(threadId); else if (listeners.size === 1) scheduleDiscovery();
        return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(discoveryTimer); };
      },
      onActivity(listener) {
        activityListeners.add(listener);
        if (lastActivity) {
          try { listener(lastActivity, 'codex-turn'); } catch (error) { console.error('[codex-native] activity listener failed:', error); }
        }
        if (activityListeners.size === 1) void monitor(++monitorGeneration);
        return () => { activityListeners.delete(listener); if (!activityListeners.size) { monitorGeneration++; clearTimeout(monitorTimer); } };
      },
      async receiveMessage(input) {
        if (disposed || !current(input)) return deferred('Codex launch 已过期');
        try { owner.assertAlive(); await discover(); }
        catch (error) { return deferred(`Codex 连接/句柄尚未就绪，未提交消息: ${error.message}`); }
        if (!threadId) return deferred('Codex TUI 尚未建立真实 thread，请完成原生登录/信任提示');
        const payload = { threadId, clientUserMessageId: input.messageId,
          input: [{ type: 'text', text: input.text, text_elements: [] }] };
        if (!current(input)) return deferred('Codex launch 已过期');
        if (input.intent === 'normal' && nativeQueue && !input.idleOnly) {
          try {
            // Same protocol as `codex queue`: durable, stable client ID and atomic
            // follow-up admission. Never turn an idle/read -> start race into steering.
            const result = await rpc.request('thread/queue/add', payload);
            if (!result?.queuedSubmission?.id || result.queuedSubmission.clientUserMessageId !== input.messageId)
              throw new Error('Codex queue returned an invalid durable admission receipt');
            return accepted('queued');
          } catch (error) {
            if (error.rpcCode === -32601 || error.rpcCode && /user message queue is unavailable|does not support.*queue|experimental api.*required/i.test(error.message)) nativeQueue = false;
            else throw error;
          }
        }
        // Read authoritative engine state. Quiet terminal output is never taken as idle.
        let snapshot;
        try { snapshot = await rpc.request('thread/read', { threadId, includeTurns: false }); }
        catch (error) { return deferred(`Codex 状态读取失败，未提交消息: ${error.message}`); }
        if (snapshot?.thread?.id !== threadId) return deferred('Codex 返回不同的 thread 身份，未提交消息');
        const status = snapshot?.thread?.status?.type;
        const activeId = activeTurns.get(threadId) ?? (status === 'active' ? await readActiveCodexTurn(snapshot.thread.path) : undefined);
        if (!current(input)) return deferred('Codex launch 已过期');
        if (status === 'active') {
          if (input.intent === 'normal') return deferred('Codex 当前回合进行中；普通信等待 idle');
          if (!activeId) return deferred('Codex 活动 turn 身份尚不可用');
          try {
            const result = await rpc.request('turn/steer', { ...payload, expectedTurnId: activeId });
            if (result?.turnId !== activeId) throw new Error('Codex steer returned an unexpected turn identity');
            return accepted('steered');
          } catch (error) {
            if (error.rpcCode && /no active turn|expected.*turn|turn.*mismatch|not.*active/i.test(error.message)) {
              activeTurns.delete(threadId);
              return deferred('Codex 确认目标回合已变，消息尚未插入');
            }
            throw error;
          }
        }
        if (status !== 'idle') return deferred(`Codex thread 尚不可接收消息 (${status ?? 'unknown'})`);
        const result = await rpc.request('turn/start', isolatedWorktree ? { ...payload, cwd } : payload);
        if (!result?.turn?.id) throw new Error('Codex turn/start returned no turn identity');
        activeTurns.set(threadId, result.turn.id);
        return accepted('sent');
      },
    };
  } catch (error) { dispose(); throw error; }
}
