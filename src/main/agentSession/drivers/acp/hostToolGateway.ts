/**
 * 宿主工具 HTTP 网关：MCP shim 回打主进程执行 GuiHostTool（决策表与 Claude hostTools 同款）。
 * askQuestion 走 requestUserQuestion → UserQuestionCard（与 Pi/Cursor 同卡）。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createGuiHostToolGateway } from '../../tools/gateway';
import type { GuiDriverConnectInput } from '../../types';
import { requestAbort } from '../../../protocol/requestAbort';
import { assertToolArguments } from '../../../capabilities/schemaValidation';
import { requestApprovalCatalogEntry } from './mcpServers';
import { isPlanToolName } from '../../../../shared/planExtract';
import type { GuiHostToolResult } from '../../tools/gateway';

/** Optional host-owned interception around a single authenticated tool call. */
export interface HostToolCallInterceptor {
  run(call: { id: string; name: string; arguments: Record<string, unknown>; signal: AbortSignal;
    turnId?: string; isCurrent(): boolean }, execute: () => Promise<GuiHostToolResult>): Promise<GuiHostToolResult>;
}

export async function startHostToolGateway(
  input: Pick<
    GuiDriverConnectInput,
    | 'sessionId'
    | 'cwd'
    | 'workspaceContext'
    | 'hostTools'
    | 'requestApproval'
    | 'getPolicyState'
    | 'getTurnId'
    | 'getDesktopTurnId'
    | 'log'
    | 'requestUserQuestion'
  >,
  options?: { interceptor?: HostToolCallInterceptor; captureImages?: boolean }
): Promise<{ url: string; readonly token: string; rotateToken(): string; close: () => void }> {
  let token = crypto.randomBytes(16).toString('hex');
  let approvalSeq = 0;
  let closed = false;
  const requests = new Set<ReturnType<typeof requestAbort>>();
  const hostTools = createGuiHostToolGateway(input, { isCurrent: () => !closed, captureImages: options?.captureImages === true });

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('{}');
      return;
    }
    // The connection token is reused across turns. Bind the request when its
    // headers arrive, before a delayed body can cross into a later turn.
    let turnId: string | undefined, desktopTurnId: string | undefined;
    try { turnId = input.getTurnId?.(); desktopTurnId = input.getDesktopTurnId?.(); }
    catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ isError: true, text: 'The originating turn is unavailable.' }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        oversized = true;
        res.statusCode = 413;
        res.end(JSON.stringify({ isError: true, text: 'Host tool request exceeds the size limit.' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized || closed) return;
      void (async () => {
        let body: { token?: string; name?: string; arguments?: Record<string, unknown> };
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
          body = parsed as typeof body;
        } catch {
          res.end(JSON.stringify({ isError: true, text: '坏 JSON' }));
          return;
        }
        if (body.token !== token) {
          res.statusCode = 403;
          res.end(JSON.stringify({ isError: true, text: 'token 无效' }));
          return;
        }
        const name = String(body.name ?? '');
        const call = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
        const desktopCall = /^(?:host[._])?desktop[._]/.test(name);
        const request = requestAbort(req, res);
        requests.add(request);
        try {
          const isCurrent = (): boolean => !closed && !request.signal.aborted &&
            (!input.getTurnId || (!!turnId && input.getTurnId() === turnId)) &&
            (!desktopCall || !input.getDesktopTurnId || (!!desktopTurnId && input.getDesktopTurnId() === desktopTurnId));
          if (!isCurrent()) {
            if (!res.destroyed) res.end(JSON.stringify({ isError: true, text: 'The originating turn has ended.' }));
            return;
          }
          // 自愿审批属于真实的人机请求，不是引擎的预审批回调。
          if (name === 'host_requestApproval') {
            assertToolArguments(requestApprovalCatalogEntry().inputSchema, call, name);
            if (typeof input.requestApproval !== 'function') throw new Error('未接入审批通道');
            const approvalName = typeof call.toolName === 'string' && call.toolName.trim()
              ? call.toolName.trim()
              : 'requestApproval';
            const decision = await input.requestApproval({
              toolCallId: `gw-appr-${++approvalSeq}`,
              toolName: approvalName,
              input:
                call.input && typeof call.input === 'object' && !Array.isArray(call.input)
                  ? (call.input as Record<string, unknown>)
                  : {},
              ...(typeof call.reason === 'string' && call.reason.trim()
                ? { reason: call.reason.trim() }
                : {}),
              requireHumanApproval: true
            }, isPlanToolName(approvalName) ? undefined : request.signal);
            if (!isCurrent() || res.destroyed) {
              if (!res.destroyed) res.end(JSON.stringify({ isError: true, text: 'The originating turn has ended.' }));
              return;
            }
            const text = decision.approved
              ? `已批准${decision.feedback ? `；用户反馈：${decision.feedback}` : ''}。可以继续执行该动作。`
              : `用户拒绝${decision.reason ? `：${decision.reason}` : ''}。不要执行该动作，按反馈调整方案。`;
            res.end(JSON.stringify({ isError: false, text }));
            return;
          }
          const id = `acp-mcp-${++approvalSeq}`;
          const execute = () => hostTools.invoke(name, call, { id, signal: request.signal,
            desktopTurnSnapshot: { id: desktopTurnId, isCurrent: () => !closed && !request.signal.aborted &&
              !!desktopTurnId && input.getDesktopTurnId?.() === desktopTurnId } });
          const result = options?.interceptor
            ? await options.interceptor.run({ id, name, arguments: call, signal: request.signal, turnId, isCurrent }, execute)
            : await execute();
          if (!res.destroyed) {
            let validImage = true;
            if (result.image) {
              try { validImage = isCurrent() && result.imageCurrent?.() === true; } catch { validImage = false; }
            }
            if (!validImage) res.end(JSON.stringify({ isError: true, text: 'Desktop screenshot authorization changed.' }));
            else res.end(JSON.stringify({ isError: !result.ok, text: result.text, ...(result.ok && result.image ? { image: result.image } : {}) }));
          }
        } catch (e) {
          if (!res.destroyed) res.end(JSON.stringify({ isError: true, text: (e as Error).message }));
        } finally {
          request.dispose();
          requests.delete(request);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    throw new Error('宿主工具网关未能绑定本地端口');
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    get token() { return token; },
    rotateToken: () => {
      if (closed) throw new Error('Host tool gateway is closed');
      token = crypto.randomBytes(16).toString('hex');
      for (const request of requests) request.abort();
      return token;
    },
    close: () => {
      closed = true;
      for (const request of requests) request.abort();
      try {
        server.close();
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
    }
  };
}
