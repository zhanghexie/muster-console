/**
 * 统一宿主工具 stdio MCP：ACP session/new.mcpServers 与 pty 引擎 mcpServers 共用。
 * 工具面：MUSTER_HOST_TOOLS_CATALOG JSON，或 preset（默认 pty-allowlist）。
 * 身份：HOST_TOOLS_TOKEN+URL（invoke 网关）或 MUSTER_* Shell URL，或 pid-map。
 */
import fs from 'node:fs';
import { inboundMcpToolDefs, inboundMcpAllowlist } from './toolList';
import { parentPidOf, readInboundMcpPidRecord } from './pidMap';
import {
  dispatchInboundMcpTool,
  handleInboundMcpMessage,
  parseHostToolsCatalogJson,
  resolveInboundIdentity,
  type InboundMcpToolDef
} from '../../shared/inboundMcp';
import { createMcpStdioFramer, encodeMcpStdioFrame } from '../../shared/inboundMcpStdio';
import type { HostToolPresetId } from '../../shared/hostTools';

function envRecord(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) out[k] = v;
  return out;
}

function nodeHttp(): {
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal
  ) => Promise<{ ok: boolean; status: number; text: string }>;
} {
  return {
    async postJson(url, body, headers, signal) {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body), signal
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    }
  };
}

function loadTools(): { tools: InboundMcpToolDef[]; allowlist: readonly string[] } {
  const catalogPath = String(
    process.env.MUSTER_HOST_TOOLS_CATALOG ?? process.env.MUSTER_ACP_TOOLS_CATALOG ?? ''
  ).trim();
  if (catalogPath) {
    try {
      const tools = parseHostToolsCatalogJson(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
      return {
        tools,
        allowlist: tools.map((t) => t.name.replace(/_/g, '.'))
      };
    } catch {
      return { tools: [], allowlist: [] };
    }
  }
  const presetRaw = String(process.env.MUSTER_HOST_TOOLS_PRESET ?? 'pty-allowlist').trim();
  const preset: HostToolPresetId =
    presetRaw === 'gui-full' || presetRaw === 'acp-subset' || presetRaw === 'pty-allowlist'
      ? presetRaw
      : 'pty-allowlist';
  const tools = inboundMcpToolDefs(preset);
  return { tools, allowlist: inboundMcpAllowlist(preset) };
}

const { tools, allowlist } = loadTools();

async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const identity = resolveInboundIdentity({
    env: envRecord(),
    pid: process.pid,
    ppid: process.ppid,
    lookup: (pid) => readInboundMcpPidRecord(pid),
    parentOf: parentPidOf
  });
  if (!identity) {
    return {
      content: [
        {
          type: 'text' as const,
          text: '无法解析宿主会话身份（缺少 MUSTER_HOST_TOOLS_* / MUSTER_* 且 pid-map 未命中）。请确认工作台已打开本会话。'
        }
      ],
      isError: true
    };
  }
  return dispatchInboundMcpTool(name, args, identity, nodeHttp(), allowlist, signal);
}

const pendingCalls = new Map<string | number, AbortController>();
const framer = createMcpStdioFramer((msg, format) => {
  void handleInboundMcpMessage(msg, {
    tools,
    callTool,
    pendingCalls,
    serverVersion: process.env.MUSTER_VERSION
  }).then((reply) => {
    if (!reply) return;
    process.stdout.write(encodeMcpStdioFrame(reply, format));
  }).catch((error: unknown) => {
    const id = (msg as { id?: unknown } | null)?.id;
    if (id === undefined || id === null) return;
    process.stdout.write(encodeMcpStdioFrame({ jsonrpc: '2.0', id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }, format));
  });
});

process.stdin.on('data', (chunk: Buffer) => framer.push(chunk));
const abortPending = () => { for (const controller of pendingCalls.values()) controller.abort(); };
process.stdin.on('end', () => { abortPending(); process.exit(0); });
process.once('SIGTERM', () => { abortPending(); process.exit(0); });
process.once('SIGINT', () => { abortPending(); process.exit(0); });
process.stdin.resume();
