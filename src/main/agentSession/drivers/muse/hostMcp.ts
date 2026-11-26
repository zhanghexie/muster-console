import crypto from 'node:crypto';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GuiDriverConnectInput } from '../../types';
import { createGuiHostToolGateway } from '../../tools/gateway';
import { hostToolsToCatalog } from '../acp/mcpServers';
import type { createPromptAuthorityScope } from '../../../agent/turnScope';

/** A fresh server is issued for each Muse process/turn; its token is never reused. */
export interface MuseTurnAuthority {
  hostTurnId: string;
  scope: ReturnType<typeof createPromptAuthorityScope>;
  signal: AbortSignal;
}

export async function startMuseHostMcp(
  input: GuiDriverConnectInput,
  currentTurn: () => MuseTurnAuthority | undefined,
  options?: { onToolsListed?: () => void }
): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = crypto.randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`, 'utf8');
  const catalog = hostToolsToCatalog(input.hostTools);
  const calls = new Set<AbortController>();
  let closed = false;
  let sequence = 0;
  const gateway = createGuiHostToolGateway(input, { isCurrent: () => !closed });
  const server = new Server({ name: 'muster', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    options?.onToolsListed?.();
    return { tools: catalog.tools as unknown as Tool[] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const turn = currentTurn();
    const live = (): boolean => !closed && !!turn && currentTurn() === turn && !turn.signal.aborted &&
      !!input.getTurnId && input.getTurnId() === turn.hostTurnId;
    if (!live()) return { isError: true, content: [{ type: 'text', text: 'The originating turn has ended.' }] };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    calls.add(controller);
    turn!.signal.addEventListener('abort', abort, { once: true });
    extra.signal.addEventListener('abort', abort, { once: true });
    try {
      if (!live() || extra.signal.aborted) throw new Error('The originating turn has ended.');
      const result = await turn!.scope.run(() => gateway.invoke(request.params.name, request.params.arguments ?? {}, {
        id: `muse-mcp-${++sequence}`, signal: controller.signal
      }));
      if (!live() || controller.signal.aborted) throw new Error('The originating turn has ended.');
      return { isError: !result.ok, content: [{ type: 'text', text: result.text }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    } finally {
      calls.delete(controller);
      turn!.signal.removeEventListener('abort', abort);
      extra.signal.removeEventListener('abort', abort);
    }
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '', 'utf8');
    if (closed || req.url !== '/mcp' || req.headers.origin || auth.length !== expectedAuth.length || !crypto.timingSafeEqual(auth, expectedAuth)) {
      res.writeHead(403).end();
      req.resume();
      return;
    }
    if (req.method !== 'POST') {
      void transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let invalid = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        if (!invalid) { invalid = true; res.writeHead(413).end(); }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (invalid || closed) return;
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400).end(); return; }
      void transport.handleRequest(req, res, body).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { httpServer.off('error', reject); resolve(); });
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await server.close();
    httpServer.close();
    throw new Error('Muse 宿主 MCP 未能绑定本地端口');
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const call of calls) call.abort();
      closing = (async () => {
        await server.close();
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      })();
      return closing;
    }
  };
}
