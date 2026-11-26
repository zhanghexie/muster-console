import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { McpServerConfig } from '../../shared/types';
import type { McpConnectionTestResult } from '../../shared/mcpManagement';
import { resolveStdioCommand } from '../agent/mcpHub';
import { findOnPath } from '../../shared/runtimePreflight';
import { decodeChildOutput } from '../encoding/winUtf8';
import { redactMcpDiagnostic } from '../../shared/mcpConfig';
import { t } from '../../shared/i18n';
export { redactMcpDiagnostic } from '../../shared/mcpConfig';

export function validateManagedMcp(server: McpServerConfig): void {
  if (!server.name?.trim()) throw new Error(t('MCP 名称不能为空'));
  if (!['stdio', 'http'].includes(server.transport)) throw new Error(t('MCP 传输类型必须是 stdio 或 HTTP'));
  if (server.transport === 'http') {
    let url: URL;
    try { url = new URL(server.url?.trim() ?? ''); } catch { throw new Error(t('HTTP MCP 需要有效 URL')); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(t('HTTP MCP 只允许 http / https 地址'));
    if (url.username || url.password) throw new Error(t('请通过请求头提供凭证，不要把账号密码放在 URL 中'));
  } else if (!server.command?.trim()) throw new Error(t('stdio MCP 需要启动命令'));
}

function classify(error: unknown): McpConnectionTestResult['status'] {
  const obj = error as { code?: unknown; status?: unknown; message?: unknown } | undefined;
  const message = String(obj?.message ?? error ?? 'Connection failed');
  if (obj?.status === 401 || obj?.status === 403 || /\b(?:401|403)\b|unauthori[sz]ed|forbidden|oauth|authentication/i.test(message)) return 'auth-required';
  if (obj?.code === 'ENOENT' || /ENOENT|not found|spawn.*ENOENT/i.test(message)) return 'command-missing';
  if (obj?.code === 'ETIMEDOUT' || /timeout|timed out|AbortError/i.test(message)) return 'timeout';
  return 'connection-error';
}

/** A fresh MCP client per explicit connection test: a direct initialize + tools/list handshake that verifies the server configuration. It never goes through the host relay chain and never authenticates or opens a browser. Relay availability depends on the mcp.enabled master switch (gated in McpManagementService.test). */
export async function testMcpConnection(server: McpServerConfig, timeoutMs = 15_000): Promise<McpConnectionTestResult> {
  const started = Date.now();
  const result = (status: McpConnectionTestResult['status'], message: string, tools: McpConnectionTestResult['tools'] = []): McpConnectionTestResult => ({
    ok: status === 'connected', status, tools, message: redactMcpDiagnostic(message, server), checkedAt: new Date().toISOString(), durationMs: Date.now() - started
  });
  try { validateManagedMcp(server); } catch (error) { return result('invalid', (error as Error).message); }
  let command: string | undefined;
  if (server.transport === 'stdio') {
    const configured = resolveStdioCommand(server.command!);
    const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };
    if (path.isAbsolute(configured) || /[\\/]/.test(configured)) {
      const candidate = path.resolve(server.cwd ?? process.cwd(), configured);
      const choices = process.platform === 'win32' && !path.extname(candidate) ? [candidate, ...((process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')).map(ext => candidate + ext)] : [candidate];
      command = choices.find(isFile);
    } else {
      command = findOnPath([configured], { exists: isFile, join: path.join, pathEnv: Object.entries(server.env ?? {}).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? process.env.PATH }) ?? undefined;
    }
    if (!command) return result('command-missing', t('找不到 MCP 启动命令：{{command}}', { command: server.command }));
  }
  const abort = new AbortController();
  let client: Client | undefined;
  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | undefined;
  let stderr = Buffer.alloc(0);
  let ownedPid: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = async (): Promise<string | undefined> => {
    // Close the transport even when client.connect has not installed it yet.
    try { await transport?.close(); } catch { /* preserve the diagnostic error */ }
    try { await client?.close(); } catch { /* already closed transport */ }
    // SDK close() can return immediately after SIGKILL; wait for OS reaping before
    // reporting that an isolated diagnostic has finished.
    if (ownedPid) {
      const deadline = Date.now() + 1000;
      let running = true;
      while (running && Date.now() < deadline) {
        try { process.kill(ownedPid, 0); } catch { running = false; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (running) {
        try { process.kill(ownedPid, 'SIGKILL'); } catch { /* process exited between checks */ }
        const forceDeadline = Date.now() + 1000;
        while (Date.now() < forceDeadline) {
          try { process.kill(ownedPid, 0); } catch { return undefined; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        // mcp-settings F-01: 清理失败不抛出——throw 会把已组装的诊断结果整体变成
        // IPC 异常、并阻断 HTTP→SSE 回落；改为返回警告文本，由调用方并入结果。
        return t('MCP 测试进程未能退出，请检查诊断进程');
      }
    }
    return undefined;
  };
  const connect = async (legacySse = false): Promise<McpConnectionTestResult['tools']> => {
    client = new Client({ name: 'muster-mcp-diagnostic', version: '1.0.0' }, {});
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    if (server.transport === 'http') {
      const options = { requestInit: { headers: server.headers ?? {}, signal: abort.signal } };
      transport = legacySse ? new SSEClientTransport(new URL(server.url!), options) : new StreamableHTTPClientTransport(new URL(server.url!), options);
    } else {
      transport = new StdioClientTransport({ command: command!, args: server.args ?? [], env: { ...getDefaultEnvironment(), ...(server.env ?? {}) }, cwd: server.cwd, stderr: 'pipe' });
      const stdio = transport;
      const nativeClose = stdio.close.bind(stdio);
      let closeInFlight: Promise<void> | undefined;
      // On initialize abort the SDK also invokes transport.close(). Memoize that
      // promise: a second close otherwise sees SDK's cleared _process and returns
      // while the first close is still terminating the child.
      stdio.close = () => {
        ownedPid ??= stdio.pid;
        return closeInFlight ??= (async () => {
          // Windows npm/.cmd launchers may have a child MCP process. Killing only
          // the launcher leaks that child, so terminate our diagnostic's own tree.
          if (process.platform === 'win32' && ownedPid) {
            const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
            const taskkill = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
            await new Promise<void>(resolve => execFile(taskkill, ['/PID', String(ownedPid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, () => resolve()));
          }
          await nativeClose();
        })();
      };
      // Attach before initialization so a noisy server cannot block its handshake.
      transport.stderr?.on('data', (chunk: Buffer | string) => { stderr = Buffer.concat([stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]).subarray(-4000); });
      transport.stderr?.on('error', () => { /* connection result remains authoritative */ });
    }
    await client.connect(transport, { timeout: remaining, signal: abort.signal });
    const listed = await client.listTools(undefined, { timeout: Math.max(1, timeoutMs - (Date.now() - started)), signal: abort.signal });
    return listed.tools.map(tool => ({ name: tool.name, description: tool.description ?? '' }));
  };
  let outcome: McpConnectionTestResult;
  try {
    const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error(t('MCP 连接测试超时（{{timeout}}ms）', { timeout: timeoutMs }))); }, timeoutMs); });
    const job = (async () => {
      try { return await connect(); } catch (error) {
        // Authentication is reported directly, never converted into an SSE retry/login.
        if (server.transport !== 'http' || abort.signal.aborted || classify(error) === 'auth-required') throw error;
        await cleanup(); // best-effort：清理失败不阻断 HTTP→SSE 回落
        return connect(true);
      }
    })();
    const tools = await Promise.race([job, timedOut]);
    // 如实表述：本诊断是独立新建 SDK client 直连 server 的 initialize+tools/list，
    // 验证的是 server 配置正确性，不经过宿主中转链路——不宣称「中转可达」。
    outcome = result('connected', t('握手成功：服务器配置正确（直连验证，未经中转链路），发现 {{count}} 个工具', { count: tools.length }), tools);
  } catch (error) {
    const message = `${(error as Error).message}${stderr.length ? `\nstderr: ${decodeChildOutput(stderr).slice(-1000)}` : ''}`;
    const status = abort.signal.aborted ? 'timeout' : classify(error);
    outcome = result(status, status === 'auth-required' ? t('需要认证或权限不足。请检查请求头或服务器登录状态后重试。\n{{message}}', { message }) : message);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
  // mcp-settings F-01：清理失败作为附加警告并入结果返回，不替换/中断诊断结论。
  const cleanupError = await cleanup();
  if (cleanupError) outcome.cleanupError = redactMcpDiagnostic(cleanupError, server);
  return outcome;
}
