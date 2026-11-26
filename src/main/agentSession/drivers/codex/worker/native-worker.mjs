// One SDK turn per worker. Only public SDK APIs are used; stdout is our IPC, not CLI JSONL.
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { MAX_APP_SERVER_IMAGE_FRAME_BYTES, projectAppServerOutput } from './appServerOutput.mjs';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let started = false;
let identityAnswered = false;
let appServer;
const MAX_FRAME_BYTES = 1024 * 1024;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'identity-challenge') {
    if (started || identityAnswered || typeof message.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.nonce)) {
      send({ type: 'identity-error' });
    } else {
      identityAnswered = true;
      send({ type: 'identity-response', nonce: message.nonce });
    }
    return;
  }
  // Run Claude's filesystem SDK in this isolated process so its configuration
  // directory cannot affect other active Claude/service-plan sessions.
  if (message.type === 'claude-fork' && !started) {
    started = true;
    void (async () => {
      try {
        if (typeof message.configDir !== 'string' || !message.configDir || typeof message.cwd !== 'string' ||
            typeof message.sessionToken !== 'string' || typeof message.entryId !== 'string' ||
            !['user', 'assistant'].includes(message.role)) throw new Error('Claude 原生分叉参数无效');
        process.env.CLAUDE_CONFIG_DIR = message.configDir;
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        const messages = await sdk.getSessionMessages(message.sessionToken, { dir: message.cwd });
        const matches = messages.filter(item => item.uuid === message.entryId && item.type === message.role);
        if (matches.length !== 1) { send({ type: 'claude-fork-result', status: 'unsupported' }); return; }
        const result = await sdk.forkSession(message.sessionToken, { dir: message.cwd, upToMessageId: message.entryId });
        if (!result?.sessionId || result.sessionId === message.sessionToken) throw new Error('Claude 返回了无效的分叉会话标识');
        send({ type: 'claude-fork-result', status: 'forked', token: result.sessionId });
      } catch (error) {
        send({ type: 'claude-fork-result', status: 'error', error: String(error?.message ?? error).slice(0, 2000) });
      }
    })();
    return;
  }
  if (message.type === 'app-rpc') {
    if (!appServer?.stdin.writable || appServer.stdin.destroyed) {
      send({ type: 'app-error', error: 'Codex app-server 输入通道不可用' });
      return;
    }
    const frame = JSON.stringify(message.value) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || appServer.stdin.writableLength + Buffer.byteLength(frame) > 8 * MAX_FRAME_BYTES) {
      send({ type: 'app-error', error: 'Codex app-server 输入超限' });
      return;
    }
    if (!appServer.stdin.write(frame)) {
      input.pause();
      appServer.stdin.once('drain', () => input.resume());
    }
    return;
  }
  if (message.type === 'run-app-server' && !started) {
    started = true;
    if (typeof message.executable !== 'string' || !message.executable || typeof message.cwd !== 'string') {
      send({ type: 'app-error', error: 'Codex app-server 启动参数无效' });
      return;
    }
    try {
      appServer = spawn(message.executable, ['app-server'], {
        cwd: message.cwd, env: message.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderrTail = '';
      appServer.stderr.setEncoding('utf8');
      appServer.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-6000); });
      appServer.stdin.on('error', () => send({ type: 'app-error', error: 'Codex app-server 输入管道已关闭' }));
      appServer.on('error', error => send({ type: 'app-error', error: `Codex app-server 启动失败：${String(error?.message ?? error)}` }));
      appServer.on('exit', (code, signal) => send({ type: 'app-exit', code, signal, stderr: stderrTail }));
      let buffered = '';
      let bufferedBytes = 0;
      appServer.stdout.setEncoding('utf8');
      appServer.stdout.on('data', chunk => {
        buffered += chunk;
        bufferedBytes += Buffer.byteLength(chunk);
        for (;;) {
          const end = buffered.indexOf('\n');
          if (end < 0) break;
          const line = buffered.slice(0, end + 1);
          const frame = line.slice(0, -1).replace(/\r$/, '');
          buffered = buffered.slice(end + 1);
          bufferedBytes -= Buffer.byteLength(line);
          const frameBytes = Buffer.byteLength(frame);
          if (frameBytes > MAX_APP_SERVER_IMAGE_FRAME_BYTES) { send({ type: 'app-error', error: 'Codex app-server 输出超限' }); return; }
          if (!frame.trim()) continue;
          try {
            const value = projectAppServerOutput(JSON.parse(frame), frameBytes);
            if (!send({ type: 'app-rpc', value })) {
              appServer.stdout.pause();
              process.stdout.once('drain', () => appServer?.stdout.resume());
            }
          } catch (error) { send({ type: 'app-error', error: String(error?.message ?? '').includes('超限') ? 'Codex app-server 输出超限' : 'Codex app-server 输出不是有效 JSON-RPC' }); return; }
        }
        if (bufferedBytes > MAX_APP_SERVER_IMAGE_FRAME_BYTES) send({ type: 'app-error', error: 'Codex app-server 未结束输出超限' });
      });
    } catch (error) { send({ type: 'app-error', error: `Codex app-server 启动失败：${String(error?.message ?? error)}` }); }
    return;
  }
});
input.on('close', () => { appServer?.stdin.end(); });
send({ type: 'ready' });
