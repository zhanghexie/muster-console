import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { current, accepted, deferred, unsupported, cliOutput } from './_native.mjs';

export async function claudeChannelSupport(cwd, probe = cliOutput, env = process.env) {
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => /^(1|true)$/i.test(env[key] ?? '')))
    return 'Claude Channels 不支持当前 Bedrock/Vertex/Foundry 接入';
  // --help hides this preview flag; --version skips parsing unknown flags. An empty
  // --print invocation validates the parser and exits before any model prompt.
  try { await probe(['claude', '--dangerously-load-development-channels', 'server:muster-mailbox', '--print'], cwd); }
  catch (error) {
    if (/Input must be provided/.test(error.message)) return null;
    if (/unknown option.*dangerously-load-development-channels/.test(error.message)) return '此 Claude Code 不支持原生 Channels，请升级';
    throw error;
  }
  throw new Error('Claude channel capability probe returned an unexpected success');
}

/** Native channel admission is a stdio write receipt, never a model processing ACK. */
export async function prepareClaudeChannel(launch, { includeOptInFlag = true } = {}) {
  const token = randomBytes(32).toString('hex');
  const messages = new Map();
  let waiting;
  let ready = false;
  let disposed = false;
  const flush = () => {
    if (!waiting || !messages.size) return;
    const [id, item] = messages.entries().next().value;
    const response = waiting;
    waiting = undefined;
    response.end(JSON.stringify({ id, text: item.text }));
  };
  const server = http.createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end(); return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/next') {
      ready = true;
      if (waiting) waiting.end('{}');
      waiting = response;
      response.on('close', () => { if (waiting === response) waiting = undefined; });
      const timer = setTimeout(() => { if (waiting === response) { waiting = undefined; response.end('{}'); } }, 25_000);
      response.on('close', () => clearTimeout(timer));
      flush(); return;
    }
    if (request.method === 'POST' && request.url === '/ack') {
      let body = '';
      request.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
      request.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const item = messages.get(id);
          if (item) { messages.delete(id); item.resolve(accepted('written')); }
          response.end('{}');
        } catch { response.writeHead(400).end(); }
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-channel-'));
  const config = path.join(directory, 'mcp.json');
  try {
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'muster-mailbox': {
      command: process.execPath, args: [fileURLToPath(new URL('./_claude-channel.mjs', import.meta.url))],
      env: { ELECTRON_RUN_AS_NODE: '1', MUSTER_CHANNEL_URL: `http://127.0.0.1:${server.address().port}`,
        MUSTER_CHANNEL_TOKEN: token },
    } } }), { mode: 0o600 });
    // Preserve Claude's own preview warning, MCP consent and organization policy. No
    // --dangerously-skip-permissions / --strict-mcp-config / persisted user edits.
    const nativeArgs = ['--mcp-config', config, ...(includeOptInFlag ? ['--dangerously-load-development-channels', 'server:muster-mailbox'] : [])];
    return {
      ...launch(nativeArgs),
      dispose() {
        if (disposed) return;
        disposed = true;
        waiting?.end('{}'); server.close(); server.closeAllConnections();
        for (const item of messages.values()) item.reject(new Error('Claude channel disposed; admission unknown'));
        messages.clear();
        fs.rmSync(directory, { recursive: true, force: true });
      },
      async receiveMessage(input) {
        if (disposed || !current(input)) return deferred('Claude channel launch 已过期');
        if (input.intent === 'interrupt') return unsupported('Claude Channels 仅提供后续事件队列，没有原生 cancel/steer；先由宿主确认停止，再经 channel 投递');
        if (!ready) return deferred('Claude 原生 channel 尚未初始化；请完成终端中的 MCP/Channels 确认，或检查版本、账号和组织策略');
        if (messages.size >= 32) return deferred('Claude channel 待写入队列已满');
        const existing = messages.get(input.messageId);
        if (existing) return existing.promise;
        let resolve, reject;
        const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
        const item = { text: input.text, promise, resolve, reject };
        messages.set(input.messageId, item);
        // The signal aborts admission only while the notification has not left the broker.
        // Once /next consumed it, cancellation is uncertain and must not type a duplicate.
        flush();
        return promise;
      },
    };
  } catch (error) { server.close(); server.closeAllConnections(); fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
