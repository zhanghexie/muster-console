import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpConfig, McpServerConfig } from '../../shared/types';
import { t } from '../../shared/i18n';
import { redactMcpDiagnostic } from '../../shared/mcpConfig';
import { selectMcpResultPaths } from '../../shared/mcpRelay';

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** 连接失败占位条目名（调用方据此过滤/告警） */
export const MCP_CONNECT_ERROR = '(connect-error)';

/** 单台 server 的连接超时：SDK 默认 60s，一台挂住的 server 就能把建连拖到一分钟 */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
/** 单次 tools/call 超时 */
export const MCP_CALL_TIMEOUT_MS = 120_000;
/** 连接失败后的冷却期：期间不再重拉子进程（每次 list 都重试坏 server 会刷屏+烧资源） */
export const MCP_FAILURE_COOLDOWN_MS = 30_000;
/** callTool 结果回灌上限（超出截断并提示）；发现式省下的 token 不能被单个大结果吐回来 */
export const MCP_RESULT_MAX_CHARS = 20_000;
/** 每台 server 保留的 stderr 尾部字节数（诊断用，不无界堆积） */
const STDERR_TAIL_MAX = 4_000;

interface LiveServer {
  config: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
}

interface FailureRecord {
  message: string;
  at: number;
}

/**
 * Windows 上这些 JS 工具链命令实际是 `.cmd` 包装脚本，CreateProcess 认不了裸名。
 * （原先只特判了 npx，pnpm/yarn/bunx 配置一律启动失败。）
 */
const WIN_CMD_WRAPPERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno']);

export function resolveStdioCommand(command: string): string {
  const cmd = command.trim();
  if (process.platform !== 'win32') return cmd;
  if (/\.(cmd|bat|exe|ps1)$/i.test(cmd)) return cmd;
  // 带路径分隔符的当成显式路径，不猜后缀
  if (/[\\/]/.test(cmd)) return cmd;
  return WIN_CMD_WRAPPERS.has(cmd.toLowerCase()) ? `${cmd}.cmd` : cmd;
}

/**
 * MCP 结果 → 给模型的文本：优先取 content 里的文本块（整包 JSON.stringify 会把
 * 换行/引号全转义，token 约翻倍且难读），其余类型给简短占位；isError 明确标注，
 * 否则模型分不清「调用失败」与「成功但返回了错误描述」。
 */
export function formatMcpToolResult(
  result: unknown,
  opts?: { maxChars?: number; resultPaths?: readonly string[] }
): { text: string; isError: boolean } {
  const max = opts?.maxChars ?? MCP_RESULT_MAX_CHARS;
  const r = (result ?? {}) as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
  };
  const isError = r.isError === true;
  const resultPaths = !isError ? opts?.resultPaths : undefined;
  if (resultPaths) {
    const source = mcpResultJson(r);
    if (source) return { text: selectMcpResultPaths(source, resultPaths), isError };
  }
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const raw of r.content) {
      const block = (raw ?? {}) as { type?: unknown; text?: unknown; mimeType?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'image') {
        parts.push(`[image ${String(block.mimeType ?? 'unknown')}]`);
      } else if (block.type === 'resource' || block.type === 'resource_link') {
        parts.push(`[resource] ${safeJson(raw)}`);
      } else if (block.type) {
        parts.push(`[${String(block.type)}] ${safeJson(raw)}`);
      }
    }
  }
  if (!parts.length && r.structuredContent !== undefined) {
    // Only the host-generated JSON representation is compacted. A server's
    // text blocks and resource formatting remain untouched.
    parts.push(safeJson(r.structuredContent, true));
  }
  let text = parts.join('\n').trim();
  if (!text) text = parts.length ? '' : safeJson(result);
  if (resultPaths) text = `[mcp.call: resultPaths requires structured content or a single JSON object/array text block; showing the original result]\n${text}`;
  if (text.length > max) {
    text = `${text.slice(0, max)}\n…（结果被截断，原长 ${text.length} 字符；请缩小查询范围或分页）`;
  }
  return { text: isError ? `${t('[MCP 工具报错]')}\n${text}` : text, isError };
}

function mcpResultJson(result: { structuredContent?: unknown; content?: unknown }): object | undefined {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) return undefined;
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') return undefined;
  const text = block.text.trimStart();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function safeJson(v: unknown, compact = false): string {
  try {
    return JSON.stringify(v, null, compact ? undefined : 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * 调度侧轻量 MCP 客户端：按需连接、缓存 tools/list，连接失败带冷却，断线自动摘除。
 * （不用 pi-mcp-adapter：其包以 .ts 导出且依赖 pi-tui，Electron 主进程无法直接加载。）
 */
export class McpHub {
  private lives = new Map<string, LiveServer>();
  private connecting = new Map<string, Promise<LiveServer>>();
  private failures = new Map<string, FailureRecord>();
  /** 每台 server 的 stderr 尾部（stdio）：连接/调用失败时的第一现场 */
  private stderrTails = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly cfg: McpConfig,
    private readonly opts?: {
      connectTimeoutMs?: number;
      callTimeoutMs?: number;
      failureCooldownMs?: number;
    }
  ) {}

  enabledServers(): McpServerConfig[] {
    if (!this.cfg.enabled) return [];
    return this.cfg.servers.filter((s) => s.enabled && s.name.trim());
  }

  /** 某台 server 最近的 stderr 尾部（无则空串） */
  stderrTail(name: string): string {
    const tail = this.stderrTails.get(name) ?? '';
    const cfg = this.cfg.servers.find(server => server.name === name);
    return cfg ? redactMcpDiagnostic(tail, cfg) : tail;
  }

  /** 全部启用 server 的工具；**并行**连接，单台失败只产出一条占位条目 */
  async listAllTools(allowed?: ReadonlySet<string>): Promise<McpToolInfo[]> {
    const servers = this.enabledServers().filter(server => !allowed || allowed.has(server.name));
    const settled = await Promise.all(
      servers.map(async (s): Promise<McpToolInfo[]> => {
        try {
          const live = await this.ensure(s.name);
          return live.tools;
        } catch (e) {
          const tail = this.stderrTail(s.name);
          return [
            {
              server: s.name,
              name: MCP_CONNECT_ERROR,
              description: tail
                ? `${(e as Error).message}\nstderr: ${tail.slice(-600)}`
                : (e as Error).message
            }
          ];
        }
      })
    );
    return settled.flat();
  }

  async searchTools(query: string): Promise<McpToolInfo[]> {
    const q = query.trim().toLowerCase();
    const all = await this.listAllTools();
    if (!q) return all;
    return all.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) ||
        tool.server.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q)
    );
  }

  async describeTool(server: string, tool: string): Promise<McpToolInfo | null> {
    const live = await this.ensure(server);
    return live.tools.find((x) => x.name === tool) ?? null;
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    beforeCall?: () => void
  ): Promise<string> {
    return (await this.callToolResult(server, tool, args, beforeCall)).text;
  }

  /** Keep the provider's error status available to callers that expose structured results. */
  async callToolResult(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    beforeCall?: () => void,
    resultPaths?: readonly string[]
  ): Promise<{ text: string; isError: boolean }> {
    const live = await this.ensure(server);
    beforeCall?.();
    try {
      const result = await live.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { timeout: this.opts?.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS }
      );
      const formatted = formatMcpToolResult(result, { resultPaths });
      return {
        text: formatted.isError ? redactMcpDiagnostic(formatted.text, live.config) : formatted.text,
        isError: formatted.isError
      };
    } catch (e) {
      // 调用期断线：摘除失效连接，下次 ensure 重连（否则整个会话都在用死连接）
      this.dropLive(server);
      const tail = this.stderrTail(server);
      const message = redactMcpDiagnostic((e as Error).message, this.findConfig(server));
      throw new Error(tail ? `${message}\nstderr: ${tail.slice(-600)}` : message);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.lives.values()];
    this.lives.clear();
    this.connecting.clear();
    this.failures.clear();
    await Promise.all(
      clients.map(async (live) => {
        try {
          await live.client.close();
        } catch {
          /* ignore */
        }
      })
    );
  }

  private findConfig(name: string): McpServerConfig {
    const s = this.enabledServers().find((x) => x.name === name);
    if (!s) throw new Error(t('MCP 服务器未启用或不存在: {{name}}', { name }));
    return s;
  }

  private dropLive(name: string): void {
    this.lives.delete(name);
  }

  private noteStderr(name: string, chunk: string): void {
    const prev = this.stderrTails.get(name) ?? '';
    const next = prev + chunk;
    this.stderrTails.set(
      name,
      next.length > STDERR_TAIL_MAX ? next.slice(-STDERR_TAIL_MAX) : next
    );
  }

  private async ensure(name: string): Promise<LiveServer> {
    if (this.closed) throw new Error(t('MCP 已关闭'));
    const existing = this.lives.get(name);
    if (existing) return existing;
    const pending = this.connecting.get(name);
    if (pending) return pending;

    // 失败冷却：坏 server 在冷却期内直接复用上次错误，不反复重拉子进程
    const cooldown = this.opts?.failureCooldownMs ?? MCP_FAILURE_COOLDOWN_MS;
    const failed = this.failures.get(name);
    if (failed && Date.now() - failed.at < cooldown) {
      throw new Error(failed.message);
    }

    const job = this.connect(this.findConfig(name));
    this.connecting.set(name, job);
    try {
      const live = await job;
      this.failures.delete(name);
      // close() 可能在 await 期间发生：此时不要把新连接塞回表里（无人再关它）
      if (this.closed) {
        try {
          await live.client.close();
        } catch {
          /* ignore */
        }
        throw new Error(t('MCP 已关闭'));
      }
      this.lives.set(name, live);
      return live;
    } catch (e) {
      const cfg = this.cfg.servers.find(server => server.name === name);
      const message = cfg ? redactMcpDiagnostic((e as Error).message, cfg) : (e as Error).message;
      this.failures.set(name, { message, at: Date.now() });
      throw new Error(message);
    } finally {
      this.connecting.delete(name);
    }
  }

  private async connect(cfg: McpServerConfig): Promise<LiveServer> {
    const client = new Client({ name: 'muster-workbench', version: '0.1.0' }, {});
    const timeout = this.opts?.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;

    if (cfg.transport === 'http') {
      if (!cfg.url?.trim()) throw new Error(t('{{name}}: HTTP MCP 缺少 url', { name: cfg.name }));
      const url = new URL(cfg.url.trim());
      const headers = cfg.headers ?? {};
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }), {
          timeout
        });
      } catch (streamErr) {
        // 老式 SSE server 不认 Streamable HTTP（配置里的 type:sse 会被归一成 http）：回落一次
        try {
          await client.connect(new SSEClientTransport(url, { requestInit: { headers } }), {
            timeout
          });
        } catch {
          throw streamErr;
        }
      }
    } else {
      const command = resolveStdioCommand(cfg.command ?? '');
      if (!command) throw new Error(t('{{name}}: stdio MCP 缺少 command', { name: cfg.name }));
      const env: Record<string, string> = {
        ...getDefaultEnvironment(),
        ...(cfg.env ?? {})
      };
      const transport = new StdioClientTransport({
        command,
        args: cfg.args ?? [],
        env,
        cwd: cfg.cwd,
        stderr: 'pipe'
      });
      await client.connect(transport, { timeout });
      // stderr 必须有人读：SDK 把它接到 PassThrough，无人消费时管道缓冲写满后
      // 子进程会阻塞在写日志上（表现为 server 跑一阵突然假死）。顺带留尾部做诊断。
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        this.noteStderr(cfg.name, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
      transport.stderr?.on('error', () => {
        /* 读 stderr 失败不影响主通道 */
      });
    }

    // 断线（子进程崩溃 / HTTP 流断）：摘除缓存，下次调用重连——留着死连接会让
    // 本会话后续所有 MCP 调用一直失败到会话重建
    client.onclose = () => {
      const live = this.lives.get(cfg.name);
      if (live?.client === client) this.dropLive(cfg.name);
    };

    const listed = await client.listTools(undefined, { timeout });
    const tools: McpToolInfo[] = (listed.tools ?? []).map((x) => ({
      server: cfg.name,
      name: x.name,
      description: x.description ?? '',
      inputSchema: x.inputSchema
    }));
    console.log(`[mcp] connected ${cfg.name} tools=${tools.length}`);
    return { config: cfg, client, tools };
  }
}
